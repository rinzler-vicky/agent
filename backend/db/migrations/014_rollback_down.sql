-- Rollback for migration 014 (Phase 2.5b)
DROP FUNCTION IF EXISTS get_expired_agent_previews();
DROP TRIGGER IF EXISTS workflow_versions_proposal_notify ON workflow_versions;
DROP FUNCTION IF EXISTS notify_workflow_proposal();
DROP INDEX IF EXISTS idx_preview_environments_active_version;
DROP INDEX IF EXISTS idx_preview_environments_ttl;
DROP INDEX IF EXISTS idx_preview_environments_tenant_status;
DROP TABLE IF EXISTS preview_environments;
