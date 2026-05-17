import { Module, MiddlewareConsumer, NestModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ThrottlerModule } from '@nestjs/throttler';
import * as dotenv from 'dotenv';
import { DatabaseModule } from './database/database.module';
import { HealthModule } from './health/health.module';
import { AuthModule } from './auth/auth.module';
import { TenantsModule } from './tenants/tenants.module';
import { AuditModule } from './audit/audit.module';
import { StorageModule } from './storage/storage.module';
import { WorkflowsModule } from './workflows/workflows.module';
import { TenantMiddleware } from './auth/tenant.middleware';

// ConfigModule.forRoot loads .env via NestJS DI — too late for module-level
// constants that are evaluated at import time. Load dotenv explicitly so
// WORKFLOW_CONTROL_PLANE_ENABLED from a local .env file is visible here.
dotenv.config();
const workflowControlPlaneEnabled =
  process.env.WORKFLOW_CONTROL_PLANE_ENABLED === 'true';

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
    ...(workflowControlPlaneEnabled ? [WorkflowsModule] : []),
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(TenantMiddleware).forRoutes('*');
  }
}
