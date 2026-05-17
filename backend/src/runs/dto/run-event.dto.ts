import { IsString, IsObject, IsOptional, IsUUID, IsInt, Min } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateRunEventDto {
  @ApiProperty({ description: 'Event type' })
  @IsString()
  event_type: string;

  @ApiProperty({ description: 'Event data payload' })
  @IsObject()
  event_data: Record<string, any>;

  @ApiPropertyOptional({ description: 'Step run ID if event relates to a specific step' })
  @IsUUID()
  @IsOptional()
  step_run_id?: string;

  @ApiPropertyOptional({ description: 'Error fingerprint for failure events' })
  @IsString()
  @IsOptional()
  error_fingerprint?: string;

  @ApiPropertyOptional({ description: 'Sequence number (auto-generated if not provided)' })
  @IsInt()
  @Min(1)
  @IsOptional()
  sequence?: number;
}

export interface RunEvent {
  id: string;
  run_id: string;
  sequence: number;
  event_type: string;
  event_data: Record<string, any>;
  step_run_id?: string;
  error_fingerprint?: string;
  occurred_at: Date;
}
