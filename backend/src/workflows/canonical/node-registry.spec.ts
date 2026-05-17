import {
  KNOWN_NODE_TYPES,
  NODE_REGISTRY,
  getNodeSpec,
  isKnownNodeType,
  portsCompatible,
} from '@/workflows/canonical/node-registry';

describe('node registry', () => {
  it('contains exactly the eleven seeded node types', () => {
    const expected = [
      'branch',
      'end',
      'error.handle',
      'http.request',
      'llm.call',
      'loop',
      'parallel',
      'start',
      'tool.call',
      'transform',
      'wait',
    ];
    expect(KNOWN_NODE_TYPES.slice().sort()).toEqual(expected);
  });

  it('every node spec declares input and output arrays (possibly empty)', () => {
    for (const [type, spec] of Object.entries(NODE_REGISTRY)) {
      expect(spec.type).toBe(type);
      expect(Array.isArray(spec.inputs)).toBe(true);
      expect(Array.isArray(spec.outputs)).toBe(true);
    }
  });

  it('start has no inputs and end has no outputs', () => {
    expect(NODE_REGISTRY.start.inputs).toEqual([]);
    expect(NODE_REGISTRY.end.outputs).toEqual([]);
  });

  it('isKnownNodeType reflects registry membership', () => {
    expect(isKnownNodeType('start')).toBe(true);
    expect(isKnownNodeType('not.a.type')).toBe(false);
  });

  it('getNodeSpec returns the spec or undefined', () => {
    expect(getNodeSpec('http.request')).toBeDefined();
    expect(getNodeSpec('does.not.exist')).toBeUndefined();
  });

  describe('portsCompatible', () => {
    it('matches identical kinds', () => {
      expect(portsCompatible('signal', 'signal')).toBe(true);
      expect(portsCompatible('data', 'data')).toBe(true);
    });
    it('rejects mismatched concrete kinds', () => {
      expect(portsCompatible('signal', 'data')).toBe(false);
      expect(portsCompatible('data', 'signal')).toBe(false);
    });
    it('accepts any on either side', () => {
      expect(portsCompatible('any', 'data')).toBe(true);
      expect(portsCompatible('data', 'any')).toBe(true);
      expect(portsCompatible('any', 'any')).toBe(true);
    });
  });
});
