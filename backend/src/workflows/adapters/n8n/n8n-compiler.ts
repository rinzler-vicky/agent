import type { CompiledWorkflow, CanonicalNode } from '@/workflows/canonical/types';
import type {
  N8nNode,
  N8nWorkflow,
  N8nConnections,
  N8nCompiledArtifact,
  N8nConnectionTarget,
} from './types';

export interface N8nCompileOptions {
  workflowName: string;
  webhookBaseUrl: string;
  webhookSecret: string;
  workflowVersionId: string;
  tenantId: string;
  errorWorkflowName?: string;
}

export class N8nCompileError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'N8nCompileError';
  }
}

const UNSUPPORTED_TYPES = new Set(['parallel', 'error.handle']);
const SYNTHETIC_TYPES = new Set(['start', 'end']);

const HTTP_REQUEST = 'n8n-nodes-base.httpRequest';
const HTTP_REQUEST_VERSION = 4.2;
const IF_NODE = 'n8n-nodes-base.if';
const IF_VERSION = 2;
const SPLIT_IN_BATCHES = 'n8n-nodes-base.splitInBatches';
const SPLIT_VERSION = 3;
const SET_NODE = 'n8n-nodes-base.set';
const SET_VERSION = 3.4;
const WAIT_NODE = 'n8n-nodes-base.wait';
const WAIT_VERSION = 1.1;
const ERROR_TRIGGER = 'n8n-nodes-base.errorTrigger';
const ERROR_TRIGGER_VERSION = 1;
const MANUAL_TRIGGER = 'n8n-nodes-base.manualTrigger';
const MANUAL_TRIGGER_VERSION = 1;

const WEBHOOK_PATH = '/v1/n8n/webhooks/execution';
const X_OFFSET = 240;
const PRE_DX = -80;
const POST_DX = 80;

/**
 * Compile a CompiledWorkflow (Phase 2.2 output) to a pair of n8n workflows:
 * the main workflow with injected pre/post-step pings, and a shared
 * errorWorkflow that fires on any failure. Both objects are byte-stable
 * for identical inputs (keys inserted in sorted order; no Date.now() inside).
 *
 * Determinism is load-bearing for the workflow_adapter_artifacts cache and
 * the issue #43 AC "same canonical → same n8n JSON byte-for-byte".
 */
export function compileToN8n(
  compiled: CompiledWorkflow,
  opts: N8nCompileOptions,
): N8nCompiledArtifact {
  for (const node of Object.values(compiled.nodes)) {
    if (UNSUPPORTED_TYPES.has(node.type)) {
      throw new N8nCompileError(
        'unsupported_node_type_for_n8n_adapter',
        `Canonical node type "${node.type}" (node id="${node.id}") is not yet mapped to n8n. ` +
          `Supported: http.request, llm.call, tool.call, branch, loop, transform, wait, start, end.`,
      );
    }
  }

  const functionalIds = compiled.topoOrder.filter(
    (id) => !SYNTHETIC_TYPES.has(compiled.nodes[id].type),
  );

  const nodes: N8nNode[] = [];
  const connections: N8nConnections = {};

  const triggerName = '__trigger';
  nodes.push({
    name: triggerName,
    type: MANUAL_TRIGGER,
    typeVersion: MANUAL_TRIGGER_VERSION,
    position: [0, 0],
    parameters: {},
  });

  const startPing = '__start_ping';
  nodes.push(
    pingNode(startPing, 1, 0, opts, {
      runIdParam: opts.workflowVersionId,
      tenantIdParam: opts.tenantId,
      event: 'workflow.started',
    }),
  );
  addConnection(connections, triggerName, startPing);

  let prevTail = startPing;
  functionalIds.forEach((canonicalId, idx) => {
    const baseX = (idx + 2) * X_OFFSET;
    const preName = `__pre_${canonicalId}`;
    const postName = `__post_${canonicalId}`;

    nodes.push(
      pingNode(preName, baseX + PRE_DX, 0, opts, {
        runIdParam: opts.workflowVersionId,
        tenantIdParam: opts.tenantId,
        event: 'step.started',
        stepKey: canonicalId,
      }),
    );

    const mainNode = canonicalToN8nNode(compiled.nodes[canonicalId], baseX, 0);
    nodes.push(mainNode);

    nodes.push(
      pingNode(postName, baseX + POST_DX, 0, opts, {
        runIdParam: opts.workflowVersionId,
        tenantIdParam: opts.tenantId,
        event: 'step.completed',
        stepKey: canonicalId,
      }),
    );

    addConnection(connections, prevTail, preName);
    addConnection(connections, preName, canonicalId);
    addConnection(connections, canonicalId, postName);
    prevTail = postName;
  });

  const endPing = '__end_ping';
  nodes.push(
    pingNode(endPing, (functionalIds.length + 2) * X_OFFSET, 0, opts, {
      runIdParam: opts.workflowVersionId,
      tenantIdParam: opts.tenantId,
      event: 'workflow.completed',
    }),
  );
  addConnection(connections, prevTail, endPing);

  const errorWorkflow = buildErrorWorkflow(opts);

  const workflow: N8nWorkflow = {
    name: opts.workflowName,
    nodes: [...nodes].sort((a, b) => a.name.localeCompare(b.name)),
    connections: sortConnections(connections),
    settings: {
      executionOrder: 'v1',
      saveExecutionProgress: true,
      saveDataErrorExecution: 'all',
      saveDataSuccessExecution: 'all',
      saveManualExecutions: true,
      timezone: 'UTC',
      ...(opts.errorWorkflowName ? { errorWorkflow: opts.errorWorkflowName } : {}),
    },
  };

  return {
    workflow,
    errorWorkflow,
    canonicalHash: compiled.sourceHash,
    compiledAt: '0000-00-00T00:00:00.000Z',
  };
}

function canonicalToN8nNode(node: CanonicalNode, x: number, y: number): N8nNode {
  const params = node.config ?? {};
  switch (node.type) {
    case 'http.request':
      return {
        name: node.id,
        type: HTTP_REQUEST,
        typeVersion: HTTP_REQUEST_VERSION,
        position: [x, y],
        parameters: params,
      };
    case 'llm.call':
      return {
        name: node.id,
        type: HTTP_REQUEST,
        typeVersion: HTTP_REQUEST_VERSION,
        position: [x, y],
        parameters: {
          method: 'POST',
          url: '={{ $env.N8N_WEBHOOK_BASE_URL }}/v1/agent/llm-call',
          sendBody: true,
          jsonBody: JSON.stringify(params),
          ...params,
        },
      };
    case 'tool.call':
      return {
        name: node.id,
        type: HTTP_REQUEST,
        typeVersion: HTTP_REQUEST_VERSION,
        position: [x, y],
        parameters: {
          method: 'POST',
          url: '={{ $env.N8N_WEBHOOK_BASE_URL }}/v1/agent/tool-call',
          sendBody: true,
          jsonBody: JSON.stringify(params),
          ...params,
        },
      };
    case 'branch':
      return {
        name: node.id,
        type: IF_NODE,
        typeVersion: IF_VERSION,
        position: [x, y],
        parameters: params,
      };
    case 'loop':
      return {
        name: node.id,
        type: SPLIT_IN_BATCHES,
        typeVersion: SPLIT_VERSION,
        position: [x, y],
        parameters: params,
      };
    case 'transform':
      return {
        name: node.id,
        type: SET_NODE,
        typeVersion: SET_VERSION,
        position: [x, y],
        parameters: params,
      };
    case 'wait':
      return {
        name: node.id,
        type: WAIT_NODE,
        typeVersion: WAIT_VERSION,
        position: [x, y],
        parameters: params,
      };
    default:
      throw new N8nCompileError(
        'unsupported_node_type_for_n8n_adapter',
        `Canonical node type "${node.type}" has no n8n mapping.`,
      );
  }
}

interface PingPayload {
  runIdParam: string;
  tenantIdParam: string;
  event: string;
  stepKey?: string;
}

function pingNode(
  name: string,
  x: number,
  y: number,
  opts: N8nCompileOptions,
  payload: PingPayload,
): N8nNode {
  const bodyObj: Record<string, unknown> = {
    runId: payload.runIdParam,
    tenantId: payload.tenantIdParam,
    event: payload.event,
    timestamp: '={{ $now.toISO() }}',
    n8nExecutionId: '={{ $execution.id }}',
  };
  if (payload.stepKey) bodyObj.stepKey = payload.stepKey;

  return {
    name,
    type: HTTP_REQUEST,
    typeVersion: HTTP_REQUEST_VERSION,
    position: [x, y],
    parameters: {
      method: 'POST',
      url: `${opts.webhookBaseUrl}${WEBHOOK_PATH}`,
      sendBody: true,
      bodyContentType: 'json',
      specifyBody: 'json',
      jsonBody: stableJson(bodyObj),
      sendHeaders: true,
      headerParameters: {
        parameters: [
          {
            name: 'x-agent-webhook-secret',
            value: opts.webhookSecret,
          },
          {
            name: 'content-type',
            value: 'application/json',
          },
        ],
      },
      options: {
        retry: { retries: 2 },
        response: { response: { neverError: true } },
      },
    },
  };
}

function buildErrorWorkflow(opts: N8nCompileOptions): N8nWorkflow {
  const triggerName = '__error_trigger';
  const pingName = '__failure_ping';

  const nodes: N8nNode[] = [
    {
      name: triggerName,
      type: ERROR_TRIGGER,
      typeVersion: ERROR_TRIGGER_VERSION,
      position: [0, 0],
      parameters: {},
    },
    pingNode(pingName, X_OFFSET, 0, opts, {
      runIdParam: opts.workflowVersionId,
      tenantIdParam: opts.tenantId,
      event: 'workflow.failed',
    }),
  ];
  const connections: N8nConnections = {};
  addConnection(connections, triggerName, pingName);

  return {
    name: opts.errorWorkflowName ?? `${opts.workflowName}__error_handler`,
    nodes: nodes.sort((a, b) => a.name.localeCompare(b.name)),
    connections: sortConnections(connections),
    settings: {
      executionOrder: 'v1',
      saveExecutionProgress: false,
      saveDataErrorExecution: 'all',
      saveDataSuccessExecution: 'none',
      saveManualExecutions: false,
      timezone: 'UTC',
    },
  };
}

function addConnection(
  conns: N8nConnections,
  from: string,
  to: string,
  outputName = 'main',
): void {
  const target: N8nConnectionTarget = { node: to, type: 'main', index: 0 };
  if (!conns[from]) conns[from] = {};
  if (!conns[from][outputName]) conns[from][outputName] = [[]];
  conns[from][outputName][0].push(target);
}

function sortConnections(conns: N8nConnections): N8nConnections {
  const result: N8nConnections = {};
  for (const key of Object.keys(conns).sort()) {
    const inner: Record<string, N8nConnectionTarget[][]> = {};
    for (const outKey of Object.keys(conns[key]).sort()) {
      inner[outKey] = conns[key][outKey].map((arr) =>
        [...arr].sort((a, b) => a.node.localeCompare(b.node)),
      );
    }
    result[key] = inner;
  }
  return result;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableJson(obj[k])}`).join(',')}}`;
}

export { stableJson as __test_stableJson };
