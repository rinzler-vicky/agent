import { Module, MiddlewareConsumer, NestModule } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { DatabaseModule } from './database/database.module';
import { HealthModule } from './health/health.module';
import { AuthModule } from './auth/auth.module';
import { TenantsModule } from './tenants/tenants.module';
import { AuditModule } from './audit/audit.module';
import { StorageModule } from './storage/storage.module';
import { WorkflowsModule } from './workflows/workflows.module';
import { TenantMiddleware } from './auth/tenant.middleware';

// WorkflowsModule is imported unconditionally so SwaggerModule can reflect
// its controllers into /api/docs everywhere. The "feature flag" intent of
// ADR-0002 is enforced at runtime: N8nWebhookController returns 401 without
// N8N_WEBHOOK_SECRET, and N8nSyncService.syncPublishedVersion throws via
// requiredEnv() if its adapter env vars aren't set. See ADR-0002 and the
// header comment on WorkflowsModule for the full rationale.
//
// ThrottlerGuard is bound via APP_GUARD so per-route `@Throttle()` overrides
// (Phase 2.4's stricter 30/min on POST /v1/workflow-proposals) actually
// enforce. Without this binding the decorator metadata is set but no guard
// reads it. ttl is in milliseconds in @nestjs/throttler v6.
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: '.env' }),
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 100 }]),
    DatabaseModule,
    HealthModule,
    AuthModule,
    TenantsModule,
    AuditModule,
    StorageModule,
    WorkflowsModule,
  ],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(TenantMiddleware).forRoutes('*');
  }
}
