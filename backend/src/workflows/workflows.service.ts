import {
  BadGatewayException,
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Pool, PoolClient } from 'pg';
import { DATABASE_POOL } from '@/database/database.module';
import { AuditService } from '@/audit/audit.service';
import { compile } from '@/workflows/canonical';
import { N8nSyncService } from './adapters/n8n/n8n-sync.service';
import { diffSpecs, type WorkflowDiff } from './diff';

type LifecycleState = 'draft' | 'published' | 'superseded' | 'rejected';

interface WorkflowVersionRow {
  id: string;
  workflow_def_id: string;
  version_number: number;
  spec: Record<string, unknown>;
  lifecycle_state: LifecycleState;
  approval_state: string;
  parent_version_id: string | null;
  proposal_source: string | null;
  proposal_context: Record<string, unknown> | null;
  proposal_rationale: string | null;
  created_by_actor: string | null;
  published_at: Date | null;
  changelog: string | null;
  created_at: Date;
}

interface WorkflowDefRow {
  id: string;
  tenant_id: string;
  slug: string;
  display_name: string;
  active_version_id: string | null;
  rollback_target_id: string | null;
}

interface ActorCtx {
  tenantId: string;
  userId: string;
}

interface CreateDraftInput {
  workflowDefId?: string;
  slug?: string;
  displayName?: string;
  spec: Record<string, unknown>;
  changelog?: string;
}

@Injectable()
export class WorkflowsService {
  private readonly logger = new Logger(WorkflowsService.name);

  constructor(
    @Inject(DATABASE_POOL) private readonly pool: Pool,
    private readonly audit: AuditService,
    private readonly sync: N8nSyncService,
  ) {}

  // -----------------------------------------------------------------
  // Reads
  // -----------------------------------------------------------------

  async getById(versionId: string, ctx: ActorCtx): Promise<WorkflowVersionRow> {
    return this.withTenantClient(ctx.tenantId, async (client) => {
      const version = await this.loadVersion(client, versionId, ctx.tenantId);
      if (!version) {
        throw new NotFoundException(`workflow_version ${versionId} not found`);
      }
      return version;
    });
  }

  async listByDef(defId: string, ctx: ActorCtx): Promise<WorkflowVersionRow[]> {
    return this.withTenantClient(ctx.tenantId, async (client) => {
      const def = await this.loadDef(client, defId, ctx.tenantId);
      if (!def) throw new NotFoundException(`workflow_def ${defId} not found`);
      const res = await client.query(
        `SELECT * FROM workflow_versions WHERE workflow_def_id = $1 ORDER BY version_number DESC`,
        [defId],
      );
      return res.rows as WorkflowVersionRow[];
    });
  }

  // -----------------------------------------------------------------
  // Draft CRUD
  // -----------------------------------------------------------------

  async createDraft(input: CreateDraftInput, ctx: ActorCtx): Promise<WorkflowVersionRow> {
    // We don't pre-compile here — `POST /v1/workflows` is a draft create, so
    // a half-built spec should still land. /validate runs the compiler on demand.
    // The withTenantClient wrapper makes the (optional) def insert + version
    // insert atomic; a failure on the version write rolls back the def insert
    // so we never leave an orphaned workflow_defs row.
    return this.withTenantClient(ctx.tenantId, async (client) => {
      let defId = input.workflowDefId;
      if (!defId) {
        if (!input.slug || !input.displayName) {
          throw new BadRequestException(
            'Either `workflowDefId` or both `slug` and `displayName` are required',
          );
        }
        const def = await client.query<WorkflowDefRow>(
          `INSERT INTO workflow_defs (tenant_id, slug, display_name)
           VALUES ($1, $2, $3)
           RETURNING *`,
          [ctx.tenantId, input.slug, input.displayName],
        );
        defId = def.rows[0].id;
      } else {
        const def = await this.loadDef(client, defId, ctx.tenantId);
        if (!def) {
          throw new NotFoundException(`workflow_def ${defId} not found`);
        }
      }

      const inserted = await client.query<WorkflowVersionRow>(
        `INSERT INTO workflow_versions
           (workflow_def_id, spec, lifecycle_state, approval_state, created_by_actor, changelog)
         VALUES ($1, $2, 'draft', 'draft', $3, $4)
         RETURNING *`,
        [defId, input.spec, ctx.userId, input.changelog ?? null],
      );
      const row = inserted.rows[0];

      await this.audit.log(
        {
          tenantId: ctx.tenantId,
          actorId: ctx.userId,
          actorType: 'user',
          action: 'workflow.draft.created',
          resourceType: 'workflow_version',
          resourceId: row.id,
          metadata: {
            workflowDefId: defId,
            versionNumber: row.version_number,
          },
        },
        client,
      );

      return row;
    });
  }

  /**
   * Edit a draft. `workflow_versions` is immutable, so we insert a NEW draft
   * row carrying the replacement spec and demote the prior draft to
   * `superseded`. The new row gets a new version_number via the existing
   * trigger. Returns the new row (the prior id is now stale on the client).
   * Insert + supersede + audit run inside one transaction (via
   * withTenantClient), so a failure anywhere rolls back all three.
   */
  async editDraft(
    versionId: string,
    input: { spec: Record<string, unknown>; changelog?: string },
    ctx: ActorCtx,
  ): Promise<WorkflowVersionRow> {
    return this.withTenantClient(ctx.tenantId, async (client) => {
      const prior = await this.loadVersion(client, versionId, ctx.tenantId);
      if (!prior) throw new NotFoundException(`workflow_version ${versionId} not found`);
      if (prior.lifecycle_state !== 'draft') {
        throw new BadRequestException(
          `cannot edit ${prior.lifecycle_state} version; only drafts are mutable (via supersede)`,
        );
      }

      const inserted = await client.query<WorkflowVersionRow>(
        `INSERT INTO workflow_versions
           (workflow_def_id, spec, lifecycle_state, approval_state, created_by_actor, changelog, parent_version_id)
         VALUES ($1, $2, 'draft', 'draft', $3, $4, $5)
         RETURNING *`,
        [prior.workflow_def_id, input.spec, ctx.userId, input.changelog ?? null, prior.id],
      );
      const row = inserted.rows[0];

      await client.query(
        `UPDATE workflow_versions SET lifecycle_state = 'superseded' WHERE id = $1`,
        [prior.id],
      );

      await this.audit.log(
        {
          tenantId: ctx.tenantId,
          actorId: ctx.userId,
          actorType: 'user',
          action: 'workflow.draft.updated',
          resourceType: 'workflow_version',
          resourceId: row.id,
          metadata: {
            workflowDefId: prior.workflow_def_id,
            supersededVersionId: prior.id,
            newVersionNumber: row.version_number,
          },
        },
        client,
      );

      return row;
    });
  }

  // -----------------------------------------------------------------
  // Validate
  // -----------------------------------------------------------------

  async validateById(versionId: string, ctx: ActorCtx) {
    const row = await this.getById(versionId, ctx);
    return this.validateSpec(row.spec);
  }

  validateSpec(spec: unknown) {
    const result = compile(spec);
    if (result.ok) {
      return { ok: true as const, errors: [], hash: result.compiled.sourceHash };
    }
    return { ok: false as const, errors: result.errors };
  }

  // -----------------------------------------------------------------
  // Diff
  // -----------------------------------------------------------------

  async diff(
    versionId: string,
    fromVersionNumber: number,
    toVersionNumber: number,
    ctx: ActorCtx,
  ): Promise<WorkflowDiff> {
    return this.withTenantClient(ctx.tenantId, async (client) => {
      const anchor = await this.loadVersion(client, versionId, ctx.tenantId);
      if (!anchor) throw new NotFoundException(`workflow_version ${versionId} not found`);
      const both = await client.query<WorkflowVersionRow>(
        `SELECT * FROM workflow_versions
          WHERE workflow_def_id = $1 AND version_number = ANY($2::int[])`,
        [anchor.workflow_def_id, [fromVersionNumber, toVersionNumber]],
      );
      const from = both.rows.find((r) => r.version_number === fromVersionNumber);
      const to = both.rows.find((r) => r.version_number === toVersionNumber);
      if (!from) throw new NotFoundException(`from version ${fromVersionNumber} not found`);
      if (!to) throw new NotFoundException(`to version ${toVersionNumber} not found`);
      try {
        return diffSpecs(from.spec, to.spec, fromVersionNumber, toVersionNumber);
      } catch (err) {
        // diffSpecs throws a plain Error when either stored spec fails to
        // compile. Drafts intentionally allow invalid specs, so callers
        // diffing a draft against a published row would otherwise see a 500.
        // Translate to 400 with the compiler error string carried through.
        throw new BadRequestException({
          message: 'one or both stored specs failed to compile; cannot diff',
          detail: err instanceof Error ? err.message : String(err),
        });
      }
    });
  }

  // -----------------------------------------------------------------
  // Publish
  // -----------------------------------------------------------------

  /**
   * Promote a draft to `published`. Commit DB state first, then call the
   * n8n adapter — a sync failure surfaces 502 but leaves the audit row in
   * place so the operator can rerun publish or rollback. This mirrors the
   * non-atomic trade-off documented in Phase 2.3 (n8n-sync.service.ts:130).
   *
   * Concurrency: takes `SELECT ... FOR UPDATE` on the workflow_defs row so
   * two simultaneous publishes for the same def serialize. Without the lock,
   * both could read the same `active_version_id`, demote it, and both promote
   * different targets — leaving multiple 'published' rows and a corrupted
   * rollback chain.
   */
  async publish(versionId: string, ctx: ActorCtx & { role: string }) {
    if (ctx.role !== 'admin') throw new ForbiddenException('admin role required to publish');

    const { committed, target, def } = await this.withTenantClient(ctx.tenantId, async (client) => {
      const target = await this.loadVersion(client, versionId, ctx.tenantId);
      if (!target) throw new NotFoundException(`workflow_version ${versionId} not found`);
      if (target.lifecycle_state !== 'draft') {
        throw new BadRequestException(
          `cannot publish a ${target.lifecycle_state} version; only drafts are publishable`,
        );
      }

      const compileResult = compile(target.spec);
      if (!compileResult.ok) {
        throw new BadRequestException({
          message: 'spec failed to compile',
          errors: compileResult.errors,
        });
      }

      const def = await this.loadDef(client, target.workflow_def_id, ctx.tenantId, true);
      if (!def) {
        // Should be impossible after loadVersion succeeded, but the FK leaves
        // it nominally reachable — fail closed.
        throw new NotFoundException('workflow_def disappeared mid-publish');
      }

      // Demote prior published of the same def (there can be only one
      // 'published' row per def at a time — enforced by the def-row lock
      // above plus this UPDATE inside the same txn).
      const prior = await client.query<WorkflowVersionRow>(
        `UPDATE workflow_versions
            SET lifecycle_state = 'superseded'
          WHERE workflow_def_id = $1 AND lifecycle_state = 'published'
          RETURNING *`,
        [target.workflow_def_id],
      );

      await client.query(
        `UPDATE workflow_versions
            SET lifecycle_state = 'published', published_at = now(), approval_state = 'approved'
          WHERE id = $1`,
        [target.id],
      );

      const priorActive = def.active_version_id;
      await client.query(
        `UPDATE workflow_defs
            SET active_version_id = $1, rollback_target_id = $2, updated_at = now()
          WHERE id = $3`,
        [target.id, priorActive, def.id],
      );

      return {
        committed: { priorActiveId: priorActive, priorRows: prior.rows },
        target,
        def,
      };
    });

    // Sync n8n AFTER the DB commit, mirroring 2.3's non-atomic trade-off.
    // Keep audit-write OUTSIDE the sync try block: an audit failure after a
    // successful sync should not be misreported as a sync failure.
    let syncResult;
    try {
      syncResult = await this.sync.syncPublishedVersion(target.id, ctx.tenantId, ctx.userId);
    } catch (err) {
      this.logger.error(
        `n8n sync failed for workflow_version ${target.id}; DB state already published`,
        err,
      );
      // Best-effort failure audit; we still throw 502 regardless.
      await this.audit
        .log({
          tenantId: ctx.tenantId,
          actorId: ctx.userId,
          actorType: 'user',
          action: 'workflow.published',
          resourceType: 'workflow_version',
          resourceId: target.id,
          metadata: {
            workflowDefId: def.id,
            versionNumber: target.version_number,
            priorActiveId: committed.priorActiveId,
            syncError: err instanceof Error ? err.message : String(err),
          },
        })
        .catch((auditErr) =>
          this.logger.error('failed to write publish failure audit row', auditErr),
        );
      throw new BadGatewayException(
        `workflow published in DB but n8n sync failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    // Sync succeeded. Audit-write failure here must NOT bubble as a sync
    // failure to the caller — log and swallow.
    try {
      await this.audit.log({
        tenantId: ctx.tenantId,
        actorId: ctx.userId,
        actorType: 'user',
        action: 'workflow.published',
        resourceType: 'workflow_version',
        resourceId: target.id,
        metadata: {
          workflowDefId: def.id,
          versionNumber: target.version_number,
          priorActiveId: committed.priorActiveId,
          syncAction: syncResult.action,
          n8nWorkflowId: syncResult.n8nWorkflowId,
          canonicalHash: syncResult.canonicalHash,
        },
      });
    } catch (auditErr) {
      this.logger.error('publish success audit write failed; sync already succeeded', auditErr);
    }

    return {
      workflowVersionId: target.id,
      syncAction: syncResult.action,
      n8nWorkflowId: syncResult.n8nWorkflowId,
      canonicalHash: syncResult.canonicalHash,
    };
  }

  // -----------------------------------------------------------------
  // Rollback
  // -----------------------------------------------------------------

  /**
   * Restore the workflow_def to its prior published version. Driven by
   * `workflow_defs.rollback_target_id`, set by `publish()`. Re-runs n8n sync
   * for the new active so the remote stays consistent. Same FOR UPDATE lock
   * pattern as publish to keep the rollback chain consistent under concurrency.
   */
  async rollback(defId: string, ctx: ActorCtx & { role: string }) {
    if (ctx.role !== 'admin') throw new ForbiddenException('admin role required to rollback');

    const { newActive, demoted } = await this.withTenantClient(ctx.tenantId, async (client) => {
      const def = await this.loadDef(client, defId, ctx.tenantId, true);
      if (!def) throw new NotFoundException(`workflow_def ${defId} not found`);
      const rollbackTargetId = def.rollback_target_id;
      if (!rollbackTargetId) {
        throw new BadRequestException('no rollback target recorded for this workflow_def');
      }
      const currentActiveId = def.active_version_id;

      // Promote the rollback target back to 'published'.
      await client.query(
        `UPDATE workflow_versions
            SET lifecycle_state = 'published', published_at = now()
          WHERE id = $1`,
        [rollbackTargetId],
      );
      // Demote the previously active version to 'superseded' (if it differs
      // from the rollback target).
      if (currentActiveId && currentActiveId !== rollbackTargetId) {
        await client.query(
          `UPDATE workflow_versions
              SET lifecycle_state = 'superseded'
            WHERE id = $1`,
          [currentActiveId],
        );
      }
      // Swap the def pointers: new active = rollback target, new rollback
      // target = the version we just demoted.
      await client.query(
        `UPDATE workflow_defs
            SET active_version_id = $1, rollback_target_id = $2, updated_at = now()
          WHERE id = $3`,
        [rollbackTargetId, currentActiveId, def.id],
      );

      return { newActive: rollbackTargetId, demoted: currentActiveId };
    });

    let syncResult;
    try {
      syncResult = await this.sync.syncPublishedVersion(newActive, ctx.tenantId, ctx.userId);
    } catch (err) {
      await this.audit
        .log({
          tenantId: ctx.tenantId,
          actorId: ctx.userId,
          actorType: 'user',
          action: 'workflow.rolled_back',
          resourceType: 'workflow_version',
          resourceId: newActive,
          metadata: {
            workflowDefId: defId,
            fromVersionId: demoted,
            toVersionId: newActive,
            syncError: err instanceof Error ? err.message : String(err),
          },
        })
        .catch((auditErr) =>
          this.logger.error('failed to write rollback failure audit row', auditErr),
        );
      throw new BadGatewayException(
        `rollback persisted in DB but n8n re-sync failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    try {
      await this.audit.log({
        tenantId: ctx.tenantId,
        actorId: ctx.userId,
        actorType: 'user',
        action: 'workflow.rolled_back',
        resourceType: 'workflow_version',
        resourceId: newActive,
        metadata: {
          workflowDefId: defId,
          fromVersionId: demoted,
          toVersionId: newActive,
          syncAction: syncResult.action,
        },
      });
    } catch (auditErr) {
      this.logger.error('rollback success audit write failed; sync already succeeded', auditErr);
    }

    return {
      rolledBackTo: newActive,
      demoted: demoted ?? '',
      syncAction: syncResult.action,
    };
  }

  // -----------------------------------------------------------------
  // Tenant-scoped client helper
  // -----------------------------------------------------------------

  /**
   * Acquire a pg client, open a transaction, set the per-tenant session
   * variable as TRANSACTION-LOCAL, run `fn`, COMMIT (or ROLLBACK on throw),
   * release the client. The `is_local=true` arg to set_config is critical:
   * without it the value persists for the session, leaking the tenant
   * context to the next request that borrows this pooled connection.
   *
   * RLS on `workflow_defs` (and other tenant-scoped tables) reads
   * `app.tenant_id` via `current_setting`. `workflow_versions` itself has no
   * RLS — every read joins through `workflow_defs` and asserts tenant_id
   * explicitly (see `loadVersion`).
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
        // ROLLBACK failure shouldn't mask the original throw, but log it so
        // we don't lose visibility into broken pooled connections.
        this.logger.error('ROLLBACK failed in withTenantClient', rbErr);
      }
      throw err;
    } finally {
      client.release();
    }
  }

  private async loadVersion(
    client: PoolClient,
    versionId: string,
    tenantId: string,
  ): Promise<WorkflowVersionRow | null> {
    const res = await client.query<WorkflowVersionRow>(
      `SELECT v.*
         FROM workflow_versions v
         JOIN workflow_defs d ON d.id = v.workflow_def_id
        WHERE v.id = $1 AND d.tenant_id = $2
        LIMIT 1`,
      [versionId, tenantId],
    );
    return res.rows[0] ?? null;
  }

  private async loadDef(
    client: PoolClient,
    defId: string,
    tenantId: string,
    forUpdate = false,
  ): Promise<WorkflowDefRow | null> {
    const res = await client.query<WorkflowDefRow>(
      `SELECT * FROM workflow_defs WHERE id = $1 AND tenant_id = $2 LIMIT 1${
        forUpdate ? ' FOR UPDATE' : ''
      }`,
      [defId, tenantId],
    );
    return res.rows[0] ?? null;
  }
}
