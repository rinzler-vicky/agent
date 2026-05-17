import { IsUUID, IsString, IsObject, IsOptional } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateTaskEdgeDto {
  @ApiProperty({ description: 'Source task ID' })
  @IsUUID()
  from_task_id: string;

  @ApiProperty({ description: 'Target task ID' })
  @IsUUID()
  to_task_id: string;

  @ApiPropertyOptional({ description: 'Edge type (dependency, conditional, etc.)' })
  @IsString()
  @IsOptional()
  edge_type?: string;

  @ApiPropertyOptional({ description: 'Edge metadata' })
  @IsObject()
  @IsOptional()
  metadata?: Record<string, any>;
}

export interface TaskEdge {
  id: string;
  task_graph_id: string;
  from_task_id: string;
  to_task_id: string;
  edge_type: string;
  metadata: Record<string, any>;
  created_at: Date;
}
