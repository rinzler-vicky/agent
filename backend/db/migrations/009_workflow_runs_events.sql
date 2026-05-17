-- Migration 009: Workflow Runs, Step Runs, Run Events (Phase 2.1)
-- workflow_runs table (tenant-scoped, execution tracking)
CREATE TABLE IF NOT EXISTS workflow_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  workflow_version_id UUID NOT NULL REFERENCES workflow_versions(id) ON DELETE RESTRICT,
  conversation_id UUID REFERENCES conversations(id) ON DELETE SET NULL,
  task_graph_id UUID REFERENCES task_graphs(id) ON DELETE SET NULL,
  execution_engine TEXT NOT NULL DEFAULT 'n8n_queue',
  status TEXT NOT NULL DEFAULT 'pending',
  input JSONB NOT NULL DEFAULT '{}',
  output JSONB,
  error_details JSONB,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- step_runs table (individual step execution tracking)
CREATE TABLE IF NOT EXISTS step_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_run_id UUID NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  step_key TEXT NOT NULL,
  step_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  input JSONB,
  output JSONB,
  error_details JSONB,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(workflow_run_id, step_key)
);

-- run_events table (append-only event log)
CREATE TABLE IF NOT EXISTS run_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  event_data JSONB NOT NULL DEFAULT '{}',
  step_run_id UUID REFERENCES step_runs(id) ON DELETE SET NULL,
  error_fingerprint TEXT,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(run_id, sequence)
);

-- Enforce append-only behavior on run_events
CREATE RULE run_events_no_update AS ON UPDATE TO run_events DO INSTEAD NOTHING;
CREATE RULE run_events_no_delete AS ON DELETE TO run_events DO INSTEAD NOTHING;

-- Enable RLS on all run tables
ALTER TABLE workflow_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE step_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE run_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE run_events FORCE ROW LEVEL SECURITY;

-- RLS policy for workflow_runs: tenant isolation
CREATE POLICY workflow_runs_tenant_isolation ON workflow_runs
  USING (tenant_id = current_setting('app.tenant_id', true)::UUID);

-- RLS policy for step_runs: tenant isolation via workflow_run
CREATE POLICY step_runs_tenant_isolation ON step_runs
  USING (
    EXISTS (
      SELECT 1 FROM workflow_runs
      WHERE workflow_runs.id = step_runs.workflow_run_id
        AND workflow_runs.tenant_id = current_setting('app.tenant_id', true)::UUID
    )
  );

-- RLS policy for run_events: tenant isolation via workflow_run
CREATE POLICY run_events_tenant_isolation ON run_events
  USING (
    EXISTS (
      SELECT 1 FROM workflow_runs
      WHERE workflow_runs.id = run_events.run_id
        AND workflow_runs.tenant_id = current_setting('app.tenant_id', true)::UUID
    )
  );

-- Indexes for efficient querying
CREATE INDEX idx_workflow_runs_tenant_id ON workflow_runs(tenant_id);
CREATE INDEX idx_workflow_runs_conversation_id ON workflow_runs(tenant_id, conversation_id);
CREATE INDEX idx_workflow_runs_workflow_version ON workflow_runs(workflow_version_id);
CREATE INDEX idx_workflow_runs_status ON workflow_runs(status);
CREATE INDEX idx_workflow_runs_created_at ON workflow_runs(created_at DESC);
CREATE INDEX idx_step_runs_workflow_run_id ON step_runs(workflow_run_id);
CREATE INDEX idx_step_runs_status ON step_runs(status);
CREATE INDEX idx_run_events_run_id ON run_events(run_id);
CREATE INDEX idx_run_events_sequence_desc ON run_events(run_id, sequence DESC);
CREATE INDEX idx_run_events_event_type ON run_events(event_type);

-- Grant access to app_user role
GRANT SELECT, INSERT, UPDATE, DELETE ON workflow_runs TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON step_runs TO app_user;
GRANT SELECT, INSERT ON run_events TO app_user;

-- Auto-increment sequence trigger for run_events
CREATE OR REPLACE FUNCTION next_event_sequence()
RETURNS TRIGGER AS $$
DECLARE
  max_seq INTEGER;
BEGIN
  SELECT COALESCE(MAX(sequence), 0) INTO max_seq
  FROM run_events WHERE run_id = NEW.run_id;
  NEW.sequence := max_seq + 1;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER run_events_auto_sequence
  BEFORE INSERT ON run_events
  FOR EACH ROW
  WHEN (NEW.sequence IS NULL)
  EXECUTE FUNCTION next_event_sequence();
