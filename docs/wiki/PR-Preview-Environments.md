# PR Preview Environments

Every Pull Request that is marked as "ready for review" gets a dedicated preview environment: an isolated Render web service with its own auto-generated `JWT_SECRET` and an isolated Neon Postgres branch. Previews are torn down automatically when the PR is closed or merged.

For architecture rationale, see [ADR-0002](Architecture-Decision-Records#adr-0002).

---

## Architecture

Two declarative sources of truth, one orchestration workflow:

| Source | Role |
|--------|------|
| **`render.yaml`** (Render Blueprint) | Declares the `agent` web service: build/start commands, health check, env vars, preview enablement. `JWT_SECRET` uses `generateValue: true` so Render creates a unique secret per service at creation time. |
| **Neon project** | Postgres schema lives on the default branch (`production`). Each PR gets a copy-on-write child branch named `preview/pr-<num>`. |
| **`.github/workflows/pr-preview.yml`** | Orchestrates what the declarative sources can't: creates the Neon branch, wires its URL as `DATABASE_URL` into the preview service, waits for health, and posts the PR comment. On PR close: deletes the Neon branch. |

---

## First-Time Setup

This is a one-time setup per repository. See [Installation](Installation#step-3--optional-connect-render-blueprint-for-pr-previews) for the full walkthrough.

Summary:
1. Create a Neon project and apply baseline migrations to the default branch.
2. Connect the Neon GitHub Integration (auto-creates `NEON_API_KEY` secret + `NEON_PROJECT_ID` variable).
3. Connect the Render Blueprint (Render Dashboard → New → Blueprint).
4. Add `RENDER_API_KEY` and `RENDER_SERVICE_ID` to GitHub Secrets.

---

## What Happens on Every PR

1. PR opens / is pushed to → `pr-preview.yml` runs.
2. **Neon branch created**: `preview/pr-<num>` is a copy-on-write clone of the default branch — full schema, extensions, and RLS policies inherited. An `expires_at` 14 days out is set as a safety net.
3. **Render preview service created** automatically by Render Blueprint (named `agent-pr-<num>`), with its own auto-generated `JWT_SECRET`.
4. **Workflow PUTs `DATABASE_URL`** (the Neon branch's connection string) onto the preview service and triggers a fresh deploy.
5. **Workflow waits** for `<preview-url>/v1/health` to return 200.
6. **Schema diff**: if the PR's schema differs from the parent branch, `neondatabase/schema-diff-action` posts a separate comment showing the diff.
7. **Workflow comments** on the PR with the preview URL and Neon branch details.

> **Note:** The first preview deploy may appear as "Failed" in Render's log because it boots before `DATABASE_URL` is set. The second deploy (triggered by the workflow) succeeds. PR authors see only the comment on the successful deploy.

---

## What Happens on PR Close

1. **Neon branch deleted**: `preview/pr-<num>` is removed.
2. **Render preview service deleted**: handled automatically by Render.
3. **GitHub deployment marked inactive**, environment deleted, teardown comment posted.

---

## Using a Preview Environment

As a reviewer, you can test any PR by:

1. Opening the PR on GitHub.
2. Finding the preview URL in the automated comment.
3. Accessing the API at the preview URL.
4. The API documentation is at `<preview-url>/api/docs`.

---

## Required Secrets and Variables

| Name | Type | Set by |
|------|------|--------|
| `RENDER_API_KEY` | Secret | Manual (Render Dashboard → Account Settings → API Keys) |
| `RENDER_SERVICE_ID` | Secret | Manual (the `srv-…` ID of the base `agent` service) |
| `NEON_API_KEY` | Secret | Neon GitHub Integration |
| `NEON_PROJECT_ID` | Variable | Neon GitHub Integration |

---

## Troubleshooting Previews

### `JWT_SECRET must be set to a strong secret in production`

**On the base service:** Blueprint isn't connected, or `JWT_SECRET` was never generated. Run the bootstrap workflow:

```bash
gh workflow run bootstrap-render-base.yml
```

**On a preview service:** Render Blueprint's `generateValue: true` isn't applying. Check:
1. Render Dashboard → service → Environment tab → confirm `JWT_SECRET` shows as **Generated**.
2. Render Dashboard → service → Settings → confirm Blueprint is connected.
3. If not connected, connect Blueprint (Render Dashboard → New → Blueprint).

### "No Render preview service found for PR #N after 3 min"

Render Blueprint is not connected, so Render isn't auto-creating preview services for PRs. Connect Blueprint via the Render dashboard, then re-run the workflow.

Less common cause: `render.yaml` is missing on the PR branch, or `previews.generation: automatic` was removed from the service config.

### "Preview is up but DB queries fail with `relation "tenants" does not exist`"

The Neon default branch was not migrated before opening the PR. Apply baseline migrations to the Neon default branch, then close and reopen the PR to provision a fresh preview branch.

### "Workflow fails at 'Neon DB URL is empty'"

`NEON_API_KEY` is missing, invalid, or doesn't have access to the project in `NEON_PROJECT_ID`. Check both values in Settings → Secrets and variables → Actions.

### Hit the Neon free-tier branch limit

Neon Free allows ~10 child branches per project. Close stale PRs (which deletes their branches), or upgrade to the Launch plan.

### I don't see a Neon comment on the PR

Neon's GitHub Integration does not post PR comments by itself. A separate comment only appears when `neondatabase/schema-diff-action` detects a schema difference between the preview branch and the parent. If the PR doesn't touch migrations, no Neon-authored comment is expected — only the combined preview comment from our workflow.

---

## Local Testing (Docker Compose)

For local testing separate from the Render flow:

```bash
docker compose up
# Backend: http://localhost:3000
# Health:  http://localhost:3000/v1/health
# API docs: http://localhost:3000/api/docs
```

`docker-compose.yml` runs Postgres + the backend container together. Edit env values in the compose file or a sibling `.env`.

---

## References

- [`render.yaml`](https://github.com/rinzler-vicky/agent/blob/main/render.yaml) — Render Blueprint
- [`docs/PR_PREVIEWS.md`](https://github.com/rinzler-vicky/agent/blob/main/docs/PR_PREVIEWS.md) — Full runbook
- [ADR-0002](Architecture-Decision-Records#adr-0002) — Architecture rationale
- [Render Blueprint spec](https://render.com/docs/blueprint-spec)
- [Neon branching with GitHub Actions](https://neon.com/docs/guides/branching-github-actions)
