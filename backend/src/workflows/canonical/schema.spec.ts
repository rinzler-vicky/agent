import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import {
  CanonicalEdgeDto,
  CanonicalNodeDto,
  CanonicalPortRefDto,
  CanonicalWorkflowDto,
} from '@/workflows/canonical/schema';

const validate = <T extends object>(cls: new () => T, raw: unknown) =>
  validateSync(plainToInstance(cls, raw as object), {
    whitelist: true,
    forbidNonWhitelisted: true,
    forbidUnknownValues: true,
    stopAtFirstError: false,
  });

describe('CanonicalPortRefDto', () => {
  it('accepts a valid port ref', () => {
    expect(validate(CanonicalPortRefDto, { nodeId: 'n1', port: 'out' })).toEqual(
      [],
    );
  });
  it('rejects empty nodeId', () => {
    expect(validate(CanonicalPortRefDto, { nodeId: '', port: 'out' }).length)
      .toBeGreaterThan(0);
  });
  it('rejects nodeId with disallowed characters', () => {
    expect(
      validate(CanonicalPortRefDto, { nodeId: 'n 1', port: 'out' }).length,
    ).toBeGreaterThan(0);
  });
});

describe('CanonicalNodeDto', () => {
  it('accepts a node with optional config omitted', () => {
    expect(validate(CanonicalNodeDto, { id: 'n1', type: 'start' })).toEqual([]);
  });
  it('rejects a node with missing id', () => {
    expect(validate(CanonicalNodeDto, { type: 'start' }).length).toBeGreaterThan(0);
  });
});

describe('CanonicalEdgeDto', () => {
  it('accepts a valid edge', () => {
    expect(
      validate(CanonicalEdgeDto, {
        id: 'e1',
        from: { nodeId: 'n1', port: 'out' },
        to: { nodeId: 'n2', port: 'in' },
      }),
    ).toEqual([]);
  });
  it('rejects a malformed nested port ref', () => {
    expect(
      validate(CanonicalEdgeDto, {
        id: 'e1',
        from: { nodeId: '', port: 'out' },
        to: { nodeId: 'n2', port: 'in' },
      }).length,
    ).toBeGreaterThan(0);
  });
});

describe('CanonicalWorkflowDto', () => {
  it('accepts a minimal valid workflow', () => {
    expect(
      validate(CanonicalWorkflowDto, {
        schemaVersion: '1',
        id: 'wf_1',
        name: 'minimal',
        nodes: [{ id: 'a', type: 'start' }],
        edges: [],
      }),
    ).toEqual([]);
  });
  it('rejects when nodes is not an array', () => {
    expect(
      validate(CanonicalWorkflowDto, {
        schemaVersion: '1',
        id: 'wf_1',
        name: 'bad',
        nodes: 'not-an-array',
        edges: [],
      }).length,
    ).toBeGreaterThan(0);
  });
});
