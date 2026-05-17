import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
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
  private readonly logger = new Logger(ProposalsService.name);

  constructor(
    @Inject(DATABASE_POOL) private readonly pool: Pool,
    private readonly audit: AuditService,
  ) {}

  /**
   * Land an agent-authored draft. Implements ARCHITECTURE.md §3 Class C:
   * - Validate the canonical spec via the 2.2 compiler.
   * - Verify the parent version is published or superseded (drafts can't
   *   be patched-from).
   * - When stepRunId/workflowRunId is supplied, verify it belongs to the
   *   caller tenant AND is a step of a run of *this workflow_def*. This
   *   keeps the failure → draft audit linkage trustworthy — without it a
   *   caller could attach any random uuid.
   * - Insert a draft `workflow_versions` row carrying `proposal_source`,
   *   `proposal_context`, `proposal_rationale`, `parent_version_id`,
   *   `created_by_actor`.
   * - Write the audit event with `resource_id = newDraftVersionId` using
   *   the same client/transaction so the draft + audit succeed or fail
   *   together.
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
      // The contract documents parentVersionId as "the published version
      // this patch derives from". Accept published OR superseded (covers
      // the race window where parent got superseded between when the agent
      // saw it and when the proposal arrived). Reject draft/rejected.
      const parent = await client.query(
        `SELECT v.id, v.lifecycle_state
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
      const parentState = parent.rows[0].lifecycle_state;
      if (parentState !== 'published' && parentState !== 'superseded') {
        throw new BadRequestException(
          `parent workflow_version ${input.parentVersionId} is in state '${parentState}'; proposals can only derive from published (or formerly published) versions`,
        );
      }

      // Verify stepRunId / workflowRunId ownership so the audit linkage
      // can't be spoofed across tenants or against an unrelated workflow.
      if (input.stepRunId) {
        const r = await client.query(
          `SELECT sr.status, wr.id AS run_id, wr.tenant_id, wv.workflow_def_id
             FROM step_runs sr
             JOIN workflow_runs wr ON wr.id = sr.workflow_run_id
             JOIN workflow_versions wv ON wv.id = wr.workflow_version_id
            WHERE sr.id = $1
            LIMIT 1`,
          [input.stepRunId],
        );
        if (
          r.rows.length === 0 ||
          r.rows[0].tenant_id !== ctx.tenantId ||
          r.rows[0].workflow_def_id !== input.workflowDefId
        ) {
          throw new NotFoundException(
            `step_run ${input.stepRunId} not found for this tenant + workflow_def`,
          );
        }
        if (input.workflowRunId && r.rows[0].run_id !== input.workflowRunId) {
          throw new BadRequestException(
            `step_run ${input.stepRunId} does not belong to workflow_run ${input.workflowRunId}`,
          );
        }
        if (r.rows[0].status !== 'failed') {
          throw new BadRequestException(
            `step_run ${input.stepRunId} is in status '${r.rows[0].status}'; failure_recovery proposals must reference a failed step`,
          );
        }
      } else if (input.workflowRunId) {
        const r = await client.query(
          `SELECT wr.id, wr.tenant_id, wv.workflow_def_id
             FROM workflow_runs wr
             JOIN workflow_versions wv ON wv.id = wr.workflow_version_id
            WHERE wr.id = $1
            LIMIT 1`,
          [input.workflowRunId],
        );
        if (
          r.rows.length === 0 ||
          r.rows[0].tenant_id !== ctx.tenantId ||
          r.rows[0].workflow_def_id !== input.workflowDefId
        ) {
          throw new NotFoundException(
            `workflow_run ${input.workflowRunId} not found for this tenant + workflow_def`,
          );
        }
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

      // Audit lives on the same client so the draft + audit row either both
      // commit or both roll back. Without this, a failed audit insert would
      // leave a draft without the failure-linkage the endpoint is supposed
      // to guarantee.
      await this.audit.log(
        {
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
        },
        client,
      );

      return row;
    });
  }

  /**
   * See WorkflowsService.withTenantClient — same pattern: transaction-local
   * tenant context (`is_local=true`), auto-ROLLBACK on throw so a failed
   * draft insert never leaves the pooled connection in an aborted state or
   * with `app.tenant_id` leaking to the next borrower.
   */
  private async withTenantClient<T>(
    tenantId: string,
    fn: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch (rbErr) {
        this.logger.error('ROLLBACK failed in withTenantClient', rbErr);
      }
      throw err;
    } finally {
      client.release();
    }
  }
}
