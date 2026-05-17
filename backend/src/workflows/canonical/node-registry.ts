export type PortKind = 'signal' | 'data' | 'any';

export interface PortSpec {
  name: string;
  kind: PortKind;
}

export interface NodeSpec {
  type: string;
  inputs: PortSpec[];
  outputs: PortSpec[];
}

const def = (
  type: string,
  inputs: PortSpec[],
  outputs: PortSpec[],
): [string, NodeSpec] => [type, { type, inputs, outputs }];

export const NODE_REGISTRY: Readonly<Record<string, NodeSpec>> = Object.freeze(
  Object.fromEntries([
    def('start', [], [{ name: 'out', kind: 'signal' }]),
    def('end', [{ name: 'in', kind: 'any' }], []),
    def(
      'http.request',
      [{ name: 'in', kind: 'signal' }],
      [{ name: 'out', kind: 'data' }],
    ),
    def(
      'llm.call',
      [{ name: 'in', kind: 'data' }],
      [{ name: 'out', kind: 'data' }],
    ),
    def(
      'tool.call',
      [{ name: 'in', kind: 'data' }],
      [{ name: 'out', kind: 'data' }],
    ),
    def(
      'branch',
      [{ name: 'in', kind: 'data' }],
      [
        { name: 'true', kind: 'data' },
        { name: 'false', kind: 'data' },
      ],
    ),
    def(
      'transform',
      [{ name: 'in', kind: 'data' }],
      [{ name: 'out', kind: 'data' }],
    ),
    def(
      'loop',
      [{ name: 'in', kind: 'data' }],
      [
        { name: 'body', kind: 'data' },
        { name: 'done', kind: 'data' },
      ],
    ),
    def(
      'parallel',
      [{ name: 'in', kind: 'data' }],
      [{ name: 'out', kind: 'data' }],
    ),
    def(
      'wait',
      [{ name: 'in', kind: 'any' }],
      [{ name: 'out', kind: 'any' }],
    ),
    def(
      'error.handle',
      [{ name: 'in', kind: 'any' }],
      [{ name: 'out', kind: 'any' }],
    ),
  ]),
);

export const KNOWN_NODE_TYPES: readonly string[] = Object.freeze(
  Object.keys(NODE_REGISTRY).sort(),
);

export const isKnownNodeType = (type: string): boolean =>
  Object.prototype.hasOwnProperty.call(NODE_REGISTRY, type);

export const getNodeSpec = (type: string): NodeSpec | undefined =>
  NODE_REGISTRY[type];

export const portsCompatible = (out: PortKind, into: PortKind): boolean =>
  out === into || out === 'any' || into === 'any';
