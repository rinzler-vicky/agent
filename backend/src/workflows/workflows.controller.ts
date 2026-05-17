import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { Request } from 'express';
import { JwtAuthGuard } from '@/auth/jwt-auth.guard';
import { RolesGuard } from '@/auth/roles.guard';
import { Roles } from '@/auth/roles.decorator';
import { WorkflowsService } from './workflows.service';
import {
  CreateWorkflowDraftDto,
  EditWorkflowDraftDto,
  PublishResultDto,
  RollbackResultDto,
  ValidateResultDto,
  WorkflowDiffResponseDto,
  WorkflowVersionResponseDto,
} from './dto/workflow-lifecycle.dto';

interface AuthedRequest extends Request {
  user?: {
    sub: string;
    tenantId: string;
    role: string;
    type: 'user' | 'service_account';
  };
}

const requireTenantUser = (req: AuthedRequest): { tenantId: string; userId: string; role: string } => {
  if (!req.user?.sub || !req.user?.tenantId) {
    throw new BadRequestException('authenticated user context is missing');
  }
  return { tenantId: req.user.tenantId, userId: req.user.sub, role: req.user.role };
};

const toResponseDto = (row: any): WorkflowVersionResponseDto => ({
  id: row.id,
  workflowDefId: row.workflow_def_id,
  versionNumber: row.version_number,
  lifecycleState: row.lifecycle_state,
  approvalState: row.approval_state,
  proposalSource: row.proposal_source ?? undefined,
  parentVersionId: row.parent_version_id ?? undefined,
  proposalContext: row.proposal_context ?? undefined,
  proposalRationale: row.proposal_rationale ?? undefined,
  createdByActor: row.created_by_actor ?? undefined,
  publishedAt: row.published_at ? new Date(row.published_at).toISOString() : undefined,
  changelog: row.changelog ?? undefined,
  createdAt: new Date(row.created_at).toISOString(),
});

@ApiTags('workflows')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller({ path: 'workflows', version: '1' })
export class WorkflowsController {
  constructor(private readonly service: WorkflowsService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Create a draft workflow version',
    description:
      'Pass `workflowDefId` to add a draft to an existing def, or `{slug, displayName}` to create a fresh def + first draft.',
  })
  @ApiOkResponse({ type: WorkflowVersionResponseDto })
  async createDraft(
    @Body() dto: CreateWorkflowDraftDto,
    @Req() req: AuthedRequest,
  ): Promise<WorkflowVersionResponseDto> {
    const ctx = requireTenantUser(req);
    const row = await this.service.createDraft(dto, ctx);
    return toResponseDto(row);
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Edit a draft workflow version (inserts a new immutable draft, supersedes the prior)',
    description:
      'workflow_versions rows are immutable; PATCH inserts a new draft row with the replacement spec and demotes the prior draft to `superseded`. The new row id is returned in the response.',
  })
  @ApiOkResponse({ type: WorkflowVersionResponseDto })
  async editDraft(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: EditWorkflowDraftDto,
    @Req() req: AuthedRequest,
  ): Promise<WorkflowVersionResponseDto> {
    const ctx = requireTenantUser(req);
    const row = await this.service.editDraft(id, dto, ctx);
    return toResponseDto(row);
  }

  @Post(':id/validate')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Compile-validate a draft (no mutation, no audit)' })
  @ApiOkResponse({ type: ValidateResultDto })
  async validate(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: AuthedRequest,
  ): Promise<ValidateResultDto> {
    const ctx = requireTenantUser(req);
    const result = await this.service.validateById(id, ctx);
    return {
      ok: result.ok,
      errors: result.errors.map((e) => ({ code: e.code, path: e.path, message: e.message })),
      hash: result.ok ? result.hash : undefined,
    };
  }

  @Post(':id/publish')
  @HttpCode(HttpStatus.OK)
  @Roles('admin')
  @ApiOperation({
    summary: 'Publish a draft (admin only; Phase 5 will replace this gate with approval routing)',
  })
  @ApiOkResponse({ type: PublishResultDto })
  async publish(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: AuthedRequest,
  ): Promise<PublishResultDto> {
    const ctx = requireTenantUser(req);
    return this.service.publish(id, ctx);
  }

  @Post(':id/rollback')
  @HttpCode(HttpStatus.OK)
  @Roles('admin')
  @ApiOperation({
    summary:
      'Rollback to the prior published version of the workflow_def that owns this version (admin only)',
  })
  @ApiOkResponse({ type: RollbackResultDto })
  async rollback(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: AuthedRequest,
  ): Promise<RollbackResultDto> {
    const ctx = requireTenantUser(req);
    // Resolve the def via the version id so the caller can keep referring to
    // the version they last published instead of the def id directly.
    const version = await this.service.getById(id, ctx);
    return this.service.rollback(version.workflow_def_id, ctx);
  }

  @Get(':id/diff')
  @ApiOperation({
    summary: 'Diff two version_number values of the workflow_def owning :id (RFC 6902 JSON Patch)',
  })
  @ApiQuery({ name: 'from', type: Number, required: true })
  @ApiQuery({ name: 'to', type: Number, required: true })
  @ApiOkResponse({ type: WorkflowDiffResponseDto })
  async diff(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Query('from', new ParseIntPipe()) from: number,
    @Query('to', new ParseIntPipe()) to: number,
    @Req() req: AuthedRequest,
  ): Promise<WorkflowDiffResponseDto> {
    const ctx = requireTenantUser(req);
    const result = await this.service.diff(id, from, to, ctx);
    return {
      fromVersion: result.fromVersion,
      toVersion: result.toVersion,
      fromHash: result.fromHash,
      toHash: result.toHash,
      patch: result.patch as unknown as Array<Record<string, unknown>>,
    };
  }
}
