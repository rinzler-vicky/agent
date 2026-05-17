-- Migration 007: Conversations and Messages (Phase 2.1)
-- conversations table (tenant-scoped)
CREATE TABLE IF NOT EXISTS conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  workspace_id UUID REFERENCES workspaces(id) ON DELETE SET NULL,
  -- NOTE: workspace_id should ideally be constrained to same tenant, but would require
  -- composite keys on workspaces table (out of scope for this PR). RLS policies prevent
  -- cross-tenant access at query level.
  title TEXT,
  context JSONB NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'active',
  created_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- messages table (tenant-scoped via conversation)
CREATE TABLE IF NOT EXISTS messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sequence_number INTEGER NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(conversation_id, sequence_number)
);

-- Enable RLS on conversations and messages
ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;

-- RLS policy for conversations: tenant isolation
CREATE POLICY conversations_tenant_isolation ON conversations
  USING (tenant_id = current_setting('app.tenant_id', true)::UUID);

-- RLS policy for messages: tenant isolation via conversation
CREATE POLICY messages_tenant_isolation ON messages
  USING (
    EXISTS (
      SELECT 1 FROM conversations
      WHERE conversations.id = messages.conversation_id
        AND conversations.tenant_id = current_setting('app.tenant_id', true)::UUID
    )
  );

-- Indexes for efficient querying
CREATE INDEX idx_conversations_tenant_id ON conversations(tenant_id);
CREATE INDEX idx_conversations_workspace_id ON conversations(workspace_id);
CREATE INDEX idx_conversations_created_at ON conversations(created_at DESC);
CREATE INDEX idx_messages_conversation_id ON messages(conversation_id);
CREATE INDEX idx_messages_sequence ON messages(conversation_id, sequence_number);

-- Grant access to app_user role
GRANT SELECT, INSERT, UPDATE, DELETE ON conversations TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON messages TO app_user;

-- Auto-increment sequence_number trigger for messages with row-level locking
CREATE OR REPLACE FUNCTION next_message_sequence()
RETURNS TRIGGER AS $$
DECLARE
  max_seq INTEGER;
BEGIN
  IF NEW.sequence_number IS NOT NULL THEN
    RETURN NEW;
  END IF;

  -- Lock the conversation row to prevent concurrent sequence conflicts
  PERFORM 1 FROM conversations WHERE id = NEW.conversation_id FOR UPDATE;

  SELECT COALESCE(MAX(sequence_number), 0) INTO max_seq
  FROM messages WHERE conversation_id = NEW.conversation_id;
  NEW.sequence_number := max_seq + 1;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER messages_auto_sequence
  BEFORE INSERT ON messages
  FOR EACH ROW
  EXECUTE FUNCTION next_message_sequence();
