import { IsString, IsObject, IsOptional, IsUUID, IsEnum } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateWorkflowProposalDto {
  @ApiProperty({ description: 'Workflow definition ID' })
  @IsUUID()
  workflow_def_id: string;

  @ApiProperty({ description: 'Parent version ID being modified' })
  @IsUUID()
  parent_version_id: string;

  @ApiProperty({ description: 'Workflow specification (canonical JSON)' })
  @IsObject()
  spec: Record<string, any>;

  @ApiPropertyOptional({ description: 'Proposal source', enum: ['agent', 'human', 'system'] })
  @IsEnum(['agent', 'human', 'system'])
  @IsOptional()
  proposal_source?: 'agent' | 'human' | 'system';

  @ApiPropertyOptional({ description: 'Proposal context metadata' })
  @IsObject()
  @IsOptional()
  proposal_context?: Record<string, any>;

  @ApiPropertyOptional({ description: 'Human-readable rationale for the proposal' })
  @IsString()
  @IsOptional()
  proposal_rationale?: string;

  @ApiPropertyOptional({ description: 'Changelog describing changes' })
  @IsString()
  @IsOptional()
  changelog?: string;

  @ApiPropertyOptional({ description: 'Run ID that triggered this proposal' })
  @IsUUID()
  @IsOptional()
  created_from_run_id?: string;
}

export class UpdateWorkflowVersionDto {
  @ApiPropertyOptional({ description: 'Lifecycle state' })
  @IsEnum(['draft', 'published', 'superseded', 'rejected'])
  @IsOptional()
  lifecycle_state?: 'draft' | 'published' | 'superseded' | 'rejected';

  @ApiPropertyOptional({ description: 'Approval state' })
  @IsEnum(['draft', 'pending', 'approved', 'rejected'])
  @IsOptional()
  approval_state?: 'draft' | 'pending' | 'approved' | 'rejected';

  @ApiPropertyOptional({ description: 'Workflow specification' })
  @IsObject()
  @IsOptional()
  spec?: Record<string, any>;

  @ApiPropertyOptional({ description: 'Changelog' })
  @IsString()
  @IsOptional()
  changelog?: string;
}

export interface WorkflowVersion {
  id: string;
  workflow_def_id: string;
  version_number: number;
  spec: Record<string, any>;
  lifecycle_state: string;
  approval_state: string;
  parent_version_id?: string;
  proposal_source?: string;
  proposal_context?: Record<string, any>;
  proposal_rationale?: string;
  created_by_actor?: string;
  created_from_run_id?: string;
  published_at?: Date;
  changelog?: string;
  created_at: Date;
}
