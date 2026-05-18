import type {
  CompiledWorkflow,
  CanonicalNode,
  CanonicalEdge,
} from '@/workflows/canonical/types';
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

const TRIGGER_NAME = '__trigger';
const START_PING = '__start_ping';
const END_PING = '__end_ping';
const END_CANCELLED = '__end_cancelled';
const CANCEL_CHECK_PREFIX = '__cancel_check_';
const CHECK_DX = -40; // sits between __pre_<id> (PRE_DX = -80) and the canonical node (0)

/**
 * Canonical output port → n8n output index for multi-output node types.
 * n8n IF node: 0 = true, 1 = false. n8n splitInBatches: 0 = body, 1 = done.
 */
const PORT_INDEX: Record<string, Record<string, number>> = {
  branch: { true: 0, false: 1 },
  loop: { body: 0, done: 1 },
};

const MULTI_OUTPUT_TYPES = new Set(Object.keys(PORT_INDEX));

/**
 * Compile a CompiledWorkflow (Phase 2.2 output) to a pair of n8n workflows:
 * the main workflow with injected pre-step pings and a trailing post-ping
 * for single-output nodes; plus a shared errorWorkflow that fires on any
 * failure. Both objects are byte-stable for identical inputs (keys inserted
 * in sorted order; no Date.now() inside).
 *
 * Determinism is load-bearing for the workflow_adapter_artifacts cache and
 * the issue #43 AC "same canonical → same n8n JSON byte-for-byte".
 *
 * Connections are built from `compiled.edges` so multi-output canonical
 * nodes (branch/loop) route to distinct n8n output indices instead of
 * collapsing onto main[0].
 *
 * Runtime values that vary per execution are wired as n8n expressions:
 *   - main workflow pings read `runId` and `tenantId` from the `__trigger`
 *     node's input (Phase 2.4 will call `POST /workflows/{id}/run` with
 *     these in the trigger payload);
 *   - the error workflow's failure ping reads `n8nExecutionId` from
 *     `$execution.id` and surfaces workflow/error context from
 *     `$json.execution.*` / `$json.workflow.id`. It does NOT carry
 *     `runId`/`tenantId` (an Error Trigger has no access to the original
 *     trigger payload), so the webhook handler currently routes those
 *     events to an audit-only path — Phase 2.4 will add an
 *     `n8n_execution_id` column pre-recorded at trigger time so failure
 *     events can be back-resolved to the originating run.
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
  const positionByCanonicalId = new Map(
    functionalIds.map((id, idx) => [id, idx]),
  );

  const nodes: N8nNode[] = [];
  const connections: N8nConnections = {};

  nodes.push({
    name: TRIGGER_NAME,
    type: MANUAL_TRIGGER,
    typeVersion: MANUAL_TRIGGER_VERSION,
    position: [0, 0],
    parameters: {},
  });

  nodes.push(
    pingNode(START_PING, X_OFFSET, 0, opts, {
      event: 'workflow.started',
      triggerSource: 'manual',
    }),
  );
  addConnection(connections, TRIGGER_NAME, START_PING);

  // Track which canonical nodes have a post-ping (only single-output types).
  const hasPostPing = (canonicalType: string) =>
    !MULTI_OUTPUT_TYPES.has(canonicalType) && !SYNTHETIC_TYPES.has(canonicalType);

  for (const canonicalId of functionalIds) {
    const idx = positionByCanonicalId.get(canonicalId) ?? 0;
    const baseX = (idx + 2) * X_OFFSET;
    const preName = `__pre_${canonicalId}`;
    const postName = `__post_${canonicalId}`;
    const checkName = `${CANCEL_CHECK_PREFIX}${canonicalId}`;
    const node = compiled.nodes[canonicalId];

    nodes.push(
      pingNode(preName, baseX + PRE_DX, 0, opts, {
        event: 'step.started',
        stepKey: canonicalId,
        triggerSource: 'manual',
      }),
    );

    // Cooperative cancel: the pre-ping returns { cancelled: boolean } from
    // the webhook handler (a single SELECT against workflow_runs.status).
    // The IF routes the true branch to the shared __end_cancelled sink and
    // the false branch to the actual canonical node. n8n IF v2 output
    // index 0 = true, 1 = false (matches PORT_INDEX.branch).
    nodes.push(cancelCheckNode(checkName, baseX + CHECK_DX, 0));
    addConnection(connections, preName, checkName);
    addConnection(connections, checkName, END_CANCELLED, 'main', 0);
    addConnection(connections, checkName, canonicalId, 'main', 1);

    nodes.push(canonicalToN8nNode(node, baseX, 0, opts));

    if (hasPostPing(node.type)) {
      nodes.push(
        pingNode(postName, baseX + POST_DX, 0, opts, {
          event: 'step.completed',
          stepKey: canonicalId,
          triggerSource: 'manual',
        }),
      );
      addConnection(connections, canonicalId, postName);
    }
  }

  // Single sink for cooperative cancel. Emits one workflow.cancelled event
  // per run (only the first IF that resolves to true reaches this sink;
  // subsequent steps never run because their pre-pings are not invoked).
  nodes.push(
    pingNode(END_CANCELLED, (functionalIds.length + 2) * X_OFFSET, 120, opts, {
      event: 'workflow.cancelled',
      triggerSource: 'manual',
    }),
  );

  // Drive forward connections from canonical edges (port-aware).
  for (const edge of compiled.edges) {
    routeEdge(edge, compiled.nodes, connections, hasPostPing);
  }

  nodes.push(
    pingNode(END_PING, (functionalIds.length + 2) * X_OFFSET, 0, opts, {
      event: 'workflow.completed',
      triggerSource: 'manual',
    }),
  );

  // Sinks (no outbound canonical edges to functional/end) need an explicit
  // edge to __end_ping; routeEdge already wires the end-targeting edges,
  // and any node whose post-ping has no outbound connection joins __end_ping.
  wireDanglingTails(compiled, connections, hasPostPing);

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

function routeEdge(
  edge: CanonicalEdge,
  nodesById: Record<string, CanonicalNode>,
  connections: N8nConnections,
  hasPostPing: (type: string) => boolean,
): void {
  const fromNode = nodesById[edge.from.nodeId];
  const toNode = nodesById[edge.to.nodeId];
  if (!fromNode || !toNode) return;

  // Edges originating at canonical `start` collapse into the start-ping →
  // pre-target chain, which we already wired above (pre nodes have their
  // own incoming edge from the start-ping ladder built below).
  // Edges terminating at canonical `end` route to __end_ping.
  const sourceIsStart = fromNode.type === 'start';
  const targetIsEnd = toNode.type === 'end';

  const sourceName = sourceIsStart
    ? START_PING
    : hasPostPing(fromNode.type)
      ? `__post_${fromNode.id}`
      : fromNode.id;
  const outputIndex = sourceIsStart || hasPostPing(fromNode.type)
    ? 0
    : (PORT_INDEX[fromNode.type]?.[edge.from.port] ?? 0);

  const targetName = targetIsEnd ? END_PING : `__pre_${toNode.id}`;

  addConnection(connections, sourceName, targetName, 'main', outputIndex);
}

/**
 * After routing all canonical edges, any non-end "tail" (a node whose post-
 * ping or output has no consumer) needs to feed __end_ping so the workflow
 * has a deterministic terminator. This covers workflows whose canonical
 * graph has functional sink nodes connected only to canonical `end`.
 */
function wireDanglingTails(
  compiled: CompiledWorkflow,
  connections: N8nConnections,
  hasPostPing: (type: string) => boolean,
): void {
  for (const id of Object.keys(compiled.nodes)) {
    const node = compiled.nodes[id];
    if (SYNTHETIC_TYPES.has(node.type)) continue;

    const tailName = hasPostPing(node.type) ? `__post_${id}` : id;
    const outbound = connections[tailName];
    if (!outbound || !outbound.main || outbound.main.every((arr) => arr.length === 0)) {
      // No outbound canonical wiring; route to __end_ping at index 0.
      addConnection(connections, tailName, END_PING);
    }
  }
}

function canonicalToN8nNode(
  node: CanonicalNode,
  x: number,
  y: number,
  opts: N8nCompileOptions,
): N8nNode {
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
      return agentHttpNode(node.id, `${opts.webhookBaseUrl}/v1/agent/llm-call`, params, opts.webhookSecret, [x, y]);
    case 'tool.call':
      return agentHttpNode(node.id, `${opts.webhookBaseUrl}/v1/agent/tool-call`, params, opts.webhookSecret, [x, y]);
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

/**
 * Build an httpRequest node targeting a backend agent route (llm-call /
 * tool-call). URL is baked at compile time (matches pingNode's approach);
 * body uses stableJson for determinism; the canonical config is sent as
 * the body payload but never overwrites our structural fields.
 */
function agentHttpNode(
  name: string,
  url: string,
  canonicalConfig: Record<string, unknown>,
  webhookSecret: string,
  position: [number, number],
): N8nNode {
  return {
    name,
    type: HTTP_REQUEST,
    typeVersion: HTTP_REQUEST_VERSION,
    position,
    parameters: {
      method: 'POST',
      url,
      sendBody: true,
      bodyContentType: 'json',
      specifyBody: 'json',
      jsonBody: stableJson(canonicalConfig),
      sendHeaders: true,
      headerParameters: {
        parameters: [
          { name: 'x-agent-webhook-secret', value: webhookSecret },
          { name: 'content-type', value: 'application/json' },
        ],
      },
      options: {
        response: { response: { neverError: true } },
      },
    },
  };
}

interface PingPayload {
  event: string;
  stepKey?: string;
  /**
   * Which trigger node feeds runId/tenantId. Main workflow → `__trigger`
   * (Manual Trigger receives `{ runId, tenantId }` from the Phase 2.4 caller).
   * Error workflow → `__error_trigger` (Error Trigger; only n8n execution
   * metadata is available, so runId/tenantId are omitted — see error path).
   */
  triggerSource: 'manual' | 'error';
}

function pingNode(
  name: string,
  x: number,
  y: number,
  opts: N8nCompileOptions,
  payload: PingPayload,
): N8nNode {
  const bodyObj: Record<string, unknown> = {
    event: payload.event,
    timestamp: '={{ $now.toISO() }}',
    n8nExecutionId: '={{ $execution.id }}',
  };

  if (payload.triggerSource === 'manual') {
    // Manual Trigger receives runId/tenantId from the Phase 2.4 caller.
    bodyObj.runId = `={{ $('${TRIGGER_NAME}').item.json.runId }}`;
    bodyObj.tenantId = `={{ $('${TRIGGER_NAME}').item.json.tenantId }}`;
  } else {
    // Error Trigger only exposes execution metadata; runId/tenantId are not
    // available. The webhook controller routes these events to an audit-only
    // path (no workflow_runs / run_events writes) until Phase 2.4 adds the
    // n8n_execution_id column on workflow_runs so the originating run can be
    // resolved. See N8nWebhookController.receive() for the actual routing.
    bodyObj.errorDetails = '={{ $json.execution.error || null }}';
    bodyObj.lastNodeExecuted = '={{ $json.execution.lastNodeExecuted || null }}';
    bodyObj.failedWorkflowId = '={{ $json.workflow.id }}';
  }

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
          { name: 'x-agent-webhook-secret', value: opts.webhookSecret },
          { name: 'content-type', value: 'application/json' },
        ],
      },
      options: {
        retry: { retries: 2 },
        response: { response: { neverError: true } },
      },
    },
  };
}

/**
 * Cooperative-cancel IF node. Reads `$json.cancelled` from the preceding
 * pre-ping's response (the webhook controller sets it from
 * `workflow_runs.status='cancelled'`). Output 0 = true → __end_cancelled;
 * output 1 = false → the canonical step.
 *
 * Uses the n8n IF v2 condition schema. The single boolean condition with
 * `operator.operation='true'` and `singleValue=true` evaluates the leftValue
 * for truthiness. The `id` is fixed (load-bearing for determinism: omitted
 * IDs make n8n generate random ones).
 */
function cancelCheckNode(name: string, x: number, y: number): N8nNode {
  return {
    name,
    type: IF_NODE,
    typeVersion: IF_VERSION,
    position: [x, y],
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' },
        conditions: [
          {
            id: 'cancel-check',
            leftValue: '={{ $json.cancelled === true }}',
            rightValue: '',
            operator: { type: 'boolean', operation: 'true', singleValue: true },
          },
        ],
        combinator: 'and',
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
      event: 'workflow.failed',
      triggerSource: 'error',
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
  outputIndex = 0,
): void {
  const target: N8nConnectionTarget = { node: to, type: 'main', index: 0 };
  if (!conns[from]) conns[from] = {};
  if (!conns[from][outputName]) conns[from][outputName] = [];
  while (conns[from][outputName].length <= outputIndex) {
    conns[from][outputName].push([]);
  }
  conns[from][outputName][outputIndex].push(target);
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
