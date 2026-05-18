import { Module } from '@nestjs/common';
import { AuditModule } from '@/audit/audit.module';
import { AuthModule } from '@/auth/auth.module';
import { WorkflowsModule } from '@/workflows/workflows.module';
import { RunsController } from './runs.controller';
import { RunsService } from './runs.service';

/**
 * Phase 2.5a — workflow execution engine on top of the n8n adapter.
 *
 * Wires `POST/GET/cancel /v1/workflow-runs`. SSE event streaming and the
 * failure → proposal_triggers hook land in later slices of the same PR.
 *
 * Imports WorkflowsModule for `N8nExecutionAdapter` so we share the single
 * adapter instance with WorkflowsModule rather than provisioning a duplicate.
 */
@Module({
  imports: [AuditModule, AuthModule, WorkflowsModule],
  controllers: [RunsController],
  providers: [RunsService],
  exports: [RunsService],
})
export class RunsModule {}
