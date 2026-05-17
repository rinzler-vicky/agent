# Installation

This page covers everything you need to get the Agent repository running end-to-end.

---

## Prerequisites

| Requirement | Notes |
|-------------|-------|
| GitHub repository | You already have one — this is it. |
| Anthropic API key | Required. Powers Claude for code generation, self-healing, and AI gatekeeper fallback. |
| Gemini API key | Optional. Preferred AI reviewer for the structural gatekeeper. |
| Render account | Required for PR preview environments. |
| Neon Postgres account | Required for PR preview environments (isolated database branch per PR). |

---

## Step 1 — Add Repository Secrets

Go to **Settings → Secrets and variables → Actions** and add:

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `ANTHROPIC_API_KEY` | Secret | **YES** | API key for Claude. [Get one from the Anthropic Console](https://console.anthropic.com/settings/keys). |
| `GEMINI_API_KEY` | Secret | Optional | API key for Gemini (preferred gatekeeper reviewer). [Get one from Google AI Studio](https://aistudio.google.com/app/apikey). |
| `RENDER_API_KEY` | Secret | For previews | Render account API key. Find in Render Dashboard → Account Settings → API Keys. |
| `RENDER_SERVICE_ID` | Secret | For previews | The `srv-…` ID of the base `agent` Render service. |
| `NEON_API_KEY` | Secret | For previews | Neon API key. Set automatically if you use the Neon GitHub Integration. |

And add this **variable** (not secret):

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `NEON_PROJECT_ID` | Variable | For previews | Your Neon project ID (e.g., `cold-block-91735878`). Set automatically by Neon GitHub Integration. |

**Minimum requirement:** Only `ANTHROPIC_API_KEY` is needed for the agent to write code and open PRs. The preview-related secrets are only needed if you want per-PR preview environments.

---

## Step 2 — Create the Routing Label

The agent is triggered by applying a label to a GitHub Issue.

1. Go to **Issues → Labels → New label**.
2. Name: `route: claude-backend`
3. Color: your choice.
4. Click **Create label**.

---

## Step 3 — (Optional) Connect Render Blueprint for PR Previews

PR preview environments need a Render Blueprint connection. This is a one-time setup per repository.

### 3a. Create the Neon Project

1. [Neon Console](https://console.neon.tech) → **New Project**.
2. Name: `agent`. Postgres version: **16**. Region: closest to your Render region.
3. Click **Create Project**. Note the project's default branch name (usually `production` for Console-created projects).

### 3b. Apply Database Migrations to the Neon Default Branch

Every PR preview branch is a copy-on-write clone of the default branch, so it must have the schema before you open the first PR.

```bash
export DATABASE_URL='postgresql://neondb_owner:...@ep-...neon.tech/neondb?sslmode=require'
node backend/scripts/migrate.js
```

Verify in Neon's SQL Editor:

```sql
SELECT extname FROM pg_extension;  -- should include 'vector' and 'uuid-ossp'
SELECT count(*) FROM tenants;      -- should return 0 (table exists, empty)
```

### 3c. Connect the Neon GitHub Integration

1. Neon Console → Project → **Integrations** → GitHub card → **Add**.
2. Select this repository → **Connect**.

Neon automatically creates `NEON_API_KEY` (secret) and `NEON_PROJECT_ID` (variable) in your repo's Actions settings.

### 3d. Connect the Render Blueprint

1. Render Dashboard → **New** → **Blueprint**.
2. Select this repository. Render reads `render.yaml`.
3. Confirm the services Render will create.
4. Provide the `sync: false` values when prompted:
   - `DATABASE_URL` (point at the Neon default branch connection string from step 3b)
   - `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `S3_BUCKET`, `CORS_ORIGINS` (on the `agent-shared` env group)
5. Click **Apply**. Render creates the service, auto-generates `JWT_SECRET`, builds, and deploys.

Verify: `curl https://<your-service>.onrender.com/v1/health`

For full preview environment documentation, see [PR Preview Environments](PR-Preview-Environments).

---

## Step 4 — Local Development

You can run the backend locally with Docker Compose:

```bash
docker compose up
# Backend: http://localhost:3000
# Health:  http://localhost:3000/v1/health
# API docs: http://localhost:3000/api/docs
```

Or directly with pnpm (requires a local Postgres):

```bash
# From repo root
pnpm install

# Run migrations
export DATABASE_URL='postgresql://...'
node backend/scripts/migrate.js

# Start the backend
pnpm --filter backend run start:dev
```

Copy `backend/.env.example` to `backend/.env` and fill in the values before starting.

---

## Environment Variables Reference

All environment variables are documented in `backend/.env.example`. Key variables:

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | Yes | Postgres connection string |
| `JWT_SECRET` | Yes | Strong secret for JWT signing (min 32 chars) |
| `PORT` | No | HTTP port (default: 3000) |
| `CORS_ORIGINS` | Yes | Comma-separated allowed origins |
| `AWS_ACCESS_KEY_ID` | For storage | AWS / S3-compatible key |
| `AWS_SECRET_ACCESS_KEY` | For storage | AWS / S3-compatible secret |
| `S3_BUCKET` | For storage | S3 bucket name |
| `S3_ENDPOINT` | No | Override for S3-compatible endpoints (MinIO, R2) |
| `WORKFLOW_CONTROL_PLANE_ENABLED` | No | Feature flag for Phase 2 workflow engine (default: false) |
| `REDIS_URL` | For n8n queue | Redis connection string |
| `N8N_API_URL` | For n8n | n8n API base URL |
| `N8N_API_KEY` | For n8n | n8n API key |
| `NEON_API_KEY` | For previews | Neon API key |
| `NEON_PROJECT_ID` | For previews | Neon project ID |

---

## Next Steps

- [Usage](Usage) — learn how to write issues and trigger the agent.
- [PR Preview Environments](PR-Preview-Environments) — detailed setup and runbook for Render + Neon.
- [Troubleshooting](Troubleshooting) — common setup problems.
