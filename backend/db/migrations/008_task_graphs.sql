-- Migration 008: Task Graphs, Tasks, Task Edges (Phase 2.1)
-- task_graphs table (tenant-scoped)
CREATE TABLE IF NOT EXISTS task_graphs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  conversation_id UUID REFERENCES conversations(id) ON DELETE SET NULL,
  display_name TEXT NOT NULL,
  description TEXT,
  context JSONB NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- tasks table (nodes in the task graph)
CREATE TABLE IF NOT EXISTS tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_graph_id UUID NOT NULL REFERENCES task_graphs(id) ON DELETE CASCADE,
  task_key TEXT NOT NULL,
  display_name TEXT NOT NULL,
  task_type TEXT NOT NULL,
  config JSONB NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending',
  result JSONB,
  error_details JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(task_graph_id, task_key)
);

-- task_edges table (adjacency list for task dependencies)
CREATE TABLE IF NOT EXISTS task_edges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_graph_id UUID NOT NULL REFERENCES task_graphs(id) ON DELETE CASCADE,
  from_task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  to_task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  edge_type TEXT NOT NULL DEFAULT 'dependency',
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(task_graph_id, from_task_id, to_task_id)
);

-- Enable RLS on all task graph tables
ALTER TABLE task_graphs ENABLE ROW LEVEL SECURITY;
ALTER TABLE tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE task_edges ENABLE ROW LEVEL SECURITY;

-- RLS policy for task_graphs: tenant isolation
CREATE POLICY task_graphs_tenant_isolation ON task_graphs
  USING (tenant_id = current_setting('app.tenant_id', true)::UUID);

-- RLS policy for tasks: tenant isolation via task_graph
CREATE POLICY tasks_tenant_isolation ON tasks
  USING (
    EXISTS (
      SELECT 1 FROM task_graphs
      WHERE task_graphs.id = tasks.task_graph_id
        AND task_graphs.tenant_id = current_setting('app.tenant_id', true)::UUID
    )
  );

-- RLS policy for task_edges: tenant isolation via task_graph
CREATE POLICY task_edges_tenant_isolation ON task_edges
  USING (
    EXISTS (
      SELECT 1 FROM task_graphs
      WHERE task_graphs.id = task_edges.task_graph_id
        AND task_graphs.tenant_id = current_setting('app.tenant_id', true)::UUID
    )
  );

-- Indexes for efficient querying
CREATE INDEX idx_task_graphs_tenant_id ON task_graphs(tenant_id);
CREATE INDEX idx_task_graphs_conversation_id ON task_graphs(conversation_id);
CREATE INDEX idx_task_graphs_status ON task_graphs(status);
CREATE INDEX idx_tasks_task_graph_id ON tasks(task_graph_id);
CREATE INDEX idx_tasks_status ON tasks(status);
CREATE INDEX idx_task_edges_task_graph_id ON task_edges(task_graph_id);
CREATE INDEX idx_task_edges_from_task ON task_edges(from_task_id);
CREATE INDEX idx_task_edges_to_task ON task_edges(to_task_id);

-- Grant access to app_user role
GRANT SELECT, INSERT, UPDATE, DELETE ON task_graphs TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON tasks TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON task_edges TO app_user;
