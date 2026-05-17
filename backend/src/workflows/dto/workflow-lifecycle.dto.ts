import {
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Body for `POST /v1/workflows`. Two shapes are accepted:
 *  - Adding a version to an existing def: pass `workflowDefId`.
 *  - Creating a fresh def + first draft version: pass `slug` and `displayName`.
 */
export class CreateWorkflowDraftDto {
  @ApiPropertyOptional({ description: 'Existing workflow_def id to add a draft version to' })
  @IsUUID()
  @IsOptional()
  workflowDefId?: string;

  @ApiPropertyOptional({
    description: 'Slug for a new workflow_def (only when workflowDefId is omitted)',
  })
  @IsString()
  @IsOptional()
  @Matches(/^[a-z0-9][a-z0-9_-]{1,62}[a-z0-9]$/, {
    message: 'slug must be 3-64 lowercase chars (letters, digits, _ , -)',
  })
  slug?: string;

  @ApiPropertyOptional({ description: 'Display name for a new workflow_def' })
  @IsString()
  @IsOptional()
  @MaxLength(128)
  displayName?: string;

  @ApiProperty({
    description:
      'Canonical workflow spec. Draft creation stores the spec as-is — validation runs on demand via `POST /v1/workflows/:id/validate` and is enforced at publish time, so a half-built spec can land as a draft.',
  })
  @IsObject()
  spec: Record<string, unknown>;

  @ApiPropertyOptional({ description: 'Free-text changelog' })
  @IsString()
  @IsOptional()
  @MaxLength(2048)
  changelog?: string;
}

/**
 * Body for `PATCH /v1/workflows/:id`. Because `workflow_versions` is
 * immutable, a "patch" inserts a new draft row and supersedes the prior
 * draft. This deviates from REST PATCH semantics but matches the
 * Phase 1 immutable-versions invariant.
 */
export class EditWorkflowDraftDto {
  @ApiProperty({ description: 'Replacement canonical spec' })
  @IsObject()
  spec: Record<string, unknown>;

  @ApiPropertyOptional({ description: 'Free-text changelog' })
  @IsString()
  @IsOptional()
  @MaxLength(2048)
  changelog?: string;
}

export class WorkflowVersionResponseDto {
  @ApiProperty() id: string;
  @ApiProperty() workflowDefId: string;
  @ApiProperty() versionNumber: number;
  @ApiProperty() lifecycleState: 'draft' | 'published' | 'superseded' | 'rejected';
  @ApiProperty() approvalState: string;
  @ApiPropertyOptional() proposalSource?: string;
  @ApiPropertyOptional() parentVersionId?: string;
  @ApiPropertyOptional() proposalContext?: Record<string, unknown>;
  @ApiPropertyOptional() proposalRationale?: string;
  @ApiPropertyOptional() createdByActor?: string;
  @ApiPropertyOptional() publishedAt?: string;
  @ApiPropertyOptional() changelog?: string;
  @ApiProperty() createdAt: string;
}

export class ValidationErrorDto {
  @ApiProperty() code: string;
  @ApiProperty() path: string;
  @ApiProperty() message: string;
}

export class ValidateResultDto {
  @ApiProperty() ok: boolean;
  @ApiProperty({ type: [ValidationErrorDto] }) errors: ValidationErrorDto[];
  @ApiPropertyOptional({ description: 'Stable hash of the compiled workflow (only when ok=true)' })
  hash?: string;
}

export class WorkflowDiffResponseDto {
  @ApiProperty() fromVersion: number;
  @ApiProperty() toVersion: number;
  @ApiProperty() fromHash: string;
  @ApiProperty() toHash: string;
  @ApiProperty({
    type: 'array',
    items: { type: 'object', additionalProperties: true },
    description: 'RFC 6902 JSON Patch ops transforming the from-spec into the to-spec',
  })
  patch: Array<Record<string, unknown>>;
}

export class PublishResultDto {
  @ApiProperty() workflowVersionId: string;
  @ApiProperty({ enum: ['skipped', 'created', 'updated', 'recreated'] }) syncAction: string;
  @ApiProperty() n8nWorkflowId: string;
  @ApiProperty() canonicalHash: string;
}

export class RollbackResultDto {
  @ApiProperty() rolledBackTo: string;
  @ApiProperty() demoted: string;
  @ApiProperty({ enum: ['skipped', 'created', 'updated', 'recreated'] }) syncAction: string;
}
