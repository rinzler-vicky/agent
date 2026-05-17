import { IsString, IsOptional, IsUUID, IsObject, IsEnum } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateTaskGraphDto {
  @ApiProperty({ description: 'Display name for the task graph' })
  @IsString()
  displayName: string;

  @ApiPropertyOptional({ description: 'Optional description' })
  @IsString()
  @IsOptional()
  description?: string;

  @ApiPropertyOptional({ description: 'Conversation ID this task graph belongs to' })
  @IsUUID()
  @IsOptional()
  conversationId?: string;

  @ApiPropertyOptional({ description: 'Additional context metadata' })
  @IsObject()
  @IsOptional()
  context?: Record<string, any>;
}

export class UpdateTaskGraphDto {
  @ApiPropertyOptional({ description: 'Display name for the task graph' })
  @IsString()
  @IsOptional()
  displayName?: string;

  @ApiPropertyOptional({ description: 'Optional description' })
  @IsString()
  @IsOptional()
  description?: string;

  @ApiPropertyOptional({ description: 'Task graph status' })
  @IsEnum(['pending', 'running', 'completed', 'failed', 'cancelled'])
  @IsOptional()
  status?: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

  @ApiPropertyOptional({ description: 'Additional context metadata' })
  @IsObject()
  @IsOptional()
  context?: Record<string, any>;
}

export interface TaskGraph {
  id: string;
  tenantId: string;
  conversationId?: string;
  displayName: string;
  description?: string;
  context: Record<string, any>;
  status: string;
  createdAt: Date;
  updatedAt: Date;
}
