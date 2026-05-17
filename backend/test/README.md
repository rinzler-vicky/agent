# Phase 2.1 Migration Testing

This directory contains integration tests for the Phase 2.1 database schema.

## Prerequisites

1. A running PostgreSQL database (Neon or local)
2. All Phase 1 and Phase 2.1 migrations applied (migrations 001-011)
3. `DATABASE_URL` environment variable set

## Running Integration Tests

### 1. Set up test database

```bash
# Export your test database URL
export DATABASE_URL="postgresql://user:password@localhost:5432/agent_test"

# Run migrations
cd backend
pnpm migrate:up
```

### 2. Run RLS isolation tests

```bash
# Run all e2e tests
pnpm test:e2e

# Run only RLS tests
pnpm test:e2e test/rls-isolation.e2e-spec.ts
```

## What is tested

### RLS Isolation Tests (`rls-isolation.e2e-spec.ts`)

Tests that Row-Level Security (RLS) policies correctly isolate data by tenant:

- **Conversations RLS**: Verifies tenant A cannot see tenant B's conversations
- **Messages RLS**: Verifies messages are isolated via conversation tenant ownership
- **Task Graphs RLS**: Verifies task graphs, tasks, and task edges are tenant-isolated
- **Workflow Runs RLS**: Verifies workflow runs, step runs, and run events are tenant-isolated
- **Proposal Triggers RLS**: Verifies proposal triggers are tenant-isolated
- **Run Events Append-Only**: Verifies UPDATE and DELETE operations are blocked on `run_events` table

## Migration Rollback Testing

To test rollback:

```bash
# Apply all migrations
pnpm migrate:up

# Verify tables exist
psql $DATABASE_URL -c "\dt"

# Roll back
pnpm migrate:down

# Verify Phase 2.1 tables are removed
psql $DATABASE_URL -c "\dt"
```

## Expected Results

- All RLS tests should pass, confirming tenant isolation works correctly
- No cross-tenant data leakage should occur
- Append-only enforcement should prevent modification of `run_events`
- Rollback should cleanly remove all Phase 2.1 tables without errors

## Troubleshooting

### Tests fail with connection error

Ensure `DATABASE_URL` is set and the database is accessible:

```bash
psql $DATABASE_URL -c "SELECT 1"
```

### RLS tests fail

Verify migrations were applied correctly:

```bash
psql $DATABASE_URL -c "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename"
```

Check that RLS is enabled on tables:

```bash
psql $DATABASE_URL -c "SELECT tablename, rowsecurity FROM pg_tables WHERE schemaname = 'public' AND rowsecurity = true"
```

### Append-only tests fail

Verify the RULE exists on `run_events`:

```bash
psql $DATABASE_URL -c "SELECT rulename FROM pg_rules WHERE tablename = 'run_events'"
```
