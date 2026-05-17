import { Module } from '@nestjs/common';
import { AuditModule } from '@/audit/audit.module';
import { AuthModule } from '@/auth/auth.module';
import { N8nApiClient } from './adapters/n8n/n8n-api.client';
import { N8nSyncService } from './adapters/n8n/n8n-sync.service';
import { N8nWebhookController } from './adapters/n8n/n8n-webhook.controller';
import { WorkflowsController } from './workflows.controller';
import { WorkflowsService } from './workflows.service';
import { ProposalsController } from './proposals.controller';
import { ProposalsService } from './proposals.service';
import { ServiceAccountThrottlerGuard } from './guards/service-account-throttler.guard';

/**
 * Phase 2 control plane wiring. Imported unconditionally so the n8n webhook
 * route appears in /api/docs everywhere; the controller answers 401 by
 * default (no N8N_WEBHOOK_SECRET) and N8nSyncService throws via
 * requiredEnv() if its adapter env vars are unset, so the "feature flag"
 * intent of ADR-0002 is enforced at runtime rather than at module-import
 * time. The DatabaseModule (DATABASE_POOL) is global and need not be
 * re-imported here.
 *
 * Phase 2.4 adds the human draft/lifecycle controller (WorkflowsController)
 * and the agent-facing proposal controller (ProposalsController). AuthModule
 * is imported so JwtAuthGuard / RolesGuard / JwtModule (used by
 * ServiceAccountScopeGuard) resolve via DI.
 */
@Module({
  imports: [AuditModule, AuthModule],
  controllers: [N8nWebhookController, WorkflowsController, ProposalsController],
  providers: [
    N8nApiClient,
    N8nSyncService,
    WorkflowsService,
    ProposalsService,
    ServiceAccountThrottlerGuard,
  ],
  exports: [N8nSyncService, WorkflowsService, ProposalsService],
})
export class WorkflowsModule {}
