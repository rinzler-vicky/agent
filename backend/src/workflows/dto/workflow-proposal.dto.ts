import { IsString, IsObject, IsOptional, IsUUID, IsEnum, MaxLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Body for `POST /v1/workflow-proposals`. The agent-facing surface for
 * Phase 2 self-modification (ARCHITECTURE.md §3, Class C). The endpoint
 * is locked behind `ServiceAccountScopeGuard('workflows:propose')`; see
 * `proposals.controller.ts` for the auth chain.
 *
 * Field naming follows the camelCase JSON contract used elsewhere on this
 * API; the issue body uses snake_case (canonical_json, step_run_id, …) as
 * descriptive prose, not as the wire format.
 */
export class CreateWorkflowProposalDto {
  @ApiProperty({ description: 'Workflow definition ID this proposal targets' })
  @IsUUID()
  workflowDefId: string;

  @ApiProperty({ description: 'Parent published version this proposal patches' })
  @IsUUID()
  parentVersionId: string;

  @ApiProperty({ description: 'Canonical workflow JSON (validated by the compiler)' })
  @IsObject()
  spec: Record<string, any>;

  @ApiPropertyOptional({
    description:
      'step_run_id that triggered this proposal. When present, the resulting draft is stored with proposal_source=failure_recovery; when absent, proposal_source=agent_reflection.',
  })
  @IsUUID()
  @IsOptional()
  stepRunId?: string;

  @ApiPropertyOptional({ description: 'workflow_run_id that contains the failing step (for cross-reference)' })
  @IsUUID()
  @IsOptional()
  workflowRunId?: string;

  @ApiPropertyOptional({ description: 'Stable error fingerprint (e.g. error code + node id)' })
  @IsString()
  @IsOptional()
  @MaxLength(256)
  errorFingerprint?: string;

  @ApiPropertyOptional({
    description: 'Free-text rationale explaining why this patch should be applied',
  })
  @IsString()
  @IsOptional()
  @MaxLength(4096)
  rationale?: string;

  @ApiPropertyOptional({ description: 'Optional changelog stored on the new draft row' })
  @IsString()
  @IsOptional()
  @MaxLength(2048)
  changelog?: string;
}

export class UpdateWorkflowVersionDto {
  @ApiPropertyOptional({ description: 'Lifecycle state' })
  @IsEnum(['draft', 'published', 'superseded', 'rejected'])
  @IsOptional()
  lifecycleState?: 'draft' | 'published' | 'superseded' | 'rejected';

  @ApiPropertyOptional({ description: 'Approval state' })
  @IsEnum(['draft', 'pending', 'approved', 'rejected'])
  @IsOptional()
  approvalState?: 'draft' | 'pending' | 'approved' | 'rejected';

  @ApiPropertyOptional({ description: 'Changelog' })
  @IsString()
  @IsOptional()
  changelog?: string;

  // NOTE: spec field removed - workflow_versions is immutable per Phase 1 pattern.
  // To change spec, create a new version/proposal via CreateWorkflowProposalDto.
}

export interface WorkflowVersion {
  id: string;
  workflowDefId: string;
  versionNumber: number;
  spec: Record<string, any>;
  lifecycleState: string;
  approvalState: string;
  parentVersionId?: string;
  proposalSource?: string;
  proposalContext?: Record<string, any>;
  proposalRationale?: string;
  createdByActor?: string;
  createdFromRunId?: string;
  publishedAt?: Date;
  changelog?: string;
  createdAt: Date;
}
