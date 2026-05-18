import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter } from 'events';
import { FailureHookService, extractFailedNodes } from './failure-hook.service';
import { SseSubscriberService } from './sse-subscriber.service';
import { N8nApiClient } from '@/workflows/adapters/n8n/n8n-api.client';
import { AuditService } from '@/audit/audit.service';
import { DATABASE_POOL } from '@/database/database.module';

const RUN = '11111111-1111-1111-1111-111111111111';
const TENANT = '22222222-2222-2222-2222-222222222222';
const STEP_RUN = '33333333-3333-3333-3333-333333333333';
const PROVIDER_EXEC = 'n8n-exec-abc';

interface MockClient {
  query: jest.Mock;
  release: jest.Mock;
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

const buildService = async (overrides?: {
  lockAcquired?: boolean;
  providerExecutionId?: string | null;
  executionData?: unknown;
  stepRunId?: string | null;
  conflictOnInsert?: boolean;
}): Promise<{
  service: FailureHookService;
  subscriber: SseSubscriberService;
  api: { getExecution: jest.Mock };
  audit: { log: jest.Mock };
  queries: Array<{ sql: string; params: any[] }>;
}> => {
  const queries: Array<{ sql: string; params: any[] }> = [];
  const lockAcquired = overrides?.lockAcquired ?? true;
  const providerExecutionId =
    overrides?.providerExecutionId === undefined ? PROVIDER_EXEC : overrides.providerExecutionId;
  const stepRunId = overrides?.stepRunId === undefined ? STEP_RUN : overrides.stepRunId;
  const conflict = overrides?.conflictOnInsert ?? false;

  const client: MockClient = {
    query: jest.fn().mockImplementation((sql: string, params?: any[]) => {
      queries.push({ sql, params: params ?? [] });
      if (sql.includes('pg_try_advisory_xact_lock')) {
        return Promise.resolve({ rows: [{ acquired: lockAcquired }] });
      }
      if (sql.startsWith('SELECT input FROM workflow_runs')) {
        return Promise.resolve({
          rows: [{
            input: providerExecutionId
              ? { __provider: { providerExecutionId } }
              : {},
          }],
        });
      }
      if (sql.includes('FROM step_runs WHERE workflow_run_id')) {
        return Promise.resolve({ rows: stepRunId ? [{ id: stepRunId }] : [] });
      }
      if (sql.includes("event_type = 'step.completed'")) {
        return Promise.resolve({
          rows: [{ event_data: { payload: { output: { checkpoint: 'yes' } } } }],
        });
      }
      if (sql.startsWith('INSERT INTO proposal_triggers')) {
        return Promise.resolve({ rows: conflict ? [] : [{ id: 'pt-1' }] });
      }
      return Promise.resolve({ rows: [] });
    }),
    release: jest.fn(),
  };
  const pool = { connect: jest.fn().mockResolvedValue(client) };
  const subscriber: SseSubscriberService = {
    notifications: new EventEmitter(),
  } as unknown as SseSubscriberService;
  const api = {
    getExecution: jest.fn().mockResolvedValue({ data: overrides?.executionData ?? null }),
  };
  const audit = { log: jest.fn().mockResolvedValue(undefined) };

  const module: TestingModule = await Test.createTestingModule({
    providers: [
      FailureHookService,
      { provide: DATABASE_POOL, useValue: pool },
      { provide: SseSubscriberService, useValue: subscriber },
      { provide: N8nApiClient, useValue: api },
      { provide: AuditService, useValue: audit },
    ],
  }).compile();
  const service = module.get(FailureHookService);
  service.onModuleInit();
  return { service, subscriber, api, audit, queries };
};

describe('extractFailedNodes', () => {
  it('returns one entry per node with an error on its last attempt', () => {
    const data = {
      resultData: {
        runData: {
          step_a: [{}], // no error
          step_b: [{ error: { name: 'Boom', message: 'kaboom' } }],
          step_c: [{}, { error: { message: 'second-attempt failed' } }],
        },
      },
    };
    const result = extractFailedNodes(data);
    expect(result).toEqual([
      { nodeName: 'step_b', error: { name: 'Boom', message: 'kaboom' } },
      { nodeName: 'step_c', error: { name: 'NodeExecutionError', message: 'second-attempt failed' } },
    ]);
  });

  it('returns [] for missing/empty runData', () => {
    expect(extractFailedNodes(undefined)).toEqual([]);
    expect(extractFailedNodes({})).toEqual([]);
    expect(extractFailedNodes({ resultData: { runData: {} } })).toEqual([]);
  });
});

describe('FailureHookService', () => {
  const emitFailedEvent = (subscriber: SseSubscriberService) =>
    subscriber.notifications.emit('event', {
      run_id: RUN,
      tenant_id: TENANT,
      sequence: 9,
      event_type: 'workflow.failed',
      step_run_id: null,
      event_id: 'evt-9',
    });

  it('ignores non-failure events', async () => {
    const { subscriber, api } = await buildService();
    subscriber.notifications.emit('event', {
      run_id: RUN, tenant_id: TENANT, sequence: 1,
      event_type: 'step.completed', step_run_id: null, event_id: 'evt-1',
    });
    await flush();
    expect(api.getExecution).not.toHaveBeenCalled();
  });

  it('skips when another pod holds the advisory lock', async () => {
    const { subscriber, api, audit, queries } = await buildService({ lockAcquired: false });
    emitFailedEvent(subscriber);
    await flush(); await flush();
    expect(api.getExecution).not.toHaveBeenCalled();
    expect(audit.log).not.toHaveBeenCalled();
    // COMMIT runs even on skip
    expect(queries.some((q) => q.sql === 'COMMIT')).toBe(true);
  });

  it('audits + skips when workflow_runs has no providerExecutionId', async () => {
    const { subscriber, api, audit, queries } = await buildService({ providerExecutionId: null });
    emitFailedEvent(subscriber);
    await flush(); await flush();
    expect(api.getExecution).not.toHaveBeenCalled();
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'failure_hook.skipped_no_provider_id' }),
      expect.anything(),
    );
    expect(queries.some((q) => q.sql.startsWith('INSERT INTO proposal_triggers'))).toBe(false);
  });

  it('inserts one proposal_triggers row per failed node and audits each', async () => {
    const { subscriber, api, audit, queries } = await buildService({
      executionData: {
        resultData: {
          runData: {
            step_a: [{ error: { name: 'E1', message: 'fail-a' } }],
            step_b: [{ error: { name: 'E2', message: 'fail-b' } }],
          },
        },
      },
    });
    emitFailedEvent(subscriber);
    await flush(); await flush(); await flush();

    expect(api.getExecution).toHaveBeenCalledWith(PROVIDER_EXEC);
    const inserts = queries.filter((q) => q.sql.startsWith('INSERT INTO proposal_triggers'));
    expect(inserts).toHaveLength(2);
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'workflow.run.failure_trigger_created' }),
      expect.anything(),
    );
    expect(audit.log.mock.calls.filter((c) => c[0].action === 'workflow.run.failure_trigger_created'))
      .toHaveLength(2);
  });

  it('falls back to a single trigger with no step_run_id when n8n returns no per-node data', async () => {
    const { subscriber, audit, queries } = await buildService({ executionData: null });
    emitFailedEvent(subscriber);
    await flush(); await flush();

    const inserts = queries.filter((q) => q.sql.startsWith('INSERT INTO proposal_triggers'));
    expect(inserts).toHaveLength(1);
    // stepRunId is the 3rd parameter (1-indexed: tenant, run, step_run, fp, ctx)
    expect(inserts[0].params[2]).toBeNull();
    expect(audit.log).toHaveBeenCalled();
  });

  it('skips audit when the INSERT is a no-op (ON CONFLICT DO NOTHING)', async () => {
    const { subscriber, audit } = await buildService({
      conflictOnInsert: true,
      executionData: {
        resultData: { runData: { step_a: [{ error: { name: 'E1', message: 'x' } }] } },
      },
    });
    emitFailedEvent(subscriber);
    await flush(); await flush();
    // Only the skipped-no-provider_id case ever audits; conflict path audits nothing
    expect(audit.log).not.toHaveBeenCalled();
  });
});
