import {
  Body,
  Controller,
  Headers,
  HttpCode,
  Logger,
  Post,
  UnauthorizedException,
  Inject,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ApiTags,
  ApiOperation,
  ApiHeader,
  ApiBody,
  ApiOkResponse,
  ApiUnauthorizedResponse,
  ApiExtraModels,
  getSchemaPath,
} from '@nestjs/swagger';
import { Pool, PoolClient } from 'pg';
import { v5 as uuidv5, validate as uuidValidate } from 'uuid';
import { DATABASE_POOL } from '@/database/database.module';
import { AuditService } from '@/audit/audit.service';
import { verifyStaticSecret, isFresh, SECRET_HEADER } from './hmac';
import { N8nApiClient } from './n8n-api.client';
import type { N8nWebhookEvent } from './types';
import { WEBHOOK_EVENT_TYPES } from './types';
import { N8nWebhookEventDto, N8nWebhookResponseDto } from './n8n-webhook.dto';

const DEDUPE_NAMESPACE = '7a7c4f1e-3b9e-4f5a-9e3d-c1b2a3d4e5f6';

// Derived from WEBHOOK_EVENT_TYPES (types.ts) — single source of truth shared
// by the type union and this runtime allow-list.
const ALLOWED_EVENTS = new Set<string>(WEBHOOK_EVENT_TYPES);

@ApiTags('n8n-webhooks')
@ApiExtraModels(N8nWebhookEventDto, N8nWebhookResponseDto)
@Controller({ path: 'n8n/webhooks', version: '1' })
export class N8nWebhookController {
  private readonly logger = new Logger(N8nWebhookController.name);
  private readonly webhookSecret: string;
  private readonly clockSkewSeconds: number;

  constructor(
    @Inject(DATABASE_POOL) private readonly pool: Pool,
    @Inject(ConfigService) config: ConfigService,
    private readonly api: N8nApiClient,
    private readonly audit: AuditService,
  ) {
    this.webhookSecret = config.get<string>('N8N_WEBHOOK_SECRET') ?? '';
    this.clockSkewSeconds = Number(config.get<string>('N8N_WEBHOOK_CLOCK_SKEW_S') ?? '300');
  }

  @Post('execution')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Receive an execution event from n8n',
    description:
      'Inbound endpoint that n8n calls from injected `__pre_*`, `__post_*`, `__start_ping`, and `__end_ping` HTTP Request nodes (and from the shared error-trigger workflow). Verifies a static shared secret, checks timestamp freshness, deduplicates via a uuidv5 key, sets the tenant RLS context from the signed payload, then upserts `step_runs` and appends to `run_events`. Idempotent on repeated deliveries. Always returns 200 on accepted (n8n retries on non-2xx).',
  })
  @ApiHeader({
    name: SECRET_HEADER,
    description: 'Shared secret (matches `N8N_WEBHOOK_SECRET`). Verified with constant-time comparison.',
    required: true,
  })
  @ApiBody({ type: N8nWebhookEventDto })
  @ApiOkResponse({
    description: 'Event accepted (or deduplicated).',
    schema: { $ref: getSchemaPath(N8nWebhookResponseDto) },
  })
  @ApiUnauthorizedResponse({
    description: 'Missing/invalid secret, malformed payload, non-UUID identifiers, or timestamp outside the freshness window.',
  })
  async receive(
    @Headers(SECRET_HEADER) secretHeader: string | undefined,
    @Body() body: N8nWebhookEvent,
  ): Promise<{ ok: true; deduped?: boolean; cancelled?: boolean }> {
    if (!verifyStaticSecret(secretHeader, this.webhookSecret)) {
      throw new UnauthorizedException('Invalid webhook secret');
    }
    if (!body || typeof body !== 'object' || !body.event) {
      throw new UnauthorizedException('Malformed payload');
    }
    if (!ALLOWED_EVENTS.has(body.event)) {
      throw new UnauthorizedException('Unsupported event type');
    }
    if (!isFresh(body.timestamp, this.clockSkewSeconds)) {
      throw new UnauthorizedException('Stale timestamp');
    }

    // The error workflow's Error Trigger cannot access the main workflow's
    // trigger input, so workflow.failed events arrive without runId/tenantId.
    // They are valid: route them to the audit log only and return 200.
    // Phase 2.4 will add an n8n_execution_id column to workflow_runs (pre-
    // recorded at trigger time) so failure events can be associated with
    // the originating run inside the proper tenant context.
    if (body.event === 'workflow.failed' && (!body.runId || !body.tenantId)) {
      await this.audit.log({
        actorType: 'system',
        action: 'n8n.webhook.failure_unassociated',
        resourceType: 'n8n_execution',
        resourceId: body.n8nExecutionId ?? 'unknown',
        metadata: {
          event: body.event,
          n8nExecutionId: body.n8nExecutionId,
          payload: body.payload ?? null,
        },
      });
      // No run context → cannot evaluate cancel state. Default false.
      return { ok: true, cancelled: false };
    }

    if (!body.runId || !body.tenantId) {
      throw new UnauthorizedException('Malformed payload');
    }
    if (!uuidValidate(body.tenantId) || !uuidValidate(body.runId)) {
      throw new UnauthorizedException('Invalid runId or tenantId');
    }
    // step.started/step.completed write to step_runs.step_key (NOT NULL).
    // Validate here so a malformed ping is rejected with 401 rather than
    // reaching the DB and returning a 500 that triggers n8n retries.
    if ((body.event === 'step.started' || body.event === 'step.completed') && !body.stepKey) {
      throw new UnauthorizedException('stepKey is required for step events');
    }

    const eventId = uuidv5(
      `${body.runId}|${body.stepKey ?? ''}|${body.event}|${body.timestamp}`,
      DEDUPE_NAMESPACE,
    );

    let cancelled = false;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // set_config with is_local=true is equivalent to SET LOCAL but accepts a
      // bind parameter, which SET LOCAL does not support.
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [body.tenantId]);

      // Serialize concurrent deliveries with the same event_id so the
      // SELECT-then-INSERT below is effectively atomic without needing a
      // new UNIQUE index (which would require a migration). The lock is
      // held for the transaction's lifetime and released automatically.
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [eventId]);

      const existing = await client.query(
        `SELECT 1 FROM run_events WHERE event_data->>'event_id' = $1 LIMIT 1`,
        [eventId],
      );
      if (existing.rows.length > 0) {
        // Even on dedup we must surface the current cancel state so the
        // compiler-injected pre-ping can short-circuit on retry deliveries.
        cancelled = await this.isCancelled(client, body.runId);
        await client.query('COMMIT');
        return { ok: true, deduped: true, cancelled };
      }

      await this.applyEvent(client, body, eventId);
      cancelled = await this.isCancelled(client, body.runId);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    if (
      (body.event === 'workflow.completed' || body.event === 'workflow.failed') &&
      body.n8nExecutionId
    ) {
      void this.reconcile(body).catch((err) =>
        this.logger.warn(`reconcile failed for run ${body.runId}: ${err.message}`),
      );
    }

    await this.audit.log({
      tenantId: body.tenantId,
      actorType: 'system',
      action: 'n8n.webhook.received',
      resourceType: 'workflow_run',
      resourceId: body.runId,
      metadata: { event: body.event, stepKey: body.stepKey, n8nExecutionId: body.n8nExecutionId },
    });

    return { ok: true, cancelled };
  }

  /**
   * Phase 2.5a cooperative-cancel signal: returns true iff the run is in
   * `cancelled` status. Called per webhook delivery so the compiler-injected
   * `__pre_*` ping response can drive the per-step `__cancel_check_*` IF.
   * Cheap single-row lookup; relies on RLS scope already set on `client`.
   */
  private async isCancelled(client: PoolClient, runId: string): Promise<boolean> {
    const res = await client.query(
      `SELECT 1 FROM workflow_runs WHERE id = $1 AND status = 'cancelled' LIMIT 1`,
      [runId],
    );
    return res.rows.length > 0;
  }

  private async applyEvent(
    client: PoolClient,
    body: N8nWebhookEvent,
    eventId: string,
  ): Promise<void> {
    let stepRunId: string | null = null;

    if (body.event === 'step.started') {
      const upsert = await client.query(
        `INSERT INTO step_runs (workflow_run_id, step_key, step_name, status, started_at)
         VALUES ($1, $2, $2, 'running', now())
         ON CONFLICT (workflow_run_id, step_key)
         DO UPDATE SET status = 'running', started_at = COALESCE(step_runs.started_at, now()), updated_at = now()
         RETURNING id`,
        [body.runId, body.stepKey],
      );
      stepRunId = upsert.rows[0]?.id ?? null;
    } else if (body.event === 'step.completed') {
      const upsert = await client.query(
        `INSERT INTO step_runs (workflow_run_id, step_key, step_name, status, started_at, completed_at)
         VALUES ($1, $2, $2, 'succeeded', now(), now())
         ON CONFLICT (workflow_run_id, step_key)
         DO UPDATE SET status = 'succeeded', completed_at = now(), updated_at = now()
         RETURNING id`,
        [body.runId, body.stepKey],
      );
      stepRunId = upsert.rows[0]?.id ?? null;
    } else if (body.event === 'workflow.started') {
      // Don't flip cancelled/terminal runs back to running.
      await client.query(
        `UPDATE workflow_runs
           SET status = 'running',
               started_at = COALESCE(started_at, now()),
               updated_at = now()
         WHERE id = $1
           AND status NOT IN ('cancelled', 'succeeded', 'failed')`,
        [body.runId],
      );
    } else if (body.event === 'workflow.completed') {
      // A cancel that fires concurrent with workflow.completed must win:
      // the user asked to cancel and the system acknowledged it.
      await client.query(
        `UPDATE workflow_runs
           SET status = 'succeeded',
               completed_at = now(),
               updated_at = now()
         WHERE id = $1
           AND status NOT IN ('cancelled', 'failed', 'succeeded')`,
        [body.runId],
      );
    } else if (body.event === 'workflow.failed') {
      await client.query(
        `UPDATE workflow_runs
           SET status = 'failed',
               completed_at = now(),
               error_details = $2,
               updated_at = now()
         WHERE id = $1
           AND status NOT IN ('cancelled', 'succeeded', 'failed')`,
        [body.runId, body.payload ?? {}],
      );
    } else if (body.event === 'workflow.cancelled') {
      // Emitted by the compiler-injected __end_cancelled HTTP Request when
      // the per-step IF detects cancel. Idempotent: only stamps completed_at
      // if the run was still pending/running. The cancel endpoint already
      // flipped status to 'cancelled' synchronously; this writes the audit
      // breadcrumb that confirms n8n actually halted.
      await client.query(
        `UPDATE workflow_runs
           SET completed_at = COALESCE(completed_at, now()),
               updated_at = now()
         WHERE id = $1 AND status = 'cancelled'`,
        [body.runId],
      );
    }

    await client.query(
      `INSERT INTO run_events (run_id, event_type, event_data, step_run_id)
       VALUES ($1, $2, $3, $4)`,
      [
        body.runId,
        body.event,
        {
          event_id: eventId,
          stepKey: body.stepKey ?? null,
          n8nExecutionId: body.n8nExecutionId ?? null,
          payload: body.payload ?? null,
        },
        stepRunId,
      ],
    );
  }

  private async reconcile(body: N8nWebhookEvent): Promise<void> {
    if (!body.n8nExecutionId) return;
    const execution = await this.api.getExecution(body.n8nExecutionId);
    if (!execution) return;

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [body.tenantId]);
      await client.query(
        `UPDATE workflow_runs
         SET output = COALESCE(output, $2),
             status = CASE
               WHEN status IN ('succeeded','failed') THEN status
               WHEN $3::boolean THEN 'succeeded'
               ELSE status
             END,
             updated_at = now()
         WHERE id = $1`,
        [body.runId, execution.data ?? {}, !!execution.finished],
      );
      await client.query(
        `INSERT INTO run_events (run_id, event_type, event_data)
         VALUES ($1, 'workflow.reconciled', $2)`,
        [body.runId, { n8nExecutionId: execution.id, finished: execution.finished }],
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
}
