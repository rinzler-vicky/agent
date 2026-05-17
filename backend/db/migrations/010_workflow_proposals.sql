-- Migration 010: Workflow Proposal Schema (Phase 2.1)
-- Per ADR-0002 §Open Q 1+2: Add proposal metadata to workflow_versions table

-- Add lifecycle_state column for workflow lifecycle management
ALTER TABLE workflow_versions
  ADD COLUMN IF NOT EXISTS lifecycle_state TEXT NOT NULL DEFAULT 'draft';

-- Add proposal-specific columns for agent-authored drafts
ALTER TABLE workflow_versions
  ADD COLUMN IF NOT EXISTS parent_version_id UUID REFERENCES workflow_versions(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS proposal_source TEXT,
  ADD COLUMN IF NOT EXISTS proposal_context JSONB,
  ADD COLUMN IF NOT EXISTS proposal_rationale TEXT;

-- Add proposal_triggers table for failure → proposal hook
CREATE TABLE IF NOT EXISTS proposal_triggers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  workflow_run_id UUID NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  step_run_id UUID REFERENCES step_runs(id) ON DELETE SET NULL,
  error_fingerprint TEXT NOT NULL,
  trigger_context JSONB NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending',
  processed_at TIMESTAMPTZ,
  result_version_id UUID REFERENCES workflow_versions(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Enable RLS on proposal_triggers
ALTER TABLE proposal_triggers ENABLE ROW LEVEL SECURITY;

-- RLS policy for proposal_triggers: tenant isolation
CREATE POLICY proposal_triggers_tenant_isolation ON proposal_triggers
  USING (tenant_id = current_setting('app.tenant_id', true)::UUID);

-- Indexes for workflow_versions proposal queries
CREATE INDEX idx_workflow_versions_lifecycle_state ON workflow_versions(lifecycle_state);
CREATE INDEX idx_workflow_versions_parent_version ON workflow_versions(parent_version_id);
CREATE INDEX idx_workflow_versions_proposal_source ON workflow_versions(proposal_source) WHERE proposal_source IS NOT NULL;

-- Indexes for proposal_triggers
CREATE INDEX idx_proposal_triggers_tenant_id ON proposal_triggers(tenant_id);
CREATE INDEX idx_proposal_triggers_status ON proposal_triggers(status);
CREATE INDEX idx_proposal_triggers_workflow_run ON proposal_triggers(workflow_run_id);
CREATE INDEX idx_proposal_triggers_created_at ON proposal_triggers(created_at DESC);

-- Grant access to app_user role
GRANT SELECT, INSERT, UPDATE ON proposal_triggers TO app_user;

-- Comment on columns for documentation
COMMENT ON COLUMN workflow_versions.lifecycle_state IS 'Workflow lifecycle: draft, published, superseded, rejected';
COMMENT ON COLUMN workflow_versions.parent_version_id IS 'For proposals: the version being modified';
COMMENT ON COLUMN workflow_versions.proposal_source IS 'Source of proposal: agent, human, system';
COMMENT ON COLUMN workflow_versions.proposal_context IS 'Proposal metadata: run context, error details, environment info';
COMMENT ON COLUMN workflow_versions.proposal_rationale IS 'Human-readable explanation of why this proposal was created';
