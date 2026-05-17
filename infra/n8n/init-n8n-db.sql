-- Idempotently create the n8n internal database alongside the canonical
-- agent_db on the same Postgres server. n8n owns its own schema inside
-- this database; the canonical control plane never touches it.

SELECT 'CREATE DATABASE n8n'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'n8n')\gexec
