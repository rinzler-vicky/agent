import { IsString, IsObject, IsUUID, IsEnum, IsOptional } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateProposalTriggerDto {
  @ApiProperty({ description: 'Workflow run ID that triggered this proposal' })
  @IsUUID()
  workflowRunId: string;

  @ApiProperty({ description: 'Error fingerprint for deduplication' })
  @IsString()
  errorFingerprint: string;

  @ApiPropertyOptional({ description: 'Step run ID if failure occurred in a specific step' })
  @IsUUID()
  @IsOptional()
  stepRunId?: string;

  @ApiPropertyOptional({ description: 'Additional trigger context' })
  @IsObject()
  @IsOptional()
  triggerContext?: Record<string, any>;
}

export class UpdateProposalTriggerDto {
  @ApiPropertyOptional({ description: 'Trigger status' })
  @IsEnum(['pending', 'processing', 'completed', 'failed'])
  @IsOptional()
  status?: 'pending' | 'processing' | 'completed' | 'failed';

  @ApiPropertyOptional({ description: 'Resulting workflow version ID if proposal was created' })
  @IsUUID()
  @IsOptional()
  resultVersionId?: string;
}

export interface ProposalTrigger {
  id: string;
  tenantId: string;
  workflowRunId: string;
  stepRunId?: string;
  errorFingerprint: string;
  triggerContext: Record<string, any>;
  status: string;
  processedAt?: Date;
  resultVersionId?: string;
  createdAt: Date;
}
