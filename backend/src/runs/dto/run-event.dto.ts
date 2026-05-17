import { IsString, IsObject, IsOptional, IsUUID, IsInt, Min } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateRunEventDto {
  @ApiProperty({ description: 'Event type' })
  @IsString()
  eventType: string;

  @ApiProperty({ description: 'Event data payload' })
  @IsObject()
  eventData: Record<string, any>;

  @ApiPropertyOptional({ description: 'Step run ID if event relates to a specific step' })
  @IsUUID()
  @IsOptional()
  stepRunId?: string;

  @ApiPropertyOptional({ description: 'Error fingerprint for failure events' })
  @IsString()
  @IsOptional()
  errorFingerprint?: string;

  @ApiPropertyOptional({ description: 'Sequence number (auto-generated if not provided)' })
  @IsInt()
  @Min(1)
  @IsOptional()
  sequence?: number;
}

export interface RunEvent {
  id: string;
  runId: string;
  sequence: number;
  eventType: string;
  eventData: Record<string, any>;
  stepRunId?: string;
  errorFingerprint?: string;
  occurredAt: Date;
}
