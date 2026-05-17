import { Module } from '@nestjs/common';
import { AuditModule } from '@/audit/audit.module';
import { N8nApiClient } from './adapters/n8n/n8n-api.client';
import { N8nSyncService } from './adapters/n8n/n8n-sync.service';
import { N8nWebhookController } from './adapters/n8n/n8n-webhook.controller';

/**
 * Phase 2 control plane wiring. Gated by WORKFLOW_CONTROL_PLANE_ENABLED.
 * The DatabaseModule (DATABASE_POOL) is registered globally and does not
 * need to be re-imported here.
 */
@Module({
  imports: [AuditModule],
  controllers: [N8nWebhookController],
  providers: [N8nApiClient, N8nSyncService],
  exports: [N8nSyncService],
})
export class WorkflowsModule {}
