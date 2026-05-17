import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Swagger-only DTO mirroring the N8nWebhookEvent type in types.ts.
 * Runtime validation lives in N8nWebhookController.receive (uuid + freshness +
 * HMAC); this class exists purely to drive /api/docs schema rendering.
 */
export class N8nWebhookEventDto {
  @ApiProperty({
    description: 'UUID of the workflow_runs row this event belongs to.',
    example: '6ba7b810-9dad-11d1-80b4-00c04fd430c8',
    format: 'uuid',
  })
  runId!: string;

  @ApiProperty({
    description: 'Tenant UUID, embedded by the compiler so the handler can set `app.tenant_id` without a pre-RLS lookup.',
    example: '550e8400-e29b-41d4-a716-446655440000',
    format: 'uuid',
  })
  tenantId!: string;

  @ApiProperty({
    description: 'Event type emitted by the n8n ping node.',
    enum: [
      'workflow.started',
      'workflow.completed',
      'workflow.failed',
      'step.started',
      'step.completed',
    ],
    example: 'step.completed',
  })
  event!: string;

  @ApiProperty({
    description: 'ISO-8601 timestamp from n8n at emit time. Rejected if outside `N8N_WEBHOOK_CLOCK_SKEW_S` window.',
    example: '2026-05-17T12:00:00.000Z',
    format: 'date-time',
  })
  timestamp!: string;

  @ApiPropertyOptional({
    description: 'Canonical node id; present on step.started / step.completed events.',
    example: 'b_http',
  })
  stepKey?: string;

  @ApiPropertyOptional({
    description: 'n8n execution id; present on terminal workflow events. Used for best-effort reconciliation via GET /executions/{id}.',
    example: 'abc123',
  })
  n8nExecutionId?: string;

  @ApiPropertyOptional({
    description: 'Free-form event payload (error details for workflow.failed, node output for step.completed, etc).',
    type: 'object',
    additionalProperties: true,
  })
  payload?: Record<string, unknown>;
}

export class N8nWebhookResponseDto {
  @ApiProperty({ example: true })
  ok!: true;

  @ApiPropertyOptional({
    description: 'Present and true when the event_id was already processed in a prior delivery.',
    example: false,
  })
  deduped?: boolean;
}
