import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { EventEmitter } from 'events';
import { AgentPreviewSpawnerService } from './agent-preview-spawner.service';
import { SseSubscriberService, WorkflowProposalNotifyPayload } from '@/runs/sse-subscriber.service';
import { NeonApiClient } from './neon-api.client';
import { RenderApiClient } from './render-api.client';
import { AuditService } from '@/audit/audit.service';
import { DATABASE_POOL } from '@/database/database.module';

const VERSION = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const TENANT = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const WORKFLOW_DEF = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

const basePayload: WorkflowProposalNotifyPayload = {
  version_id: VERSION,
  tenant_id: TENANT,
  workflow_def_id: WORKFLOW_DEF,
  parent_version_id: null,
  proposal_source: 'failure_recovery',
};

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

interface MockClient {
  query: jest.Mock;
  release: jest.Mock;
}

const buildService = async (overrides?: {
  enabled?: boolean;
  cap?: number;
  lockAcquired?: boolean;
  activeCount?: number;
  insertReturnsId?: boolean;
  neonFails?: boolean;
  renderFails?: boolean;
  serviceUrl?: string;
}): Promise<{
  service: AgentPreviewSpawnerService;
  subscriber: SseSubscriberService;
  audit: { log: jest.Mock };
  neon: { createBranch: jest.Mock; deleteBranch: jest.Mock };
  render: {
    createService: jest.Mock;
    getService: jest.Mock;
    deleteService: jest.Mock;
    putEnvVars: jest.Mock;
    waitForServiceUrl: jest.Mock;
  };
  queries: Array<{ sql: string; params: any[] }>;
}> => {
  const queries: Array<{ sql: string; params: any[] }> = [];
  const lockAcquired = overrides?.lockAcquired ?? true;
  const activeCount = overrides?.activeCount ?? 0;
  const insertReturnsId = overrides?.insertReturnsId ?? true;

  const client: MockClient = {
    query: jest.fn().mockImplementation((sql: string, params?: any[]) => {
      queries.push({ sql, params: params ?? [] });
      if (sql.includes('pg_try_advisory_xact_lock')) {
        return Promise.resolve({ rows: [{ acquired: lockAcquired }] });
      }
      if (sql.startsWith('SELECT COUNT(*)')) {
        return Promise.resolve({ rows: [{ n: activeCount }] });
      }
      if (sql.startsWith('INSERT INTO preview_environments')) {
        return Promise.resolve({ rows: insertReturnsId ? [{ id: 'preview-1' }] : [] });
      }
      return Promise.resolve({ rows: [] });
    }),
    release: jest.fn(),
  };
  const pool = { connect: jest.fn().mockResolvedValue(client) };

  const subscriber: SseSubscriberService = {
    notifications: new EventEmitter(),
  } as unknown as SseSubscriberService;

  const audit = { log: jest.fn().mockResolvedValue(undefined) };

  const neon = {
    createBranch: overrides?.neonFails
      ? jest.fn().mockRejectedValue(new Error('neon-down'))
      : jest.fn().mockResolvedValue({
          branch: { id: 'br-1', name: 'agent-preview-1' },
          connection_uri: 'postgres://neon/branch',
        }),
    deleteBranch: jest.fn().mockResolvedValue(undefined),
  };

  const render = {
    createService: overrides?.renderFails
      ? jest.fn().mockRejectedValue(new Error('render-down'))
      : jest.fn().mockResolvedValue({ id: 'svc-1', name: 'agent-preview-1', type: 'web_service' }),
    getService: jest.fn().mockResolvedValue({
      id: 'svc-1',
      name: 'agent-preview-1',
      type: 'web_service',
      serviceDetails: { url: overrides?.serviceUrl ?? 'https://agent-preview-1.onrender.com' },
    }),
    deleteService: jest.fn().mockResolvedValue(undefined),
    putEnvVars: jest.fn().mockResolvedValue(undefined),
    waitForServiceUrl: jest
      .fn()
      .mockResolvedValue(overrides?.serviceUrl ?? 'https://agent-preview-1.onrender.com'),
  };

  const cfg: Record<string, string> = {
    AGENT_PREVIEW_ENABLED: overrides?.enabled === false ? 'false' : 'true',
    MAX_ACTIVE_AGENT_PREVIEWS_PER_TENANT: String(overrides?.cap ?? 3),
    AGENT_PREVIEW_TTL_HOURS: '24',
    RENDER_REPO_URL: 'https://github.com/rinzler-vicky/agent',
    RENDER_BASE_BRANCH: 'main',
    RENDER_OWNER_ID: 'tea-test',
  };

  const module: TestingModule = await Test.createTestingModule({
    providers: [
      AgentPreviewSpawnerService,
      { provide: DATABASE_POOL, useValue: pool },
      { provide: SseSubscriberService, useValue: subscriber },
      { provide: AuditService, useValue: audit },
      { provide: NeonApiClient, useValue: neon },
      { provide: RenderApiClient, useValue: render },
      {
        provide: ConfigService,
        useValue: { get: (k: string) => cfg[k] ?? '' },
      },
    ],
  }).compile();

  const service = module.get(AgentPreviewSpawnerService);
  service.onModuleInit();
  return { service, subscriber, audit, neon, render, queries };
};

describe('AgentPreviewSpawnerService', () => {
  it('is a no-op when AGENT_PREVIEW_ENABLED=false', async () => {
    const { subscriber, neon, render, audit } = await buildService({ enabled: false });
    subscriber.notifications.emit('workflow_proposals', basePayload);
    await flush();
    expect(neon.createBranch).not.toHaveBeenCalled();
    expect(render.createService).not.toHaveBeenCalled();
    expect(audit.log).not.toHaveBeenCalled();
  });

  it('ignores proposals whose source is not failure_recovery', async () => {
    const { subscriber, neon, render } = await buildService();
    subscriber.notifications.emit('workflow_proposals', {
      ...basePayload,
      proposal_source: 'agent_reflection',
    });
    await flush();
    expect(neon.createBranch).not.toHaveBeenCalled();
    expect(render.createService).not.toHaveBeenCalled();
  });

  it('skips when the advisory lock is held by another pod', async () => {
    const { subscriber, neon, render, audit } = await buildService({ lockAcquired: false });
    subscriber.notifications.emit('workflow_proposals', basePayload);
    await flush();
    expect(neon.createBranch).not.toHaveBeenCalled();
    expect(render.createService).not.toHaveBeenCalled();
    // No audit either — silent skip is the contract (same-tenant work is already underway).
    expect(audit.log).not.toHaveBeenCalled();
  });

  it('audits rate_limited and skips Render when tenant is at concurrency cap', async () => {
    const { subscriber, neon, render, audit } = await buildService({ cap: 3, activeCount: 3 });
    subscriber.notifications.emit('workflow_proposals', basePayload);
    await flush();
    expect(neon.createBranch).not.toHaveBeenCalled();
    expect(render.createService).not.toHaveBeenCalled();
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'agent_preview.rate_limited',
        metadata: expect.objectContaining({ active_count: 3, cap: 3 }),
      }),
      expect.anything(),
    );
  });

  it('happy path: inserts row, calls Neon + Render, audits agent_preview.created', async () => {
    const { subscriber, neon, render, audit, queries } = await buildService();
    subscriber.notifications.emit('workflow_proposals', basePayload);
    await flush();
    await flush();

    expect(neon.createBranch).toHaveBeenCalledTimes(1);
    expect(render.createService).toHaveBeenCalledTimes(1);
    expect(render.waitForServiceUrl).toHaveBeenCalledWith('svc-1');

    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'agent_preview.created',
        resourceType: 'preview_environment',
        metadata: expect.objectContaining({
          workflow_version_id: VERSION,
          render_service_id: 'svc-1',
          preview_url: 'https://agent-preview-1.onrender.com',
        }),
      }),
    );

    const insertCall = queries.find((q) => q.sql.startsWith('INSERT INTO preview_environments'));
    expect(insertCall).toBeDefined();
    expect(insertCall!.params).toEqual([TENANT, VERSION, '24']);
  });

  it('idempotency: when INSERT returns no rows (ON CONFLICT), does not call Render', async () => {
    const { subscriber, neon, render } = await buildService({ insertReturnsId: false });
    subscriber.notifications.emit('workflow_proposals', basePayload);
    await flush();
    expect(neon.createBranch).not.toHaveBeenCalled();
    expect(render.createService).not.toHaveBeenCalled();
  });

  it('Neon failure: marks row failed, audits agent_preview.failed', async () => {
    const { subscriber, audit, render } = await buildService({ neonFails: true });
    subscriber.notifications.emit('workflow_proposals', basePayload);
    await flush();
    await flush();
    expect(render.createService).not.toHaveBeenCalled();
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'agent_preview.failed',
        metadata: expect.objectContaining({
          workflow_version_id: VERSION,
          error: 'neon-down',
        }),
      }),
    );
  });

  it('Render failure: marks row failed, audits agent_preview.failed', async () => {
    const { subscriber, audit } = await buildService({ renderFails: true });
    subscriber.notifications.emit('workflow_proposals', basePayload);
    await flush();
    await flush();
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'agent_preview.failed',
        metadata: expect.objectContaining({ error: 'render-down' }),
      }),
    );
  });
});
