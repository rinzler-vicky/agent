-- Rollback for migration 013 (Phase 2.5a)
DROP TRIGGER IF EXISTS run_events_notify ON run_events;
DROP FUNCTION IF EXISTS notify_run_event();
DROP INDEX IF EXISTS idx_proposal_triggers_pending_dedupe;
DROP INDEX IF EXISTS idx_run_events_event_id_dedupe;
