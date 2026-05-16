-- personas table
CREATE TABLE IF NOT EXISTS personas (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  slug TEXT NOT NULL,
  display_name TEXT NOT NULL,
  active_version_id UUID,
  rollback_target_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(tenant_id, slug)
);

-- persona_versions table (immutable)
CREATE TABLE IF NOT EXISTS persona_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  persona_id UUID NOT NULL REFERENCES personas(id) ON DELETE CASCADE,
  version_number INTEGER NOT NULL,
  system_prompt TEXT NOT NULL,
  delegation_policy JSONB NOT NULL DEFAULT '{}',
  tool_policy JSONB NOT NULL DEFAULT '{}',
  write_policy JSONB NOT NULL DEFAULT '{}',
  memory_policy JSONB NOT NULL DEFAULT '{}',
  safety_policy JSONB NOT NULL DEFAULT '{}',
  approval_state TEXT NOT NULL DEFAULT 'draft',
  created_by_actor UUID,
  created_from_run_id UUID,
  published_at TIMESTAMPTZ,
  changelog TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(persona_id, version_number)
);

-- prompt_templates table
CREATE TABLE IF NOT EXISTS prompt_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  slug TEXT NOT NULL,
  display_name TEXT NOT NULL,
  active_version_id UUID,
  rollback_target_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(tenant_id, slug)
);

-- prompt_versions table (immutable)
CREATE TABLE IF NOT EXISTS prompt_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id UUID NOT NULL REFERENCES prompt_templates(id) ON DELETE CASCADE,
  version_number INTEGER NOT NULL,
  content TEXT NOT NULL,
  variables JSONB NOT NULL DEFAULT '[]',
  approval_state TEXT NOT NULL DEFAULT 'draft',
  created_by_actor UUID,
  created_from_run_id UUID,
  published_at TIMESTAMPTZ,
  changelog TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(template_id, version_number)
);

-- workflow_defs table
CREATE TABLE IF NOT EXISTS workflow_defs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  slug TEXT NOT NULL,
  display_name TEXT NOT NULL,
  active_version_id UUID,
  rollback_target_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(tenant_id, slug)
);

-- workflow_versions table (immutable)
CREATE TABLE IF NOT EXISTS workflow_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_def_id UUID NOT NULL REFERENCES workflow_defs(id) ON DELETE CASCADE,
  version_number INTEGER NOT NULL,
  spec JSONB NOT NULL,
  approval_state TEXT NOT NULL DEFAULT 'draft',
  created_by_actor UUID,
  created_from_run_id UUID,
  published_at TIMESTAMPTZ,
  changelog TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(workflow_def_id, version_number)
);

-- workflow_adapter_artifacts table
CREATE TABLE IF NOT EXISTS workflow_adapter_artifacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_version_id UUID NOT NULL REFERENCES workflow_versions(id) ON DELETE CASCADE,
  adapter_type TEXT NOT NULL,
  artifact JSONB NOT NULL,
  compiled_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(workflow_version_id, adapter_type)
);

-- RLS for config tables
ALTER TABLE personas ENABLE ROW LEVEL SECURITY;
ALTER TABLE prompt_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflow_defs ENABLE ROW LEVEL SECURITY;

CREATE POLICY personas_tenant_isolation ON personas
  USING (tenant_id = current_setting('app.tenant_id', true)::UUID);

CREATE POLICY prompt_templates_tenant_isolation ON prompt_templates
  USING (tenant_id = current_setting('app.tenant_id', true)::UUID);

CREATE POLICY workflow_defs_tenant_isolation ON workflow_defs
  USING (tenant_id = current_setting('app.tenant_id', true)::UUID);

-- Versioning trigger function (auto-increment version_number)
CREATE OR REPLACE FUNCTION next_version_number()
RETURNS TRIGGER AS $$
DECLARE
  max_ver INTEGER;
  parent_col TEXT;
BEGIN
  -- Determine which parent column to use based on table
  IF TG_TABLE_NAME = 'persona_versions' THEN
    SELECT COALESCE(MAX(version_number), 0) INTO max_ver
    FROM persona_versions WHERE persona_id = NEW.persona_id;
  ELSIF TG_TABLE_NAME = 'prompt_versions' THEN
    SELECT COALESCE(MAX(version_number), 0) INTO max_ver
    FROM prompt_versions WHERE template_id = NEW.template_id;
  ELSIF TG_TABLE_NAME = 'workflow_versions' THEN
    SELECT COALESCE(MAX(version_number), 0) INTO max_ver
    FROM workflow_versions WHERE workflow_def_id = NEW.workflow_def_id;
  END IF;
  NEW.version_number := max_ver + 1;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER persona_versions_auto_version
  BEFORE INSERT ON persona_versions
  FOR EACH ROW EXECUTE FUNCTION next_version_number();

CREATE TRIGGER prompt_versions_auto_version
  BEFORE INSERT ON prompt_versions
  FOR EACH ROW EXECUTE FUNCTION next_version_number();

CREATE TRIGGER workflow_versions_auto_version
  BEFORE INSERT ON workflow_versions
  FOR EACH ROW EXECUTE FUNCTION next_version_number();
