import { detectCycle } from '@/workflows/canonical/cycle-detector';

describe('detectCycle', () => {
  it('returns hasCycle=false on a simple DAG', () => {
    const r = detectCycle(
      ['a', 'b', 'c'],
      { a: ['b'], b: ['c'], c: [] },
    );
    expect(r.hasCycle).toBe(false);
    expect(r.errors).toEqual([]);
  });

  it('returns hasCycle=false on the empty graph', () => {
    expect(detectCycle([], {}).hasCycle).toBe(false);
  });

  it('finds a two-node cycle and reports the path', () => {
    const r = detectCycle(['a', 'b'], { a: ['b'], b: ['a'] });
    expect(r.hasCycle).toBe(true);
    expect(r.cyclePath?.[0]).toBe(r.cyclePath?.[r.cyclePath.length - 1]);
    expect(r.cyclePath).toContain('a');
    expect(r.cyclePath).toContain('b');
  });

  it('finds a four-node cycle', () => {
    const r = detectCycle(
      ['a', 'b', 'c', 'd'],
      { a: ['b'], b: ['c'], c: ['d'], d: ['a'] },
    );
    expect(r.hasCycle).toBe(true);
    expect(r.cyclePath?.length).toBeGreaterThanOrEqual(5); // 4 nodes + closing repeat
  });

  it('finds a cycle nested inside a larger DAG', () => {
    // a -> b -> c -> b is the cycle; d is a separate sink off a.
    const r = detectCycle(
      ['a', 'b', 'c', 'd'],
      { a: ['b', 'd'], b: ['c'], c: ['b'], d: [] },
    );
    expect(r.hasCycle).toBe(true);
    expect(r.cyclePath).toBeDefined();
    // Cycle path must close on itself.
    expect(r.cyclePath?.[0]).toBe(r.cyclePath?.[r.cyclePath.length - 1]);
  });

  it('does not falsely flag a large diamond DAG', () => {
    // a -> b,c -> d; many parallel paths but no cycle.
    const nodeIds = ['a', 'b', 'c', 'd'];
    const adj = { a: ['b', 'c'], b: ['d'], c: ['d'], d: [] };
    for (let i = 0; i < 10; i++) {
      expect(detectCycle(nodeIds, adj).hasCycle).toBe(false);
    }
  });

  it('cycle path is deterministic for the same input', () => {
    const adj = { a: ['b'], b: ['c'], c: ['a'] };
    const first = detectCycle(['a', 'b', 'c'], adj).cyclePath;
    for (let i = 0; i < 20; i++) {
      expect(detectCycle(['a', 'b', 'c'], adj).cyclePath).toEqual(first);
    }
  });

  it('handles a deep linear DAG without stack overflow (iterative)', () => {
    const N = 5000;
    const ids = Array.from({ length: N }, (_, i) => `n${String(i).padStart(5, '0')}`);
    const adj: Record<string, string[]> = {};
    for (let i = 0; i < N; i++) adj[ids[i]] = i + 1 < N ? [ids[i + 1]] : [];
    expect(detectCycle(ids, adj).hasCycle).toBe(false);
  });
});
