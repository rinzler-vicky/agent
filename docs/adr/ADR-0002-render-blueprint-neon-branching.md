# ADR-0002 — Render Blueprint + Neon branching for ephemeral preview environments

- Status: Proposed
- Date: 2026-05-17
- Related issue(s): #35 (PR Preview Automation), PR #36
- Deciders: rinzler-vicky

## Context

Issue #35 / PR #36 introduce ephemeral preview environments for every Pull Request. The first implementation relied on Render's "manual PR preview" mode and a GitHub Actions workflow that imperatively patched the Render service via the Render REST API on every PR event:

- PATCHed `serviceDetails.envSpecificDetails.{buildCommand,startCommand}` to align Render with this monorepo's `pnpm --filter` invocation.
- PUT a synthesized `JWT_SECRET` (`openssl rand -hex 32`) onto the Render base service when the value was missing or still the placeholder.
- Added a `render-preview` label to the PR to satisfy Render's manual-preview opt-in.

This approach failed for every deploy on the PR branch with:

```
Error: JWT_SECRET must be set to a strong secret in production
    at bootstrap (backend/dist/main.js:15:19)
```

Root cause: Render's auto-deploy fires the moment a commit is pushed and the server boot races the workflow's env-var PUT. Even when the PUT eventually succeeds, the in-flight deploy that started before the PUT lands has already failed bootstrap. The same race applies on preview-service creation: previews inherit env vars from the base service *at creation time*, so a base service that doesn't yet have `JWT_SECRET` spawns previews that don't have it either.

Beyond the race, the imperative approach violates the user's stated principle that "GitHub should be the source of truth for everything." The Render dashboard owned the canonical service shape; the workflow's PATCHes were drift-correction, not declaration.

Constraints:

- Stay on Render (already chosen; not introducing a new vendor).
- Use Neon Postgres per ADR-0001 — including for previews.
- Bootstrap guard at `backend/src/main.ts:13-19` must not be weakened; the fix is to ensure the secret is set, not to soften the check.
- No long-lived shared preview database — each preview must have its own isolated Postgres state for safe testing.

## Decision

Replace imperative Render API patching with **Render Blueprint** (`render.yaml`) as the declarative source of truth, and use **Neon database branching** via the official `neondatabase/create-branch-action` / `delete-branch-action` for per-PR ephemeral Postgres.

Concretely:

1. **`render.yaml` at repo root** declares the `agent-backend` web service with `runtime: node`, the exact `pnpm --filter` build/start commands, `healthCheckPath: /v1/health`, and `previews.generation: automatic`.
2. **`JWT_SECRET` is declared with `generateValue: true`.** Render generates a unique 256-bit base64 value per service (base and each preview) at service-creation time, before the first deploy boots. This is what eliminates the race.
3. **An `envVarGroups: agent-shared` block** holds AWS credentials, S3 bucket, and CORS origins. Group references propagate to preview services automatically; `sync: false` env vars declared directly on a service do not.
4. **`DATABASE_URL` stays `sync: false`** on the service — set once in the Render dashboard for the base service (pointing at the Neon `main` branch), and for previews it is set by the workflow after Render creates the preview service.
5. **`.github/workflows/pr-preview.yml` is slimmed** to: create a Neon branch named `preview/pr-<num>` (copy-on-write clone of `main`), discover the matching Render preview service via the Render API, PUT the Neon branch's connection string as `DATABASE_URL`, trigger a fresh deploy, wait for `/v1/health` to return 200, post the preview URL to the PR. The teardown job deletes the Neon branch.

The build/start command sync, JWT_SECRET generation, `render-preview` labeling, and Docker image build to GHCR (which Render never consumed) are all removed from the workflow.

## Options considered

| Option | Pros | Cons | Risks | Evidence |
| --- | --- | --- | --- | --- |
| **Render Blueprint + Neon branching** (chosen) | Declarative; race-free by construction; GitHub is source of truth; per-PR isolated DB matching ADR-0001 vendor choice | Adds two new GitHub secrets/variables (NEON_API_KEY, NEON_PROJECT_ID); first preview deploy may fail until DATABASE_URL lands (cosmetic, surfaced as a "Failed" entry in Render's deploy log) | `generateValue` per-preview behavior is not explicitly documented but is the observable default; verified in plan's verification step | Render Blueprint spec; Render preview-environments docs; Neon branching docs |
| **Keep imperative workflow, fix race with stronger ordering** | Smallest diff | Still racy in principle (Render auto-deploys are not transactional with API calls); doesn't address "GitHub as source of truth" goal | Workflow can grow indefinitely correcting drift | Current PR #36 history shows 10+ commits iterating on this approach without converging |
| **Render Blueprint + Render-managed Postgres** | Fully self-contained; no Neon involvement | Diverges from ADR-0001 (Neon chosen); per-preview Postgres cost on Render; loses Neon branching/copy-on-write benefits | Vendor lock to Render for DB | Render docs support `databases:` block in render.yaml |
| **Render Blueprint + shared dev Neon DB for all previews** | Cheapest; simplest workflow | Previews share state — risky for migrations testing, destructive operations leak between PRs | Cross-PR data corruption | — |
| **Move off Render entirely (Fly.io / Railway)** | More native per-PR isolation on some platforms | Throws away existing Render setup; larger blast radius; ADR-0001 didn't pick a deploy vendor | Significant work for marginal gain | — |

## Consequences

### Positive

- Bootstrap guard at `backend/src/main.ts:13-19` is satisfied at every deploy by construction, not by patching after the fact.
- A fresh clone of the repo can be deployed end-to-end with three steps: connect Render Blueprint, set four `sync: false` secrets once in the Render dashboard, connect Neon GitHub Integration (or manually add `NEON_API_KEY` + `NEON_PROJECT_ID`). No per-deploy intervention.
- Every preview has full schema, RLS policies, and `pgvector`/`uuid-ossp` extensions — inherited from the Neon `main` branch via copy-on-write. Phase 1's tenant-isolation guarantees apply to previews on day one.
- The workflow shrinks substantially: build/start command sync (~70 lines), JWT generation (~40 lines), preview label (~15 lines), and GHCR Docker build (~25 lines) all removed.

### Negative

- The first auto-deploy of a new preview service may fail because `DATABASE_URL` lands only after the workflow PUTs it. This shows as one "Failed" deploy in the Render deploy history per preview. The follow-up deploy succeeds; PR authors only see the success. If this noise becomes a problem, the path forward is to disable `autoDeploy` on previews and have the workflow trigger the first deploy manually — explicitly deferred as not worth the complexity right now.
- `NEON_API_KEY` granted write access to the Neon project. Compromise of the GitHub repo's Actions environment would let an attacker create/delete branches. Mitigated by scope (key has no access to production data on `main` beyond cloning, which is already part of the design) and by Neon's auto-rotation of integration-managed keys.
- `generateValue: true` per-preview behavior is undocumented; if Render changes this to inherit from base, every preview would share `JWT_SECRET` with prod. Verification step explicitly checks this.

### Neutral / tradeoffs

- Render Blueprint requires one extra one-time step in the Render dashboard ("New Blueprint"). After that, dashboard interaction is rare.
- `DATABASE_URL` is the only env var with imperative workflow management remaining. This is fundamental — Neon branch URLs are dynamic and cannot live in static YAML.

## Security implications

- `JWT_SECRET` per-preview is unique and never shared across services. A leak from one preview cannot forge tokens against another.
- Preview Neon branches are isolated logical databases with their own data, but they live in the same Neon project as `main`. Anyone with `NEON_API_KEY` can read or delete any branch (including `main`). Treat the Neon API key with the same care as `RENDER_API_KEY`.
- The `agent-shared` env group's AWS credentials propagate to every preview by design. If you do not want preview environments to write to production S3 buckets, set `S3_BUCKET` to a preview-only bucket via the group's `sync: false` value, or override per-preview using Render's `previewValue` on the service block.
- The bootstrap guard's exact behavior is preserved: it still throws when `NODE_ENV=production` and `JWT_SECRET` is unset or equals the placeholder. The Blueprint guarantees the guard never trips in normal operation; the guard is now a tripwire for misconfiguration rather than a routine error.

## Operational implications

- First-time setup checklist (also reproduced in `docs/PR_PREVIEWS.md`):
  1. Create Neon project, set Postgres version to 16, choose region near the Render region.
  2. Run `node backend/scripts/migrate.js` against the Neon `main` branch's connection string to apply migrations `001..005`.
  3. Connect Neon GitHub Integration (Neon Console → Integrations → GitHub) — this auto-creates `NEON_API_KEY` (secret) and `NEON_PROJECT_ID` (variable) in the GitHub repo.
  4. In Render: New → Blueprint → select this repo. Provide values for the prompted `sync: false` env vars.
- Ongoing operation: zero per-deploy human steps. `git push origin main` updates the base service. `gh pr create` provisions a preview within ~3–5 minutes (Neon branch creation + Render preview build + workflow wiring).
- Free-tier accounting: Neon Free plan allows 3 root branches per project. All preview branches are children of `main` and consume the child-branch allowance (currently ~10). For more concurrent PRs, upgrade to Launch plan or shorten `expires_at` on branches.

## Test strategy

End-to-end on a throwaway branch before merging:

1. Connect Blueprint and verify base service is live with health 200.
2. Open a draft PR → mark ready → confirm:
   - GitHub Actions job succeeds.
   - Render dashboard shows a preview service with an auto-generated `JWT_SECRET` **distinct from the base service's value**.
   - First preview deploy fails (no `DATABASE_URL`); workflow-triggered redeploy succeeds.
   - `curl <preview-url>/v1/health` returns 200.
   - PR comment lands with the preview URL.
3. Confirm `SELECT count(*) FROM tenants;` on the preview's Neon branch succeeds (schema inheritance from `main`).
4. Push another commit → preview redeploys; Neon `create-branch-action` returns `created=false` and reuses the branch.
5. Close PR → Neon branch is deleted; GitHub deployment marked inactive.

## Migration / rollback strategy

This ADR's implementation replaces an unmerged PR's workflow rather than a live production setup. No data migration is required. If the Blueprint approach causes issues after merge:

1. `git revert` the commit that adds `render.yaml` and rewrites `pr-preview.yml`.
2. In Render dashboard: Service Settings → Blueprint → Disconnect. The service stays running with its current env vars (including `JWT_SECRET`, now permanent on that service).
3. The previous imperative workflow can be restored from `git log .github/workflows/pr-preview.yml`.

Neon branches created during testing can be deleted manually from the Neon console. The Neon GitHub Integration can be disconnected from Neon Console → Integrations → GitHub → Disconnect.

## Follow-up issues

- Frontend service: add a second `services:` block to `render.yaml` when the frontend exists.
- Pre-deploy migration runner: add `preDeployCommand: pnpm --filter @agent/backend migrate` once Phase 1b is complete and migration runner is hardened for repeated runs.
- Hard prod/dev split: consider declaring two top-level `services` entries (one tracking `main` as prod, one as preview parent) when the team wants the separation.
- Preview-only AWS / S3 credentials so previews cannot touch production buckets.
- Eliminate the first-deploy-fails noise by disabling `autoDeploy` on previews and triggering the first deploy from the workflow after `DATABASE_URL` is set.
