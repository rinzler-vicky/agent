import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { RunsService } from './runs.service';
import { DATABASE_POOL } from '@/database/database.module';
import { AuditService } from '@/audit/audit.service';
import {
  N8nExecutionAdapter,
  N8nExecutionError,
} from '@/workflows/adapters/n8n/n8n-execution.adapter';

const TENANT = '11111111-1111-1111-1111-111111111111';
const USER = '22222222-2222-2222-2222-222222222222';
const VERSION = '33333333-3333-3333-3333-333333333333';
const RUN = '44444444-4444-4444-4444-444444444444';
const N8N_WF = 'n8n-wf-abc';
const N8N_EXEC = 'n8n-exec-xyz';

const txnOpen = (client: { query: jest.Mock }) => {
  client.query
    .mockResolvedValueOnce({ rows: [] }) // BEGIN
    .mockResolvedValueOnce({ rows: [] }); // set_config
};

const runRow = (overrides: Record<string, unknown> = {}) => ({
  id: RUN,
  tenant_id: TENANT,
  workflow_version_id: VERSION,
  conversation_id: null,
  task_graph_id: null,
  execution_engine: 'n8n_queue',
  status: 'pending',
  input: {},
  output: null,
  error_details: null,
  started_at: null,
  completed_at: null,
  created_at: new Date(),
  updated_at: new Date(),
  ...overrides,
});

describe('RunsService', () => {
  let service: RunsService;
  let client: { query: jest.Mock; release: jest.Mock };
  let pool: { connect: jest.Mock };
  let audit: { log: jest.Mock };
  let adapter: { triggerExecution: jest.Mock };

  beforeEach(async () => {
    client = { query: jest.fn(), release: jest.fn() };
    pool = { connect: jest.fn().mockResolvedValue(client) };
    audit = { log: jest.fn().mockResolvedValue(undefined) };
    adapter = { triggerExecution: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RunsService,
        { provide: DATABASE_POOL, useValue: pool },
        { provide: AuditService, useValue: audit },
        { provide: N8nExecutionAdapter, useValue: adapter },
      ],
    }).compile();
    service = module.get(RunsService);
  });

  describe('create', () => {
    it('commits the INSERT before triggering n8n (so the row is visible to webhook callbacks)', async () => {
      // Phase 1: insertPendingRun txn — BEGIN, set_config, version lookup, INSERT, COMMIT
      txnOpen(client);
      client.query
        .mockResolvedValueOnce({ rows: [{ id: VERSION }] }) // version lookup
        .mockResolvedValueOnce({ rows: [runRow()] }) // INSERT
        .mockResolvedValueOnce({ rows: [] }); // COMMIT

      // Phase 3: stashProviderAndAudit txn — BEGIN, set_config, UPDATE, COMMIT
      txnOpen(client);
      client.query
        .mockResolvedValueOnce({
          rows: [
            runRow({ input: { __provider: { providerExecutionId: N8N_EXEC, n8nWorkflowId: N8N_WF } } }),
          ],
        }) // UPDATE stash
        .mockResolvedValueOnce({ rows: [] }); // COMMIT

      adapter.triggerExecution.mockResolvedValue({
        providerExecutionId: N8N_EXEC,
        n8nWorkflowId: N8N_WF,
      });

      const result = await service.create(
        { workflowVersionId: VERSION },
        TENANT,
        { userId: USER },
      );

      // The trigger fires AFTER the insert txn closes — verify call order
      const queryCalls = client.query.mock.calls.map((c) => c[0]);
      const insertIdx = queryCalls.findIndex((q: string) => typeof q === 'string' && q.includes('INSERT INTO workflow_runs'));
      const firstCommitIdx = queryCalls.indexOf('COMMIT');
      expect(firstCommitIdx).toBeGreaterThan(insertIdx);
      // adapter.triggerExecution is called between the two txns; assert it was called once
      expect(adapter.triggerExecution).toHaveBeenCalledTimes(1);

      expect(audit.log).toHaveBeenCalledTimes(1);
      expect(audit.log.mock.calls[0][0]).toMatchObject({
        action: 'workflow.run.started',
        tenantId: TENANT,
        actorType: 'user',
        actorId: USER,
        resourceId: RUN,
      });
      expect(result.input.__provider.providerExecutionId).toBe(N8N_EXEC);
      expect(client.query).not.toHaveBeenCalledWith('ROLLBACK');
    });

    it('rolls back the insert txn when the version is not published in this tenant', async () => {
      txnOpen(client);
      client.query
        .mockResolvedValueOnce({ rows: [] }) // version lookup empty
        .mockResolvedValueOnce({ rows: [] }); // ROLLBACK

      await expect(
        service.create({ workflowVersionId: VERSION }, TENANT, { userId: USER }),
      ).rejects.toThrow(NotFoundException);

      expect(adapter.triggerExecution).not.toHaveBeenCalled();
      expect(client.query).toHaveBeenCalledWith('ROLLBACK');
    });

    it('marks the run failed when the adapter throws (run row stays, status flips to failed)', async () => {
      // Phase 1: insert succeeds
      txnOpen(client);
      client.query
        .mockResolvedValueOnce({ rows: [{ id: VERSION }] })
        .mockResolvedValueOnce({ rows: [runRow()] })
        .mockResolvedValueOnce({ rows: [] }); // COMMIT
      adapter.triggerExecution.mockRejectedValue(
        new N8nExecutionError('trigger_failed', 'boom'),
      );
      // Phase 2 → markRunFailed txn — BEGIN, set_config, UPDATE, audit insert, COMMIT
      txnOpen(client);
      client.query
        .mockResolvedValueOnce({ rows: [] }) // UPDATE status=failed
        .mockResolvedValueOnce({ rows: [] }); // COMMIT

      await expect(
        service.create({ workflowVersionId: VERSION }, TENANT, { userId: USER }),
      ).rejects.toThrow(N8nExecutionError);

      // markRunFailed runs in a follow-up txn and audits 'trigger_failed'
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'workflow.run.trigger_failed' }),
        expect.anything(),
      );
      // 'workflow.run.started' audit is NEVER written when the trigger fails
      expect(audit.log).not.toHaveBeenCalledWith(
        expect.objectContaining({ action: 'workflow.run.started' }),
        expect.anything(),
      );
    });
  });

  describe('cancel', () => {
    it('flips status when run is pending/running and audits', async () => {
      txnOpen(client);
      client.query
        .mockResolvedValueOnce({
          rows: [{ id: RUN, input: { __provider: { providerExecutionId: N8N_EXEC } } }],
        }) // UPDATE
        .mockResolvedValueOnce({ rows: [] }); // COMMIT

      const result = await service.cancel(RUN, TENANT, { userId: USER });

      expect(result).toEqual({ cancelled: true });
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'workflow.run.cancelled',
          resourceId: RUN,
          metadata: expect.objectContaining({ providerExecutionId: N8N_EXEC }),
        }),
        client,
      );
    });

    it('returns { cancelled: false } when the run is already terminal', async () => {
      txnOpen(client);
      client.query
        .mockResolvedValueOnce({ rows: [] }) // UPDATE matched nothing
        .mockResolvedValueOnce({ rows: [{ 1: 1 }] }) // existence check found it
        .mockResolvedValueOnce({ rows: [] }); // COMMIT

      const result = await service.cancel(RUN, TENANT, { userId: USER });

      expect(result).toEqual({ cancelled: false });
      expect(audit.log).not.toHaveBeenCalled();
    });

    it('404s when the run does not exist', async () => {
      txnOpen(client);
      client.query
        .mockResolvedValueOnce({ rows: [] }) // UPDATE matched nothing
        .mockResolvedValueOnce({ rows: [] }) // existence check empty
        .mockResolvedValueOnce({ rows: [] }); // COMMIT

      await expect(service.cancel(RUN, TENANT, { userId: USER })).rejects.toThrow(NotFoundException);
    });
  });

  describe('getWithRollup', () => {
    it('returns run + steps + counts', async () => {
      txnOpen(client);
      const now = new Date();
      client.query
        .mockResolvedValueOnce({ rows: [runRow({ status: 'running' })] })
        .mockResolvedValueOnce({
          rows: [
            { id: 'step1', workflow_run_id: RUN, step_key: 'a', step_name: 'a', status: 'succeeded', created_at: now, updated_at: now },
            { id: 'step2', workflow_run_id: RUN, step_key: 'b', step_name: 'b', status: 'running', created_at: now, updated_at: now },
            { id: 'step3', workflow_run_id: RUN, step_key: 'c', step_name: 'c', status: 'failed', created_at: now, updated_at: now },
          ],
        })
        .mockResolvedValueOnce({ rows: [] }); // COMMIT

      const result = await service.getWithRollup(RUN, TENANT);

      expect(result.run.status).toBe('running');
      expect(result.steps).toHaveLength(3);
      expect(result.counts).toEqual({ pending: 0, running: 1, succeeded: 1, failed: 1 });
    });

    it('404s when the run is not visible (RLS-scoped)', async () => {
      txnOpen(client);
      client.query
        .mockResolvedValueOnce({ rows: [] }) // run lookup empty
        .mockResolvedValueOnce({ rows: [] }); // ROLLBACK

      await expect(service.getWithRollup(RUN, TENANT)).rejects.toThrow(NotFoundException);
    });
  });
});
