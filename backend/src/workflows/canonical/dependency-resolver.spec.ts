import { resolve } from '@/workflows/canonical/dependency-resolver';
import type { CanonicalWorkflowDto } from '@/workflows/canonical/schema';

const wf = (overrides: Partial<CanonicalWorkflowDto>): CanonicalWorkflowDto => ({
  schemaVersion: '1',
  id: 'wf',
  name: 't',
  nodes: [],
  edges: [],
  ...overrides,
});

describe('resolve', () => {
  it('builds sorted adjacency and reverse adjacency for a simple chain', () => {
    // start.out:signal -> http.request.in:signal -> http.request.out:data ->
    // end.in:any. All port kinds compatible.
    const r = resolve(
      wf({
        nodes: [
          { id: 'a', type: 'start' },
          { id: 'b', type: 'http.request' },
          { id: 'c', type: 'end' },
        ],
        edges: [
          { id: 'e1', from: { nodeId: 'a', port: 'out' }, to: { nodeId: 'b', port: 'in' } },
          { id: 'e2', from: { nodeId: 'b', port: 'out' }, to: { nodeId: 'c', port: 'in' } },
        ],
      }),
    );
    expect(r.errors).toEqual([]);
    expect(r.graph.adjacency).toEqual({ a: ['b'], b: ['c'], c: [] });
    expect(r.graph.reverseAdjacency).toEqual({ a: [], b: ['a'], c: ['b'] });
  });

  it('reports UNKNOWN_NODE_TYPE without crashing the resolver', () => {
    const r = resolve(
      wf({
        nodes: [
          { id: 'a', type: 'start' },
          { id: 'b', type: 'not.a.real.type' },
        ],
        edges: [
          { id: 'e1', from: { nodeId: 'a', port: 'out' }, to: { nodeId: 'b', port: 'in' } },
        ],
      }),
    );
    expect(r.errors.some((e) => e.code === 'UNKNOWN_NODE_TYPE')).toBe(true);
    // Adjacency still built so cycle detection has something to walk.
    expect(r.graph.adjacency.a).toEqual(['b']);
  });

  it('flags SELF_LOOP and DANGLING_EDGE', () => {
    const r = resolve(
      wf({
        nodes: [
          { id: 'a', type: 'transform' },
          { id: 'b', type: 'transform' },
        ],
        edges: [
          { id: 'self', from: { nodeId: 'a', port: 'out' }, to: { nodeId: 'a', port: 'in' } },
          { id: 'gone', from: { nodeId: 'a', port: 'out' }, to: { nodeId: 'ghost', port: 'in' } },
        ],
      }),
    );
    const codes = r.errors.map((e) => e.code);
    expect(codes).toContain('SELF_LOOP');
    expect(codes).toContain('DANGLING_EDGE');
  });

  it('flags PORT_MISMATCH when output kind != input kind', () => {
    // start.out is signal; llm.call.in is data — mismatch.
    const r = resolve(
      wf({
        nodes: [
          { id: 'a', type: 'start' },
          { id: 'b', type: 'llm.call' },
        ],
        edges: [
          { id: 'e1', from: { nodeId: 'a', port: 'out' }, to: { nodeId: 'b', port: 'in' } },
        ],
      }),
    );
    expect(r.errors.some((e) => e.code === 'PORT_MISMATCH')).toBe(true);
  });

  it('flags DANGLING_EDGE for unknown port names', () => {
    const r = resolve(
      wf({
        nodes: [
          { id: 'a', type: 'start' },
          { id: 'b', type: 'end' },
        ],
        edges: [
          { id: 'e1', from: { nodeId: 'a', port: 'nope' }, to: { nodeId: 'b', port: 'in' } },
        ],
      }),
    );
    expect(
      r.errors.filter(
        (e) => e.code === 'DANGLING_EDGE' && e.path.endsWith('from.port'),
      ),
    ).toHaveLength(1);
  });

  it('reports ISOLATED_NODE only when more than one node exists', () => {
    const lone = resolve(wf({ nodes: [{ id: 'only', type: 'start' }] }));
    expect(lone.errors.some((e) => e.code === 'ISOLATED_NODE')).toBe(false);

    const orphan = resolve(
      wf({
        nodes: [
          { id: 'a', type: 'start' },
          { id: 'b', type: 'end' },
          { id: 'orphan', type: 'transform' },
        ],
        edges: [
          { id: 'e1', from: { nodeId: 'a', port: 'out' }, to: { nodeId: 'b', port: 'in' } },
        ],
      }),
    );
    expect(orphan.errors.some((e) => e.code === 'ISOLATED_NODE')).toBe(true);
  });

  it('deduplicates parallel edges in the adjacency lists', () => {
    const r = resolve(
      wf({
        nodes: [
          { id: 'a', type: 'transform' },
          { id: 'b', type: 'transform' },
        ],
        edges: [
          { id: 'e1', from: { nodeId: 'a', port: 'out' }, to: { nodeId: 'b', port: 'in' } },
          { id: 'e2', from: { nodeId: 'a', port: 'out' }, to: { nodeId: 'b', port: 'in' } },
        ],
      }),
    );
    expect(r.graph.adjacency.a).toEqual(['b']);
    expect(r.graph.reverseAdjacency.b).toEqual(['a']);
  });
});
