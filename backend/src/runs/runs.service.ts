import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Pool, PoolClient } from 'pg';
import { DATABASE_POOL } from '@/database/database.module';
import { AuditService } from '@/audit/audit.service';
import {
  N8nExecutionAdapter,
  N8nExecutionError,
} from '@/workflows/adapters/n8n/n8n-execution.adapter';
import { CreateWorkflowRunDto, WorkflowRun } from './dto/workflow-run.dto';
import { StepRun } from './dto/step-run.dto';

export interface WorkflowRunWithRollup {
  run: WorkflowRun;
  steps: StepRun[];
  counts: { pending: number; running: number; succeeded: number; failed: number };
}

export interface RunActor {
  userId?: string;
  serviceAccountId?: string;
}

@Injectable()
export class RunsService {
  private readonly logger = new Logger(RunsService.name);

  constructor(
    @Inject(DATABASE_POOL) private readonly pool: Pool,
    private readonly audit: AuditService,
    private readonly executionAdapter: N8nExecutionAdapter,
  ) {}

  /**
   * Creates a workflow_runs row, asks the n8n adapter to start the execution,
   * then stashes the provider's executionId on the run.
   *
   * Ordering is load-bearing: the INSERT must be **committed** before we call
   * the n8n adapter. n8n turns around and POSTs `__start_ping` back into our
   * webhook controller almost immediately; those callbacks open a fresh DB
   * connection and `SELECT FROM workflow_runs WHERE id = ...`, which can't
   * see uncommitted rows across transactions and would drop the ping
   * (`malformed payload` path).
   *
   * Failure mode: if the n8n trigger fails after the run has been
   * committed, we mark the run `failed` in a follow-up txn rather than
   * orphaning a pending row. The audit log breadcrumb survives even when
   * the trigger blows up.
   */
  async create(
    dto: CreateWorkflowRunDto,
    tenantId: string,
    actor: RunActor,
  ): Promise<WorkflowRun> {
    // Phase 1: validate + commit the run row so n8n callbacks can see it.
    const insertedRun = await this.insertPendingRun(dto, tenantId);

    // Phase 2: fire the trigger OUTSIDE the txn. If it fails, mark the run
    // failed and rethrow.
    let trigger;
    try {
      trigger = await this.executionAdapter.triggerExecution({
        workflowVersionId: dto.workflowVersionId,
        tenantId,
        runId: insertedRun.id,
        input: dto.input,
      });
    } catch (err) {
      this.logger.warn(
        `n8n trigger failed for run ${insertedRun.id}; marking failed: ${(err as Error).message}`,
      );
      await this.markRunFailed(insertedRun.id, tenantId, err as Error);
      if (err instanceof N8nExecutionError) {
        this.logger.warn(`run create failed: ${err.code} ${err.message}`);
      }
      throw err;
    }

    // Phase 3: stash the provider id + audit, in a small follow-up txn.
    return this.stashProviderAndAudit(insertedRun.id, tenantId, dto, actor, trigger);
  }

  private async insertPendingRun(
    dto: CreateWorkflowRunDto,
    tenantId: string,
  ): Promise<WorkflowRun> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);

      const versionRes = await client.query(
        `SELECT v.id
           FROM workflow_versions v
           JOIN workflow_defs d ON d.id = v.workflow_def_id
          WHERE v.id = $1
            AND d.tenant_id = $2
            AND v.lifecycle_state = 'published'
          LIMIT 1`,
        [dto.workflowVersionId, tenantId],
      );
      if (versionRes.rows.length === 0) {
        throw new NotFoundException(
          `published workflow_version ${dto.workflowVersionId} not found for this tenant`,
        );
      }

      const insertRes = await client.query(
        `INSERT INTO workflow_runs
            (tenant_id, workflow_version_id, conversation_id, task_graph_id, execution_engine, status, input)
         VALUES ($1, $2, $3, $4, $5, 'pending', $6)
         RETURNING *`,
        [
          tenantId,
          dto.workflowVersionId,
          dto.conversationId ?? null,
          dto.taskGraphId ?? null,
          dto.executionEngine ?? 'n8n_queue',
          dto.input ?? {},
        ],
      );

      await client.query('COMMIT');
      return mapRow(insertRes.rows[0]);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  private async stashProviderAndAudit(
    runId: string,
    tenantId: string,
    dto: CreateWorkflowRunDto,
    actor: RunActor,
    trigger: { providerExecutionId: string; n8nWorkflowId: string },
  ): Promise<WorkflowRun> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);

      const stashed = await client.query(
        `UPDATE workflow_runs
            SET input = jsonb_set(coalesce(input, '{}'::jsonb), '{__provider}', $2::jsonb, true),
                updated_at = now()
          WHERE id = $1
        RETURNING *`,
        [
          runId,
          JSON.stringify({
            providerExecutionId: trigger.providerExecutionId,
            n8nWorkflowId: trigger.n8nWorkflowId,
          }),
        ],
      );

      await this.audit.log(
        {
          tenantId,
          actorId: actor.userId ?? actor.serviceAccountId,
          actorType: actor.userId ? 'user' : 'service_account',
          action: 'workflow.run.started',
          resourceType: 'workflow_run',
          resourceId: runId,
          metadata: {
            workflowVersionId: dto.workflowVersionId,
            providerExecutionId: trigger.providerExecutionId,
            n8nWorkflowId: trigger.n8nWorkflowId,
          },
        },
        client,
      );

      await client.query('COMMIT');
      return mapRow(stashed.rows[0]);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  private async markRunFailed(runId: string, tenantId: string, cause: Error): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
      await client.query(
        `UPDATE workflow_runs
            SET status = 'failed',
                completed_at = COALESCE(completed_at, now()),
                error_details = $2,
                updated_at = now()
          WHERE id = $1
            AND status NOT IN ('cancelled', 'succeeded', 'failed')`,
        [runId, { reason: 'trigger_failed', message: cause.message }],
      );
      await this.audit.log(
        {
          tenantId,
          actorType: 'system',
          action: 'workflow.run.trigger_failed',
          resourceType: 'workflow_run',
          resourceId: runId,
          metadata: { message: cause.message, name: cause.name },
        },
        client,
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      this.logger.warn(`failed to mark run ${runId} as failed: ${(err as Error).message}`);
    } finally {
      client.release();
    }
  }

  async getWithRollup(id: string, tenantId: string): Promise<WorkflowRunWithRollup> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);

      const runRes = await client.query(
        `SELECT * FROM workflow_runs WHERE id = $1 LIMIT 1`,
        [id],
      );
      if (runRes.rows.length === 0) {
        throw new NotFoundException(`workflow_run ${id} not found`);
      }
      const run = mapRow(runRes.rows[0]);

      const stepsRes = await client.query(
        `SELECT * FROM step_runs WHERE workflow_run_id = $1 ORDER BY created_at ASC`,
        [id],
      );
      const steps = stepsRes.rows.map(mapStepRow);

      const counts = { pending: 0, running: 0, succeeded: 0, failed: 0 };
      for (const s of steps) {
        if (s.status in counts) (counts as Record<string, number>)[s.status]++;
      }

      await client.query('COMMIT');
      return { run, steps, counts };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Cooperative cancellation. Flips status to 'cancelled' iff the run is still
   * in pending/running — protects against a `workflow.completed` arriving
   * after a user cancel from being silently undone. The actual halt happens
   * inside n8n: the next `__pre_*` ping reads the new status and routes to
   * the synthetic `__end_cancelled` node.
   */
  async cancel(id: string, tenantId: string, actor: RunActor): Promise<{ cancelled: boolean }> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);

      const upd = await client.query(
        `UPDATE workflow_runs
            SET status = 'cancelled', updated_at = now()
          WHERE id = $1 AND status IN ('pending', 'running')
        RETURNING id, input`,
        [id],
      );

      if (upd.rows.length === 0) {
        // Either not found or already terminal. Distinguish for the API:
        const exists = await client.query(`SELECT 1 FROM workflow_runs WHERE id = $1`, [id]);
        await client.query('COMMIT');
        if (exists.rows.length === 0) {
          throw new NotFoundException(`workflow_run ${id} not found`);
        }
        return { cancelled: false };
      }

      const providerExecutionId =
        upd.rows[0].input?.__provider?.providerExecutionId ?? null;

      await this.audit.log(
        {
          tenantId,
          actorId: actor.userId ?? actor.serviceAccountId,
          actorType: actor.userId ? 'user' : 'service_account',
          action: 'workflow.run.cancelled',
          resourceType: 'workflow_run',
          resourceId: id,
          metadata: { providerExecutionId },
        },
        client,
      );

      await client.query('COMMIT');
      return { cancelled: true };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
}

const mapRow = (row: Record<string, any>): WorkflowRun => ({
  id: row.id,
  tenantId: row.tenant_id,
  workflowVersionId: row.workflow_version_id,
  conversationId: row.conversation_id ?? undefined,
  taskGraphId: row.task_graph_id ?? undefined,
  executionEngine: row.execution_engine,
  status: row.status,
  input: row.input ?? {},
  output: row.output ?? undefined,
  errorDetails: row.error_details ?? undefined,
  startedAt: row.started_at ?? undefined,
  completedAt: row.completed_at ?? undefined,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const mapStepRow = (row: Record<string, any>): StepRun => ({
  id: row.id,
  workflowRunId: row.workflow_run_id,
  stepKey: row.step_key,
  stepName: row.step_name,
  status: row.status,
  input: row.input ?? undefined,
  output: row.output ?? undefined,
  errorDetails: row.error_details ?? undefined,
  startedAt: row.started_at ?? undefined,
  completedAt: row.completed_at ?? undefined,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

// PoolClient is used implicitly via audit.log signature; keep import live.
export type { PoolClient };
