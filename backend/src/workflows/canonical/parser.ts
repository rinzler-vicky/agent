import { plainToInstance } from 'class-transformer';
import { validateSync, ValidationError } from 'class-validator';
import { makeError, type CompilationError } from './errors';
import { CanonicalWorkflowDto } from './schema';

export interface ParseSuccess {
  ok: true;
  value: CanonicalWorkflowDto;
  errors: CompilationError[];
}
export interface ParseFailure {
  ok: false;
  errors: CompilationError[];
  value?: undefined;
}
export type ParseResult = ParseSuccess | ParseFailure;

/**
 * Walk class-validator's nested ValidationError tree, emitting one
 * CompilationError per failing constraint at the leaves.
 */
const flattenValidationErrors = (
  errs: ValidationError[],
  parentPath: string,
  out: CompilationError[],
): void => {
  for (const e of errs) {
    const path =
      parentPath === ''
        ? e.property
        : `${parentPath}.${e.property}`;
    if (e.constraints) {
      for (const [constraint, message] of Object.entries(e.constraints)) {
        out.push(
          makeError('SCHEMA_INVALID', path, message, { constraint }),
        );
      }
    }
    if (e.children && e.children.length > 0) {
      flattenValidationErrors(e.children, path, out);
    }
  }
};

const checkDuplicateIds = (
  workflow: CanonicalWorkflowDto,
  errors: CompilationError[],
): void => {
  const nodeSeen = new Set<string>();
  for (let i = 0; i < workflow.nodes.length; i++) {
    const n = workflow.nodes[i];
    if (typeof n?.id !== 'string') continue;
    if (nodeSeen.has(n.id)) {
      errors.push(
        makeError(
          'DUPLICATE_NODE_ID',
          `nodes[${i}].id`,
          `duplicate node id "${n.id}"`,
          { id: n.id },
        ),
      );
    } else {
      nodeSeen.add(n.id);
    }
  }
  const edgeSeen = new Set<string>();
  for (let i = 0; i < workflow.edges.length; i++) {
    const e = workflow.edges[i];
    if (typeof e?.id !== 'string') continue;
    if (edgeSeen.has(e.id)) {
      errors.push(
        makeError(
          'DUPLICATE_NODE_ID',
          `edges[${i}].id`,
          `duplicate edge id "${e.id}"`,
          { id: e.id },
        ),
      );
    } else {
      edgeSeen.add(e.id);
    }
  }
};

/**
 * Parse and structurally validate a raw canonical workflow input.
 * Never throws. Collects all leaf-level errors, not just the first.
 */
export const parse = (raw: unknown): ParseResult => {
  const errors: CompilationError[] = [];

  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    errors.push(
      makeError(
        'SCHEMA_INVALID',
        '',
        'canonical workflow must be a JSON object',
      ),
    );
    return { ok: false, errors };
  }

  const instance = plainToInstance(
    CanonicalWorkflowDto,
    raw as Record<string, unknown>,
    { enableImplicitConversion: false },
  );

  const validationErrors = validateSync(instance, {
    whitelist: true,
    forbidNonWhitelisted: true,
    forbidUnknownValues: true,
    stopAtFirstError: false,
    validationError: { target: false, value: false },
  });

  flattenValidationErrors(validationErrors, '', errors);

  // class-validator's structural pass does not enforce id uniqueness;
  // do it here so the rest of the pipeline can treat ids as keys.
  if (Array.isArray(instance.nodes) && Array.isArray(instance.edges)) {
    checkDuplicateIds(instance, errors);
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return { ok: true, value: instance, errors: [] };
};
