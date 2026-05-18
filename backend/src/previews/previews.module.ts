import { Module } from '@nestjs/common';
import { DatabaseModule } from '@/database/database.module';
import { AuditModule } from '@/audit/audit.module';
import { RunsModule } from '@/runs/runs.module';
import { AgentPreviewSpawnerService } from './agent-preview-spawner.service';
import { NeonApiClient } from './neon-api.client';
import { RenderApiClient } from './render-api.client';
import { PreviewTtlService } from './preview-ttl.service';

/**
 * Phase 2.5b — preview environment provisioning for agent-initiated previews.
 *
 * PR-driven previews are NOT routed through this module — they live entirely
 * in `.github/workflows/pr-preview.yml` and the `preview_environments` table
 * row for a PR is INSERTed by the workflow via `psql`. Both surfaces share
 * the same table; the `source` column discriminates.
 *
 * Depends on RunsModule for `SseSubscriberService` (single LISTEN client,
 * second channel `workflow_proposals` — see migration 014 and Phase 2.5a).
 */
@Module({
  imports: [DatabaseModule, AuditModule, RunsModule],
  providers: [AgentPreviewSpawnerService, NeonApiClient, RenderApiClient, PreviewTtlService],
})
export class PreviewsModule {}
