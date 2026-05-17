import { IsString, IsEnum, IsObject, IsOptional } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateStepRunDto {
  @ApiProperty({ description: 'Step key within the workflow' })
  @IsString()
  stepKey: string;

  @ApiProperty({ description: 'Human-readable step name' })
  @IsString()
  stepName: string;

  @ApiPropertyOptional({ description: 'Input data for this step' })
  @IsObject()
  @IsOptional()
  input?: Record<string, any>;
}

export class UpdateStepRunDto {
  @ApiPropertyOptional({ description: 'Step status' })
  @IsEnum(['pending', 'running', 'completed', 'failed', 'skipped'])
  @IsOptional()
  status?: 'pending' | 'running' | 'completed' | 'failed' | 'skipped';

  @ApiPropertyOptional({ description: 'Output data from the step' })
  @IsObject()
  @IsOptional()
  output?: Record<string, any>;

  @ApiPropertyOptional({ description: 'Error details if step failed' })
  @IsObject()
  @IsOptional()
  errorDetails?: Record<string, any>;
}

export interface StepRun {
  id: string;
  workflowRunId: string;
  stepKey: string;
  stepName: string;
  status: string;
  input?: Record<string, any>;
  output?: Record<string, any>;
  errorDetails?: Record<string, any>;
  startedAt?: Date;
  completedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}
