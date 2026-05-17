import { IsUUID, IsString, IsObject, IsOptional } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateTaskEdgeDto {
  @ApiProperty({ description: 'Source task ID' })
  @IsUUID()
  fromTaskId: string;

  @ApiProperty({ description: 'Target task ID' })
  @IsUUID()
  toTaskId: string;

  @ApiPropertyOptional({ description: 'Edge type (dependency, conditional, etc.)' })
  @IsString()
  @IsOptional()
  edgeType?: string;

  @ApiPropertyOptional({ description: 'Edge metadata' })
  @IsObject()
  @IsOptional()
  metadata?: Record<string, any>;
}

export interface TaskEdge {
  id: string;
  taskGraphId: string;
  fromTaskId: string;
  toTaskId: string;
  edgeType: string;
  metadata: Record<string, any>;
  createdAt: Date;
}
