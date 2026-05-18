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
 * Every 30 minutes, call the SECURITY DEFINER helper
 * `get_expired_agent_previews()` (migration 014) which returns expired
 * agent-driven rows across all tenants — the function bypasses the
 * preview_environments RLS policy legitimately because it's owned by the
 * table owner and `FORCE ROW LEVEL SECURITY` is not set on the table.
 *
 * For each row: best-effort delete the Render service + Neon branch, then
 * flip status='expired' + torn_down_at=now() + audit `agent_preview.expired`.
 * External calls swallow errors so a row that fails external teardown still
 * flips to `expired` and doesn't re-enter the sweep loop forever.
 *
 * PR-driven preview rows are NOT touched here — those are torn down by
 * pr-preview.yml on PR close, which flips the row to 'torn_down'.
 *
 * Multi-pod safety: in practice we run a single replica; if that changes,
 * add `pg_try_advisory_xact_lock(hashtext(row.id))` around the per-row
 * UPDATE block.
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

  // Every 30 minutes: a 24-hour default TTL doesn't need a sharper cadence
  // and 30m halves Render/Neon API churn vs 15m.
  @Cron(CronExpression.EVERY_30_MINUTES, { name: 'agent-preview-ttl' })
  async sweep(): Promise<void> {
    const client = await this.pool.connect();
    let rows: Array<{
      id: string;
      tenant_id: string;
      render_backend_service_id: string | null;
      neon_branch_id: string | null;
      neon_branch_name: string | null;
    }>;
    try {
      // SECURITY DEFINER helper bypasses RLS legitimately (see migration 014
      // comment block). The function's WHERE predicate is hard-locked to
      // agent_failure_recovery + ready + expired, so this call cannot be
      // widened by callers.
      const res = await client.query(`SELECT * FROM get_expired_agent_previews()`);
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
    neon_branch_id: string | null;
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
    if (row.neon_branch_id) {
      try {
        await this.neon.deleteBranch(row.neon_branch_id);
      } catch (err) {
        this.logger.warn(
          `Neon deleteBranch failed for ${row.neon_branch_id}: ${(err as Error).message}`,
        );
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
            neon_branch_id: row.neon_branch_id,
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
