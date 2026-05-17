import { createPatch, Operation } from 'rfc6902';
import { compile } from '@/workflows/canonical';
import type { CompiledWorkflow } from '@/workflows/canonical';

export interface WorkflowDiff {
  fromVersion: number;
  toVersion: number;
  fromHash: string;
  toHash: string;
  patch: Operation[];
}

/**
 * Diff two workflow specs. We compile each spec first so the diff is
 * computed over the deterministic, canonicalized graph (compiled output
 * has sorted nodes/edges, resolved adjacency, stable sourceHash). The
 * resulting RFC 6902 patch is applicable by any conformant consumer via
 * `rfc6902.applyPatch`, which is useful for Phase 5 reviewer tooling.
 *
 * Throws if either side fails to compile. Validation errors should be
 * surfaced via /workflows/:id/validate before invoking diff.
 */
export const diffSpecs = (
  fromSpec: unknown,
  toSpec: unknown,
  fromVersionNumber: number,
  toVersionNumber: number,
): WorkflowDiff => {
  const fromResult = compile(fromSpec);
  if (!fromResult.ok) {
    throw new Error(
      `from spec failed to compile: ${fromResult.errors.map((e) => e.code).join(', ')}`,
    );
  }
  const toResult = compile(toSpec);
  if (!toResult.ok) {
    throw new Error(
      `to spec failed to compile: ${toResult.errors.map((e) => e.code).join(', ')}`,
    );
  }
  return buildDiff(fromResult.compiled, toResult.compiled, fromVersionNumber, toVersionNumber);
};

/**
 * Internal helper used by both `diffSpecs` and tests. Exposed so unit
 * tests can pass pre-compiled fixtures without re-running the parser.
 */
export const buildDiff = (
  from: CompiledWorkflow,
  to: CompiledWorkflow,
  fromVersion: number,
  toVersion: number,
): WorkflowDiff => {
  // Diff a stable projection — exclude adjacency/reverseAdjacency since
  // they're derivable from edges and would add noise (every edge change
  // would echo as two adjacency-map entry changes).
  const project = (c: CompiledWorkflow) => ({
    id: c.id,
    schemaVersion: c.schemaVersion,
    name: c.name,
    ...(c.description !== undefined ? { description: c.description } : {}),
    nodes: c.nodes,
    edges: c.edges,
    topoOrder: c.topoOrder,
  });
  return {
    fromVersion,
    toVersion,
    fromHash: from.sourceHash,
    toHash: to.sourceHash,
    patch: createPatch(project(from), project(to)),
  };
};
