-- Enable RLS on all tenant-scoped tables
ALTER TABLE workspaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE service_accounts ENABLE ROW LEVEL SECURITY;

-- RLS policies for workspaces
CREATE POLICY workspaces_tenant_isolation ON workspaces
  USING (tenant_id = current_setting('app.tenant_id', true)::UUID);

-- RLS policies for users
CREATE POLICY users_tenant_isolation ON users
  USING (tenant_id = current_setting('app.tenant_id', true)::UUID);

-- RLS policies for service_accounts
CREATE POLICY service_accounts_tenant_isolation ON service_accounts
  USING (tenant_id = current_setting('app.tenant_id', true)::UUID);

-- Create application role for normal operations (with RLS)
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    CREATE ROLE app_user;
  END IF;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON tenants TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON workspaces TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON users TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON service_accounts TO app_user;
