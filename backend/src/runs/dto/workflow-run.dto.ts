import { IsUUID, IsString, IsObject, IsOptional, IsEnum } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateWorkflowRunDto {
  @ApiProperty({ description: 'Workflow version ID to execute' })
  @IsUUID()
  workflowVersionId: string;

  @ApiPropertyOptional({ description: 'Conversation ID for this run' })
  @IsUUID()
  @IsOptional()
  conversationId?: string;

  @ApiPropertyOptional({ description: 'Task graph ID for this run' })
  @IsUUID()
  @IsOptional()
  taskGraphId?: string;

  @ApiPropertyOptional({ description: 'Execution engine to use', enum: ['n8n_queue', 'durable'] })
  @IsEnum(['n8n_queue', 'durable'])
  @IsOptional()
  executionEngine?: 'n8n_queue' | 'durable';

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
  errorDetails?: Record<string, any>;
}

export interface WorkflowRun {
  id: string;
  tenantId: string;
  workflowVersionId: string;
  conversationId?: string;
  taskGraphId?: string;
  executionEngine: string;
  status: string;
  input: Record<string, any>;
  output?: Record<string, any>;
  errorDetails?: Record<string, any>;
  startedAt?: Date;
  completedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}
