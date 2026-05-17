import { topologicalSort } from '@/workflows/canonical/topological-sort';

describe('topologicalSort', () => {
  it('returns nodes in lexicographic order when no edges exist', () => {
    expect(topologicalSort(['b', 'a', 'c'], { a: [], b: [], c: [] })).toEqual([
      'a',
      'b',
      'c',
    ]);
  });

  it('respects edge dependencies', () => {
    const order = topologicalSort(['a', 'b', 'c'], { a: ['b'], b: ['c'], c: [] })!;
    expect(order.indexOf('a')).toBeLessThan(order.indexOf('b'));
    expect(order.indexOf('b')).toBeLessThan(order.indexOf('c'));
  });

  it('produces deterministic output for diamond graphs across many runs', () => {
    // a -> b, a -> c, b -> d, c -> d. b and c are both ready after a;
    // deterministic tiebreak picks b first because "b" < "c".
    const ids = ['a', 'b', 'c', 'd'];
    const adj = { a: ['b', 'c'], b: ['d'], c: ['d'], d: [] };
    const first = topologicalSort(ids, adj);
    expect(first).toEqual(['a', 'b', 'c', 'd']);
    for (let i = 0; i < 100; i++) {
      expect(topologicalSort(ids, adj)).toEqual(first);
    }
  });

  it('returns undefined on a cyclic input', () => {
    expect(topologicalSort(['a', 'b'], { a: ['b'], b: ['a'] })).toBeUndefined();
  });
});
