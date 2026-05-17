// class-validator + class-transformer rely on reflect-metadata being loaded
// before any decorated class is defined. Nest's bootstrap normally pulls it
// in for app code; this pure module has no Nest dependency, so we import it
// here to make the module self-sufficient (safe to import multiple times —
// it self-guards against double-init).
import 'reflect-metadata';

import { Type } from 'class-transformer';
import {
  IsArray,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  ValidateNested,
} from 'class-validator';

const ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

export class CanonicalPortRefDto {
  @IsString()
  @Matches(ID_PATTERN, { message: 'nodeId must match /^[a-zA-Z0-9_-]{1,64}$/' })
  nodeId!: string;

  @IsString()
  @Matches(/^[a-zA-Z0-9_-]{1,32}$/, {
    message: 'port must match /^[a-zA-Z0-9_-]{1,32}$/',
  })
  port!: string;
}

export class CanonicalNodeDto {
  @IsString()
  @Matches(ID_PATTERN, { message: 'id must match /^[a-zA-Z0-9_-]{1,64}$/' })
  id!: string;

  @IsString()
  type!: string;

  @IsObject()
  @IsOptional()
  config?: Record<string, unknown>;
}

export class CanonicalEdgeDto {
  @IsString()
  @Matches(ID_PATTERN, { message: 'id must match /^[a-zA-Z0-9_-]{1,64}$/' })
  id!: string;

  @ValidateNested()
  @Type(() => CanonicalPortRefDto)
  from!: CanonicalPortRefDto;

  @ValidateNested()
  @Type(() => CanonicalPortRefDto)
  to!: CanonicalPortRefDto;
}

export class CanonicalWorkflowDto {
  @IsString()
  schemaVersion!: string;

  @IsString()
  @Matches(ID_PATTERN, { message: 'id must match /^[a-zA-Z0-9_-]{1,64}$/' })
  id!: string;

  @IsString()
  name!: string;

  @IsString()
  @IsOptional()
  description?: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CanonicalNodeDto)
  nodes!: CanonicalNodeDto[];

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CanonicalEdgeDto)
  edges!: CanonicalEdgeDto[];
}

export const CANONICAL_SCHEMA_VERSION = '1' as const;
