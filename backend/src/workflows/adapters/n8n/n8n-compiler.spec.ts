import { compile } from '@/workflows/canonical';
import { compileToN8n, N8nCompileError } from './n8n-compiler';
import type { N8nCompileOptions } from './n8n-compiler';

const OPTS: N8nCompileOptions = {
  workflowName: 'wf-test',
  webhookBaseUrl: 'http://backend:3000',
  webhookSecret: 'static-secret-token',
  workflowVersionId: '11111111-1111-1111-1111-111111111111',
  tenantId: '22222222-2222-2222-2222-222222222222',
  errorWorkflowName: 'wf-test__error',
};

const linear = {
  schemaVersion: '1',
  id: 'wf_linear',
  name: 'Linear',
  nodes: [
    { id: 'a_start', type: 'start' },
    { id: 'b_http', type: 'http.request', config: { url: 'https://example.com', method: 'GET' } },
    { id: 'c_set', type: 'transform' },
    { id: 'd_end', type: 'end' },
  ],
  edges: [
    { id: 'e1', from: { nodeId: 'a_start', port: 'out' }, to: { nodeId: 'b_http', port: 'in' } },
    { id: 'e2', from: { nodeId: 'b_http', port: 'out' }, to: { nodeId: 'c_set', port: 'in' } },
    { id: 'e3', from: { nodeId: 'c_set', port: 'out' }, to: { nodeId: 'd_end', port: 'in' } },
  ],
};

const branch = {
  schemaVersion: '1',
  id: 'wf_branch',
  name: 'Branch',
  nodes: [
    { id: 'a_start', type: 'start' },
    { id: 'b_load', type: 'http.request', config: { url: 'https://example.com', method: 'GET' } },
    { id: 'c_branch', type: 'branch' },
    { id: 'd_true', type: 'transform' },
    { id: 'e_false', type: 'transform' },
    { id: 'f_end_t', type: 'end' },
    { id: 'g_end_f', type: 'end' },
  ],
  edges: [
    { id: 'e1', from: { nodeId: 'a_start', port: 'out' }, to: { nodeId: 'b_load', port: 'in' } },
    { id: 'e2', from: { nodeId: 'b_load', port: 'out' }, to: { nodeId: 'c_branch', port: 'in' } },
    { id: 'e3', from: { nodeId: 'c_branch', port: 'true' }, to: { nodeId: 'd_true', port: 'in' } },
    { id: 'e4', from: { nodeId: 'c_branch', port: 'false' }, to: { nodeId: 'e_false', port: 'in' } },
    { id: 'e5', from: { nodeId: 'd_true', port: 'out' }, to: { nodeId: 'f_end_t', port: 'in' } },
    { id: 'e6', from: { nodeId: 'e_false', port: 'out' }, to: { nodeId: 'g_end_f', port: 'in' } },
  ],
};

function compileOk(raw: any) {
  const r = compile(raw);
  if (!r.ok) throw new Error('canonical compile failed: ' + JSON.stringify(r.errors));
  return r.compiled;
}

describe('compileToN8n', () => {
  it('compiles a linear canonical workflow into n8n shape', () => {
    const artifact = compileToN8n(compileOk(linear), OPTS);
    const names = artifact.workflow.nodes.map((n) => n.name);

    expect(names).toContain('__trigger');
    expect(names).toContain('__start_ping');
    expect(names).toContain('__end_ping');
    expect(names).toContain('b_http');
    expect(names).toContain('c_set');
    expect(names).toContain('__pre_b_http');
    expect(names).toContain('__post_c_set');
    expect(names).not.toContain('a_start');
    expect(names).not.toContain('d_end');

    expect(artifact.workflow.connections.__trigger.main[0][0].node).toBe('__start_ping');
    expect(artifact.workflow.connections.__start_ping.main[0][0].node).toBe('__pre_b_http');
    expect(artifact.workflow.connections.__pre_b_http.main[0][0].node).toBe('b_http');
    expect(artifact.workflow.connections.b_http.main[0][0].node).toBe('__post_b_http');
  });

  it('emits a separate errorWorkflow with errorTrigger + failure ping', () => {
    const artifact = compileToN8n(compileOk(linear), OPTS);
    const ewNames = artifact.errorWorkflow.nodes.map((n) => n.name);
    expect(ewNames).toEqual(['__error_trigger', '__failure_ping'].sort());
    expect(artifact.errorWorkflow.nodes.find((n) => n.name === '__error_trigger')!.type).toBe(
      'n8n-nodes-base.errorTrigger',
    );
  });

  it('handles a branching topology', () => {
    const artifact = compileToN8n(compileOk(branch), OPTS);
    const names = artifact.workflow.nodes.map((n) => n.name);
    expect(names).toContain('c_branch');
    expect(names).toContain('d_true');
    expect(names).toContain('e_false');
    expect(names).toContain('__pre_c_branch');
    expect(names).toContain('__post_e_false');
  });

  it('fails loudly on unsupported parallel node type', () => {
    const wf = {
      schemaVersion: '1',
      id: 'wf_par',
      name: 'Parallel',
      nodes: [
        { id: 'a_start', type: 'start' },
        { id: 'b_load', type: 'http.request', config: { url: 'https://example.com', method: 'GET' } },
        { id: 'c_par', type: 'parallel' },
        { id: 'd_end', type: 'end' },
      ],
      edges: [
        { id: 'e1', from: { nodeId: 'a_start', port: 'out' }, to: { nodeId: 'b_load', port: 'in' } },
        { id: 'e2', from: { nodeId: 'b_load', port: 'out' }, to: { nodeId: 'c_par', port: 'in' } },
        { id: 'e3', from: { nodeId: 'c_par', port: 'out' }, to: { nodeId: 'd_end', port: 'in' } },
      ],
    };
    expect(() => compileToN8n(compileOk(wf), OPTS)).toThrow(N8nCompileError);
    expect(() => compileToN8n(compileOk(wf), OPTS)).toThrow(/parallel/);
  });

  it('fails loudly on unsupported error.handle node type', () => {
    const wf = {
      schemaVersion: '1',
      id: 'wf_eh',
      name: 'ErrorHandle',
      nodes: [
        { id: 'a_start', type: 'start' },
        { id: 'b_eh', type: 'error.handle' },
        { id: 'c_end', type: 'end' },
      ],
      edges: [
        { id: 'e1', from: { nodeId: 'a_start', port: 'out' }, to: { nodeId: 'b_eh', port: 'in' } },
        { id: 'e2', from: { nodeId: 'b_eh', port: 'out' }, to: { nodeId: 'c_end', port: 'in' } },
      ],
    };
    expect(() => compileToN8n(compileOk(wf), OPTS)).toThrow(/error\.handle/);
  });

  describe('determinism (AC: same canonical → byte-identical n8n JSON)', () => {
    it('produces byte-identical JSON across 50 iterations for the linear fixture', () => {
      const c = compileOk(linear);
      const first = JSON.stringify(compileToN8n(c, OPTS));
      for (let i = 0; i < 50; i++) {
        expect(JSON.stringify(compileToN8n(c, OPTS))).toBe(first);
      }
    });

    it('produces byte-identical JSON across 50 iterations for the branch fixture', () => {
      const c = compileOk(branch);
      const first = JSON.stringify(compileToN8n(c, OPTS));
      for (let i = 0; i < 50; i++) {
        expect(JSON.stringify(compileToN8n(c, OPTS))).toBe(first);
      }
    });

    it('sorts node array and connection keys lexicographically', () => {
      const artifact = compileToN8n(compileOk(branch), OPTS);
      const names = artifact.workflow.nodes.map((n) => n.name);
      expect(names).toEqual([...names].sort());
      const connKeys = Object.keys(artifact.workflow.connections);
      expect(connKeys).toEqual([...connKeys].sort());
    });
  });

  it('carries canonicalHash from the upstream compiled workflow', () => {
    const c = compileOk(linear);
    const artifact = compileToN8n(c, OPTS);
    expect(artifact.canonicalHash).toBe(c.sourceHash);
  });

  it('embeds the static webhook secret in each ping node header', () => {
    const artifact = compileToN8n(compileOk(linear), OPTS);
    const pings = artifact.workflow.nodes.filter((n) => n.name.startsWith('__'));
    const wfPings = pings.filter((n) => n.type === 'n8n-nodes-base.httpRequest');
    expect(wfPings.length).toBeGreaterThan(0);
    for (const ping of wfPings) {
      const headers = (ping.parameters as any).headerParameters?.parameters;
      const secret = headers.find((h: any) => h.name === 'x-agent-webhook-secret');
      expect(secret.value).toBe(OPTS.webhookSecret);
    }
  });
});
