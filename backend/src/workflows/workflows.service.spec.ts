import { Test, TestingModule } from '@nestjs/testing';
import {
  BadGatewayException,
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { WorkflowsService } from './workflows.service';
import { DATABASE_POOL } from '@/database/database.module';
import { AuditService } from '@/audit/audit.service';
import { N8nSyncService } from './adapters/n8n/n8n-sync.service';

// A valid compiler input (matches the canonical compiler.spec.ts happy path).
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
const USER = '22222222-2222-2222-2222-222222222222';
const DEF_ID = '33333333-3333-3333-3333-333333333333';
const VERSION_ID = '44444444-4444-4444-4444-444444444444';
const PRIOR_PUBLISHED_ID = '55555555-5555-5555-5555-555555555555';

const draftRow = (overrides: Partial<Record<string, unknown>> = {}) => ({
  id: VERSION_ID,
  workflow_def_id: DEF_ID,
  version_number: 2,
  spec: VALID_SPEC,
  lifecycle_state: 'draft',
  approval_state: 'draft',
  parent_version_id: null,
  proposal_source: null,
  proposal_context: null,
  proposal_rationale: null,
  created_by_actor: USER,
  published_at: null,
  changelog: null,
  created_at: new Date('2026-01-01T00:00:00Z'),
  ...overrides,
});

const defRow = (overrides: Partial<Record<string, unknown>> = {}) => ({
  id: DEF_ID,
  tenant_id: TENANT,
  slug: 'wf-test',
  display_name: 'WF Test',
  active_version_id: PRIOR_PUBLISHED_ID,
  rollback_target_id: null,
  ...overrides,
});

describe('WorkflowsService', () => {
  let service: WorkflowsService;
  let client: { query: jest.Mock; release: jest.Mock };
  let pool: { connect: jest.Mock };
  let audit: { log: jest.Mock };
  let sync: { syncPublishedVersion: jest.Mock };

  beforeEach(async () => {
    client = { query: jest.fn(), release: jest.fn() };
    pool = { connect: jest.fn().mockResolvedValue(client) };
    audit = { log: jest.fn().mockResolvedValue(undefined) };
    sync = { syncPublishedVersion: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WorkflowsService,
        { provide: DATABASE_POOL, useValue: pool },
        { provide: AuditService, useValue: audit },
        { provide: N8nSyncService, useValue: sync },
      ],
    }).compile();
    service = module.get(WorkflowsService);
  });

  describe('createDraft', () => {
    it('rejects when neither workflowDefId nor (slug+displayName) is provided', async () => {
      client.query.mockResolvedValueOnce({ rows: [] }); // set_config
      await expect(
        service.createDraft({ spec: VALID_SPEC }, { tenantId: TENANT, userId: USER }),
      ).rejects.toThrow(BadRequestException);
    });

    it('inserts a fresh def + draft and writes an audit row', async () => {
      client.query
        .mockResolvedValueOnce({ rows: [] }) // set_config
        .mockResolvedValueOnce({ rows: [defRow({ id: DEF_ID })] }) // INSERT workflow_defs
        .mockResolvedValueOnce({ rows: [draftRow()] }); // INSERT workflow_versions

      const result = await service.createDraft(
        { slug: 'wf-new', displayName: 'New WF', spec: VALID_SPEC },
        { tenantId: TENANT, userId: USER },
      );

      expect(result.id).toBe(VERSION_ID);
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: TENANT,
          actorId: USER,
          action: 'workflow.draft.created',
          resourceType: 'workflow_version',
          resourceId: VERSION_ID,
        }),
      );
    });

    it('reuses an existing workflow_def when workflowDefId is provided', async () => {
      client.query
        .mockResolvedValueOnce({ rows: [] }) // set_config
        .mockResolvedValueOnce({ rows: [defRow()] }) // loadDef
        .mockResolvedValueOnce({ rows: [draftRow()] }); // INSERT workflow_versions

      const result = await service.createDraft(
        { workflowDefId: DEF_ID, spec: VALID_SPEC },
        { tenantId: TENANT, userId: USER },
      );
      expect(result.workflow_def_id).toBe(DEF_ID);
    });

    it('404s when workflowDefId does not exist for tenant', async () => {
      client.query
        .mockResolvedValueOnce({ rows: [] }) // set_config
        .mockResolvedValueOnce({ rows: [] }); // loadDef → empty
      await expect(
        service.createDraft(
          { workflowDefId: DEF_ID, spec: VALID_SPEC },
          { tenantId: TENANT, userId: USER },
        ),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('editDraft', () => {
    it('inserts a new draft and supersedes the prior one', async () => {
      const newRow = draftRow({ id: 'new-id', version_number: 3, parent_version_id: VERSION_ID });
      client.query
        .mockResolvedValueOnce({ rows: [] }) // set_config
        .mockResolvedValueOnce({ rows: [draftRow()] }) // loadVersion (prior draft)
        .mockResolvedValueOnce({ rows: [newRow] }) // INSERT new draft
        .mockResolvedValueOnce({ rows: [] }); // UPDATE prior → superseded

      const result = await service.editDraft(
        VERSION_ID,
        { spec: VALID_SPEC, changelog: 'tighten timeouts' },
        { tenantId: TENANT, userId: USER },
      );

      expect(result.id).toBe('new-id');
      expect(result.parent_version_id).toBe(VERSION_ID);
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'workflow.draft.updated',
          metadata: expect.objectContaining({ supersededVersionId: VERSION_ID }),
        }),
      );
    });

    it('refuses to edit a non-draft version', async () => {
      client.query
        .mockResolvedValueOnce({ rows: [] }) // set_config
        .mockResolvedValueOnce({ rows: [draftRow({ lifecycle_state: 'published' })] });
      await expect(
        service.editDraft(
          VERSION_ID,
          { spec: VALID_SPEC },
          { tenantId: TENANT, userId: USER },
        ),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('validateSpec', () => {
    it('returns ok=true + hash for a valid spec', () => {
      const result = service.validateSpec(VALID_SPEC);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.hash).toMatch(/^[a-f0-9]{64}$/);
    });

    it('returns ok=false + structured errors for an invalid spec', () => {
      const result = service.validateSpec({ schemaVersion: '1' });
      expect(result.ok).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });
  });

  describe('publish', () => {
    it('rejects non-admin', async () => {
      await expect(
        service.publish(VERSION_ID, { tenantId: TENANT, userId: USER, role: 'member' }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('rejects when spec fails to compile', async () => {
      client.query
        .mockResolvedValueOnce({ rows: [] }) // set_config
        .mockResolvedValueOnce({ rows: [draftRow({ spec: { schemaVersion: '1' } })] });
      await expect(
        service.publish(VERSION_ID, { tenantId: TENANT, userId: USER, role: 'admin' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('promotes draft, demotes prior published, updates def, syncs n8n, audits', async () => {
      client.query
        .mockResolvedValueOnce({ rows: [] }) // set_config
        .mockResolvedValueOnce({ rows: [draftRow()] }) // loadVersion
        .mockResolvedValueOnce({ rows: [defRow()] }) // loadDef
        .mockResolvedValueOnce({ rows: [] }) // BEGIN
        .mockResolvedValueOnce({ rows: [{ id: PRIOR_PUBLISHED_ID }] }) // demote prior published
        .mockResolvedValueOnce({ rows: [] }) // promote target
        .mockResolvedValueOnce({ rows: [] }) // update def
        .mockResolvedValueOnce({ rows: [] }); // COMMIT

      sync.syncPublishedVersion.mockResolvedValueOnce({
        workflowVersionId: VERSION_ID,
        n8nWorkflowId: 'n8n-1',
        n8nErrorWorkflowId: 'n8n-err-1',
        canonicalHash: 'h',
        action: 'created',
      });

      const result = await service.publish(VERSION_ID, {
        tenantId: TENANT,
        userId: USER,
        role: 'admin',
      });

      expect(result.workflowVersionId).toBe(VERSION_ID);
      expect(result.syncAction).toBe('created');
      expect(sync.syncPublishedVersion).toHaveBeenCalledWith(VERSION_ID, TENANT, USER);
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'workflow.published',
          metadata: expect.objectContaining({ priorActiveId: PRIOR_PUBLISHED_ID }),
        }),
      );
    });

    it('surfaces 502 with audit metadata when n8n sync fails post-commit', async () => {
      client.query
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [draftRow()] })
        .mockResolvedValueOnce({ rows: [defRow()] })
        .mockResolvedValueOnce({ rows: [] }) // BEGIN
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] }); // COMMIT

      sync.syncPublishedVersion.mockRejectedValueOnce(new Error('n8n unreachable'));

      await expect(
        service.publish(VERSION_ID, { tenantId: TENANT, userId: USER, role: 'admin' }),
      ).rejects.toThrow(BadGatewayException);

      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'workflow.published',
          metadata: expect.objectContaining({ syncError: 'n8n unreachable' }),
        }),
      );
    });
  });

  describe('rollback', () => {
    it('rejects non-admin', async () => {
      await expect(
        service.rollback(DEF_ID, { tenantId: TENANT, userId: USER, role: 'member' }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('400s when no rollback target is recorded', async () => {
      client.query
        .mockResolvedValueOnce({ rows: [] }) // set_config
        .mockResolvedValueOnce({ rows: [defRow({ rollback_target_id: null })] });
      await expect(
        service.rollback(DEF_ID, { tenantId: TENANT, userId: USER, role: 'admin' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('swaps active and rollback target, demotes current, re-syncs', async () => {
      const NEW_ACTIVE = '66666666-6666-6666-6666-666666666666';
      const CURRENT_ACTIVE = VERSION_ID;
      client.query
        .mockResolvedValueOnce({ rows: [] }) // set_config
        .mockResolvedValueOnce({
          rows: [defRow({ active_version_id: CURRENT_ACTIVE, rollback_target_id: NEW_ACTIVE })],
        })
        .mockResolvedValueOnce({ rows: [] }) // BEGIN
        .mockResolvedValueOnce({ rows: [] }) // promote target
        .mockResolvedValueOnce({ rows: [] }) // demote current
        .mockResolvedValueOnce({ rows: [] }) // update def
        .mockResolvedValueOnce({ rows: [] }); // COMMIT

      sync.syncPublishedVersion.mockResolvedValueOnce({
        workflowVersionId: NEW_ACTIVE,
        n8nWorkflowId: 'n8n-rb',
        n8nErrorWorkflowId: '',
        canonicalHash: 'h',
        action: 'updated',
      });

      const result = await service.rollback(DEF_ID, {
        tenantId: TENANT,
        userId: USER,
        role: 'admin',
      });
      expect(result.rolledBackTo).toBe(NEW_ACTIVE);
      expect(result.demoted).toBe(CURRENT_ACTIVE);
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'workflow.rolled_back' }),
      );
    });
  });

  describe('diff', () => {
    it('returns an empty patch when both version_numbers resolve to identical specs', async () => {
      const fromRow = { ...draftRow({ version_number: 1, id: 'v1' }), spec: VALID_SPEC };
      const toRow = { ...draftRow({ version_number: 2, id: 'v2' }), spec: VALID_SPEC };
      client.query
        .mockResolvedValueOnce({ rows: [] }) // set_config
        .mockResolvedValueOnce({ rows: [draftRow()] }) // loadVersion anchor
        .mockResolvedValueOnce({ rows: [fromRow, toRow] }); // both versions

      const result = await service.diff(VERSION_ID, 1, 2, { tenantId: TENANT, userId: USER });
      expect(result.patch).toEqual([]);
      expect(result.fromHash).toBe(result.toHash);
    });

    it('404s when a requested version_number is missing', async () => {
      client.query
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [draftRow()] })
        .mockResolvedValueOnce({ rows: [] }); // neither version found

      await expect(
        service.diff(VERSION_ID, 1, 2, { tenantId: TENANT, userId: USER }),
      ).rejects.toThrow(NotFoundException);
    });
  });
});
