import { IsString, IsEnum, IsObject, IsOptional, IsUUID } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateTaskDto {
  @ApiProperty({ description: 'Unique key for this task within the graph' })
  @IsString()
  task_key: string;

  @ApiProperty({ description: 'Display name for the task' })
  @IsString()
  display_name: string;

  @ApiProperty({ description: 'Task type' })
  @IsString()
  task_type: string;

  @ApiPropertyOptional({ description: 'Task configuration' })
  @IsObject()
  @IsOptional()
  config?: Record<string, any>;
}

export class UpdateTaskDto {
  @ApiPropertyOptional({ description: 'Display name for the task' })
  @IsString()
  @IsOptional()
  display_name?: string;

  @ApiPropertyOptional({ description: 'Task status' })
  @IsEnum(['pending', 'running', 'completed', 'failed', 'skipped'])
  @IsOptional()
  status?: 'pending' | 'running' | 'completed' | 'failed' | 'skipped';

  @ApiPropertyOptional({ description: 'Task result data' })
  @IsObject()
  @IsOptional()
  result?: Record<string, any>;

  @ApiPropertyOptional({ description: 'Error details if task failed' })
  @IsObject()
  @IsOptional()
  error_details?: Record<string, any>;

  @ApiPropertyOptional({ description: 'Task configuration' })
  @IsObject()
  @IsOptional()
  config?: Record<string, any>;
}

export interface Task {
  id: string;
  task_graph_id: string;
  task_key: string;
  display_name: string;
  task_type: string;
  config: Record<string, any>;
  status: string;
  result?: Record<string, any>;
  error_details?: Record<string, any>;
  created_at: Date;
  updated_at: Date;
}
