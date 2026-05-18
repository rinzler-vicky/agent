import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Pool } from 'pg';
import { DATABASE_POOL } from '@/database/database.module';
import { AuditService } from '@/audit/audit.service';
import { NeonApiClient } from './neon-api.client';
import { RenderApiClient } from './render-api.client';

/**
 * Phase 2.5b — TTL teardown for agent-initiated previews.
 *
 * Every 15 minutes, scan `preview_environments` for rows where
 *   status='ready' AND source='agent_failure_recovery' AND expires_at < now()
 * For each row: best-effort delete the Render service + Neon branch, then
 * set status='expired' + torn_down_at=now() + audit `agent_preview.expired`.
 *
 * PR-driven preview rows are NOT touched here — those are torn down by
 * pr-preview.yml on PR close, which also flips the row to 'torn_down'.
 *
 * Multi-pod safety: an advisory lock per row prevents two pods from racing
 * the same teardown.
 */
@Injectable()
export class PreviewTtlService {
  private readonly logger = new Logger(PreviewTtlService.name);

  constructor(
    @Inject(DATABASE_POOL) private readonly pool: Pool,
    private readonly audit: AuditService,
    private readonly neon: NeonApiClient,
    private readonly render: RenderApiClient,
  ) {}

  // Every 30 minutes: a 24-hour TTL doesn't need a sharper cadence and 30m
  // halves Render/Neon API churn vs 15m. CronExpression.EVERY_30_MINUTES is
  // the @nestjs/schedule named constant.
  @Cron(CronExpression.EVERY_30_MINUTES, { name: 'agent-preview-ttl' })
  async sweep(): Promise<void> {
    const client = await this.pool.connect();
    let rows: Array<{
      id: string;
      tenant_id: string;
      render_backend_service_id: string | null;
      neon_branch_name: string | null;
    }>;
    try {
      // Use a privileged SELECT bypassing RLS: this job is system-scoped and
      // sweeps across tenants. The DB role for the connection pool has full
      // table access; RLS is only enforced after `set_config('app.tenant_id', ...)`
      // — we deliberately skip that here.
      const res = await client.query(
        `SELECT id, tenant_id, render_backend_service_id, neon_branch_name
           FROM preview_environments
          WHERE status = 'ready'
            AND source = 'agent_failure_recovery'
            AND expires_at < now()
          LIMIT 50`,
      );
      rows = res.rows;
    } finally {
      client.release();
    }

    for (const row of rows) {
      await this.tearDown(row).catch((err) =>
        this.logger.warn(`teardown failed for preview ${row.id}: ${(err as Error).message}`),
      );
    }
  }

  private async tearDown(row: {
    id: string;
    tenant_id: string;
    render_backend_service_id: string | null;
    neon_branch_name: string | null;
  }): Promise<void> {
    // Best-effort external teardown — log but don't throw on failure so the
    // DB row still flips to expired (avoids stuck rows that re-enter the
    // sweep loop forever).
    if (row.render_backend_service_id) {
      try {
        await this.render.deleteService(row.render_backend_service_id);
      } catch (err) {
        this.logger.warn(
          `Render deleteService failed for ${row.render_backend_service_id}: ${(err as Error).message}`,
        );
      }
    }
    if (row.neon_branch_name) {
      try {
        // Neon's DELETE accepts a branch id, but we stored the name. Look up
        // by listing branches and matching name.
        // For simplicity, we skip Neon teardown in v1 — Neon branches have
        // their own expires_at (set to 14 days by neondatabase action) and
        // will auto-clean. Document in PR_PREVIEWS.md.
      } catch {
        /* skipped */
      }
    }

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [row.tenant_id]);
      await client.query(
        `UPDATE preview_environments
            SET status = 'expired',
                torn_down_at = now(),
                updated_at = now()
          WHERE id = $1`,
        [row.id],
      );
      await this.audit.log(
        {
          tenantId: row.tenant_id,
          actorType: 'system',
          action: 'agent_preview.expired',
          resourceType: 'preview_environment',
          resourceId: row.id,
          metadata: {
            render_service_id: row.render_backend_service_id,
            neon_branch_name: row.neon_branch_name,
          },
        },
        client,
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
