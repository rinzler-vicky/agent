-- Down migration for Phase 2.1 (migrations 007-011)
-- Roll back in reverse dependency order

-- Drop composite indexes from migration 011
DROP INDEX IF EXISTS idx_workflow_versions_def_lifecycle;
DROP INDEX IF EXISTS idx_workflow_runs_version_created;
DROP INDEX IF EXISTS idx_task_graphs_tenant_conversation;
DROP INDEX IF EXISTS idx_proposal_triggers_tenant_status_created;
DROP INDEX IF EXISTS idx_step_runs_run_status;
DROP INDEX IF EXISTS idx_workflow_runs_tenant_conversation_created;

-- Drop proposal schema from migration 010
DROP TABLE IF EXISTS proposal_triggers CASCADE;
DROP INDEX IF EXISTS idx_workflow_versions_proposal_source;
DROP INDEX IF EXISTS idx_workflow_versions_parent_version;
DROP INDEX IF EXISTS idx_workflow_versions_lifecycle_state;

ALTER TABLE workflow_versions
  DROP COLUMN IF EXISTS proposal_rationale,
  DROP COLUMN IF EXISTS proposal_context,
  DROP COLUMN IF EXISTS proposal_source,
  DROP COLUMN IF EXISTS parent_version_id,
  DROP COLUMN IF EXISTS lifecycle_state;

-- Drop workflow runs and events from migration 009
DROP FUNCTION IF EXISTS next_event_sequence CASCADE;
DROP TABLE IF EXISTS run_events CASCADE;
DROP TABLE IF EXISTS step_runs CASCADE;
DROP TABLE IF EXISTS workflow_runs CASCADE;

-- Drop task graphs from migration 008
DROP TABLE IF EXISTS task_edges CASCADE;
DROP TABLE IF EXISTS tasks CASCADE;
DROP TABLE IF EXISTS task_graphs CASCADE;

-- Drop conversations and messages from migration 007
DROP FUNCTION IF EXISTS next_message_sequence CASCADE;
DROP TABLE IF EXISTS messages CASCADE;
DROP TABLE IF EXISTS conversations CASCADE;
