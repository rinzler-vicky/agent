import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Pool, PoolClient } from 'pg';
import { createHash } from 'crypto';
import { DATABASE_POOL } from '@/database/database.module';
import { AuditService } from '@/audit/audit.service';
import { N8nApiClient } from '@/workflows/adapters/n8n/n8n-api.client';
import { SseSubscriberService, NotifyPayload } from './sse-subscriber.service';

interface N8nNodeRunData {
  error?: { message?: string; name?: string; description?: string };
  data?: unknown;
}

interface N8nExecutionData {
  resultData?: {
    runData?: Record<string, N8nNodeRunData[]>;
  };
}

/**
 * Phase 2.5a failure → proposal hook.
 *
 * Subscribes to the in-process EventEmitter exposed by SseSubscriberService
 * (so we share the single LISTEN connection — see comment on
 * SseSubscriberService). Filters for `workflow.failed` events that carry a
 * tenant + run id (the audit-only error-workflow path is skipped).
 *
 * For each qualifying failure:
 *   1. Takes a `pg_try_advisory_xact_lock` on `('proposal_trigger_failed:' + run_id)`
 *      so a multi-pod deployment doesn't write duplicate triggers. The
 *      partial unique index on `proposal_triggers` (migration 013) covers
 *      the cross-restart case.
 *   2. Fetches the n8n execution detail via N8nApiClient.getExecution(),
 *      walks `data.resultData.runData` for per-node `error`, and matches
 *      each failed node to a `step_runs` row via `step_key === nodeName`.
 *   3. Computes a small error_fingerprint (sha1 of `name:message`,
 *      truncated to 16 hex chars) and looks up the most recent successful
 *      step's output as `last_successful_checkpoint`.
 *   4. INSERTs one row into `proposal_triggers` per failed node (status
 *      'pending'). The agent worker that drains this queue is deferred to
 *      a follow-up sub-issue.
 *   5. Audits `workflow.run.failure_trigger_created` per row.
 */
@Injectable()
export class FailureHookService implements OnModuleInit {
  private readonly logger = new Logger(FailureHookService.name);

  constructor(
    @Inject(DATABASE_POOL) private readonly pool: Pool,
    private readonly subscriber: SseSubscriberService,
    private readonly api: N8nApiClient,
    private readonly audit: AuditService,
  ) {}

  onModuleInit(): void {
    this.subscriber.notifications.on('event', (payload: NotifyPayload) => {
      if (payload.event_type !== 'workflow.failed') return;
      // Fire-and-forget — log on failure but don't block the LISTEN loop.
      void this.handle(payload).catch((err) =>
        this.logger.warn(`failure hook failed for run ${payload.run_id}: ${(err as Error).message}`),
      );
    });
  }

  private async handle(payload: NotifyPayload): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [payload.tenant_id]);

      const lock = await client.query(
        `SELECT pg_try_advisory_xact_lock(hashtext($1)) AS acquired`,
        [`proposal_trigger_failed:${payload.run_id}`],
      );
      if (!lock.rows[0]?.acquired) {
        this.logger.debug(`another pod is handling failure for run ${payload.run_id}; skipping`);
        await client.query('COMMIT');
        return;
      }

      const runRes = await client.query(
        `SELECT input FROM workflow_runs WHERE id = $1 LIMIT 1`,
        [payload.run_id],
      );
      const providerExecutionId: string | undefined =
        runRes.rows[0]?.input?.__provider?.providerExecutionId;
      if (!providerExecutionId) {
        await this.audit.log(
          {
            tenantId: payload.tenant_id,
            actorType: 'system',
            action: 'failure_hook.skipped_no_provider_id',
            resourceType: 'workflow_run',
            resourceId: payload.run_id,
            metadata: { reason: 'workflow_runs.input.__provider.providerExecutionId missing' },
          },
          client,
        );
        await client.query('COMMIT');
        return;
      }

      const execution = await this.api.getExecution(providerExecutionId);
      const failedNodes = extractFailedNodes(execution?.data as N8nExecutionData | undefined);

      if (failedNodes.length === 0) {
        // Fallback: write a single trigger with no step_run_id so the agent
        // worker still has a record to drain even if n8n's execution detail
        // hasn't fully landed yet. The partial unique index is keyed on
        // COALESCE(step_run_id, zero-uuid), so this is dedupable.
        await this.insertTrigger(client, {
          tenantId: payload.tenant_id,
          workflowRunId: payload.run_id,
          stepRunId: null,
          errorFingerprint: fingerprint('unknown', execution?.status ?? 'failed'),
          triggerContext: {
            reason: 'no per-node error available from n8n execution detail',
            n8n_execution_id: providerExecutionId,
            last_successful_checkpoint: await this.fetchLastCheckpoint(client, payload.run_id),
          },
        });
        await client.query('COMMIT');
        return;
      }

      const lastCheckpoint = await this.fetchLastCheckpoint(client, payload.run_id);

      for (const failed of failedNodes) {
        const stepRunId = await this.findStepRunId(client, payload.run_id, failed.nodeName);
        await this.insertTrigger(client, {
          tenantId: payload.tenant_id,
          workflowRunId: payload.run_id,
          stepRunId,
          errorFingerprint: fingerprint(failed.error.name, failed.error.message),
          triggerContext: {
            failing_step_key: failed.nodeName,
            failing_step_run_id: stepRunId,
            error: failed.error,
            n8n_execution_id: providerExecutionId,
            last_successful_checkpoint: lastCheckpoint,
          },
        });
      }

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  private async insertTrigger(
    client: PoolClient,
    row: {
      tenantId: string;
      workflowRunId: string;
      stepRunId: string | null;
      errorFingerprint: string;
      triggerContext: Record<string, unknown>;
    },
  ): Promise<void> {
    // The partial unique index `idx_proposal_triggers_pending_dedupe`
    // (migration 013) covers the (workflow_run_id, step_run_id,
    // error_fingerprint) tuple for status='pending'. ON CONFLICT DO NOTHING
    // makes the insert idempotent without throwing.
    const res = await client.query(
      `INSERT INTO proposal_triggers
            (tenant_id, workflow_run_id, step_run_id, error_fingerprint, trigger_context, status)
         VALUES ($1, $2, $3, $4, $5, 'pending')
         ON CONFLICT (workflow_run_id, COALESCE(step_run_id, '00000000-0000-0000-0000-000000000000'::uuid), error_fingerprint)
            WHERE status = 'pending'
         DO NOTHING
         RETURNING id`,
      [
        row.tenantId,
        row.workflowRunId,
        row.stepRunId,
        row.errorFingerprint,
        row.triggerContext,
      ],
    );

    if (res.rows.length === 0) return; // already present

    await this.audit.log(
      {
        tenantId: row.tenantId,
        actorType: 'system',
        action: 'workflow.run.failure_trigger_created',
        resourceType: 'proposal_trigger',
        resourceId: res.rows[0].id,
        metadata: {
          workflow_run_id: row.workflowRunId,
          step_run_id: row.stepRunId,
          error_fingerprint: row.errorFingerprint,
        },
      },
      client,
    );
  }

  private async findStepRunId(
    client: PoolClient,
    runId: string,
    stepKey: string,
  ): Promise<string | null> {
    const res = await client.query(
      `SELECT id FROM step_runs WHERE workflow_run_id = $1 AND step_key = $2 LIMIT 1`,
      [runId, stepKey],
    );
    return res.rows[0]?.id ?? null;
  }

  private async fetchLastCheckpoint(
    client: PoolClient,
    runId: string,
  ): Promise<unknown> {
    const res = await client.query(
      `SELECT event_data
         FROM run_events
        WHERE run_id = $1 AND event_type = 'step.completed'
        ORDER BY sequence DESC
        LIMIT 1`,
      [runId],
    );
    return res.rows[0]?.event_data?.payload?.output ?? null;
  }
}

interface FailedNode {
  nodeName: string;
  error: { name: string; message: string };
}

/**
 * Walk n8n's `data.resultData.runData` shape. Each node maps to an array
 * of execution attempts; we collect the latest attempt's error per node.
 * Exported for unit testing.
 */
export function extractFailedNodes(data: N8nExecutionData | undefined): FailedNode[] {
  if (!data?.resultData?.runData) return [];
  const failed: FailedNode[] = [];
  for (const [nodeName, attempts] of Object.entries(data.resultData.runData)) {
    if (!Array.isArray(attempts) || attempts.length === 0) continue;
    const last = attempts[attempts.length - 1];
    if (last?.error?.message) {
      failed.push({
        nodeName,
        error: {
          name: last.error.name ?? 'NodeExecutionError',
          message: last.error.message,
        },
      });
    }
  }
  return failed;
}

function fingerprint(name: string, message: string): string {
  return createHash('sha1').update(`${name}:${message}`).digest('hex').slice(0, 16);
}
