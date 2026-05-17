import { IsString, IsEnum, IsObject, IsOptional } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateTaskDto {
  @ApiProperty({ description: 'Unique key for this task within the graph' })
  @IsString()
  taskKey: string;

  @ApiProperty({ description: 'Display name for the task' })
  @IsString()
  displayName: string;

  @ApiProperty({ description: 'Task type' })
  @IsString()
  taskType: string;

  @ApiPropertyOptional({ description: 'Task configuration' })
  @IsObject()
  @IsOptional()
  config?: Record<string, any>;
}

export class UpdateTaskDto {
  @ApiPropertyOptional({ description: 'Display name for the task' })
  @IsString()
  @IsOptional()
  displayName?: string;

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
  errorDetails?: Record<string, any>;

  @ApiPropertyOptional({ description: 'Task configuration' })
  @IsObject()
  @IsOptional()
  config?: Record<string, any>;
}

export interface Task {
  id: string;
  taskGraphId: string;
  taskKey: string;
  displayName: string;
  taskType: string;
  config: Record<string, any>;
  status: string;
  result?: Record<string, any>;
  errorDetails?: Record<string, any>;
  createdAt: Date;
  updatedAt: Date;
}
