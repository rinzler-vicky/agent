import { IsString, IsObject, IsOptional, IsUUID, IsEnum } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateWorkflowProposalDto {
  @ApiProperty({ description: 'Workflow definition ID' })
  @IsUUID()
  workflowDefId: string;

  @ApiProperty({ description: 'Parent version ID being modified' })
  @IsUUID()
  parentVersionId: string;

  @ApiProperty({ description: 'Workflow specification (canonical JSON)' })
  @IsObject()
  spec: Record<string, any>;

  @ApiPropertyOptional({ description: 'Proposal source', enum: ['agent', 'human', 'system'] })
  @IsEnum(['agent', 'human', 'system'])
  @IsOptional()
  proposalSource?: 'agent' | 'human' | 'system';

  @ApiPropertyOptional({ description: 'Proposal context metadata' })
  @IsObject()
  @IsOptional()
  proposalContext?: Record<string, any>;

  @ApiPropertyOptional({ description: 'Human-readable rationale for the proposal' })
  @IsString()
  @IsOptional()
  proposalRationale?: string;

  @ApiPropertyOptional({ description: 'Changelog describing changes' })
  @IsString()
  @IsOptional()
  changelog?: string;

  @ApiPropertyOptional({ description: 'Run ID that triggered this proposal' })
  @IsUUID()
  @IsOptional()
  createdFromRunId?: string;
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
