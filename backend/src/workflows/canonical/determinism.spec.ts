import { compile } from '@/workflows/canonical/compiler';
import type { CompiledWorkflow } from '@/workflows/canonical/types';

const stableInput = {
  schemaVersion: '1',
  id: 'wf_det',
  name: 'determinism',
  nodes: [
    { id: 'a', type: 'start' },
    { id: 'b', type: 'http.request' },
    { id: 'c', type: 'transform' },
    { id: 'd', type: 'transform' },
    { id: 'e', type: 'end' },
  ],
  edges: [
    { id: 'e1', from: { nodeId: 'a', port: 'out' }, to: { nodeId: 'b', port: 'in' } },
    { id: 'e2', from: { nodeId: 'b', port: 'out' }, to: { nodeId: 'c', port: 'in' } },
    { id: 'e3', from: { nodeId: 'b', port: 'out' }, to: { nodeId: 'd', port: 'in' } },
    { id: 'e4', from: { nodeId: 'c', port: 'out' }, to: { nodeId: 'e', port: 'in' } },
    { id: 'e5', from: { nodeId: 'd', port: 'out' }, to: { nodeId: 'e', port: 'in' } },
  ],
};

const expectCompiled = (input: unknown): CompiledWorkflow => {
  const r = compile(input);
  if (!r.ok) throw new Error(`compile failed: ${JSON.stringify(r.errors)}`);
  return r.compiled;
};

describe('compiler determinism', () => {
  it('produces a byte-identical JSON.stringify across 100 sequential runs', () => {
    const first = JSON.stringify(expectCompiled(stableInput));
    for (let i = 0; i < 100; i++) {
      expect(JSON.stringify(expectCompiled(stableInput))).toBe(first);
    }
  });

  it('produces identical output when input object keys are reordered', () => {
    const reordered = {
      edges: stableInput.edges,
      nodes: stableInput.nodes,
      name: stableInput.name,
      id: stableInput.id,
      schemaVersion: stableInput.schemaVersion,
    };
    expect(JSON.stringify(expectCompiled(reordered))).toBe(
      JSON.stringify(expectCompiled(stableInput)),
    );
  });

  it('produces identical output when node and edge arrays are reordered', () => {
    const shuffled = {
      ...stableInput,
      nodes: [...stableInput.nodes].reverse(),
      edges: [...stableInput.edges].reverse(),
    };
    expect(JSON.stringify(expectCompiled(shuffled))).toBe(
      JSON.stringify(expectCompiled(stableInput)),
    );
  });

  it('produces the same sourceHash for inputs that differ only in key ordering', () => {
    const reordered = {
      edges: stableInput.edges,
      nodes: [...stableInput.nodes].reverse(),
      name: stableInput.name,
      id: stableInput.id,
      schemaVersion: stableInput.schemaVersion,
    };
    expect(expectCompiled(reordered).sourceHash).toBe(
      expectCompiled(stableInput).sourceHash,
    );
  });
});
