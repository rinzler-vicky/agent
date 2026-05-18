-- Migration 014: preview_environments table + workflow_proposals NOTIFY trigger (Phase 2.5b).
-- Unified spine for PR-driven previews (pr-preview.yml) and agent-driven previews
-- (AgentPreviewSpawnerService). The `source` discriminator carries which path
-- created the row; per-source columns are populated by whichever surface owns the row.

CREATE TABLE IF NOT EXISTS preview_environments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  -- Agent-driven rows reference the proposal they were spawned for. Set to
  -- NULL on workflow_version delete so an in-flight teardown can still find
  -- the row by id.
  workflow_version_id UUID REFERENCES workflow_versions(id) ON DELETE SET NULL,
  -- PR-driven rows carry the GitHub PR number. Set by pr-preview.yml.
  pr_number INTEGER,
  source TEXT NOT NULL CHECK (source IN ('pr', 'agent_failure_recovery')),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'provisioning', 'ready', 'failed', 'expired', 'torn_down')),
  -- Render service IDs are populated as services are discovered/created.
  -- Per Phase 2.5b: a PR preview = 1 backend service + 1 n8n service
  -- (single-process mode; no worker, no keyvalue). Agent-initiated previews
  -- have only the backend service.
  render_backend_service_id TEXT,
  render_n8n_service_id TEXT,
  neon_branch_name TEXT,
  preview_url TEXT,
  n8n_url TEXT,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  torn_down_at TIMESTAMPTZ
);

ALTER TABLE preview_environments ENABLE ROW LEVEL SECURITY;

CREATE POLICY preview_environments_tenant_isolation ON preview_environments
  USING (tenant_id = current_setting('app.tenant_id', true)::UUID);

-- Hot-path indexes: rate-limit COUNT (tenant_id + status), TTL scan, idempotency.
CREATE INDEX idx_preview_environments_tenant_status
  ON preview_environments (tenant_id, status);

CREATE INDEX idx_preview_environments_ttl
  ON preview_environments (expires_at)
  WHERE status = 'ready';

-- Idempotency key for agent-driven spawns. Multiple backend pods all receive
-- the same NOTIFY; the spawner uses an advisory lock for in-flight dedupe,
-- but this partial unique index survives pod restarts. PR-driven rows have
-- workflow_version_id IS NULL so they're not constrained.
--
-- The CASE wrap in the WHERE predicate would otherwise need a non-immutable
-- function; ARRAY membership matches a constant set so PG accepts it. The
-- index_predicate must match the `WHERE` clause used by `INSERT ... ON CONFLICT`
-- exactly (per PG INSERT...ON CONFLICT grammar — see migration 013 comment).
CREATE UNIQUE INDEX idx_preview_environments_active_version
  ON preview_environments (workflow_version_id)
  WHERE workflow_version_id IS NOT NULL
    AND status IN ('pending', 'provisioning', 'ready');

-- NOTIFY trigger: publishes a compact payload (<8 KB Postgres NOTIFY cap)
-- whenever a workflow proposal lands. Channel `workflow_proposals` is consumed
-- by SseSubscriberService (single LISTEN client, two channels — see
-- backend/src/runs/sse-subscriber.service.ts).
--
-- SECURITY DEFINER + pinned search_path: same rationale as notify_run_event
-- (migration 013) — the tenant lookup must survive callers that haven't yet
-- set `app.tenant_id`, but we hard-fail on NULL so misconfiguration is loud.
CREATE OR REPLACE FUNCTION notify_workflow_proposal() RETURNS TRIGGER AS $$
DECLARE
  v_tenant UUID;
BEGIN
  -- workflow_versions has no tenant_id column; join through workflow_defs.
  SELECT wd.tenant_id INTO v_tenant
    FROM workflow_defs wd
   WHERE wd.id = NEW.workflow_def_id;
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'notify_workflow_proposal: workflow_defs.tenant_id not found for workflow_def_id=%',
      NEW.workflow_def_id;
  END IF;
  PERFORM pg_notify(
    'workflow_proposals',
    json_build_object(
      'version_id', NEW.id,
      'tenant_id', v_tenant,
      'workflow_def_id', NEW.workflow_def_id,
      'parent_version_id', NEW.parent_version_id,
      'proposal_source', NEW.proposal_source
    )::text
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public;

-- Fires only on rows that ARE proposals (proposal_source non-null). The
-- AgentPreviewSpawnerService further filters to proposal_source='failure_recovery'.
CREATE TRIGGER workflow_versions_proposal_notify
  AFTER INSERT ON workflow_versions
  FOR EACH ROW
  WHEN (NEW.proposal_source IS NOT NULL)
  EXECUTE FUNCTION notify_workflow_proposal();

GRANT SELECT, INSERT, UPDATE ON preview_environments TO app_user;

COMMENT ON TABLE preview_environments IS
  'Unified record of PR-driven and agent-driven preview environments. Phase 2.5b.';
COMMENT ON COLUMN preview_environments.source IS
  'pr = spawned by .github/workflows/pr-preview.yml; agent_failure_recovery = spawned by AgentPreviewSpawnerService.';
COMMENT ON COLUMN preview_environments.status IS
  'pending -> provisioning -> ready -> (expired|torn_down|failed). expired set by PreviewTtlService cron.';
