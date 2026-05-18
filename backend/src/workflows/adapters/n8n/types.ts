/**
 * n8n public-API shapes used by the adapter. Field names match
 * github.com/n8n-io/n8n packages/cli/src/public-api/v1/handlers/workflows/spec/schemas/
 * (workflow.yml, node.yml, workflowSettings.yml).
 */

export interface N8nNode {
  name: string;
  type: string;
  typeVersion: number;
  position: [number, number];
  parameters: Record<string, unknown>;
  id?: string;
  disabled?: boolean;
  notes?: string;
}

export interface N8nConnectionTarget {
  node: string;
  type: string;
  index: number;
}

export type N8nConnections = Record<
  string,
  Record<string, N8nConnectionTarget[][]>
>;

export interface N8nWorkflowSettings {
  executionOrder?: 'v1';
  saveExecutionProgress?: boolean;
  saveManualExecutions?: boolean;
  saveDataErrorExecution?: 'all' | 'none';
  saveDataSuccessExecution?: 'all' | 'none';
  errorWorkflow?: string;
  timezone?: string;
}

export interface N8nWorkflow {
  name: string;
  nodes: N8nNode[];
  connections: N8nConnections;
  settings: N8nWorkflowSettings;
}

export interface N8nCompiledArtifact {
  workflow: N8nWorkflow;
  errorWorkflow: N8nWorkflow;
  canonicalHash: string;
  compiledAt: string;
  n8nWorkflowId?: string;
  n8nErrorWorkflowId?: string;
}

export type N8nWebhookEventType =
  | 'workflow.started'
  | 'workflow.completed'
  | 'workflow.failed'
  | 'workflow.cancelled'
  | 'step.started'
  | 'step.completed';

/**
 * Runtime tuple of every allowed webhook event type.
 * Derive N8nWebhookEventType from this so there is a single source of truth
 * that works at both compile time (the union type) and runtime (the array).
 *
 * Phase 2.5a adds `workflow.cancelled`: emitted by the compiler-injected
 * `__end_cancelled` HTTP Request node after a per-step `__pre_*` ping reads
 * `{ cancelled: true }` from the webhook response and routes through the
 * `__cancel_check_*` IF node's true branch.
 */
export const WEBHOOK_EVENT_TYPES = [
  'workflow.started',
  'workflow.completed',
  'workflow.failed',
  'workflow.cancelled',
  'step.started',
  'step.completed',
] as const satisfies ReadonlyArray<N8nWebhookEventType>;

export interface N8nWebhookEvent {
  runId: string;
  tenantId: string;
  event: N8nWebhookEventType;
  timestamp: string;
  stepKey?: string;
  n8nExecutionId?: string;
  payload?: Record<string, unknown>;
}
