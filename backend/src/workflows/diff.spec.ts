import { diffSpecs } from './diff';
import type { CanonicalWorkflow } from './canonical';

const baseSpec = (): CanonicalWorkflow => ({
  schemaVersion: '1',
  id: 'wf-test',
  name: 'Test Workflow',
  nodes: [
    { id: 'start1', type: 'start' } as any,
    { id: 'http1', type: 'http.request', config: { url: 'https://example.com' } } as any,
    { id: 'finish', type: 'end' } as any,
  ],
  edges: [
    { id: 'e1', from: { nodeId: 'start1', port: 'out' }, to: { nodeId: 'http1', port: 'in' } } as any,
    { id: 'e2', from: { nodeId: 'http1', port: 'out' }, to: { nodeId: 'finish', port: 'in' } } as any,
  ],
});

describe('diffSpecs', () => {
  it('returns an empty patch when both specs are identical', () => {
    const result = diffSpecs(baseSpec(), baseSpec(), 1, 2);
    expect(result.fromVersion).toBe(1);
    expect(result.toVersion).toBe(2);
    expect(result.fromHash).toBe(result.toHash);
    expect(result.patch).toEqual([]);
  });

  it('emits a `replace` op when a node config changes', () => {
    const from = baseSpec();
    const to = baseSpec();
    (to.nodes[1].config as any).url = 'https://changed.example.com';
    const result = diffSpecs(from, to, 1, 2);
    expect(result.fromHash).not.toBe(result.toHash);
    expect(
      result.patch.some(
        (op) => op.op === 'replace' && /\/nodes\/http1\/config\/url$/.test(op.path),
      ),
    ).toBe(true);
  });

  it('is order-insensitive: reordered input arrays produce no diff', () => {
    const from = baseSpec();
    const to = baseSpec();
    // Reverse the input node array. After compile() they become a sorted
    // Record<id, Node>, so the diff should be empty.
    to.nodes = [to.nodes[2], to.nodes[0], to.nodes[1]];
    const result = diffSpecs(from, to, 1, 2);
    expect(result.fromHash).toBe(result.toHash);
    expect(result.patch).toEqual([]);
  });

  it('throws when the `from` spec fails to compile', () => {
    expect(() => diffSpecs({}, baseSpec(), 1, 2)).toThrow(/from spec failed to compile/);
  });

  it('throws when the `to` spec fails to compile', () => {
    expect(() => diffSpecs(baseSpec(), { schemaVersion: '1.0' }, 1, 2)).toThrow(
      /to spec failed to compile/,
    );
  });
});
