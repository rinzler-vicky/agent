import * as fc from 'fast-check';
import { compile } from '@/workflows/canonical/compiler';
import { detectCycle } from '@/workflows/canonical/cycle-detector';

/**
 * Property-based tests that exercise the compiler against many randomly
 * generated graphs. The generators only use node types whose ports are
 * `any`-compatible end-to-end (`wait` and `error.handle`) so the structural
 * pipeline runs without port-mismatch noise drowning out the actual
 * properties under test.
 *
 * Properties:
 *   1. Every randomly generated DAG compiles (ok: true).
 *   2. Every randomly generated cyclic graph fails to compile with a
 *      CYCLE_DETECTED error whose `cyclePath` is a real walk in the input.
 */

const idArb = (n: number) =>
  fc.constantFrom(...Array.from({ length: n }, (_, i) => `n${String(i).padStart(3, '0')}`));

const dagArb = fc
  .integer({ min: 2, max: 8 })
  .chain((n) => {
    const ids = Array.from({ length: n }, (_, i) => `n${String(i).padStart(3, '0')}`);
    // Edges only go from lower-index to higher-index, so the result is
    // guaranteed acyclic. Connect each node (except the last) to at least
    // one successor so we never produce isolated nodes.
    return fc.tuple(
      fc.constant(ids),
      fc.array(
        fc
          .tuple(
            fc.integer({ min: 0, max: n - 2 }),
            fc.integer({ min: 1, max: n - 1 }),
          )
          .filter(([from, to]) => from < to),
        { minLength: n - 1, maxLength: n * 2 },
      ),
    );
  })
  .map(([ids, edgePairs]) => {
    const seenForwardCoverage = new Set<number>();
    for (const [from, to] of edgePairs) seenForwardCoverage.add(from);
    // Ensure every node (except the sink) appears as an edge source so no
    // ISOLATED_NODE errors are produced.
    const augmented = [...edgePairs];
    for (let i = 0; i < ids.length - 1; i++) {
      if (!seenForwardCoverage.has(i)) augmented.push([i, ids.length - 1]);
    }
    return {
      schemaVersion: '1',
      id: 'wf_prop',
      name: 'prop',
      nodes: ids.map((id) => ({ id, type: 'wait' })),
      edges: augmented.map(([from, to], i) => ({
        id: `e${i}`,
        from: { nodeId: ids[from], port: 'out' },
        to: { nodeId: ids[to], port: 'in' },
      })),
    };
  });

const cyclicArb = fc
  .integer({ min: 2, max: 8 })
  .chain((n) => {
    const ids = Array.from({ length: n }, (_, i) => `n${String(i).padStart(3, '0')}`);
    // Build a forward chain n0 -> n1 -> ... -> n(N-1), then add one back
    // edge from a strictly higher index to a strictly lower one so the
    // result is guaranteed to be a real cycle (not a self-loop, which the
    // resolver rejects as SELF_LOOP without recording adjacency and so
    // would never surface as CYCLE_DETECTED).
    return fc.tuple(
      fc.constant(ids),
      fc.integer({ min: 0, max: n - 2 }),     // backTarget: 0..n-2
      fc.integer({ min: 0 }),                  // seed for backSource offset
    ).map(([_ids, backTarget, backSourceSeed]) => {
      const room = n - 1 - backTarget;         // candidates: backTarget+1..n-1
      const backSource = backTarget + 1 + (backSourceSeed % room);
      return { ids, backSource, backTarget };
    });
  })
  .map(({ ids, backSource, backTarget }) => {
    const edges: Array<{ id: string; from: { nodeId: string; port: string }; to: { nodeId: string; port: string } }> = [];
    for (let i = 0; i < ids.length - 1; i++) {
      edges.push({
        id: `e${i}`,
        from: { nodeId: ids[i], port: 'out' },
        to: { nodeId: ids[i + 1], port: 'in' },
      });
    }
    edges.push({
      id: 'eback',
      from: { nodeId: ids[backSource], port: 'out' },
      to: { nodeId: ids[backTarget], port: 'in' },
    });
    return {
      schemaVersion: '1',
      id: 'wf_cycle',
      name: 'cycle',
      nodes: ids.map((id) => ({ id, type: 'wait' })),
      edges,
    };
  });

describe('compiler property tests', () => {
  it('every random DAG compiles successfully', () => {
    fc.assert(
      fc.property(dagArb, (input) => {
        const r = compile(input);
        if (!r.ok) {
          // Render useful debug context if a property violation is found.
          throw new Error(
            `expected ok, got errors: ${JSON.stringify(r.errors)} for input ${JSON.stringify(input)}`,
          );
        }
        return true;
      }),
      { numRuns: 60 },
    );
  });

  it('every random cyclic graph is rejected with a cycle path that walks the input', () => {
    fc.assert(
      fc.property(cyclicArb, (input) => {
        const r = compile(input);
        if (r.ok) {
          throw new Error(
            `expected cycle rejection, but compile succeeded for input ${JSON.stringify(input)}`,
          );
        }
        const cycleErrs = r.errors.filter((e) => e.code === 'CYCLE_DETECTED');
        expect(cycleErrs.length).toBeGreaterThan(0);
        // Re-walk the adjacency to confirm the reported cyclePath is real.
        const path = (cycleErrs[0].details as { cyclePath: string[] }).cyclePath;
        const adj = new Map<string, string[]>();
        for (const n of input.nodes) adj.set(n.id, []);
        for (const e of input.edges) adj.get(e.from.nodeId)!.push(e.to.nodeId);
        for (let i = 0; i < path.length - 1; i++) {
          expect(adj.get(path[i])!.includes(path[i + 1])).toBe(true);
        }
        return true;
      }),
      { numRuns: 60 },
    );
  });

  it('cycle detector agrees with the orchestrator on cyclicity (cross-check)', () => {
    fc.assert(
      fc.property(dagArb, (input) => {
        const ids = input.nodes.map((n) => n.id);
        const adj: Record<string, string[]> = {};
        for (const id of ids) adj[id] = [];
        for (const e of input.edges) adj[e.from.nodeId].push(e.to.nodeId);
        return detectCycle(ids, adj).hasCycle === false;
      }),
      { numRuns: 60 },
    );
  });
});
