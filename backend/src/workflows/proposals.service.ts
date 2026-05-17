import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Pool, PoolClient } from 'pg';
import { DATABASE_POOL } from '@/database/database.module';
import { AuditService } from '@/audit/audit.service';
import { compile } from '@/workflows/canonical';

interface ProposalInput {
  workflowDefId: string;
  parentVersionId: string;
  spec: Record<string, unknown>;
  stepRunId?: string;
  workflowRunId?: string;
  errorFingerprint?: string;
  rationale?: string;
  changelog?: string;
}

interface ActorCtx {
  tenantId: string;
  serviceAccountId: string;
}

@Injectable()
export class ProposalsService {
  constructor(
    @Inject(DATABASE_POOL) private readonly pool: Pool,
    private readonly audit: AuditService,
  ) {}

  /**
   * Land an agent-authored draft. Implements ARCHITECTURE.md §3 Class C:
   * - Validate the canonical spec via the 2.2 compiler.
   * - Insert a draft `workflow_versions` row carrying `proposal_source`,
   *   `proposal_context`, `proposal_rationale`, `parent_version_id`,
   *   `created_by_actor`.
   * - Write an audit event with `resource_id = newDraftVersionId` so the
   *   failing-step → draft linkage is queryable from the audit log.
   *
   * `proposal_source` is derived: `'failure_recovery'` when stepRunId is
   * provided (the proposal is a reaction to a specific failed step),
   * otherwise `'agent_reflection'` (the proposal is unprompted, e.g. from
   * the Phase 4 planner reviewing recent runs).
   */
  async create(input: ProposalInput, ctx: ActorCtx) {
    const compileResult = compile(input.spec);
    if (!compileResult.ok) {
      throw new BadRequestException({
        message: 'canonical spec failed to compile',
        errors: compileResult.errors,
      });
    }

    return this.withTenantClient(ctx.tenantId, async (client) => {
      // Defense in depth: ensure both def and parent version belong to the
      // caller's tenant. workflow_versions has no RLS — we must JOIN.
      const def = await client.query(
        `SELECT id FROM workflow_defs WHERE id = $1 AND tenant_id = $2 LIMIT 1`,
        [input.workflowDefId, ctx.tenantId],
      );
      if (def.rows.length === 0) {
        throw new NotFoundException(`workflow_def ${input.workflowDefId} not found`);
      }
      const parent = await client.query(
        `SELECT v.id
           FROM workflow_versions v
           JOIN workflow_defs d ON d.id = v.workflow_def_id
          WHERE v.id = $1 AND d.tenant_id = $2 AND v.workflow_def_id = $3
          LIMIT 1`,
        [input.parentVersionId, ctx.tenantId, input.workflowDefId],
      );
      if (parent.rows.length === 0) {
        throw new NotFoundException(
          `parent workflow_version ${input.parentVersionId} not found or does not belong to workflow_def ${input.workflowDefId}`,
        );
      }

      const proposalSource = input.stepRunId ? 'failure_recovery' : 'agent_reflection';
      const proposalContext: Record<string, unknown> = {};
      if (input.workflowRunId) proposalContext.workflowRunId = input.workflowRunId;
      if (input.stepRunId) proposalContext.stepRunId = input.stepRunId;
      if (input.errorFingerprint) proposalContext.errorFingerprint = input.errorFingerprint;

      const inserted = await client.query(
        `INSERT INTO workflow_versions
           (workflow_def_id, spec, lifecycle_state, approval_state,
            created_by_actor, parent_version_id,
            proposal_source, proposal_context, proposal_rationale, changelog)
         VALUES ($1, $2, 'draft', 'draft',
                 $3, $4,
                 $5, $6, $7, $8)
         RETURNING *`,
        [
          input.workflowDefId,
          input.spec,
          ctx.serviceAccountId,
          input.parentVersionId,
          proposalSource,
          proposalContext,
          input.rationale ?? null,
          input.changelog ?? null,
        ],
      );
      const row = inserted.rows[0];

      await this.audit.log({
        tenantId: ctx.tenantId,
        actorId: ctx.serviceAccountId,
        actorType: 'service_account',
        action: 'workflow.proposal.created',
        resourceType: 'workflow_version',
        resourceId: row.id,
        metadata: {
          workflowDefId: input.workflowDefId,
          parentVersionId: input.parentVersionId,
          proposalSource,
          workflowRunId: input.workflowRunId,
          stepRunId: input.stepRunId,
          errorFingerprint: input.errorFingerprint,
          canonicalHash: compileResult.compiled.sourceHash,
        },
      });

      return row;
    });
  }

  private async withTenantClient<T>(
    tenantId: string,
    fn: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("SELECT set_config('app.tenant_id', $1, false)", [tenantId]);
      return await fn(client);
    } finally {
      client.release();
    }
  }
}
