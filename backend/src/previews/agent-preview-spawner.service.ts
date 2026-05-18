import { randomBytes } from 'crypto';
import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';
import { DATABASE_POOL } from '@/database/database.module';
import { AuditService } from '@/audit/audit.service';
import {
  SseSubscriberService,
  WorkflowProposalNotifyPayload,
} from '@/runs/sse-subscriber.service';
import { NeonApiClient } from './neon-api.client';
import { RenderApiClient } from './render-api.client';

const REQUIRED_ENABLED_CONFIG = [
  'RENDER_API_KEY',
  'RENDER_OWNER_ID',
  'RENDER_REPO_URL',
  'RENDER_BASE_BRANCH',
  'NEON_API_KEY',
  'NEON_PROJECT_ID',
] as const;

/**
 * Phase 2.5b — agent-initiated preview spawner.
 *
 * Listens on the in-process EventEmitter exposed by SseSubscriberService
 * (channel `workflow_proposals`, populated by migration 014's AFTER INSERT
 * trigger on workflow_versions). Reacts to proposals with
 * `proposal_source='failure_recovery'` (Phase 2.4 — set by
 * ProposalsController when stepRunId is provided).
 *
 * Pipeline per qualifying notification:
 *   1. Honor `AGENT_PREVIEW_ENABLED` kill switch (default false).
 *   2. `pg_try_advisory_xact_lock` per `version_id` (multi-pod dedupe).
 *   3. COUNT active rows per tenant; if >= `MAX_ACTIVE_AGENT_PREVIEWS_PER_TENANT`
 *      audit `agent_preview.rate_limited` and exit.
 *   4. INSERT `preview_environments` row (`status='pending'`,
 *      `expires_at = now() + interval '24 hours'`). The partial unique index
 *      `idx_preview_environments_active_version` makes this idempotent across
 *      pod restarts.
 *   5. Outside the txn: call Neon createBranch + Render createService for the
 *      backend. (n8n + keyvalue services are NOT created here — Render's
 *      `POST /v1/services` type enum excludes `keyvalue`. PR-driven previews
 *      get the full n8n trio via Blueprint auto-spawn; agent-initiated
 *      previews are backend-only, sufficient for compile/migration/integration
 *      verification of the proposed workflow.)
 *   6. UPDATE row to `ready` with URLs, audit `agent_preview.created`.
 *   7. On any failure during step 5/6: UPDATE `status='failed'`, audit
 *      `agent_preview.failed`. No retry — the next failure of the same run
 *      would emit a new proposal and the spawner runs again.
 */
@Injectable()
export class AgentPreviewSpawnerService implements OnModuleInit {
  private readonly logger = new Logger(AgentPreviewSpawnerService.name);
  private readonly enabled: boolean;
  private readonly maxActivePerTenant: number;
  private readonly ttlHours: number;

  constructor(
    @Inject(DATABASE_POOL) private readonly pool: Pool,
    @Inject(ConfigService) private readonly config: ConfigService,
    private readonly subscriber: SseSubscriberService,
    private readonly audit: AuditService,
    private readonly neon: NeonApiClient,
    private readonly render: RenderApiClient,
  ) {
    this.enabled = (config.get<string>('AGENT_PREVIEW_ENABLED') ?? 'false') === 'true';
    this.maxActivePerTenant = Number(
      config.get<string>('MAX_ACTIVE_AGENT_PREVIEWS_PER_TENANT') ?? '3',
    );
    this.ttlHours = Number(config.get<string>('AGENT_PREVIEW_TTL_HOURS') ?? '24');
  }

  onModuleInit(): void {
    if (this.enabled) {
      // Fail fast at startup if the kill switch is on but required external
      // config is missing — otherwise the first NOTIFY would silently fail
      // mid-pipeline with an opaque Render/Neon 400.
      const missing = REQUIRED_ENABLED_CONFIG.filter(
        (key) => !(this.config.get<string>(key) ?? '').trim(),
      );
      if (missing.length > 0) {
        throw new Error(
          `AGENT_PREVIEW_ENABLED=true but required env vars are missing: ${missing.join(', ')}`,
        );
      }
    }

    this.subscriber.notifications.on(
      'workflow_proposals',
      (payload: WorkflowProposalNotifyPayload) => {
        if (!this.enabled) return;
        if (payload.proposal_source !== 'failure_recovery') return;
        // Fire-and-forget; log on failure but never block the LISTEN loop.
        void this.handle(payload).catch((err) =>
          this.logger.warn(
            `agent preview spawn failed for version ${payload.version_id}: ${(err as Error).message}`,
          ),
        );
      },
    );
  }

  private async handle(payload: WorkflowProposalNotifyPayload): Promise<void> {
    const previewId = await this.reserve(payload);
    if (!previewId) return; // rate-limited, dedup, or insert collision

    try {
      await this.markStatus(previewId, payload.tenant_id, 'provisioning');

      const branchName = `agent-${previewId.slice(0, 8)}`;
      const { branch, connection_uri } = await this.neon.createBranch(branchName);

      const repo = this.config.get<string>('RENDER_REPO_URL') ?? '';
      const baseBranch = this.config.get<string>('RENDER_BASE_BRANCH') ?? 'main';
      const ownerId = this.config.get<string>('RENDER_OWNER_ID') ?? '';

      // backend/src/main.ts hard-fails in production when JWT_SECRET is
      // missing or the documented placeholder. Generate a strong per-preview
      // secret so the spawned service actually boots and waitForServiceUrl
      // returns a healthy URL (no client logs into an agent preview).
      const jwtSecret = randomBytes(48).toString('base64');

      const service = await this.render.createService({
        name: `agent-preview-${previewId.slice(0, 8)}`,
        ownerId,
        type: 'web_service',
        repo,
        branch: baseBranch,
        envVars: [
          { key: 'NODE_ENV', value: 'production' },
          { key: 'DATABASE_URL', value: connection_uri },
          { key: 'DATABASE_SSL', value: 'true' },
          { key: 'JWT_SECRET', value: jwtSecret },
        ],
      });

      const url = await this.render.waitForServiceUrl(service.id);

      await this.complete(previewId, payload.tenant_id, {
        renderServiceId: service.id,
        neonBranchId: branch.id,
        neonBranchName: branch.name,
        previewUrl: url,
      });

      await this.audit.log({
        tenantId: payload.tenant_id,
        actorType: 'system',
        action: 'agent_preview.created',
        resourceType: 'preview_environment',
        resourceId: previewId,
        metadata: {
          workflow_version_id: payload.version_id,
          render_service_id: service.id,
          neon_branch_id: branch.id,
          neon_branch_name: branch.name,
          preview_url: url,
        },
      });
    } catch (err) {
      const message = (err as Error).message;
      await this.markStatus(previewId, payload.tenant_id, 'failed').catch(() => undefined);
      await this.audit.log({
        tenantId: payload.tenant_id,
        actorType: 'system',
        action: 'agent_preview.failed',
        resourceType: 'preview_environment',
        resourceId: previewId,
        metadata: { workflow_version_id: payload.version_id, error: message },
      });
      throw err;
    }
  }

  /**
   * Acquire advisory lock + check rate limit + INSERT pending row, all in
   * one transaction. Returns the new preview_environments id, or null if the
   * spawn was skipped (locked elsewhere, rate-limited, or already exists).
   */
  private async reserve(payload: WorkflowProposalNotifyPayload): Promise<string | null> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [payload.tenant_id]);

      const lock = await client.query(
        `SELECT pg_try_advisory_xact_lock(hashtext($1)) AS acquired`,
        [`agent_preview_spawn:${payload.version_id}`],
      );
      if (!lock.rows[0]?.acquired) {
        await client.query('COMMIT');
        return null;
      }

      const countRes = await client.query(
        `SELECT COUNT(*)::int AS n
           FROM preview_environments
          WHERE tenant_id = $1
            AND source = 'agent_failure_recovery'
            AND status IN ('pending', 'provisioning', 'ready')`,
        [payload.tenant_id],
      );
      const activeCount = countRes.rows[0]?.n ?? 0;
      if (activeCount >= this.maxActivePerTenant) {
        await this.audit.log(
          {
            tenantId: payload.tenant_id,
            actorType: 'system',
            action: 'agent_preview.rate_limited',
            resourceType: 'workflow_version',
            resourceId: payload.version_id,
            metadata: {
              active_count: activeCount,
              cap: this.maxActivePerTenant,
            },
          },
          client,
        );
        await client.query('COMMIT');
        return null;
      }

      // ON CONFLICT predicate must match the partial unique index expression
      // from migration 014 exactly — see comment on
      // idx_preview_environments_active_version.
      const ins = await client.query(
        `INSERT INTO preview_environments
              (tenant_id, workflow_version_id, source, status, expires_at)
            VALUES ($1, $2, 'agent_failure_recovery', 'pending',
                    now() + ($3 || ' hours')::interval)
         ON CONFLICT (workflow_version_id)
           WHERE workflow_version_id IS NOT NULL
             AND status IN ('pending', 'provisioning', 'ready')
         DO NOTHING
         RETURNING id`,
        [payload.tenant_id, payload.version_id, String(this.ttlHours)],
      );

      await client.query('COMMIT');
      return ins.rows[0]?.id ?? null;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  private async markStatus(
    id: string,
    tenantId: string,
    status: 'provisioning' | 'failed',
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
      await client.query(
        `UPDATE preview_environments
            SET status = $2, updated_at = now()
          WHERE id = $1`,
        [id, status],
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  private async complete(
    id: string,
    tenantId: string,
    fields: {
      renderServiceId: string;
      neonBranchId: string;
      neonBranchName: string;
      previewUrl: string;
    },
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
      await client.query(
        `UPDATE preview_environments
            SET status = 'ready',
                render_backend_service_id = $2,
                neon_branch_id = $3,
                neon_branch_name = $4,
                preview_url = $5,
                updated_at = now()
          WHERE id = $1`,
        [
          id,
          fields.renderServiceId,
          fields.neonBranchId,
          fields.neonBranchName,
          fields.previewUrl,
        ],
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }
}
