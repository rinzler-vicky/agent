import { Module } from '@nestjs/common';
import { TenantsController } from './tenants.controller';
import { TenantsService } from './tenants.service';
import { RolesGuard } from '../auth/roles.guard';

@Module({
  controllers: [TenantsController],
  providers: [TenantsService, RolesGuard],
  exports: [TenantsService],
})
export class TenantsModule {}
