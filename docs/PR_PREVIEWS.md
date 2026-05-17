# PR Preview Environments

Every Pull Request that leaves draft status gets a dedicated preview: a Render web service, its own auto-generated `JWT_SECRET`, and an isolated Postgres database via Neon branching. Previews are torn down automatically when the PR is closed or merged.

See `docs/adr/ADR-0002-render-blueprint-neon-branching.md` for the architecture rationale.

## Architecture

Two declarative sources of truth, one orchestration workflow:

- **`render.yaml`** (Render Blueprint) — declares the `agent-backend` web service, the `agent-shared` env group, `previews.generation: automatic`, build/start commands, health check, and all static env vars. `JWT_SECRET` uses `generateValue: true` so Render creates a unique 256-bit base64 secret per service (base and each preview) before the first deploy boots.
- **Neon project `cold-block-91735878`** (or whatever `vars.NEON_PROJECT_ID` resolves to) — Postgres lives here. The Neon `main` branch holds the canonical schema. Every PR gets a copy-on-write child branch named `preview/pr-<num>`.
- **`.github/workflows/pr-preview.yml`** — only handles what the two sources above can't: it creates the Neon branch on PR open, discovers the matching Render preview service, PUTs the Neon branch URL as `DATABASE_URL`, triggers a redeploy, waits for `/v1/health`, and comments the preview URL on the PR. On PR close it deletes the Neon branch.

## First-time setup

These steps are one-time per repository. After them, every PR provisions a preview with no human intervention.

### 1. Create the Neon project

1. Neon Console → **New Project**.
2. Name: `agent`. Postgres version: **16**. Region: pick the one closest to your Render region.
3. Click **Create Project**. Neon creates a default branch `main` with role `neondb_owner`.

### 2. Apply baseline migrations to the Neon `main` branch

Every preview branch is a copy-on-write clone of `main`, so whatever schema and extensions exist on `main` at branch-creation time are what each preview inherits. Run the migrations once before opening the first PR:

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
   - `DATABASE_URL` (on `agent-backend`) → the Neon `main` branch connection string from step 2.
   - `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `S3_BUCKET`, `CORS_ORIGINS` (on the `agent-shared` env group).
5. Click **Apply**. Render creates the env group and the base service, auto-generates `JWT_SECRET`, builds, and deploys.

Verify the base service is healthy: `curl https://<your-service>.onrender.com/v1/health`.

### 5. Required GitHub secrets and variables

After steps 3 and 4 you should see in **Settings → Secrets and variables → Actions**:

| Name | Type | Set by |
|---|---|---|
| `RENDER_API_KEY` | Secret | Manual (Render Dashboard → Account Settings → API Keys) |
| `RENDER_SERVICE_ID` | Secret | Manual (the `srv-…` ID of the `agent-backend` base service) |
| `NEON_API_KEY` | Secret | Neon GitHub Integration |
| `NEON_PROJECT_ID` | Variable | Neon GitHub Integration |

## What happens on every PR

1. PR is opened / pushed → `pr-preview.yml` runs.
2. **Neon branch created**: `preview/pr-<num>` is a copy-on-write clone of `main` — full schema, extensions, and RLS policies inherited.
3. **Render preview service created** (automatically by Render Blueprint, not by the workflow): a separate service named `agent-backend-pr-<num>` is created with its own auto-generated `JWT_SECRET` and inheriting all `agent-shared` group values.
4. **Workflow PUTs `DATABASE_URL`** on the preview service (the Neon branch's connection string) and triggers a fresh deploy.
5. **Workflow waits** for `<preview-url>/v1/health` to return 200.
6. **Workflow comments** on the PR with the preview URL and Neon branch name.

The first preview deploy may show as "Failed" in Render's deploy log because it boots before the workflow sets `DATABASE_URL`. The next deploy succeeds. PR authors see only the comment on the successful deploy.

## What happens on PR close

1. **Neon branch deleted**: `preview/pr-<num>` is removed (`neondatabase/delete-branch-action`).
2. **Render preview service deleted**: handled by Render automatically when the PR closes.
3. **GitHub deployment marked inactive**, environment deleted, teardown comment posted.

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

If you see this on a preview deploy, the Render Blueprint connection is missing or broken. `JWT_SECRET` is supposed to be generated by `render.yaml`'s `generateValue: true`. Check:

1. Render Dashboard → service → Environment tab → confirm `JWT_SECRET` shows as **Generated**.
2. Render Dashboard → service → Settings → confirm Blueprint is connected.
3. If neither holds, re-run the Blueprint connection (step 4 of first-time setup).

### Workflow fails at "Could not discover a Render preview service"

The Render preview was not created. Either `render.yaml` is missing on the PR branch, or `previews.generation: automatic` was overridden. Confirm `render.yaml` exists on the PR's head commit.

### Preview is up but DB queries fail with `relation "tenants" does not exist`

The Neon `main` branch was not migrated before opening the PR. Apply step 2 of first-time setup against the Neon `main` branch, then close and reopen the PR to provision a fresh preview branch.

### Workflow fails at "Neon DB URL is empty"

`NEON_API_KEY` is missing, invalid, or doesn't have access to the project specified by `NEON_PROJECT_ID`. Re-check both values in repo Settings → Secrets and variables → Actions.

### Hit Neon free-tier branch limit

Neon Free allows ~10 child branches per project. Close stale PRs (which deletes their branches), or upgrade to the Launch plan. The Blueprint's `previews.expireAfterDays: 7` setting also expires unused preview *services* after a week, but does not delete their Neon branches — those need PR closure or manual cleanup from the Neon Console.

## References

- ADR-0002 — `docs/adr/ADR-0002-render-blueprint-neon-branching.md`
- [Render Blueprint spec](https://render.com/docs/blueprint-spec)
- [Render preview environments](https://render.com/docs/preview-environments)
- [Neon branching with GitHub Actions](https://neon.com/docs/guides/branching-github-actions)
- [Neon GitHub Integration](https://neon.com/docs/guides/neon-github-integration)
- [`neondatabase/create-branch-action`](https://github.com/neondatabase/create-branch-action)
- [`neondatabase/delete-branch-action`](https://github.com/neondatabase/delete-branch-action)
