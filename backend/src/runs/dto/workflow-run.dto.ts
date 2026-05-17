import { IsUUID, IsString, IsObject, IsOptional, IsEnum } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateWorkflowRunDto {
  @ApiProperty({ description: 'Workflow version ID to execute' })
  @IsUUID()
  workflow_version_id: string;

  @ApiPropertyOptional({ description: 'Conversation ID for this run' })
  @IsUUID()
  @IsOptional()
  conversation_id?: string;

  @ApiPropertyOptional({ description: 'Task graph ID for this run' })
  @IsUUID()
  @IsOptional()
  task_graph_id?: string;

  @ApiPropertyOptional({ description: 'Execution engine to use', enum: ['n8n_queue', 'durable'] })
  @IsEnum(['n8n_queue', 'durable'])
  @IsOptional()
  execution_engine?: 'n8n_queue' | 'durable';

  @ApiPropertyOptional({ description: 'Input data for the workflow' })
  @IsObject()
  @IsOptional()
  input?: Record<string, any>;
}

export class UpdateWorkflowRunDto {
  @ApiPropertyOptional({ description: 'Run status' })
  @IsEnum(['pending', 'running', 'completed', 'failed', 'cancelled'])
  @IsOptional()
  status?: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

  @ApiPropertyOptional({ description: 'Output data from the workflow' })
  @IsObject()
  @IsOptional()
  output?: Record<string, any>;

  @ApiPropertyOptional({ description: 'Error details if run failed' })
  @IsObject()
  @IsOptional()
  error_details?: Record<string, any>;
}

export interface WorkflowRun {
  id: string;
  tenant_id: string;
  workflow_version_id: string;
  conversation_id?: string;
  task_graph_id?: string;
  execution_engine: string;
  status: string;
  input: Record<string, any>;
  output?: Record<string, any>;
  error_details?: Record<string, any>;
  started_at?: Date;
  completed_at?: Date;
  created_at: Date;
  updated_at: Date;
}
