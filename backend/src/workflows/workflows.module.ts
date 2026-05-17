import { Module } from '@nestjs/common';
import { AuditModule } from '@/audit/audit.module';
import { N8nApiClient } from './adapters/n8n/n8n-api.client';
import { N8nSyncService } from './adapters/n8n/n8n-sync.service';
import { N8nWebhookController } from './adapters/n8n/n8n-webhook.controller';

/**
 * Phase 2 control plane wiring. Imported unconditionally so the n8n webhook
 * route appears in /api/docs everywhere; the controller answers 401 by
 * default (no N8N_WEBHOOK_SECRET) and N8nSyncService throws via
 * requiredEnv() if its adapter env vars are unset, so the "feature flag"
 * intent of ADR-0002 is enforced at runtime rather than at module-import
 * time. The DatabaseModule (DATABASE_POOL) is global and need not be
 * re-imported here.
 */
@Module({
  imports: [AuditModule],
  controllers: [N8nWebhookController],
  providers: [N8nApiClient, N8nSyncService],
  exports: [N8nSyncService],
})
export class WorkflowsModule {}
