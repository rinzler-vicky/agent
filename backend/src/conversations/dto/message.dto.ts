import { IsString, IsEnum, IsObject, IsOptional, IsInt, Min } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateMessageDto {
  @ApiProperty({ description: 'Message role', enum: ['user', 'assistant', 'system', 'tool'] })
  @IsEnum(['user', 'assistant', 'system', 'tool'])
  role: 'user' | 'assistant' | 'system' | 'tool';

  @ApiProperty({ description: 'Message content' })
  @IsString()
  content: string;

  @ApiPropertyOptional({ description: 'Additional metadata' })
  @IsObject()
  @IsOptional()
  metadata?: Record<string, any>;

  @ApiPropertyOptional({ description: 'Sequence number (auto-generated if not provided)' })
  @IsInt()
  @Min(1)
  @IsOptional()
  sequenceNumber?: number;
}

export interface Message {
  id: string;
  conversationId: string;
  sequenceNumber: number;
  role: string;
  content: string;
  metadata: Record<string, any>;
  createdAt: Date;
}
