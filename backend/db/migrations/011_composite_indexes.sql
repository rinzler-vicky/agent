-- Migration 011: Composite Indexes for Hot Paths (Phase 2.1)
-- These indexes optimize the most frequent query patterns

-- Composite index for run lookup by tenant + conversation
-- Hot path: GET /v1/runs?conversation_id=X
CREATE INDEX idx_workflow_runs_tenant_conversation_created ON workflow_runs(tenant_id, conversation_id, created_at DESC)
  WHERE conversation_id IS NOT NULL;

-- Composite index for active step runs in a workflow run
-- Hot path: Monitor in-progress steps for a run
CREATE INDEX idx_step_runs_run_status ON step_runs(workflow_run_id, status)
  WHERE status IN ('pending', 'running');

-- Composite index for pending proposal triggers by tenant
-- Hot path: Agent worker draining proposal queue
CREATE INDEX idx_proposal_triggers_tenant_status_created ON proposal_triggers(tenant_id, status, created_at)
  WHERE status = 'pending';

-- Composite index for task graph lookup by conversation
-- Hot path: GET /v1/task-graphs?conversation_id=X
CREATE INDEX idx_task_graphs_tenant_conversation ON task_graphs(tenant_id, conversation_id)
  WHERE conversation_id IS NOT NULL;

-- Composite index for workflow runs by version (for rollback analysis)
-- Hot path: List all runs of a specific workflow version
CREATE INDEX idx_workflow_runs_version_created ON workflow_runs(workflow_version_id, created_at DESC);

-- Composite index for draft workflow versions by workflow def
-- Hot path: List draft versions for a workflow
CREATE INDEX idx_workflow_versions_def_lifecycle ON workflow_versions(workflow_def_id, lifecycle_state)
  WHERE lifecycle_state = 'draft';

