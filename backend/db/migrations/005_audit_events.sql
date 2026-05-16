CREATE TABLE IF NOT EXISTS audit_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID REFERENCES tenants(id) ON DELETE SET NULL,
  actor_id UUID,
  actor_type TEXT NOT NULL DEFAULT 'user',
  action TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id UUID,
  before_state JSONB,
  after_state JSONB,
  metadata JSONB NOT NULL DEFAULT '{}',
  ip_address INET,
  user_agent TEXT,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Audit events are append-only; deny UPDATE and DELETE
CREATE RULE audit_events_no_update AS ON UPDATE TO audit_events DO INSTEAD NOTHING;
CREATE RULE audit_events_no_delete AS ON DELETE TO audit_events DO INSTEAD NOTHING;

-- Enable RLS for tenant isolation
ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_events FORCE ROW LEVEL SECURITY;

-- Tenant isolation policy: rows with a tenant_id are visible only to that tenant;
-- rows with tenant_id IS NULL (system-level events) are visible to all authenticated roles.
CREATE POLICY audit_events_tenant_isolation ON audit_events
  USING (
    tenant_id IS NULL
    OR tenant_id = current_setting('app.tenant_id', true)::UUID
  );

-- Index for efficient querying
CREATE INDEX idx_audit_events_tenant_id ON audit_events(tenant_id);
CREATE INDEX idx_audit_events_actor_id ON audit_events(actor_id);
CREATE INDEX idx_audit_events_resource ON audit_events(resource_type, resource_id);
CREATE INDEX idx_audit_events_occurred_at ON audit_events(occurred_at DESC);

-- Grant append-only access
GRANT SELECT, INSERT ON audit_events TO app_user;
