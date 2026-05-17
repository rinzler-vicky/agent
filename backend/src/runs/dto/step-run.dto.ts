import { IsString, IsEnum, IsObject, IsOptional, IsUUID } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateStepRunDto {
  @ApiProperty({ description: 'Step key within the workflow' })
  @IsString()
  step_key: string;

  @ApiProperty({ description: 'Human-readable step name' })
  @IsString()
  step_name: string;

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
  error_details?: Record<string, any>;
}

export interface StepRun {
  id: string;
  workflow_run_id: string;
  step_key: string;
  step_name: string;
  status: string;
  input?: Record<string, any>;
  output?: Record<string, any>;
  error_details?: Record<string, any>;
  started_at?: Date;
  completed_at?: Date;
  created_at: Date;
  updated_at: Date;
}
