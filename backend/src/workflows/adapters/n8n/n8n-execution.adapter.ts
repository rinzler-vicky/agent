import { Injectable, Inject, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';
import { DATABASE_POOL } from '@/database/database.module';
import { N8nApiClient, N8nApiError } from './n8n-api.client';
import type { N8nCompiledArtifact } from './types';

export interface TriggerExecutionParams {
  workflowVersionId: string;
  tenantId: string;
  runId: string;
  input?: Record<string, unknown>;
}

export interface TriggerExecutionResult {
  providerExecutionId: string;
  n8nWorkflowId: string;
}

export class N8nExecutionError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'N8nExecutionError';
  }
}

/**
 * Starts an n8n execution for a published workflow_version. Looks up the
 * cached `workflow_adapter_artifacts.artifact.n8nWorkflowId` written by
 * `N8nSyncService.syncPublishedVersion`, then calls
 * `POST /workflows/:id/run`. The trigger body is consumed by the manual
 * trigger node injected at compile time (`n8n-compiler.ts`).
 *
 * Phase 2.5a does NOT implement adapter-side cancel: n8n's
 * `POST /executions/:id/stop` returns 404 in v1.79.0
 * (https://github.com/n8n-io/n8n/issues/14748). Cancellation is cooperative
 * via the compiler's per-step `__pre_*` ping which reads
 * `workflow_runs.status` and short-circuits when cancelled.
 */
@Injectable()
export class N8nExecutionAdapter {
  private readonly logger = new Logger(N8nExecutionAdapter.name);
  private readonly triggerTimeoutMs: number;
  private readonly listFallbackDelayMs: number;

  constructor(
    @Inject(DATABASE_POOL) private readonly pool: Pool,
    @Inject(ConfigService) config: ConfigService,
    private readonly api: N8nApiClient,
  ) {
    this.triggerTimeoutMs = Number(config.get<string>('N8N_TRIGGER_TIMEOUT_MS') ?? '10000');
    this.listFallbackDelayMs = Number(
      config.get<string>('N8N_TRIGGER_LIST_FALLBACK_DELAY_MS') ?? '500',
    );
  }

  async triggerExecution(params: TriggerExecutionParams): Promise<TriggerExecutionResult> {
    const { workflowVersionId, tenantId, runId, input } = params;

    const n8nWorkflowId = await this.lookupN8nWorkflowId(workflowVersionId);
    if (!n8nWorkflowId) {
      throw new N8nExecutionError(
        'artifact_not_synced',
        `no workflow_adapter_artifacts row for workflow_version ${workflowVersionId} (workflow must be published first)`,
      );
    }

    let response: { executionId?: string };
    try {
      response = await this.api.runWorkflow(
        n8nWorkflowId,
        { runId, tenantId, input: input ?? {} },
        this.triggerTimeoutMs,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new N8nExecutionError('trigger_failed', `n8n /workflows/${n8nWorkflowId}/run failed: ${msg}`);
    }

    if (response.executionId) {
      return { providerExecutionId: response.executionId, n8nWorkflowId };
    }

    // Fallback: n8n returned 2xx but no executionId. Give n8n a beat to record
    // the execution, then ask for the newest one for this workflow id. The
    // run we just started should be the most recent.
    this.logger.warn(
      `n8n /workflows/${n8nWorkflowId}/run returned no executionId; falling back to listExecutions`,
    );
    await delay(this.listFallbackDelayMs);

    let fallbackExecutions: { id: string }[] = [];
    try {
      fallbackExecutions = await this.api.listExecutions({ workflowId: n8nWorkflowId, limit: 1 });
    } catch (err) {
      if (!(err instanceof N8nApiError)) throw err;
      throw new N8nExecutionError(
        'execution_id_lookup_failed',
        `n8n run accepted but executionId fallback failed: ${err.message}`,
      );
    }

    const newest = fallbackExecutions[0];
    if (!newest?.id) {
      throw new N8nExecutionError(
        'execution_id_missing',
        `n8n run accepted but no executionId could be resolved for workflow ${n8nWorkflowId}`,
      );
    }
    return { providerExecutionId: newest.id, n8nWorkflowId };
  }

  private async lookupN8nWorkflowId(workflowVersionId: string): Promise<string | null> {
    const res = await this.pool.query(
      `SELECT artifact FROM workflow_adapter_artifacts
       WHERE workflow_version_id = $1 AND adapter_type = 'n8n' LIMIT 1`,
      [workflowVersionId],
    );
    if (res.rows.length === 0) return null;
    const artifact = res.rows[0].artifact as N8nCompiledArtifact;
    return artifact.n8nWorkflowId ?? null;
  }
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
