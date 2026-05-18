# PR Preview Environments

Every Pull Request that leaves draft status gets a dedicated preview: a Render web service, its own auto-generated `JWT_SECRET`, and an isolated Postgres database via Neon branching. Previews are torn down automatically when the PR is closed or merged.

See `docs/adr/ADR-0002-render-blueprint-neon-branching.md` for the architecture rationale.

## Architecture

Two declarative sources of truth, one orchestration workflow:

- **`render.yaml`** (Render Blueprint) — declares the `agent` web service, the `agent-shared` env group, `previews.generation: automatic`, build/start commands, health check, and all static env vars. `JWT_SECRET` uses `generateValue: true` so Render creates a unique 256-bit base64 secret per service (base and each preview) before the first deploy boots. (Phase 2.5b's `agent-n8n` service block was reverted — see "Per-PR n8n previews — deferred" below.)
- **Neon project `cold-block-91735878`** (or whatever `vars.NEON_PROJECT_ID` resolves to) — Postgres lives here. The Neon `production` branch holds the canonical schema. Every PR gets a copy-on-write child branch named `preview/pr-<num>`.
- **`.github/workflows/pr-preview.yml`** — only handles what the two sources above can't: it creates the Neon branch on PR open, discovers the matching Render preview service, PUTs the Neon branch URL as `DATABASE_URL`, triggers a redeploy, waits for `/v1/health`, and comments the preview URL on the PR. On PR close it deletes the Neon branch.

## First-time setup

These steps are one-time per repository. After them, every PR provisions a preview with no human intervention.

### 1. Create the Neon project

1. Neon Console → **New Project**.
2. Name: `agent`. Postgres version: **16**. Region: pick the one closest to your Render region.
3. Click **Create Project**. Neon creates a default branch (named `production` in recent Neon projects, or `main` in older ones) with role `neondb_owner`. Whatever the default branch is named, **that's the parent for every preview branch** — this workflow uses Neon's default-branch behavior and does not pin a parent.

### 2. Apply baseline migrations to the Neon `production` branch

Every preview branch is a copy-on-write clone of the project's default branch (named `production` in recent Neon projects, `main` in older ones), so whatever schema and extensions exist there at branch-creation time are what each preview inherits. Run the migrations once before opening the first PR:

```bash
# Copy the connection string from Neon Console → Project → Connection Details
export DATABASE_URL='postgresql://neondb_owner:...@ep-...neon.tech/neondb?sslmode=require'
node backend/scripts/migrate.js
```

Verify in Neon's SQL Editor:

```sql
SELECT extname FROM pg_extension;          -- should include 'vector' and 'uuid-ossp'
SELECT count(*) FROM tenants;              -- should return 0 (table exists, no rows)
```

### 3. Connect the Neon GitHub Integration

Recommended path — Neon auto-creates the GitHub secret and variable for you:

1. Neon Console → Project → **Integrations** → GitHub card → **Add**.
2. **Install GitHub App** → select this repository → **Connect**.

Neon then creates in this repo's Settings → Secrets and variables → Actions:

- `NEON_API_KEY` (secret)
- `NEON_PROJECT_ID` (variable, e.g., `cold-block-91735878`)

*Manual alternative:* Neon Console → Profile (top-right) → **API keys** → New API key. Copy the project ID from Project Settings → General. Add both to the GitHub repo manually.

### 4. Connect the Render Blueprint

1. Render Dashboard → **New** → **Blueprint**.
2. Select this repository. Render reads `render.yaml`.
3. Render shows the services and env groups it will create. Confirm.
4. Render prompts once for the `sync: false` values:
   - `DATABASE_URL` (on `agent`) → the Neon `production` branch connection string from step 2.
   - `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `S3_BUCKET`, `CORS_ORIGINS` (on the `agent-shared` env group).
5. Click **Apply**. Render creates the env group and the base service, auto-generates `JWT_SECRET`, builds, and deploys.

Verify the base service is healthy: `curl https://<your-service>.onrender.com/v1/health`.

### 4a. If you already have a standalone Render service named `agent`

Skip this if you don't. Blueprint adopts an existing service when names match — so the service `name: agent` in `render.yaml` will adopt your existing `agent` service rather than create a duplicate.

The existing service's env vars are preserved (Render merges, never silently deletes). `generateValue: true` only generates `JWT_SECRET` if the key doesn't already exist, so a manually-set value survives.

Before connecting Blueprint, if your existing service has been failing with `JWT_SECRET must be set to a strong secret in production`, run the one-shot bootstrap workflow to unblock it:

```bash
gh workflow run bootstrap-render-base.yml
gh run watch  # watches the most recent run
```

That workflow PUTs a fresh `JWT_SECRET` on the service, triggers a redeploy, and waits for `/v1/health` to return 200. Once it succeeds, your existing service is healthy and Blueprint adoption in step 4 will preserve the value.

### 5. Required GitHub secrets and variables

After steps 3 and 4 you should see in **Settings → Secrets and variables → Actions**:

| Name | Type | Set by |
|---|---|---|
| `RENDER_API_KEY` | Secret | Manual (Render Dashboard → Account Settings → API Keys) |
| `RENDER_SERVICE_ID` | Secret | Manual (the `srv-…` ID of the `agent` base service) |
| `NEON_API_KEY` | Secret | Neon GitHub Integration |
| `NEON_PROJECT_ID` | Variable | Neon GitHub Integration |

## What happens on every PR

1. PR is opened / pushed → `pr-preview.yml` runs.
2. **`dorny/paths-filter@v3`** flags migration/workflow path changes (`backend/db/migrations/**`, `backend/src/workflows/**`, `infra/docker-compose.n8n.yml`, or `render.yaml`) so the smoke-test job can gate on that signal.
3. **Neon branch created**: `preview/pr-<num>` is a copy-on-write clone of the project's default branch (`production`) — full schema, extensions, and RLS policies inherited. The branch is created with an `expires_at` 14 days out as a safety net; normal PR close deletes it earlier.
3a. **(Conditional) Schema-diff comment**: if the preview branch's schema differs from the parent, `neondatabase/schema-diff-action` posts a separate PR comment showing the diff. Silent when schemas match.
4. **Backend Render preview** is auto-spawned by Render Blueprint. The workflow PUTs `DATABASE_URL` (per-PR Neon branch URL) and triggers a redeploy.
5. **Workflow records the preview in `preview_environments`** (migration 014) via `psql` against the Neon branch URL, with `set_config('app.tenant_id', …)` so RLS evaluates correctly.
6. **Workflow waits** for `<preview-url>/v1/health` to return 200.
7. **Workflow comments** on the PR with the preview URL + Neon branch details.
8. **`smoke-test` job** runs when the migration/workflow paths-filter matched — probes backend health + verifies the `preview_environments` row was recorded.

The first preview deploy may show as "Failed" in Render's deploy log because it boots before the workflow sets `DATABASE_URL`. The next deploy succeeds. PR authors see only the comment on the successful deploy.

## What happens on PR close

1. **`preview_environments` row** flipped to `status='torn_down'`, `torn_down_at = now()` (against the prod DB; the Neon branch is about to be deleted).
2. **Neon branch deleted**: `preview/pr-<num>` is removed (`neondatabase/delete-branch-action`).
3. **Render preview service deleted**: handled by Render automatically when the PR closes.
4. **GitHub deployment marked inactive**, environment deleted, teardown comment posted.

## Per-PR n8n previews — deferred

Phase 2.5b initially included a single-container `agent-n8n` service declared in `render.yaml` alongside the backend (default single-process mode; no worker, no Redis) so workflow/migration PRs could exercise n8n end-to-end against the per-PR Neon branch's `n8n` schema.

The implementation was reverted in this same phase. Two empirical findings drove the revert:

1. Render Blueprint creates `runtime: image` services on the main branch on adoption, but provides no "preview-only services" mechanism. The main-branch `agent-n8n` crash-looped immediately (missing `DB_POSTGRESDB_*` env vars, which are `sync: false` by design) and billed until manually deleted.
2. Render's Blueprint preview-spawn for `runtime: image` services did not produce a per-PR preview after Blueprint re-adoption + a fresh PR-synchronize event. The `agent` (Node) preview spawned fine; the `agent-n8n` preview never appeared. Render's docs are silent on this case (verified May 2026 against `render.com/docs/blueprint-spec` and `render.com/docs/preview-environments`).

The paths-filter gate is retained in `pr-preview.yml` so future work can still smoke-test PRs that touch workflow/migration paths. Migration 014's `render_n8n_service_id` and `n8n_url` columns are also retained (now NULL for all PR-driven rows) so a future phase can wire a different preview mechanism without a schema change.

## Agent-initiated previews

Phase 2.5b also adds agent-spawned previews driven by `AgentPreviewSpawnerService`. When a service-account agent POSTs to `/v1/workflow-proposals` with a `stepRunId` (yielding `proposal_source='failure_recovery'`), an in-process LISTEN/NOTIFY pipeline triggers the spawner:

1. Per-tenant concurrency cap (`MAX_ACTIVE_AGENT_PREVIEWS_PER_TENANT`, default 3) — rejects new spawns when at cap; audits `agent_preview.rate_limited`.
2. Advisory lock per `workflow_version_id` — dedupes across multi-pod NOTIFY delivery.
3. INSERTs `preview_environments` row (`source='agent_failure_recovery'`, `status='pending'`, 24h TTL).
4. Calls Neon `createBranch` → Render `createService` (backend only — agent-spawned previews don't include n8n; Render's `POST /v1/services` doesn't support the `keyvalue` type used in Blueprint).
5. Polls for the service URL, UPDATEs `status='ready'`, audits `agent_preview.created`.

`PreviewTtlService` (NestJS `@Cron`, every 30 minutes) sweeps expired rows: deletes the Render service, flips `status='expired'`, audits `agent_preview.expired`. Neon branches have their own `expires_at` so they auto-clean.

**Kill switch:** `AGENT_PREVIEW_ENABLED=false` disables the spawner entirely. Default is `false` until ops sizes the per-tenant cap and provisions `RENDER_API_KEY` + `RENDER_OWNER_ID`.

## Local testing

For local Docker-based testing (separate from the Render flow):

```bash
docker compose up
# Backend: http://localhost:3000
# Health:  http://localhost:3000/v1/health
# Docs:    http://localhost:3000/api/docs
```

`docker-compose.yml` runs Postgres + the backend container together. Edit env values in the compose file or a sibling `.env`.

## Troubleshooting

### Bootstrap fails with `JWT_SECRET must be set to a strong secret in production`

If you see this on the BASE service (not a preview), Blueprint isn't connected yet, or it's connected but `JWT_SECRET` was never generated. Fastest fix: trigger the bootstrap workflow.

```bash
gh workflow run bootstrap-render-base.yml
```

For a PREVIEW deploy, the Render Blueprint connection is missing or broken. `JWT_SECRET` is supposed to be generated by `render.yaml`'s `generateValue: true`. Check:

1. Render Dashboard → service → Environment tab → confirm `JWT_SECRET` shows as **Generated**.
2. Render Dashboard → service → Settings → confirm Blueprint is connected.
3. If neither holds, connect the Blueprint (step 4 of first-time setup).

### Workflow fails at "No Render preview service found for PR #N after 3 min"

The Render preview was not created. Most likely cause: Render Blueprint is not connected to this repo, so Render isn't auto-creating preview services for PRs. Connect Blueprint via the Render dashboard (step 4 of first-time setup), then re-run the workflow.

Less common: `render.yaml` is missing on the PR branch, or `previews.generation: automatic` was removed from the service config. Verify `render.yaml` exists on the PR's head commit.

### Preview is up but DB queries fail with `relation "tenants" does not exist`

The Neon `production` branch was not migrated before opening the PR. Apply step 2 of first-time setup against the Neon `production` branch, then close and reopen the PR to provision a fresh preview branch.

### Workflow fails at "Neon DB URL is empty"

`NEON_API_KEY` is missing, invalid, or doesn't have access to the project specified by `NEON_PROJECT_ID`. Re-check both values in repo Settings → Secrets and variables → Actions.

### Hit Neon free-tier branch limit

Neon Free allows ~10 child branches per project. Close stale PRs (which deletes their branches), or upgrade to the Launch plan. The Blueprint's `previews.expireAfterDays: 7` setting also expires unused preview *services* after a week, but does not delete their Neon branches. Neon branches now get an `expires_at` 14 days out as a workflow-level safety net — Neon will auto-delete them when expired even if the PR was never closed.

### I don't see a comment from Neon on the PR

Neon's GitHub Integration installs the API key + project ID, but it does **not** post PR comments by itself. The Branches view in the Neon Console is the canonical place to see preview branches. Our `pr-preview.yml` workflow posts a single combined comment (preview URL + Neon branch details) and additionally uses `neondatabase/schema-diff-action`, which posts a *separate* Neon-authored comment **only when** the preview branch's schema actually differs from the parent. If you push a PR that doesn't touch migrations, you'll only see our combined comment — that's expected.

## References

- ADR-0002 — `docs/adr/ADR-0002-render-blueprint-neon-branching.md`
- [Render Blueprint spec](https://render.com/docs/blueprint-spec)
- [Render preview environments](https://render.com/docs/preview-environments)
- [Neon branching with GitHub Actions](https://neon.com/docs/guides/branching-github-actions)
- [Neon GitHub Integration](https://neon.com/docs/guides/neon-github-integration)
- [`neondatabase/create-branch-action`](https://github.com/neondatabase/create-branch-action)
- [`neondatabase/delete-branch-action`](https://github.com/neondatabase/delete-branch-action)
