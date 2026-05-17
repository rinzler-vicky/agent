import { makeError, type CompilationError } from './errors';
import {
  getNodeSpec,
  isKnownNodeType,
  portsCompatible,
  type PortSpec,
} from './node-registry';
import type { CanonicalWorkflowDto } from './schema';

export interface ResolvedGraph {
  nodeIds: string[];
  adjacency: Record<string, string[]>;
  reverseAdjacency: Record<string, string[]>;
}

const findPort = (
  ports: PortSpec[],
  name: string,
): PortSpec | undefined => ports.find((p) => p.name === name);

const sortedUnique = (arr: string[]): string[] =>
  Array.from(new Set(arr)).sort();

/**
 * Build adjacency + reverse adjacency from validated nodes/edges.
 * Reports:
 *  - UNKNOWN_NODE_TYPE for any node whose type is not in the registry
 *  - SELF_LOOP for edges that reference the same node id on both ends
 *  - DANGLING_EDGE for edges that reference unknown node ids or unknown ports
 *  - PORT_MISMATCH when port kinds do not satisfy `portsCompatible`
 *  - ISOLATED_NODE for nodes with neither incoming nor outgoing edges (only
 *    reported when the workflow has more than one node — a one-node workflow
 *    is trivially isolated)
 */
export const resolve = (
  workflow: CanonicalWorkflowDto,
): { graph: ResolvedGraph; errors: CompilationError[] } => {
  const errors: CompilationError[] = [];
  const nodeIds = workflow.nodes.map((n) => n.id).sort();
  const nodesById = new Map<string, (typeof workflow.nodes)[number]>();
  for (const n of workflow.nodes) nodesById.set(n.id, n);

  // Unknown node types — recorded here, not in the parser, because the
  // registry is part of the compile-time contract, not the JSON shape.
  for (let i = 0; i < workflow.nodes.length; i++) {
    const n = workflow.nodes[i];
    if (!isKnownNodeType(n.type)) {
      errors.push(
        makeError(
          'UNKNOWN_NODE_TYPE',
          `nodes[${i}].type`,
          `unknown node type "${n.type}"`,
          { id: n.id, type: n.type },
        ),
      );
    }
  }

  // Build raw forward/reverse adjacency as accumulators, then sort at the end.
  const adjAccum: Record<string, string[]> = {};
  const revAccum: Record<string, string[]> = {};
  for (const id of nodeIds) {
    adjAccum[id] = [];
    revAccum[id] = [];
  }

  for (let i = 0; i < workflow.edges.length; i++) {
    const e = workflow.edges[i];
    const fromNode = nodesById.get(e.from.nodeId);
    const toNode = nodesById.get(e.to.nodeId);

    if (e.from.nodeId === e.to.nodeId) {
      errors.push(
        makeError(
          'SELF_LOOP',
          `edges[${i}]`,
          `edge "${e.id}" loops node "${e.from.nodeId}" to itself`,
          { edgeId: e.id, nodeId: e.from.nodeId },
        ),
      );
      continue;
    }
    if (!fromNode) {
      errors.push(
        makeError(
          'DANGLING_EDGE',
          `edges[${i}].from.nodeId`,
          `edge "${e.id}" references missing source node "${e.from.nodeId}"`,
          { edgeId: e.id, missingNodeId: e.from.nodeId },
        ),
      );
      continue;
    }
    if (!toNode) {
      errors.push(
        makeError(
          'DANGLING_EDGE',
          `edges[${i}].to.nodeId`,
          `edge "${e.id}" references missing target node "${e.to.nodeId}"`,
          { edgeId: e.id, missingNodeId: e.to.nodeId },
        ),
      );
      continue;
    }

    // Port validation only when both node types are known. Otherwise the
    // UNKNOWN_NODE_TYPE error above already covers the failure.
    const fromSpec = getNodeSpec(fromNode.type);
    const toSpec = getNodeSpec(toNode.type);
    if (!fromSpec || !toSpec) {
      // Still record adjacency so cycle detection works on structurally
      // present edges; unknown-type errors are surfaced separately.
      adjAccum[fromNode.id].push(toNode.id);
      revAccum[toNode.id].push(fromNode.id);
      continue;
    }

    const fromPort = findPort(fromSpec.outputs, e.from.port);
    const toPort = findPort(toSpec.inputs, e.to.port);
    if (!fromPort) {
      errors.push(
        makeError(
          'DANGLING_EDGE',
          `edges[${i}].from.port`,
          `edge "${e.id}" references unknown output port "${e.from.port}" on node type "${fromNode.type}"`,
          { edgeId: e.id, nodeType: fromNode.type, port: e.from.port },
        ),
      );
      continue;
    }
    if (!toPort) {
      errors.push(
        makeError(
          'DANGLING_EDGE',
          `edges[${i}].to.port`,
          `edge "${e.id}" references unknown input port "${e.to.port}" on node type "${toNode.type}"`,
          { edgeId: e.id, nodeType: toNode.type, port: e.to.port },
        ),
      );
      continue;
    }

    if (!portsCompatible(fromPort.kind, toPort.kind)) {
      errors.push(
        makeError(
          'PORT_MISMATCH',
          `edges[${i}]`,
          `edge "${e.id}" connects ${fromNode.type}.${fromPort.name}:${fromPort.kind} to ${toNode.type}.${toPort.name}:${toPort.kind}`,
          {
            edgeId: e.id,
            fromKind: fromPort.kind,
            toKind: toPort.kind,
          },
        ),
      );
      // Continue building adjacency even on mismatch — downstream stages
      // give the most complete error picture that way.
    }

    adjAccum[fromNode.id].push(toNode.id);
    revAccum[toNode.id].push(fromNode.id);
  }

  // Isolated-node check (only meaningful when more than one node exists).
  if (nodeIds.length > 1) {
    for (const id of nodeIds) {
      if (adjAccum[id].length === 0 && revAccum[id].length === 0) {
        errors.push(
          makeError(
            'ISOLATED_NODE',
            `nodes[?].id="${id}"`,
            `node "${id}" has no incoming or outgoing edges`,
            { nodeId: id },
          ),
        );
      }
    }
  }

  // Deterministic output: sort target lists and rebuild Records in id order.
  const adjacency: Record<string, string[]> = {};
  const reverseAdjacency: Record<string, string[]> = {};
  for (const id of nodeIds) {
    adjacency[id] = sortedUnique(adjAccum[id]);
    reverseAdjacency[id] = sortedUnique(revAccum[id]);
  }

  return {
    graph: { nodeIds, adjacency, reverseAdjacency },
    errors,
  };
};
