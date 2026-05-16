import { Controller, Get } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { HealthService } from './health.service';

@ApiTags('health')
@Controller({ path: 'health', version: '1' })
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  @Get()
  @ApiOperation({ summary: 'Health check' })
  check() {
    return this.healthService.check();
  }

  @Get('version')
  @ApiOperation({ summary: 'API version info' })
  version() {
    return this.healthService.version();
  }
}
