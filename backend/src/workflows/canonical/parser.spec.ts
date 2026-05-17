import { parse } from '@/workflows/canonical/parser';

const validInput = {
  schemaVersion: '1',
  id: 'wf_1',
  name: 'happy',
  nodes: [
    { id: 'a', type: 'start' },
    { id: 'b', type: 'end' },
  ],
  edges: [
    { id: 'e1', from: { nodeId: 'a', port: 'out' }, to: { nodeId: 'b', port: 'in' } },
  ],
};

describe('parse', () => {
  it('parses a structurally valid workflow', () => {
    const r = parse(validInput);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.id).toBe('wf_1');
      expect(r.value.nodes).toHaveLength(2);
    }
  });

  it('rejects null/array/non-object inputs without throwing', () => {
    expect(parse(null).ok).toBe(false);
    expect(parse([]).ok).toBe(false);
    expect(parse(42 as unknown).ok).toBe(false);
  });

  it('collects multiple field errors instead of bailing at the first', () => {
    const r = parse({
      schemaVersion: '1',
      id: '',
      name: 123 as unknown,
      nodes: [{ id: 'n 1', type: 'start' }],
      edges: [],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const codes = r.errors.map((e) => e.code);
      expect(codes.every((c) => c === 'SCHEMA_INVALID' || c === 'DUPLICATE_NODE_ID')).toBe(
        true,
      );
      expect(r.errors.length).toBeGreaterThanOrEqual(2);
    }
  });

  it('rejects unknown top-level fields (whitelist)', () => {
    const r = parse({ ...validInput, undeclared: 'nope' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.some((e) => /undeclared/.test(e.path))).toBe(true);
    }
  });

  it('detects duplicate node ids and edge ids', () => {
    const r = parse({
      schemaVersion: '1',
      id: 'wf_dup',
      name: 'dup',
      nodes: [
        { id: 'a', type: 'start' },
        { id: 'a', type: 'end' },
      ],
      edges: [
        { id: 'e1', from: { nodeId: 'a', port: 'out' }, to: { nodeId: 'a', port: 'in' } },
        { id: 'e1', from: { nodeId: 'a', port: 'out' }, to: { nodeId: 'a', port: 'in' } },
      ],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const dup = r.errors.filter((e) => e.code === 'DUPLICATE_NODE_ID');
      expect(dup).toHaveLength(2);
    }
  });

  it('reports nested field paths', () => {
    const r = parse({
      schemaVersion: '1',
      id: 'wf_1',
      name: 'bad-edge',
      nodes: [{ id: 'a', type: 'start' }, { id: 'b', type: 'end' }],
      edges: [
        { id: 'e1', from: { nodeId: '', port: 'out' }, to: { nodeId: 'b', port: 'in' } },
      ],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(
        r.errors.some((e) => e.path.startsWith('edges.0.from')),
      ).toBe(true);
    }
  });
});
