import { IsString, IsOptional, IsUUID, IsObject, IsEnum } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateConversationDto {
  @ApiPropertyOptional({ description: 'Workspace ID for this conversation' })
  @IsUUID()
  @IsOptional()
  workspace_id?: string;

  @ApiPropertyOptional({ description: 'Title/subject of the conversation' })
  @IsString()
  @IsOptional()
  title?: string;

  @ApiPropertyOptional({ description: 'Additional context metadata' })
  @IsObject()
  @IsOptional()
  context?: Record<string, any>;
}

export class UpdateConversationDto {
  @ApiPropertyOptional({ description: 'Title/subject of the conversation' })
  @IsString()
  @IsOptional()
  title?: string;

  @ApiPropertyOptional({ description: 'Conversation status' })
  @IsEnum(['active', 'archived', 'closed'])
  @IsOptional()
  status?: 'active' | 'archived' | 'closed';

  @ApiPropertyOptional({ description: 'Additional context metadata' })
  @IsObject()
  @IsOptional()
  context?: Record<string, any>;
}

export interface Conversation {
  id: string;
  tenant_id: string;
  workspace_id?: string;
  title?: string;
  context: Record<string, any>;
  status: string;
  created_by_user_id?: string;
  created_at: Date;
  updated_at: Date;
}
