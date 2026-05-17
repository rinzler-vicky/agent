import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ProposalsService } from './proposals.service';
import { DATABASE_POOL } from '@/database/database.module';
import { AuditService } from '@/audit/audit.service';

const VALID_SPEC = {
  schemaVersion: '1',
  id: 'wf_ok',
  name: 'ok',
  nodes: [
    { id: 'start1', type: 'start' },
    { id: 'http1', type: 'http.request' },
    { id: 'finish', type: 'end' },
  ],
  edges: [
    { id: 'e1', from: { nodeId: 'start1', port: 'out' }, to: { nodeId: 'http1', port: 'in' } },
    { id: 'e2', from: { nodeId: 'http1', port: 'out' }, to: { nodeId: 'finish', port: 'in' } },
  ],
};

const TENANT = '11111111-1111-1111-1111-111111111111';
const SA = '22222222-2222-2222-2222-222222222222';
const DEF_ID = '33333333-3333-3333-3333-333333333333';
const PARENT_VERSION_ID = '44444444-4444-4444-4444-444444444444';
const STEP_RUN_ID = '55555555-5555-5555-5555-555555555555';
const WORKFLOW_RUN_ID = '66666666-6666-6666-6666-666666666666';

const mockTxnOpen = (client: { query: jest.Mock }) => {
  client.query
    .mockResolvedValueOnce({ rows: [] }) // BEGIN
    .mockResolvedValueOnce({ rows: [] }); // set_config
};

describe('ProposalsService', () => {
  let service: ProposalsService;
  let client: { query: jest.Mock; release: jest.Mock };
  let pool: { connect: jest.Mock };
  let audit: { log: jest.Mock };

  beforeEach(async () => {
    client = { query: jest.fn(), release: jest.fn() };
    pool = { connect: jest.fn().mockResolvedValue(client) };
    audit = { log: jest.fn().mockResolvedValue(undefined) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ProposalsService,
        { provide: DATABASE_POOL, useValue: pool },
        { provide: AuditService, useValue: audit },
      ],
    }).compile();
    service = module.get(ProposalsService);
  });

  it('400s when the spec fails to compile', async () => {
    await expect(
      service.create(
        { workflowDefId: DEF_ID, parentVersionId: PARENT_VERSION_ID, spec: { schemaVersion: '1' } },
        { tenantId: TENANT, serviceAccountId: SA },
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it('404s when the workflow_def is not in the caller tenant', async () => {
    mockTxnOpen(client);
    client.query
      .mockResolvedValueOnce({ rows: [] }) // def lookup empty
      .mockResolvedValueOnce({ rows: [] }); // ROLLBACK

    await expect(
      service.create(
        { workflowDefId: DEF_ID, parentVersionId: PARENT_VERSION_ID, spec: VALID_SPEC },
        { tenantId: TENANT, serviceAccountId: SA },
      ),
    ).rejects.toThrow(NotFoundException);
  });

  it('404s when the parent version is not owned by the def + tenant', async () => {
    mockTxnOpen(client);
    client.query
      .mockResolvedValueOnce({ rows: [{ id: DEF_ID }] }) // def ok
      .mockResolvedValueOnce({ rows: [] }) // parent lookup empty
      .mockResolvedValueOnce({ rows: [] }); // ROLLBACK

    await expect(
      service.create(
        { workflowDefId: DEF_ID, parentVersionId: PARENT_VERSION_ID, spec: VALID_SPEC },
        { tenantId: TENANT, serviceAccountId: SA },
      ),
    ).rejects.toThrow(NotFoundException);
  });

  it('400s when the parent version is a draft (must derive from published/superseded)', async () => {
    mockTxnOpen(client);
    client.query
      .mockResolvedValueOnce({ rows: [{ id: DEF_ID }] })
      .mockResolvedValueOnce({ rows: [{ id: PARENT_VERSION_ID, lifecycle_state: 'draft' }] })
      .mockResolvedValueOnce({ rows: [] }); // ROLLBACK

    await expect(
      service.create(
        { workflowDefId: DEF_ID, parentVersionId: PARENT_VERSION_ID, spec: VALID_SPEC },
        { tenantId: TENANT, serviceAccountId: SA },
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it('404s when stepRunId belongs to a different tenant or workflow_def', async () => {
    mockTxnOpen(client);
    client.query
      .mockResolvedValueOnce({ rows: [{ id: DEF_ID }] })
      .mockResolvedValueOnce({ rows: [{ id: PARENT_VERSION_ID, lifecycle_state: 'published' }] })
      .mockResolvedValueOnce({
        // Tenant mismatch — different workflow_def.
        rows: [
          {
            status: 'failed',
            run_id: WORKFLOW_RUN_ID,
            tenant_id: TENANT,
            workflow_def_id: 'some-other-def-id',
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] }); // ROLLBACK

    await expect(
      service.create(
        {
          workflowDefId: DEF_ID,
          parentVersionId: PARENT_VERSION_ID,
          spec: VALID_SPEC,
          stepRunId: STEP_RUN_ID,
        },
        { tenantId: TENANT, serviceAccountId: SA },
      ),
    ).rejects.toThrow(NotFoundException);
  });

  it('400s when the referenced step_run is not in status=failed', async () => {
    mockTxnOpen(client);
    client.query
      .mockResolvedValueOnce({ rows: [{ id: DEF_ID }] })
      .mockResolvedValueOnce({ rows: [{ id: PARENT_VERSION_ID, lifecycle_state: 'published' }] })
      .mockResolvedValueOnce({
        rows: [
          {
            status: 'succeeded',
            run_id: WORKFLOW_RUN_ID,
            tenant_id: TENANT,
            workflow_def_id: DEF_ID,
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] }); // ROLLBACK

    await expect(
      service.create(
        {
          workflowDefId: DEF_ID,
          parentVersionId: PARENT_VERSION_ID,
          spec: VALID_SPEC,
          stepRunId: STEP_RUN_ID,
        },
        { tenantId: TENANT, serviceAccountId: SA },
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it('lands a failure_recovery draft when a stepRunId is provided + writes an audit event', async () => {
    const newRow = {
      id: 'new-draft',
      workflow_def_id: DEF_ID,
      version_number: 7,
      lifecycle_state: 'draft',
      approval_state: 'draft',
      parent_version_id: PARENT_VERSION_ID,
      proposal_source: 'failure_recovery',
      proposal_context: {
        workflowRunId: WORKFLOW_RUN_ID,
        stepRunId: STEP_RUN_ID,
        errorFingerprint: 'HTTP_TIMEOUT@http1',
      },
      created_at: new Date('2026-05-17T00:00:00Z'),
    };
    mockTxnOpen(client);
    client.query
      .mockResolvedValueOnce({ rows: [{ id: DEF_ID }] }) // def ok
      .mockResolvedValueOnce({ rows: [{ id: PARENT_VERSION_ID, lifecycle_state: 'published' }] })
      .mockResolvedValueOnce({
        rows: [
          {
            status: 'failed',
            run_id: WORKFLOW_RUN_ID,
            tenant_id: TENANT,
            workflow_def_id: DEF_ID,
          },
        ],
      }) // step verification
      .mockResolvedValueOnce({ rows: [newRow] }) // INSERT
      .mockResolvedValueOnce({ rows: [] }); // COMMIT

    const result = await service.create(
      {
        workflowDefId: DEF_ID,
        parentVersionId: PARENT_VERSION_ID,
        spec: VALID_SPEC,
        stepRunId: STEP_RUN_ID,
        workflowRunId: WORKFLOW_RUN_ID,
        errorFingerprint: 'HTTP_TIMEOUT@http1',
        rationale: 'retry with longer timeout',
      },
      { tenantId: TENANT, serviceAccountId: SA },
    );

    expect(result.id).toBe('new-draft');
    expect(result.proposal_source).toBe('failure_recovery');
    expect(result.proposal_context).toMatchObject({ stepRunId: STEP_RUN_ID });

    // Locate the INSERT call (the only one carrying the proposal_source param).
    const insertCall = client.query.mock.calls.find(
      ([sql]) => typeof sql === 'string' && /INSERT INTO workflow_versions/i.test(sql),
    );
    expect(insertCall).toBeDefined();
    const params = insertCall![1] as any[];
    expect(params[4]).toBe('failure_recovery'); // proposal_source param
    expect(params[5]).toMatchObject({
      workflowRunId: WORKFLOW_RUN_ID,
      stepRunId: STEP_RUN_ID,
      errorFingerprint: 'HTTP_TIMEOUT@http1',
    });

    // The audit must run on the SAME client (atomicity: draft + audit
    // succeed or fail together).
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'workflow.proposal.created',
        actorType: 'service_account',
        resourceId: 'new-draft',
        metadata: expect.objectContaining({
          proposalSource: 'failure_recovery',
          stepRunId: STEP_RUN_ID,
          errorFingerprint: 'HTTP_TIMEOUT@http1',
        }),
      }),
      client,
    );
  });

  it("defaults proposal_source to 'agent_reflection' when no stepRunId is provided", async () => {
    const newRow = {
      id: 'reflective-draft',
      workflow_def_id: DEF_ID,
      version_number: 8,
      lifecycle_state: 'draft',
      approval_state: 'draft',
      parent_version_id: PARENT_VERSION_ID,
      proposal_source: 'agent_reflection',
      proposal_context: {},
      created_at: new Date(),
    };
    mockTxnOpen(client);
    client.query
      .mockResolvedValueOnce({ rows: [{ id: DEF_ID }] })
      .mockResolvedValueOnce({ rows: [{ id: PARENT_VERSION_ID, lifecycle_state: 'published' }] })
      .mockResolvedValueOnce({ rows: [newRow] })
      .mockResolvedValueOnce({ rows: [] }); // COMMIT

    const result = await service.create(
      { workflowDefId: DEF_ID, parentVersionId: PARENT_VERSION_ID, spec: VALID_SPEC },
      { tenantId: TENANT, serviceAccountId: SA },
    );

    expect(result.proposal_source).toBe('agent_reflection');
    const insertCall = client.query.mock.calls.find(
      ([sql]) => typeof sql === 'string' && /INSERT INTO workflow_versions/i.test(sql),
    );
    expect(insertCall![1][4]).toBe('agent_reflection');
  });
});
