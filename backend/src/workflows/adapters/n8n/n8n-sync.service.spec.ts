import { N8nSyncService } from './n8n-sync.service';
import { N8nApiError, type N8nApiClient } from './n8n-api.client';
import type { AuditService } from '@/audit/audit.service';
import type { ConfigService } from '@nestjs/config';

const TENANT = '550e8400-e29b-41d4-a716-446655440000';
const WV_ID = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';

const canonicalSpec = {
  schemaVersion: '1',
  id: 'wf_linear',
  name: 'Linear',
  nodes: [
    { id: 'a_start', type: 'start' },
    { id: 'b_http', type: 'http.request', config: { url: 'https://example.com', method: 'GET' } },
    { id: 'c_end', type: 'end' },
  ],
  edges: [
    { id: 'e1', from: { nodeId: 'a_start', port: 'out' }, to: { nodeId: 'b_http', port: 'in' } },
    { id: 'e2', from: { nodeId: 'b_http', port: 'out' }, to: { nodeId: 'c_end', port: 'in' } },
  ],
};

function mockConfig(): ConfigService {
  const map: Record<string, string> = {
    N8N_WEBHOOK_BASE_URL: 'http://backend:3000',
    N8N_WEBHOOK_SECRET: 'static-secret',
  };
  return { get: (k: string) => map[k] } as unknown as ConfigService;
}

function mockAudit(): { audit: AuditService; calls: any[] } {
  const calls: any[] = [];
  return {
    audit: { log: async (e: any) => { calls.push(e); } } as unknown as AuditService,
    calls,
  };
}

function mockApi(overrides: Partial<N8nApiClient> = {}): {
  api: N8nApiClient;
  calls: Array<[string, ...any[]]>;
} {
  const calls: Array<[string, ...any[]]> = [];
  let nextId = 1;
  const defaults: any = {
    createWorkflow: async (body: any) => {
      const id = `n8n-${nextId++}`;
      calls.push(['createWorkflow', id, body.name]);
      return { id, name: body.name, active: false, versionId: 'v1', nodes: body.nodes, connections: body.connections, settings: body.settings };
    },
    updateWorkflow: async (id: string, body: any) => {
      calls.push(['updateWorkflow', id, body.name]);
      return { id, name: body.name, active: true, versionId: 'v2', nodes: body.nodes, connections: body.connections, settings: body.settings };
    },
    getWorkflow: async (id: string) => {
      calls.push(['getWorkflow', id]);
      return { id, name: 'x', active: true, versionId: 'v1', nodes: [], connections: {}, settings: {} };
    },
    activateWorkflow: async (id: string) => { calls.push(['activateWorkflow', id]); },
    deactivateWorkflow: async (id: string) => { calls.push(['deactivateWorkflow', id]); },
    deleteWorkflow: async (id: string) => { calls.push(['deleteWorkflow', id]); },
    getExecution: async (id: string) => { calls.push(['getExecution', id]); return null; },
  };
  return { api: { ...defaults, ...overrides } as N8nApiClient, calls };
}

function mockPool(opts: {
  versionRow?: { spec: unknown } | null;
  cachedArtifact?: any | null;
} = {}) {
  const queries: Array<{ sql: string; params: any[] }> = [];
  const versionRow = opts.versionRow === undefined ? { spec: canonicalSpec } : opts.versionRow;
  let cachedArtifact: any = opts.cachedArtifact ?? null;

  const client = {
    query: async (sql: string, params: any[] = []) => {
      queries.push({ sql, params });
      if (sql.includes('workflow_versions') && sql.includes('SELECT')) {
        return { rows: versionRow ? [{ spec: versionRow.spec }] : [] };
      }
      return { rows: [] };
    },
    release: () => {},
  };

  const pool = {
    connect: async () => client,
    query: async (sql: string, params: any[] = []) => {
      queries.push({ sql, params });
      if (sql.includes('SELECT artifact FROM workflow_adapter_artifacts')) {
        return { rows: cachedArtifact ? [{ artifact: cachedArtifact }] : [] };
      }
      if (sql.includes('INSERT INTO workflow_adapter_artifacts')) {
        cachedArtifact = params[1];
        return { rows: [] };
      }
      return { rows: [] };
    },
  };
  return {
    pool: pool as any,
    queries,
    getCached: () => cachedArtifact,
  };
}

function makeService(args: {
  apiOverrides?: Partial<N8nApiClient>;
  cached?: any;
  spec?: unknown;
} = {}) {
  const { api, calls } = mockApi(args.apiOverrides ?? {});
  const { audit, calls: auditCalls } = mockAudit();
  const { pool, getCached } = mockPool({
    versionRow: args.spec === undefined ? { spec: canonicalSpec } : { spec: args.spec },
    cachedArtifact: args.cached ?? null,
  });
  const svc = new N8nSyncService(pool, mockConfig(), api, audit);
  return { svc, apiCalls: calls, auditCalls, getCached };
}

describe('N8nSyncService.syncPublishedVersion', () => {
  it('creates on first sync (cache empty)', async () => {
    const { svc, apiCalls, auditCalls, getCached } = makeService();
    const r = await svc.syncPublishedVersion(WV_ID, TENANT, 'actor-1');
    expect(r.action).toBe('created');
    const created = apiCalls.filter((c) => c[0] === 'createWorkflow');
    expect(created).toHaveLength(2);
    expect(apiCalls.some((c) => c[0] === 'activateWorkflow')).toBe(true);
    expect(auditCalls).toHaveLength(1);
    expect(auditCalls[0].action).toBe('workflow.synced');
    expect(getCached()).toBeTruthy();
    expect((getCached() as any).n8nWorkflowId).toBeTruthy();
  });

  it('skips when cached hash matches and remote exists', async () => {
    const first = makeService();
    const r1 = await first.svc.syncPublishedVersion(WV_ID, TENANT, 'a');
    const cached = first.getCached();

    const { svc, apiCalls } = makeService({ cached });
    const r2 = await svc.syncPublishedVersion(WV_ID, TENANT, 'a');
    expect(r2.action).toBe('skipped');
    expect(r2.canonicalHash).toBe(r1.canonicalHash);
    expect(apiCalls.filter((c) => c[0] === 'createWorkflow' || c[0] === 'updateWorkflow')).toHaveLength(0);
  });

  it('recreates when cached n8nWorkflowId no longer exists on n8n side', async () => {
    const first = makeService();
    await first.svc.syncPublishedVersion(WV_ID, TENANT, 'a');
    const cached = first.getCached();

    const { svc, apiCalls } = makeService({
      cached,
      apiOverrides: { getWorkflow: async () => null },
    });
    const r = await svc.syncPublishedVersion(WV_ID, TENANT, 'a');
    expect(r.action).toBe('recreated');
    expect(apiCalls.filter((c) => c[0] === 'createWorkflow')).toHaveLength(2);
  });

  it('updates when cached hash differs but workflow still exists', async () => {
    const first = makeService();
    await first.svc.syncPublishedVersion(WV_ID, TENANT, 'a');
    const cached = first.getCached();

    const mutatedSpec = {
      ...canonicalSpec,
      nodes: [
        ...canonicalSpec.nodes,
        { id: 'd_set', type: 'transform' as const },
      ],
      edges: [
        { id: 'e1', from: { nodeId: 'a_start', port: 'out' }, to: { nodeId: 'b_http', port: 'in' } },
        { id: 'e2', from: { nodeId: 'b_http', port: 'out' }, to: { nodeId: 'd_set', port: 'in' } },
        { id: 'e3', from: { nodeId: 'd_set', port: 'out' }, to: { nodeId: 'c_end', port: 'in' } },
      ],
    };
    const { svc, apiCalls } = makeService({ cached, spec: mutatedSpec });
    const r = await svc.syncPublishedVersion(WV_ID, TENANT, 'a');
    expect(r.action).toBe('updated');
    expect(apiCalls.filter((c) => c[0] === 'updateWorkflow')).toHaveLength(2);
  });

  it('falls through to recreate on 404 from updateWorkflow', async () => {
    const first = makeService();
    await first.svc.syncPublishedVersion(WV_ID, TENANT, 'a');
    const cached = first.getCached();
    cached.canonicalHash = 'different-hash';

    const { svc, apiCalls } = makeService({
      cached,
      apiOverrides: {
        updateWorkflow: async () => {
          throw new N8nApiError(404, '', 'gone');
        },
      },
    });
    const r = await svc.syncPublishedVersion(WV_ID, TENANT, 'a');
    expect(r.action).toBe('recreated');
    expect(apiCalls.filter((c) => c[0] === 'createWorkflow')).toHaveLength(2);
  });

  it('throws when the workflow_version row is missing', async () => {
    const { audit } = mockAudit();
    const { api } = mockApi();
    const { pool } = mockPool({ versionRow: null });
    const svc = new N8nSyncService(pool, mockConfig(), api, audit);
    await expect(svc.syncPublishedVersion(WV_ID, TENANT, 'a')).rejects.toThrow(/not found/);
  });

  it('passes tenantId as both the SET LOCAL var and the WHERE filter (fix for Copilot review #175)', async () => {
    const queries: Array<{ sql: string; params: any[] }> = [];
    const client = {
      query: async (sql: string, params: any[] = []) => {
        queries.push({ sql, params });
        if (sql.includes('workflow_versions') && sql.includes('SELECT')) {
          return { rows: [{ spec: canonicalSpec }] };
        }
        return { rows: [] };
      },
      release: () => {},
    };
    const pool = {
      connect: async () => client,
      query: async (sql: string, params: any[] = []) => {
        queries.push({ sql, params });
        return { rows: [] };
      },
    } as any;
    const { api } = mockApi();
    const { audit } = mockAudit();
    const svc = new N8nSyncService(pool, mockConfig(), api, audit);

    await svc.syncPublishedVersion(WV_ID, TENANT, 'a');

    const setLocal = queries.find((q) => q.sql.includes('SET LOCAL app.tenant_id'));
    expect(setLocal?.params[0]).toBe(TENANT);
    const selectVersion = queries.find(
      (q) => q.sql.includes('workflow_versions') && q.sql.includes('workflow_defs'),
    );
    expect(selectVersion).toBeDefined();
    // Tenant id appears as both the RLS session var and the explicit join filter
    expect(selectVersion!.params).toContain(TENANT);
  });

  it('on 404 update fallback, only creates the main workflow (not the error workflow twice)', async () => {
    const first = makeService();
    await first.svc.syncPublishedVersion(WV_ID, TENANT, 'a');
    const cached = first.getCached();
    cached.canonicalHash = 'different-hash';

    const { svc, apiCalls } = makeService({
      cached,
      apiOverrides: {
        updateWorkflow: async () => {
          throw new N8nApiError(404, '', 'gone');
        },
      },
    });
    const r = await svc.syncPublishedVersion(WV_ID, TENANT, 'a');
    expect(r.action).toBe('recreated');
    // 1 create for the upserted error workflow + 1 create for the main = 2.
    // The bug would emit 3 (error created twice via pushFresh re-entry).
    expect(apiCalls.filter((c) => c[0] === 'createWorkflow')).toHaveLength(2);
  });
});
