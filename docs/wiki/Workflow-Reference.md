# Workflow Reference

This page describes every GitHub Actions workflow in this repository: what triggers it, what it does, and what to do when it fails.

---

## Workflow Summary

| Workflow | File | Trigger | Purpose |
|----------|------|---------|---------|
| Headless Claude Backend Dispatcher | `claude-agent.yml` | Issue labeled `route: claude-backend` | Implements the feature described in the issue and opens a PR. |
| Autonomous CI Feedback Loop | `autonomous-feedback.yml` | PR opened or updated targeting `main` | Catches CI failures and dispatches Claude to self-heal the branch. |
| AI Gatekeeper — Structural Review | `gemini-gatekeeper.yml` | PR opened or updated | Audits the PR diff against architecture rules and posts a review report. |
| PR Preview Environment | `pr-preview.yml` | PR ready for review / PR closed | Creates a Neon branch + wires `DATABASE_URL` into Render preview, posts the preview URL comment, tears down on PR close. |
| Bootstrap Render Base | `bootstrap-render-base.yml` | Manual (`workflow_dispatch`) | One-shot: sets `JWT_SECRET` on the base Render service and waits for health. Run once before connecting Blueprint. |
| Sync Wiki | `sync-wiki.yml` | Push to `main` (changes to `docs/wiki/**`) | Pushes wiki source files from `docs/wiki/` to the GitHub Wiki. |

---

## Headless Claude Backend Dispatcher

**File:** `.github/workflows/claude-agent.yml`  
**Trigger:** Issue labeled `route: claude-backend`

### What it does

1. Reads `.agentic/STATE.md` to understand current project phase and blockers.
2. Reads architecture constraint files for immutable structural rules.
3. Implements the feature described in the labeled issue.
4. Runs `pnpm run lint` and `pnpm run test`. Fixes failures before proceeding.
5. Updates `.agentic/STATE.md` with what was built.
6. Opens a Pull Request referencing the original issue.

### Required secrets

- `ANTHROPIC_API_KEY`

### When it fails

- **Budget exhausted (25 turns):** The issue is likely too large or ambiguous. Break it into smaller child issues.
- **Label not found:** Create the `route: claude-backend` label first.

---

## Autonomous CI Feedback Loop

**File:** `.github/workflows/autonomous-feedback.yml`  
**Trigger:** PR check suite completed with failure, on PRs targeting `main`

### What it does

1. Captures the full error trace (lint + test output).
2. Dispatches Claude with the error trace as context.
3. Claude identifies the root cause, fixes files, and force-pushes to the PR branch.
4. CI re-runs automatically.

Retries up to 20 turns per remediation cycle.

### When it fails

- **Budget exhausted:** The failure is too complex or requires architectural changes. Human intervention needed.
- **Tests require external services:** Integration/E2E tests that need live Postgres or Redis will fail in the CI environment without those services configured.

---

## AI Gatekeeper — Structural Review

**File:** `.github/workflows/gemini-gatekeeper.yml`  
**Trigger:** PR opened, updated, or marked ready for review

### What it does

- If `GEMINI_API_KEY` is set: uses Gemini as the reviewer.
- Otherwise: falls back to Claude using `ANTHROPIC_API_KEY`.

The reviewer audits the PR diff against:
- Backend architecture rules (NestJS structural rules, ReBAC constraints)
- Frontend architecture rules (Vue 3 + Vuetify rules)
- `.agentic/STATE.md` — confirms the agent updated project state

Posts a Markdown review comment on the PR.

### Required secrets

- `ANTHROPIC_API_KEY` (required, fallback reviewer)
- `GEMINI_API_KEY` (optional, preferred reviewer)

### How to interpret the review

- **APPROVED:** No architectural violations found. Safe to merge after human review.
- **Violations listed:** Address each item before merging, or document a deliberate exception in the PR description.

---

## PR Preview Environment

**File:** `.github/workflows/pr-preview.yml`  
**Trigger:** PR ready for review (open job); PR closed (teardown job)

### What it does (on open)

1. Creates Neon branch `preview/pr-<num>` with 14-day expiry.
2. Discovers the matching Render preview service via the Render API.
3. PUTs the Neon branch URL as `DATABASE_URL` on the preview service.
4. Triggers a fresh Render deploy.
5. Waits for `<preview-url>/v1/health` to return 200 (with timeout).
6. Optionally posts a schema-diff comment (via `neondatabase/schema-diff-action`) if migrations changed.
7. Posts a combined comment: preview URL + Neon branch details.

### What it does (on close)

1. Deletes the Neon branch.
2. Marks the GitHub deployment as inactive.
3. Posts a teardown comment.

### Required secrets and variables

| Name | Type |
|------|------|
| `RENDER_API_KEY` | Secret |
| `RENDER_SERVICE_ID` | Secret |
| `NEON_API_KEY` | Secret |
| `NEON_PROJECT_ID` | Variable |

### Troubleshooting

See [PR Preview Environments — Troubleshooting](PR-Preview-Environments#troubleshooting-previews).

---

## Bootstrap Render Base

**File:** `.github/workflows/bootstrap-render-base.yml`  
**Trigger:** Manual (`workflow_dispatch`)

### What it does

A one-shot workflow that:
1. PUTs a freshly generated `JWT_SECRET` on the base Render service via the Render API.
2. Triggers a redeploy.
3. Waits for `/v1/health` to return 200.

Run this once if the base service is failing with `JWT_SECRET must be set to a strong secret in production` before you've connected the Render Blueprint.

```bash
gh workflow run bootstrap-render-base.yml
gh run watch
```

---

## Sync Wiki

**File:** `.github/workflows/sync-wiki.yml`  
**Trigger:** Push to `main` that includes changes under `docs/wiki/**`

### What it does

1. Clones the repository's GitHub Wiki (`<repo>.wiki.git`).
2. Copies all Markdown files from `docs/wiki/` into the wiki clone.
3. Commits and pushes any changes to the wiki.

This keeps the GitHub Wiki in sync with the `docs/wiki/` directory in the main repository. To update the wiki, edit files in `docs/wiki/` and open a PR.

### Required permissions

The workflow uses `GITHUB_TOKEN` with `contents: write` permission, which is sufficient to push to the wiki.

---

## Related Pages

- [Usage](Usage) — how to trigger the agent with an issue.
- [PR Preview Environments](PR-Preview-Environments) — full preview runbook.
- [Troubleshooting](Troubleshooting) — general issue resolution.
