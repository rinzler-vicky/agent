import { makeError, type CompilationError } from './errors';

const WHITE = 0;
const GRAY = 1;
const BLACK = 2;

export interface CycleResult {
  hasCycle: boolean;
  cyclePath?: string[];
  errors: CompilationError[];
}

/**
 * Iterative DFS with explicit stack (per ADR-0002 §10) and white/gray/black
 * coloring. Returns the first cycle path discovered, expressed as the
 * sequence of node ids forming the cycle, ending with a repeat of the
 * cycle's entry node so the loop closure is unambiguous (e.g. ["a", "b",
 * "c", "a"]). The traversal starts from sorted root candidates so the
 * reported cycle is deterministic for a given input.
 */
export const detectCycle = (
  nodeIds: readonly string[],
  adjacency: Readonly<Record<string, readonly string[]>>,
): CycleResult => {
  const color: Record<string, number> = {};
  for (const id of nodeIds) color[id] = WHITE;

  // For each unvisited root (sorted), iterative DFS.
  for (const root of [...nodeIds].sort()) {
    if (color[root] !== WHITE) continue;

    // Stack frames hold the node and an index pointer into its sorted
    // neighbor list. A parallel `pathStack` records gray nodes in DFS
    // order so we can reconstruct a cycle path on closure.
    const stack: Array<{ node: string; neighbors: string[]; idx: number }> =
      [];
    const pathStack: string[] = [];

    const enter = (node: string) => {
      color[node] = GRAY;
      pathStack.push(node);
      const neighbors = [...(adjacency[node] ?? [])].sort();
      stack.push({ node, neighbors, idx: 0 });
    };

    enter(root);

    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      if (frame.idx >= frame.neighbors.length) {
        color[frame.node] = BLACK;
        pathStack.pop();
        stack.pop();
        continue;
      }
      const next = frame.neighbors[frame.idx++];
      const c = color[next];
      if (c === GRAY) {
        // Cycle discovered. Slice the gray path from `next` onward and
        // close it by repeating `next`.
        const startIdx = pathStack.indexOf(next);
        const cyclePath = pathStack.slice(startIdx).concat(next);
        return {
          hasCycle: true,
          cyclePath,
          errors: [
            makeError(
              'CYCLE_DETECTED',
              'graph',
              `cycle detected: ${cyclePath.join(' -> ')}`,
              { cyclePath },
            ),
          ],
        };
      }
      if (c === WHITE) {
        enter(next);
      }
      // BLACK neighbor — already fully processed, skip.
    }
  }

  return { hasCycle: false, errors: [] };
};
