import { IsString, IsObject, IsUUID, IsEnum, IsOptional } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateProposalTriggerDto {
  @ApiProperty({ description: 'Workflow run ID that triggered this proposal' })
  @IsUUID()
  workflow_run_id: string;

  @ApiProperty({ description: 'Error fingerprint for deduplication' })
  @IsString()
  error_fingerprint: string;

  @ApiPropertyOptional({ description: 'Step run ID if failure occurred in a specific step' })
  @IsUUID()
  @IsOptional()
  step_run_id?: string;

  @ApiPropertyOptional({ description: 'Additional trigger context' })
  @IsObject()
  @IsOptional()
  trigger_context?: Record<string, any>;
}

export class UpdateProposalTriggerDto {
  @ApiPropertyOptional({ description: 'Trigger status' })
  @IsEnum(['pending', 'processing', 'completed', 'failed'])
  @IsOptional()
  status?: 'pending' | 'processing' | 'completed' | 'failed';

  @ApiPropertyOptional({ description: 'Resulting workflow version ID if proposal was created' })
  @IsUUID()
  @IsOptional()
  result_version_id?: string;
}

export interface ProposalTrigger {
  id: string;
  tenant_id: string;
  workflow_run_id: string;
  step_run_id?: string;
  error_fingerprint: string;
  trigger_context: Record<string, any>;
  status: string;
  processed_at?: Date;
  result_version_id?: string;
  created_at: Date;
}
