import type { CompilationError } from './errors';
import type {
  CanonicalEdgeDto,
  CanonicalNodeDto,
  CanonicalWorkflowDto,
} from './schema';

export type CanonicalWorkflow = CanonicalWorkflowDto;
export type CanonicalNode = CanonicalNodeDto;
export type CanonicalEdge = CanonicalEdgeDto;

/**
 * Compiled output. Every collection field is a plain object/array with
 * keys/elements inserted in sorted order so that JSON.stringify produces a
 * byte-identical string across runs of the same canonical input. Downstream
 * (n8n adapter hashing, proposal storage) relies on this property.
 */
export interface CompiledWorkflow {
  id: string;
  schemaVersion: string;
  name: string;
  description?: string;
  nodes: Record<string, CanonicalNode>;
  edges: CanonicalEdge[];
  adjacency: Record<string, string[]>;
  reverseAdjacency: Record<string, string[]>;
  topoOrder: string[];
  sourceHash: string;
}

/**
 * On `ok: true`, `errors` is always an empty array (the success path returns
 * once every collector has reported zero issues). It is typed as
 * `CompilationError[]` instead of the tuple `[]` so consumers narrowing on
 * `ok` get a usable `errors` shape in both branches without TS inferring
 * `never` for array element accesses.
 */
export type CompilationResult =
  | { ok: true; errors: CompilationError[]; compiled: CompiledWorkflow }
  | { ok: false; errors: CompilationError[]; compiled?: undefined };
