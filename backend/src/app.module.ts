import { Module, MiddlewareConsumer, NestModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ThrottlerModule } from '@nestjs/throttler';
import { DatabaseModule } from './database/database.module';
import { HealthModule } from './health/health.module';
import { AuthModule } from './auth/auth.module';
import { TenantsModule } from './tenants/tenants.module';
import { AuditModule } from './audit/audit.module';
import { StorageModule } from './storage/storage.module';
import { WorkflowsModule } from './workflows/workflows.module';
import { TenantMiddleware } from './auth/tenant.middleware';

// WorkflowsModule is imported unconditionally so its controllers are
// reflected in /api/docs everywhere (the previous import-time gate on
// WORKFLOW_CONTROL_PLANE_ENABLED hid the route from the OpenAPI spec on
// the Render preview). The "feature flag" intent of ADR-0002 is enforced
// at runtime instead: N8nWebhookController returns 401 without
// N8N_WEBHOOK_SECRET, and N8nSyncService.syncPublishedVersion throws via
// requiredEnv() if the adapter env vars aren't set. Per NestJS docs
// (openapi/introduction): "the SwaggerModule automatically reflects all
// of your endpoints" — which it can only do for controllers in the
// application graph. Removing the import gate puts the controller in the
// graph everywhere; runtime config decides whether it does anything.
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: '.env' }),
    ThrottlerModule.forRoot([{ ttl: 60, limit: 100 }]),
    DatabaseModule,
    HealthModule,
    AuthModule,
    TenantsModule,
    AuditModule,
    StorageModule,
    WorkflowsModule,
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(TenantMiddleware).forRoutes('*');
  }
}
