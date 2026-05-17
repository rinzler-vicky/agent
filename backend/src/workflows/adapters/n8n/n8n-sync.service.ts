import { Injectable, Inject, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';
import { DATABASE_POOL } from '@/database/database.module';
import { AuditService } from '@/audit/audit.service';
import { compile } from '@/workflows/canonical';
import { compileToN8n } from './n8n-compiler';
import { N8nApiClient, N8nApiError } from './n8n-api.client';
import type { N8nCompiledArtifact } from './types';

export interface SyncResult {
  workflowVersionId: string;
  n8nWorkflowId: string;
  n8nErrorWorkflowId: string;
  canonicalHash: string;
  action: 'skipped' | 'created' | 'updated' | 'recreated';
}

@Injectable()
export class N8nSyncService {
  private readonly logger = new Logger(N8nSyncService.name);

  constructor(
    @Inject(DATABASE_POOL) private readonly pool: Pool,
    @Inject(ConfigService) private readonly config: ConfigService,
    private readonly api: N8nApiClient,
    private readonly audit: AuditService,
  ) {}

  /**
   * Compile a published workflow_version, push it to n8n, cache the compiled
   * artifact in workflow_adapter_artifacts. Idempotent: same canonical input
   * + same cached hash → no remote write. Different hash → PUT. Cached
   * n8nWorkflowId returns 404 from n8n → POST + cache update (covers the
   * "delete + republish reproduces it" AC).
   */
  async syncPublishedVersion(
    workflowVersionId: string,
    tenantId: string,
    actorId: string | undefined,
  ): Promise<SyncResult> {
    const started = Date.now();

    const versionRow = await this.loadVersion(workflowVersionId, tenantId);
    if (!versionRow) {
      throw new Error(`workflow_version ${workflowVersionId} not found for tenant ${tenantId}`);
    }

    const canonical = compile(versionRow.spec);
    if (!canonical.ok) {
      throw new Error(
        `canonical compile failed: ${canonical.errors.map((e) => e.code).join(', ')}`,
      );
    }

    const artifact = compileToN8n(canonical.compiled, {
      workflowName: `wf-${workflowVersionId}`,
      webhookBaseUrl: this.requiredEnv('N8N_WEBHOOK_BASE_URL'),
      webhookSecret: this.requiredEnv('N8N_WEBHOOK_SECRET'),
      workflowVersionId,
      tenantId,
      errorWorkflowName: `wf-${workflowVersionId}__error`,
    });

    const cached = await this.loadCachedArtifact(workflowVersionId);
    let action: SyncResult['action'];
    let n8nWorkflowId: string;
    let n8nErrorWorkflowId: string;

    if (cached && cached.canonicalHash === artifact.canonicalHash && cached.n8nWorkflowId) {
      // Verify BOTH the main workflow and the error workflow still exist.
      // If only the main is checked, a deleted error workflow leaves
      // settings.errorWorkflow pointing at a stale id and failure callbacks
      // stop working — the pair must be in sync.
      const [remoteMain, remoteError] = await Promise.all([
        this.api.getWorkflow(cached.n8nWorkflowId),
        // If n8nErrorWorkflowId is absent the error workflow was never synced;
        // treat it as missing (null) so the pair is recreated together.
        cached.n8nErrorWorkflowId
          ? this.api.getWorkflow(cached.n8nErrorWorkflowId)
          : Promise.resolve(null),
      ]);
      if (remoteMain && remoteError) {
        action = 'skipped';
        n8nWorkflowId = cached.n8nWorkflowId;
        n8nErrorWorkflowId = cached.n8nErrorWorkflowId ?? '';
      } else {
        ({ n8nWorkflowId, n8nErrorWorkflowId } = await this.pushFresh(artifact));
        action = 'recreated';
      }
    } else if (cached && cached.n8nWorkflowId) {
      // Upsert error workflow FIRST so the main update can reference its id;
      // otherwise we'd PUT a payload whose settings.errorWorkflow is the
      // workflow name and clobber the existing valid reference.
      const errorWfId =
        (await this.upsertErrorWorkflow(artifact, cached.n8nErrorWorkflowId)) ?? '';
      try {
        const updated = await this.api.updateWorkflow(cached.n8nWorkflowId, {
          ...artifact.workflow,
          settings: { ...artifact.workflow.settings, errorWorkflow: errorWfId },
        });
        await this.api.activateWorkflow(updated.id);
        n8nWorkflowId = updated.id;
        n8nErrorWorkflowId = errorWfId;
        action = 'updated';
      } catch (err) {
        if (err instanceof N8nApiError && err.status === 404) {
          // Main workflow gone on the remote side. The error workflow was
          // just upserted above; reuse its id and only create a new main.
          const mainWf = await this.api.createWorkflow({
            ...artifact.workflow,
            settings: { ...artifact.workflow.settings, errorWorkflow: errorWfId },
          });
          await this.api.activateWorkflow(mainWf.id);
          n8nWorkflowId = mainWf.id;
          n8nErrorWorkflowId = errorWfId;
          action = 'recreated';
        } else {
          throw err;
        }
      }
    } else {
      ({ n8nWorkflowId, n8nErrorWorkflowId } = await this.pushFresh(artifact));
      action = 'created';
    }

    await this.saveArtifact(workflowVersionId, {
      ...artifact,
      n8nWorkflowId,
      n8nErrorWorkflowId,
      compiledAt: new Date().toISOString(),
    });

    await this.audit.log({
      tenantId,
      actorId,
      actorType: actorId ? 'service_account' : 'system',
      action: 'workflow.synced',
      resourceType: 'workflow_version',
      resourceId: workflowVersionId,
      metadata: {
        n8nWorkflowId,
        n8nErrorWorkflowId,
        canonicalHash: artifact.canonicalHash,
        action,
        durationMs: Date.now() - started,
      },
    });

    return {
      workflowVersionId,
      n8nWorkflowId,
      n8nErrorWorkflowId,
      canonicalHash: artifact.canonicalHash,
      action,
    };
  }

  private async pushFresh(
    artifact: N8nCompiledArtifact,
  ): Promise<{ n8nWorkflowId: string; n8nErrorWorkflowId: string }> {
    const errorWf = await this.api.createWorkflow(artifact.errorWorkflow);
    const mainWf = await this.api.createWorkflow({
      ...artifact.workflow,
      settings: { ...artifact.workflow.settings, errorWorkflow: errorWf.id },
    });
    await this.api.activateWorkflow(mainWf.id);
    return { n8nWorkflowId: mainWf.id, n8nErrorWorkflowId: errorWf.id };
  }

  private async upsertErrorWorkflow(
    artifact: N8nCompiledArtifact,
    existingId: string | undefined,
  ): Promise<string | undefined> {
    if (!existingId) {
      const created = await this.api.createWorkflow(artifact.errorWorkflow);
      return created.id;
    }
    try {
      const updated = await this.api.updateWorkflow(existingId, artifact.errorWorkflow);
      return updated.id;
    } catch (err) {
      if (err instanceof N8nApiError && err.status === 404) {
        const created = await this.api.createWorkflow(artifact.errorWorkflow);
        return created.id;
      }
      throw err;
    }
  }

  private async loadVersion(
    workflowVersionId: string,
    tenantId: string,
  ): Promise<{ spec: unknown } | null> {
    // RLS hardening: workflow_versions itself has no RLS (only workflow_defs
    // does, per migration 004:101-113). Join through workflow_defs and
    // require an explicit tenant_id match so a caller with a leaked version
    // UUID from another tenant cannot read it. SET LOCAL keeps the defense
    // in depth via RLS on workflow_defs.
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // set_config with is_local=true is equivalent to SET LOCAL but accepts a
      // bind parameter, which SET LOCAL does not support.
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
      const res = await client.query(
        `SELECT v.spec
           FROM workflow_versions v
           JOIN workflow_defs d ON d.id = v.workflow_def_id
          WHERE v.id = $1
            AND d.tenant_id = $2
          LIMIT 1`,
        [workflowVersionId, tenantId],
      );
      await client.query('COMMIT');
      if (res.rows.length === 0) return null;
      return { spec: res.rows[0].spec };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  private async loadCachedArtifact(
    workflowVersionId: string,
  ): Promise<N8nCompiledArtifact | null> {
    const res = await this.pool.query(
      `SELECT artifact FROM workflow_adapter_artifacts
       WHERE workflow_version_id = $1 AND adapter_type = 'n8n' LIMIT 1`,
      [workflowVersionId],
    );
    if (res.rows.length === 0) return null;
    return res.rows[0].artifact as N8nCompiledArtifact;
  }

  private async saveArtifact(
    workflowVersionId: string,
    artifact: N8nCompiledArtifact,
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO workflow_adapter_artifacts (workflow_version_id, adapter_type, artifact, compiled_at)
       VALUES ($1, 'n8n', $2, now())
       ON CONFLICT (workflow_version_id, adapter_type)
       DO UPDATE SET artifact = EXCLUDED.artifact, compiled_at = now()`,
      [workflowVersionId, artifact],
    );
  }

  private requiredEnv(name: string): string {
    const v = this.config.get<string>(name);
    if (!v) throw new Error(`Missing required env var: ${name}`);
    return v;
  }
}
