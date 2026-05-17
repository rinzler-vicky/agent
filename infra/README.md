# Infra

Docker-compose overlays that extend the root `docker-compose.yml`.

## Phase 2.3 — n8n adapter stack

Brings up:

- `redis` (queue broker for n8n queue mode)
- `postgres-n8n-init` (one-shot: creates the `n8n` database on the existing Postgres server)
- `n8n-main` (n8n Community Edition 1.79.0, queue mode)
- `n8n-worker` (1× n8n worker)

The canonical app DB (`agent_db`) and the n8n internal DB (`n8n`) live on the **same Postgres server** but in **separate databases** — n8n owns its schema and never touches the canonical control plane.

### Bring up

From the repo root:

```bash
# 1. Ensure root stack (postgres + backend) is running
docker compose up -d postgres

# 2. Bring up the n8n overlay
docker compose -f docker-compose.yml -f infra/docker-compose.n8n.yml up -d
```

n8n editor: <http://localhost:5678> (basic auth: `admin` / value of `N8N_BASIC_AUTH_PASSWORD`).

### Required environment variables

Set in the repo root `.env`. These are referenced by both the n8n overlay
**and** the backend service in the root `docker-compose.yml` — that's how the
adapter inside the backend container picks them up. Compose's `.env` file is
only used for `${VAR}` substitution into a service's `environment:` block;
unreferenced keys are not magically forwarded to containers, which is why the
root compose explicitly declares every adapter var it needs:

| Var | Notes |
| --- | --- |
| `WORKFLOW_CONTROL_PLANE_ENABLED` | `true` to activate the adapter on the backend (default `false`). |
| `N8N_ENCRYPTION_KEY` | **Must be identical on `n8n-main` and `n8n-worker`** (per n8n docs). |
| `POSTGRES_USER` / `POSTGRES_PASSWORD` | Reused from the root compose. |
| `N8N_BASIC_AUTH_USER` / `N8N_BASIC_AUTH_PASSWORD` | Editor login. |
| `N8N_API_KEY` | Issued from the n8n editor (Settings → API). Required by the backend sync service. |
| `N8N_WEBHOOK_BASE_URL` | URL the n8n pings hit on the backend (e.g. `http://backend:3000`). |
| `N8N_WEBHOOK_SECRET` | Shared secret baked into compiled workflows; the backend verifies it on every event. |
| `N8N_WEBHOOK_CLOCK_SKEW_S` | Freshness window for inbound webhook timestamps (default `300`). |
| `N8N_RECONCILE_TIMEOUT_MS` | Axios timeout for the post-completion `GET /executions/{id}` reconciliation call (default `2000`). |
| `REDIS_URL` | Defaults to `redis://redis:6379` in the compose stack. |

### Tear down

```bash
docker compose -f docker-compose.yml -f infra/docker-compose.n8n.yml down
# Add -v to wipe Redis + n8n data volumes:
docker compose -f docker-compose.yml -f infra/docker-compose.n8n.yml down -v
```

### Version pinning

n8n is pinned to `1.79.0` per ADR-0002 §211. Bumping the tag is a deliberate change — the n8n adapter's determinism test asserts byte-stable compiled output, which can shift across n8n versions if node `typeVersion` defaults move.

### Failure injection (issue #43 AC)

To verify queue-mode resilience:

```bash
# 1. Trigger a workflow execution from the backend
# 2. Kill the worker mid-execution
docker compose -f docker-compose.yml -f infra/docker-compose.n8n.yml stop n8n-worker

# 3. Restart the worker; the job should resume from Redis
docker compose -f docker-compose.yml -f infra/docker-compose.n8n.yml start n8n-worker

# 4. Verify webhook events still land in run_events
psql ... -c "SELECT event_type, sequence FROM run_events WHERE run_id = '...' ORDER BY sequence;"
```
