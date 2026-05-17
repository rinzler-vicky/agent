import { UnauthorizedException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { N8nWebhookController } from './n8n-webhook.controller';
import type { AuditService } from '@/audit/audit.service';
import type { N8nApiClient } from './n8n-api.client';
import type { N8nWebhookEvent } from './types';

const SECRET = 'static-secret-32-chars-padding-aaaa';
const TENANT = '550e8400-e29b-41d4-a716-446655440000';
const RUN_ID = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';

function mockConfig(skewSeconds = 300): ConfigService {
  const map: Record<string, string> = {
    N8N_WEBHOOK_SECRET: SECRET,
    N8N_WEBHOOK_CLOCK_SKEW_S: String(skewSeconds),
  };
  return { get: (k: string) => map[k] } as unknown as ConfigService;
}

function freshTimestamp(offsetMs = 0): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

function makeController(opts: { existingEventId?: string } = {}) {
  const queries: Array<{ sql: string; params: any[] }> = [];
  const client = {
    query: async (sql: string, params: any[] = []) => {
      queries.push({ sql, params });
      if (sql.includes("event_data->>'event_id'") && opts.existingEventId) {
        return params[0] === opts.existingEventId ? { rows: [{ '?column?': 1 }] } : { rows: [] };
      }
      if (sql.includes('INSERT INTO step_runs')) {
        return { rows: [{ id: 'step-run-uuid' }] };
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
  const audit: AuditService = { log: async () => {} } as any;
  const api: N8nApiClient = { getExecution: async () => null } as any;
  const c = new N8nWebhookController(pool, mockConfig(), api, audit);
  return { controller: c, queries };
}

function event(overrides: Partial<N8nWebhookEvent> = {}): N8nWebhookEvent {
  return {
    runId: RUN_ID,
    tenantId: TENANT,
    event: 'workflow.started',
    timestamp: freshTimestamp(),
    ...overrides,
  };
}

describe('N8nWebhookController.receive', () => {
  it('rejects when the secret header is missing', async () => {
    const { controller } = makeController();
    await expect(controller.receive(undefined, event())).rejects.toThrow(UnauthorizedException);
  });

  it('rejects when the secret header does not match', async () => {
    const { controller } = makeController();
    await expect(controller.receive('wrong-secret', event())).rejects.toThrow(UnauthorizedException);
  });

  it('rejects unknown event types', async () => {
    const { controller } = makeController();
    await expect(
      controller.receive(SECRET, event({ event: 'step.bogus' as any })),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('rejects step events without stepKey', async () => {
    const { controller } = makeController();
    await expect(
      controller.receive(SECRET, event({ event: 'step.started', stepKey: undefined })),
    ).rejects.toThrow(UnauthorizedException);
    await expect(
      controller.receive(SECRET, event({ event: 'step.completed', stepKey: undefined })),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('accepts step events with stepKey present', async () => {
    const { controller } = makeController();
    const r = await controller.receive(SECRET, event({ event: 'step.started', stepKey: 'b_http' }));
    expect(r.ok).toBe(true);
  });

  it('rejects malformed payloads', async () => {
    const { controller } = makeController();
    await expect(controller.receive(SECRET, {} as any)).rejects.toThrow(UnauthorizedException);
  });

  it('rejects non-UUID tenant or run id', async () => {
    const { controller } = makeController();
    await expect(
      controller.receive(SECRET, event({ tenantId: 'not-a-uuid' })),
    ).rejects.toThrow(UnauthorizedException);
    await expect(
      controller.receive(SECRET, event({ runId: 'not-a-uuid' })),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('rejects stale timestamps', async () => {
    const { controller } = makeController();
    const stale = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    await expect(controller.receive(SECRET, event({ timestamp: stale }))).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('accepts a valid workflow.started event and writes run_events + workflow_runs update', async () => {
    const { controller, queries } = makeController();
    const r = await controller.receive(SECRET, event({ event: 'workflow.started' }));
    expect(r.ok).toBe(true);
    const insertEv = queries.find((q) => q.sql.includes('INSERT INTO run_events'));
    expect(insertEv).toBeDefined();
    const updateRun = queries.find((q) =>
      q.sql.includes('UPDATE workflow_runs') && q.sql.includes("status = 'running'"),
    );
    expect(updateRun).toBeDefined();
  });

  it('upserts step_runs on step.started and step.completed', async () => {
    const { controller, queries } = makeController();
    await controller.receive(SECRET, event({ event: 'step.started', stepKey: 's1' }));
    await controller.receive(SECRET, event({ event: 'step.completed', stepKey: 's1', timestamp: freshTimestamp(1000) }));
    const inserts = queries.filter((q) => q.sql.includes('INSERT INTO step_runs'));
    expect(inserts.length).toBe(2);
  });

  it('always sets app.tenant_id from the signed payload (RLS context)', async () => {
    const { controller, queries } = makeController();
    await controller.receive(SECRET, event({ event: 'workflow.started' }));
    const setTenant = queries.find(
      (q) => q.sql.includes('set_config') && q.sql.includes('app.tenant_id') && q.params[0] === TENANT,
    );
    expect(setTenant).toBeDefined();
  });

  it('deduplicates a repeated delivery (same payload → no extra inserts)', async () => {
    const { controller, queries } = makeController();
    const e = event({ event: 'step.completed', stepKey: 's1' });
    const r1 = await controller.receive(SECRET, e);
    expect(r1.deduped).toBeUndefined();

    const dedupeQueryResult = queries.find((q) => q.sql.includes("event_data->>'event_id'"));
    const eventId = dedupeQueryResult!.params[0];

    const { controller: c2, queries: q2 } = makeController({ existingEventId: eventId });
    const r2 = await c2.receive(SECRET, e);
    expect(r2.deduped).toBe(true);
    expect(q2.some((q) => q.sql.includes('INSERT INTO step_runs'))).toBe(false);
    expect(q2.some((q) => q.sql.includes('INSERT INTO run_events'))).toBe(false);
  });

  it('writes workflow_runs.status = failed on workflow.failed', async () => {
    const { controller, queries } = makeController();
    await controller.receive(
      SECRET,
      event({ event: 'workflow.failed', payload: { error: 'boom' } }),
    );
    const fail = queries.find(
      (q) => q.sql.includes('UPDATE workflow_runs') && q.sql.includes("status = 'failed'"),
    );
    expect(fail).toBeDefined();
  });

  it('takes a pg_advisory_xact_lock before the dedupe check (fix for Copilot review #76)', async () => {
    const { controller, queries } = makeController();
    await controller.receive(SECRET, event({ event: 'step.started', stepKey: 's1' }));
    const lockIdx = queries.findIndex((q) => q.sql.includes('pg_advisory_xact_lock'));
    const dedupeIdx = queries.findIndex((q) =>
      q.sql.includes("event_data->>'event_id'"),
    );
    expect(lockIdx).toBeGreaterThanOrEqual(0);
    expect(dedupeIdx).toBeGreaterThan(lockIdx);
  });

  it('accepts workflow.failed events without runId/tenantId (fix for error-workflow ping path)', async () => {
    const { controller, queries } = makeController();
    const failurePayload = {
      event: 'workflow.failed',
      timestamp: freshTimestamp(),
      n8nExecutionId: 'exec-123',
      payload: { lastNodeExecuted: 'b_http', error: 'boom' },
    } as any;
    const r = await controller.receive(SECRET, failurePayload);
    expect(r.ok).toBe(true);
    // No DB writes — audit-only path until Phase 2.4 adds the n8n_execution_id
    // column on workflow_runs that would let us resolve the originating run.
    expect(queries.some((q) => q.sql.includes('INSERT INTO run_events'))).toBe(false);
    expect(queries.some((q) => q.sql.includes('UPDATE workflow_runs'))).toBe(false);
  });

  it('still rejects non-failure events without runId/tenantId', async () => {
    const { controller } = makeController();
    await expect(
      controller.receive(SECRET, { event: 'step.started', timestamp: freshTimestamp() } as any),
    ).rejects.toThrow(UnauthorizedException);
  });
});
