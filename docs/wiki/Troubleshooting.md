# Troubleshooting

This page covers common problems and how to resolve them.

---

## Agent / Workflow Issues

### The agent didn't trigger after I applied the label

**Check:**
1. Does the label name exactly match `route: claude-backend` (including the space and colon)?
2. Is `ANTHROPIC_API_KEY` set in Settings → Secrets and variables → Actions?
3. Go to **Actions** tab → select the **Headless Claude Backend Dispatcher** workflow → check recent runs for errors.

**Fix:**
- Create or verify the label spelling.
- Add/update `ANTHROPIC_API_KEY`.
- Re-apply the label (remove it and re-add it to re-trigger the workflow).

---

### The AI Gatekeeper posted no review comment

**Check:**
1. Is `ANTHROPIC_API_KEY` or `GEMINI_API_KEY` set?
2. Is the PR targeting `main`?
3. Check the **AI Gatekeeper** workflow run in the Actions tab.

**Fix:**
- Add at least one of the API key secrets.
- Ensure the PR is not a draft (drafts may not trigger the workflow depending on configuration).

---

### The self-healing loop didn't fix a failing PR

The autonomous feedback loop has a retry budget of 20 turns. If exhausted, the issue is too complex for the agent to self-heal:

1. Read the failing CI logs in the PR's Checks tab.
2. Identify the root cause manually.
3. Push a fix commit to the PR branch, or open a new issue describing the problem for the agent to tackle separately.

---

### The agent opened a PR but `.agentic/STATE.md` was not updated

This means the agent completed implementation but did not finish the state update step. You can:
1. Manually edit `.agentic/STATE.md` to reflect the completed task.
2. Comment on the PR asking the agent to update the state (re-apply the label on the original issue if needed).

---

## Render / PR Preview Issues

### `JWT_SECRET must be set to a strong secret in production`

**On the base service (not a preview):**

Blueprint isn't connected, or `JWT_SECRET` was never generated. Run the bootstrap workflow:

```bash
gh workflow run bootstrap-render-base.yml
gh run watch
```

**On a preview service:**

`generateValue: true` in `render.yaml` should generate `JWT_SECRET` per preview. If it's missing:
1. Render Dashboard → preview service → Environment tab → confirm `JWT_SECRET` shows as **Generated**.
2. Render Dashboard → preview service → Settings → confirm Blueprint is connected.
3. If Blueprint is not connected, connect it (Render Dashboard → New → Blueprint).

---

### "No Render preview service found for PR #N after 3 min"

Render Blueprint is not connected to this repository. Render auto-creates preview services only when Blueprint is connected.

**Fix:** Connect Blueprint via Render Dashboard → New → Blueprint → select this repo.

After connecting, re-run the preview workflow:
```bash
gh workflow run pr-preview.yml
```

---

### Preview is up but DB queries fail: `relation "tenants" does not exist`

The Neon default branch was not migrated before opening the PR. Every preview inherits the schema from the default branch at branch-creation time.

**Fix:**
1. Get the Neon default branch connection string from the Neon Console.
2. Apply migrations:
   ```bash
   export DATABASE_URL='postgresql://...'
   node backend/scripts/migrate.js
   ```
3. Close and reopen the PR to provision a fresh preview branch.

---

### Workflow fails at "Neon DB URL is empty"

`NEON_API_KEY` is missing, invalid, or the key doesn't have access to the project in `NEON_PROJECT_ID`.

**Fix:** Check both values in Settings → Secrets and variables → Actions. Re-run the Neon GitHub Integration setup if needed.

---

### Hit Neon free-tier branch limit (~10 branches)

**Fix:**
- Close stale PRs — each PR close deletes its Neon branch.
- Or upgrade to the Neon Launch plan.
- Preview branches also auto-expire after 14 days (Neon will delete them automatically).

---

### I don't see a Neon comment on my PR

Neon's GitHub Integration does not post PR comments by itself. A Neon-authored comment only appears when `neondatabase/schema-diff-action` detects a schema difference between the preview branch and the parent.

If the PR doesn't touch migrations, only the combined preview URL comment from our workflow will appear — that's expected.

---

## Database / Migration Issues

### Running `node backend/scripts/migrate.js` fails

**Check:**
1. Is `DATABASE_URL` set correctly in your environment?
2. Does the Postgres user have CREATE TABLE permissions?
3. Is the `pgvector` extension available? (Required by migration 001.)

```bash
psql $DATABASE_URL -c "SELECT extname FROM pg_extension;"
```

If `pgvector` is missing, ask your Postgres provider to enable it or install it:
```sql
CREATE EXTENSION IF NOT EXISTS vector;
```

---

### `app.tenant_id` session variable not set

Queries on tenant-scoped tables require `current_setting('app.tenant_id', true)` to be set per database client. If you're making direct `psql` queries for debugging, set it manually:

```sql
SET app.tenant_id = '<your-tenant-uuid>';
SELECT * FROM workspaces;
```

---

## Local Development Issues

### Docker Compose fails to start

**Check:**
```bash
docker compose logs backend
docker compose logs postgres
```

Common causes:
- `backend/.env` missing (copy from `backend/.env.example`).
- `JWT_SECRET` not set or too short (must be at least 32 characters).
- Port 3000 or 5432 already in use on your machine.

---

### `pnpm install` fails

This is a pnpm workspaces monorepo. Run `pnpm install` from the **repo root**, not from a workspace directory.

```bash
cd /path/to/agent
pnpm install
```

If you see `EROFS` errors on install, ensure you're not running in a read-only filesystem.

---

### Backend tests fail locally but pass in CI

Common causes:
- Jest version mismatch: run `pnpm install` to ensure local deps match the lockfile.
- Environment variables leaking from a local `.env` file: tests mock the database, but some guards check env vars.

Run tests with:
```bash
cd backend
pnpm test
```

---

## Still Stuck?

1. Check the [GitHub Actions runs](https://github.com/rinzler-vicky/agent/actions) for detailed logs.
2. Check `.agentic/STATE.md` for known issues and pending tasks.
3. Open a GitHub Issue describing the problem — apply `route: claude-backend` to have the agent investigate.

---

## Related Pages

- [Installation](Installation) — initial setup.
- [PR Preview Environments](PR-Preview-Environments) — preview-specific troubleshooting.
- [Workflow Reference](Workflow-Reference) — workflow details and failure modes.
