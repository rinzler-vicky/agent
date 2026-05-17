import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Request } from 'express';
import { JwtAuthGuard } from '@/auth/jwt-auth.guard';
import { ProposalsService } from './proposals.service';
import { ServiceAccountScopeGuard } from './guards/service-account-scope.guard';
import { ServiceAccountThrottlerGuard } from './guards/service-account-throttler.guard';
import { CreateWorkflowProposalDto } from './dto/workflow-proposal.dto';
import { WorkflowVersionResponseDto } from './dto/workflow-lifecycle.dto';

interface AuthedRequest extends Request {
  user?: {
    sub: string;
    tenantId: string;
    type: 'user' | 'service_account';
    scopes?: string[];
  };
}

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

// Guard order is load-bearing: JwtAuthGuard populates req.user → the
// ServiceAccountThrottlerGuard keys the 30/min bucket on req.user.sub so
// IP rotation can't bypass the budget → ServiceAccountScopeGuard then
// enforces type+scope. Putting the throttler before the scope guard is
// intentional: an agent flooding with the wrong scope should still consume
// its budget (so the 30/min cap doesn't become an oracle that distinguishes
// "wrong scope" from "scope OK but spec broken").
@UseGuards(
  JwtAuthGuard,
  ServiceAccountThrottlerGuard,
  ServiceAccountScopeGuard('workflows:propose'),
)
@ApiTags('workflow-proposals')
@ApiBearerAuth()
@Controller({ path: 'workflow-proposals', version: '1' })
export class ProposalsController {
  constructor(private readonly service: ProposalsService) {}

  /**
   * Agent-facing proposal endpoint. Stricter throttle than the human draft
   * endpoint (30/min vs the global 100/min): a runaway agent could otherwise
   * flood `workflow_versions` faster than reviewers can drain. Phase 5 will
   * replace this with adaptive per-actor budgets.
   */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @Throttle({ default: { ttl: 60_000, limit: 30 } })
  @ApiOperation({
    summary: 'Submit an agent-authored canonical workflow patch as a draft proposal',
    description:
      'Auth: service-account JWT with `scopes` containing `workflows:propose`. ' +
      'Body: canonical spec + parent version id + optional `stepRunId` linking the ' +
      'failing step that triggered the proposal. Stores a draft `workflow_version` ' +
      'with `proposal_source=failure_recovery` (or `agent_reflection` if no stepRunId), ' +
      '`proposal_context` populated with the trigger metadata, and writes an audit event ' +
      'whose `resource_id` is the new draft id so the failing-step → draft linkage is ' +
      'queryable from the audit log.',
  })
  @ApiCreatedResponse({ type: WorkflowVersionResponseDto })
  async create(
    @Body() dto: CreateWorkflowProposalDto,
    @Req() req: AuthedRequest,
  ): Promise<WorkflowVersionResponseDto> {
    const user = req.user;
    // The guard chain already enforced this, but TypeScript can't see that.
    // Throwing here is unreachable in practice; keeps the type narrow.
    if (!user?.sub || !user.tenantId) {
      throw new BadRequestException('authenticated service-account context is missing');
    }
    const row = await this.service.create(dto, {
      tenantId: user.tenantId,
      serviceAccountId: user.sub,
    });
    return toResponseDto(row);
  }
}
