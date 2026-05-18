import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Request } from 'express';
import { JwtAuthGuard } from '@/auth/jwt-auth.guard';
import { RolesGuard } from '@/auth/roles.guard';
import { Roles } from '@/auth/roles.decorator';
import { RunsService, WorkflowRunWithRollup } from './runs.service';
import { CreateWorkflowRunDto, WorkflowRun } from './dto/workflow-run.dto';

interface AuthedRequest extends Request {
  user?: {
    sub: string;
    tenantId: string;
    role?: string;
    type: 'user' | 'service_account';
  };
}

const requireTenant = (req: AuthedRequest): { tenantId: string; actorId: string; type: 'user' | 'service_account' } => {
  if (!req.user?.sub || !req.user?.tenantId) {
    throw new BadRequestException('authenticated context is missing');
  }
  return { tenantId: req.user.tenantId, actorId: req.user.sub, type: req.user.type };
};

@ApiTags('workflow-runs')
@ApiBearerAuth()
@Controller({ path: 'workflow-runs', version: '1' })
@UseGuards(JwtAuthGuard, RolesGuard)
export class RunsController {
  constructor(private readonly runs: RunsService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Start a workflow run',
    description:
      'Creates a workflow_runs row and triggers execution in n8n via the published artifact. ' +
      'Returns the run with the provider executionId stashed in `input.__provider`. ' +
      'The workflow_version must be in lifecycle_state=published.',
  })
  @ApiCreatedResponse({ description: 'The newly-created run with provider correlation stored.' })
  async create(@Body() dto: CreateWorkflowRunDto, @Req() req: AuthedRequest): Promise<WorkflowRun> {
    const { tenantId, actorId, type } = requireTenant(req);
    return this.runs.create(dto, tenantId, type === 'user' ? { userId: actorId } : { serviceAccountId: actorId });
  }

  @Get(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Get a workflow run with step rollup',
    description: 'Returns the run, its step_runs ordered by created_at, and a status histogram.',
  })
  @ApiOkResponse({ description: 'Run + steps + counts rollup.' })
  async get(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: AuthedRequest,
  ): Promise<WorkflowRunWithRollup> {
    const { tenantId } = requireTenant(req);
    return this.runs.getWithRollup(id, tenantId);
  }

  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  @Roles('admin')
  @ApiOperation({
    summary: 'Cancel a running workflow (admin only, cooperative)',
    description:
      'Flips workflow_runs.status to "cancelled" iff the run is still pending/running. ' +
      'The n8n execution continues until its next injected `__pre_*` ping reads the new ' +
      'status and routes to `__end_cancelled`. Returns `{ cancelled: true }` if state was ' +
      'changed; `{ cancelled: false }` if the run was already terminal. ' +
      'Note: n8n REST has no hard-stop in v1.79.0 (issue #14748); cancellation is ' +
      'cooperative via the compiler-injected per-step ping.',
  })
  @ApiOkResponse({ description: '{ cancelled: boolean }' })
  async cancel(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: AuthedRequest,
  ): Promise<{ cancelled: boolean }> {
    const { tenantId, actorId, type } = requireTenant(req);
    if (type !== 'user') {
      // Belt-and-braces — @Roles('admin') already requires `role`, which
      // service-account tokens don't carry, so this path is unreachable.
      // The explicit check keeps the intent legible.
      throw new ForbiddenException('cancel is restricted to user tokens with role=admin');
    }
    return this.runs.cancel(id, tenantId, { userId: actorId });
  }
}
