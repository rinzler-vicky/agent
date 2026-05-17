/**
 * Kahn's algorithm with deterministic tiebreak: when multiple nodes have
 * indegree 0, the one with the lexicographically smallest id is consumed
 * first. Guarantees byte-identical `topoOrder` for the same input.
 *
 * Precondition: the input graph is acyclic. Caller must run cycle detection
 * first. If a cycle is somehow present, this returns `undefined` so the
 * caller can fail loud instead of returning a partial order.
 */
export const topologicalSort = (
  nodeIds: readonly string[],
  adjacency: Readonly<Record<string, readonly string[]>>,
): string[] | undefined => {
  const indegree: Record<string, number> = {};
  for (const id of nodeIds) indegree[id] = 0;
  for (const id of nodeIds) {
    for (const target of adjacency[id] ?? []) {
      if (indegree[target] === undefined) indegree[target] = 0;
      indegree[target]++;
    }
  }

  // Sorted ready-list. N is small (workflow node counts in the dozens at
  // most) so resorting after each insert is fine and easier to audit than
  // a heap.
  const ready: string[] = [];
  for (const id of [...nodeIds].sort()) {
    if (indegree[id] === 0) ready.push(id);
  }

  const order: string[] = [];
  while (ready.length > 0) {
    const next = ready.shift()!;
    order.push(next);
    for (const target of [...(adjacency[next] ?? [])].sort()) {
      indegree[target]--;
      if (indegree[target] === 0) {
        ready.push(target);
        ready.sort();
      }
    }
  }

  if (order.length !== nodeIds.length) return undefined;
  return order;
};
