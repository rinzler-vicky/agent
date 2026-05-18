-- Migration 013: NOTIFY trigger on run_events + idempotency index on proposal_triggers (Phase 2.5a)
-- See ADR-0002 §Decision 7 (SSE + LISTEN/NOTIFY) and §Decision 8 (proposal_triggers failure hook).

-- Trigger function: publishes a compact payload (<8 KB Postgres NOTIFY cap)
-- whenever a row is appended to run_events. The payload carries the run/tenant
-- ids and the sequence so the receiver can fetch the full row under the
-- correct RLS scope. AFTER INSERT ordering matters: the existing
-- next_event_sequence() BEFORE trigger must have already populated NEW.sequence.
--
-- SECURITY DEFINER + pinned search_path:
-- The lookup against workflow_runs would otherwise inherit the inserting
-- session's RLS context. Any insert path that forgets `set_config('app.tenant_id', ...)`
-- (e.g. a future system-level reconcile job) would resolve v_tenant to NULL
-- and the SSE/failure-hook consumers would silently drop the event (Copilot
-- review PR #65). DEFINER bypasses RLS for the tenant lookup only; the trigger
-- function does not insert or expose anything beyond what the inserting role
-- already had access to. Hard-failing on NULL keeps misuse loud rather than
-- silent.
CREATE OR REPLACE FUNCTION notify_run_event() RETURNS TRIGGER AS $$
DECLARE
  v_tenant UUID;
BEGIN
  SELECT tenant_id INTO v_tenant FROM workflow_runs WHERE id = NEW.run_id;
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'notify_run_event: workflow_runs.tenant_id not found for run_id=%', NEW.run_id;
  END IF;
  PERFORM pg_notify(
    'run_events',
    json_build_object(
      'run_id', NEW.run_id,
      'tenant_id', v_tenant,
      'sequence', NEW.sequence,
      'event_type', NEW.event_type,
      'step_run_id', NEW.step_run_id,
      'event_id', NEW.id
    )::text
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public;

CREATE TRIGGER run_events_notify
  AFTER INSERT ON run_events
  FOR EACH ROW EXECUTE FUNCTION notify_run_event();

-- Idempotency index for the failure → proposal_triggers hook.
-- Multiple backend pods all receive the same NOTIFY; the failure hook uses an
-- advisory lock for in-flight dedupe, but the index survives pod restarts.
-- Partial WHERE status='pending' keeps the index small (resolved triggers don't
-- need uniqueness — the same fingerprint may legitimately re-fire after a
-- prior proposal landed).
--
-- The COALESCE expression is wrapped in parens so the matching
-- `ON CONFLICT (...)` clause in INSERTs parses it as an index_expression
-- (per PG `INSERT ... ON CONFLICT` grammar — Copilot review PR #65).
CREATE UNIQUE INDEX idx_proposal_triggers_pending_dedupe
  ON proposal_triggers (workflow_run_id, (COALESCE(step_run_id, '00000000-0000-0000-0000-000000000000'::uuid)), error_fingerprint)
  WHERE status = 'pending';

-- Functional index for the n8n-webhook dedup probe
-- (`WHERE event_data->>'event_id' = $1`). Without this, every webhook
-- delivery scans the run_events table; with the new failure-hook in Phase
-- 2.5a, webhook traffic grows with run count (Gemini review PR #65).
CREATE INDEX idx_run_events_event_id_dedupe
  ON run_events ((event_data->>'event_id'));
