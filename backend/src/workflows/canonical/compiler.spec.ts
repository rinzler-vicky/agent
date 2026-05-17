import { compile } from '@/workflows/canonical/compiler';

// Port-kind compatibility: start.out=signal -> http.in=signal, http.out=data ->
// end.in=any. This is the smallest non-trivial chain that survives port-type
// validation with the seeded registry.
const happyInput = {
  schemaVersion: '1',
  id: 'wf_happy',
  name: 'happy path',
  description: 'minimal three-node chain',
  nodes: [
    { id: 'start1', type: 'start' },
    { id: 'http1', type: 'http.request' },
    { id: 'finish', type: 'end' },
  ],
  edges: [
    { id: 'e1', from: { nodeId: 'start1', port: 'out' }, to: { nodeId: 'http1', port: 'in' } },
    { id: 'e2', from: { nodeId: 'http1', port: 'out' }, to: { nodeId: 'finish', port: 'in' } },
  ],
};

describe('compile (orchestrator)', () => {
  it('emits a CompiledWorkflow on a valid input', () => {
    const r = compile(happyInput);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.compiled.id).toBe('wf_happy');
    expect(Object.keys(r.compiled.nodes)).toEqual(['finish', 'http1', 'start1']);
    expect(r.compiled.topoOrder).toEqual(['start1', 'http1', 'finish']);
    expect(r.compiled.sourceHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('aggregates errors across stages (unknown type + cycle)', () => {
    const r = compile({
      schemaVersion: '1',
      id: 'wf_bad',
      name: 'bad',
      nodes: [
        { id: 'a', type: 'transform' },
        { id: 'b', type: 'transform' },
        { id: 'c', type: 'not.a.real.type' },
      ],
      edges: [
        // a <-> b cycle
        { id: 'e1', from: { nodeId: 'a', port: 'out' }, to: { nodeId: 'b', port: 'in' } },
        { id: 'e2', from: { nodeId: 'b', port: 'out' }, to: { nodeId: 'a', port: 'in' } },
        // c is wired in too so it is not also flagged as isolated
        { id: 'e3', from: { nodeId: 'a', port: 'out' }, to: { nodeId: 'c', port: 'in' } },
      ],
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    const codes = new Set(r.errors.map((e) => e.code));
    expect(codes.has('UNKNOWN_NODE_TYPE')).toBe(true);
    expect(codes.has('CYCLE_DETECTED')).toBe(true);
  });

  it('returns only parse errors and skips later stages when parse fails', () => {
    const r = compile({ schemaVersion: '1', id: 'x', name: 'x', nodes: 'nope', edges: [] });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.every((e) => e.code === 'SCHEMA_INVALID')).toBe(true);
  });

  it('omits the description field when not present in input', () => {
    const { description: _omit, ...noDesc } = happyInput;
    const r = compile(noDesc);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect('description' in r.compiled).toBe(false);
  });
});
