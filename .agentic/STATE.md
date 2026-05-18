status: IN_PROGRESS
current_phase: 2.5a
active_domain: backend

# AGENT STATE TRACKER
This file serves as the hot memory. Read at the start of every execution; update before opening a Pull Request.

## Current Objective
Phase 2.5a (#45 split — backend execution engine + SSE + cooperative cancel + failure→proposal hook) — implementation complete; PR open against `main`. 216/216 unit tests pass. Typecheck + swagger clean. The CI/branch-preview pipeline + agent-worker drain are split into follow-up sub-issues per the user's "deferred = sub-issue" rule.

Phase 2.4 (#44) merged in PR #64.
Phase 1b — pending Neon provisioning and integration test execution.

## Decisions Made
* Established separate architectural files for frontend and backend to limit context window pollution.
* Decided on strict isolation of the policy engine to prevent controller bloat.
* Adopted database-first control plane architecture with Neon Postgres as primary database.
* Selected n8n as mandatory visual workflow engine with canonical workflow definitions stored in database.
* Chose Composio as primary connector/tool broker for external service integration.
* Defined 9-phase implementation strategy with clear tasks, acceptance criteria, and learning outcomes.
* Established workflow-first execution model where all non-trivial requests become task graphs then workflow runs.
* Documented governed self-modification model with four mutation classes (A through D) for controlled agent evolution.
* Phase 1 ADR (ADR-0001) accepted: raw pg driver (no ORM), RLS via current_setting('app.tenant_id'), JWT+bcrypt auth, append-only audit rules.
* PR Preview Environments (initial): Docker-based deployment with GHCR for container registry, Render deployment integration with manual PR preview mode. **Superseded by ADR-0002** — see below.
* **ADR-0002 (proposed, 2026-05-17)**: Render Blueprint (`render.yaml`) + Neon database branching for ephemeral previews. GitHub is source of truth for service shape. `JWT_SECRET` is declared with `generateValue: true` so Render generates per-service secrets atomically — eliminates the imperative-API-patch race that broke PR #36. Per-PR Neon branches via `neondatabase/create-branch-action@v6`. GHCR Docker build removed (was unused by Render).
* **ADR-0002 Workflow Control Plane (proposed, 2026-05-17)**: Phase 2 execution and proposal schema decisions finalized. Lifecycle state on workflow_versions (not separate drafts table), proposal metadata as columns (not 1:1 table), Neon branch per preview, n8n queue mode with Redis, execution_engine discriminator on workflow_runs, SSE + LISTEN/NOTIFY for events, proposal_triggers table for failure hooks, simple role:admin gate for Phase 2 publish.
* **Phase 2.5a — n8n cancel is cooperative, not REST-driven (2026-05-18)**: n8n v1.79.0's `POST /executions/:id/stop` returns 404 in self-hosted ([n8n-io/n8n#14748](https://github.com/n8n-io/n8n/issues/14748)). Mitigation: compiler injects `__cancel_check_<id>` IF after each `__pre_*` ping; webhook handler returns `{cancelled}` flag derived from `workflow_runs.status`. Backend cancel endpoint flips DB state; the very next per-step ping short-circuits to `__end_cancelled`. Race window between cancel and the next ping is acceptable; guard `workflow_runs` transitions with `WHERE status NOT IN ('cancelled','succeeded','failed')` so a stray `workflow.completed` can't overwrite cancel.
* **Phase 2.5a — n8n trigger via `POST /api/v1/workflows/:id/run` (2026-05-18)**: Confirmed against the n8n community thread. Compiler's `MANUAL_TRIGGER` node receives `{runId, tenantId, input}` from the call body; pre-pings extract via `$('__trigger').item.json.*`. Response `executionId` is best-effort; on omission we fall back to `GET /executions?workflowId&limit=1`.
* **Phase 2.5a — single LISTEN client, two consumers (2026-05-18)**: `SseSubscriberService` owns the only long-lived `pg.Client` for `LISTEN run_events` and re-emits payloads on an in-process `EventEmitter`. `FailureHookService` listens on that emitter rather than opening a second connection. Multi-pod idempotency: advisory lock per run id + partial unique index on `proposal_triggers` (migration 013).
* **Phase 2.5a — production frontend SSE auth deferred to Phase 6 (2026-05-18)**: Native browser `EventSource` cannot send `Authorization` headers ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/EventSource)). Backend integration tests use the Node `eventsource` package which supports headers; the production frontend will need cookie-JWT or one-shot signed URLs.

## Completed Tasks
* Created backend/docs directory for comprehensive system documentation.
* Created backend/docs/ARCHITECTURE.md with complete system architecture.
* Created backend/docs/IMPLEMENTATION_PLAN.md with 9-phase implementation roadmap.
* Drafted and recorded ADR-0001 for Phase 1 (docs/adr/ADR-0001-phase-1-foundation-database-layer.md).
* Created database migrations (backend/db/migrations/ — 001..006 SQL files):
  - 001: pgvector + uuid-ossp extensions
  - 002: Core identity schema (tenants, workspaces, users, service_accounts)
  - 003: RLS policies for tenant isolation
  - 004: Configuration tables (personas, prompt_templates, workflow_defs) with immutable versioning triggers
  - 005: append-only audit_events table
  - 006: Down/rollback migration
* Scaffolded NestJS 10 backend (backend/src/):
  - main.ts: CORS, Helmet, Swagger, URI versioning, global ValidationPipe
  - app.module.ts: wiring all modules with TenantMiddleware
  - DatabaseModule: global pg Pool via DATABASE_POOL injection token
  - HealthModule: /v1/health and /v1/health/version endpoints
  - AuthModule: JWT strategy, JwtAuthGuard, AuthService (login + service account validation)
  - TenantMiddleware: extracts tenantId from JWT or x-tenant-id+x-api-key headers
  - TenantsModule: CRUD service + controller (guarded by JWT)
  - AuditModule: append-only audit log service
  - StorageModule: S3 pre-signed upload/download URL generation with MIME allowlist
* Created backend/scripts/migrate.js: simple migration runner tracking applied migrations in schema_migrations table. Updated in Phase 2.1 to support multiple rollback files (012_rollback_phase_2_1.sql, 006_rollback_down.sql).
* Created backend/.env.example with all documented env vars. Updated in Phase 2.1 with WORKFLOW_CONTROL_PLANE_ENABLED flag, Redis, n8n, and Neon API configuration.
* 24/24 unit tests passing (health, tenants, audit, auth, storage services).
* **Phase 2.5a (Execution Engine + SSE + Failure Hook) — Issue #45 (split):**
  - Migration 013: AFTER INSERT trigger on `run_events` publishing a compact `pg_notify('run_events', ...)` payload (run/tenant/sequence/event_type/step_run_id/event_id). Partial unique index on `proposal_triggers` (workflow_run_id, COALESCE(step_run_id, zero-uuid), error_fingerprint) WHERE status='pending'. `backend/scripts/migrate.js` updated.
  - `backend/src/runs/`: new `RunsModule` with `POST/GET/cancel/events` routes. `RunsService` does the txn dance (INSERT → adapter trigger → stash provider id → audit → COMMIT). `SseSubscriberService` owns a dedicated `pg.Client` for `LISTEN run_events` and an in-process `EventEmitter` bridge. `FailureHookService` filters `workflow.failed`, reconciles via `N8nApiClient.getExecution`, walks per-node `runData`, writes one `proposal_triggers` row per failed node with the partial-index ON CONFLICT DO NOTHING guard.
  - `backend/src/workflows/adapters/n8n/`: `N8nExecutionAdapter` (trigger only, no hard cancel). `N8nApiClient` adds `runWorkflow` and `listExecutions`. `n8n-compiler.ts` injects `__cancel_check_<id>` IF v2 after each `__pre_*` ping and a single shared `__end_cancelled` HTTP Request sink. Webhook controller's response now carries `{cancelled}`; new `workflow.cancelled` event handled idempotently; all `workflow_runs` status transitions guarded with `WHERE status NOT IN ('cancelled','succeeded','failed')`.
  - 216/216 unit tests pass (40 new across the slice). Typecheck + swagger + lint clean. Wiki updated with the run lifecycle section, SSE reconnect contract, cooperative-cancel mechanics, failure-hook chain.
  - Deferred to sub-issues (per user's "deferred = sub-issue" rule): branch-preview CI pipeline + agent-initiated previews (Phase 2.5b), agent worker that drains `proposal_triggers`, explicit n8n main-process restart resilience test, production-frontend SSE auth pattern (Phase 6), hard-cancel once n8n REST stop ships.
* **Phase 2.4 (Workflow Lifecycle and Proposal API) — Issue #44:**
  - Added human draft + lifecycle controller (`WorkflowsController`) for `POST /v1/workflows`, `PATCH /v1/workflows/:id`, `POST /v1/workflows/:id/validate`, `POST /v1/workflows/:id/publish` (admin), `POST /v1/workflows/:id/rollback` (admin), `GET /v1/workflows/:id/diff`.
  - Added agent-facing `ProposalsController` for `POST /v1/workflow-proposals` (service-account JWT + `workflows:propose` scope; 30/min rate limit). Lands draft `workflow_versions` with `proposal_source='failure_recovery'` when `stepRunId` provided, `'agent_reflection'` otherwise. Audit event `workflow.proposal.created` links failing step → new draft via `resource_id`.
  - Added service-account JWT minting via `POST /v1/auth/service-account/token` (exchanges an API key for a JWT carrying `scopes` from `service_accounts.scopes`).
  - Added `ServiceAccountScopeGuard` mixin and bound `ThrottlerGuard` via `APP_GUARD` so `@Throttle()` overrides actually enforce (it was previously inert). Fixed global throttler `ttl` to milliseconds (was `60`, now `60_000`).
  - Added `rfc6902` (dependency-free) as a new production dep for RFC 6902 JSON Patch diff — replaced an initial hand-rolled diff after maintainer feedback.
  - DTO refresh on `workflow-proposal.dto.ts` to match the #44 field names (`stepRunId`, `workflowRunId`, `errorFingerprint`, `rationale`); `proposal_source` is derived server-side, not exposed to caller.
  - 176/176 unit tests passing; check:swagger clean; lint clean (no new warnings); build clean.
  - Documented in `backend/docs/PHASE_2_4_SUMMARY.md` and new wiki page `docs/wiki/Workflow-Control-Plane.md`.
* **Phase 2.1 (Execution and Proposal Schema) — Issue #41:**
  - Created migrations 007-011 for Phase 2 execution tables:
    - 007: conversations, messages (tenant-scoped, auto-increment sequence)
    - 008: task_graphs, tasks, task_edges (adjacency list with deferrable FK)
    - 009: workflow_runs, step_runs, run_events (append-only events, execution_engine discriminator)
    - 010: workflow proposal schema (lifecycle_state + proposal metadata columns on workflow_versions, proposal_triggers table)
    - 011: composite indexes for hot paths (tenant+conversation runs, event tail queries, pending triggers)
    - 012: rollback migration for Phase 2.1
  - Added RLS policies for all Phase 2.1 tables (direct and cascading isolation)
  - Enforced append-only semantics on run_events via Postgres RULE
  - Created TypeScript DTOs for all Phase 2.1 entities (conversations, task-graphs, runs, workflows)
  - Created comprehensive integration test suite for RLS isolation (backend/test/rls-isolation.e2e-spec.ts)
  - Documented Phase 2.1 implementation in backend/docs/PHASE_2_1_SUMMARY.md
* **PR Preview Automation (Issue #35):**
  - Created backend/Dockerfile, backend/.dockerignore, docker-compose.yml, .dockerignore for local Docker testing (still used for local dev; no longer used in CI).
  - Initial .github/workflows/pr-preview.yml used GHCR + imperative Render API patching for build/start commands and JWT_SECRET generation. **Replaced** by ADR-0002 Blueprint flow on 2026-05-17 (rewritten to do only Neon branch provisioning + DATABASE_URL wiring + URL/health/comment).
  - Created render.yaml (Render Blueprint) as the declarative source of truth for service shape, env vars, and preview enablement.
  - Created docs/adr/ADR-0002-render-blueprint-neon-branching.md.
  - Rewrote docs/PR_PREVIEWS.md to reflect the Blueprint + Neon flow.

## Trial / Errors (Issue #35)
* **JWT_SECRET race condition.** Imperative `PUT /v1/services/{id}/env-vars` against the Render base service races Render's auto-deploy. Render boots the new commit before the env-var lands, bootstrap guard at `backend/src/main.ts:13-19` throws, deploy fails. Observed on PR #36 commit cbf9c2c. **Fix:** declare `JWT_SECRET` with `generateValue: true` in render.yaml — Render generates per-service at creation time, atomically, pre-boot. Race window does not exist.
* **`sync: false` env vars do not propagate to preview services.** Initial Blueprint draft placed AWS keys / S3 bucket / CORS as `sync: false` on the service block; this would have required the workflow to re-PUT them on every preview. **Fix:** moved shared secrets into an `envVarGroups: agent-shared` block; group references propagate.
* **Docker build to GHCR was dead weight.** Render does its own git+pnpm build per the start command, never consumed the GHCR image. **Fix:** removed all docker buildx / login / build / push steps from the workflow.
* **Shipped 89aaf59 without renaming Blueprint service to match existing.** The existing standalone Render service is named `agent` (URL `agent-wmia.onrender.com`), but `render.yaml` declared `agent-backend`. Per Render docs, Blueprint adopts existing services only when names match. Connecting Blueprint as-was would have created a duplicate. Also: removing the old workflow's "Ensure JWT_SECRET" step (race-prone but functional) before Blueprint was connected meant the existing service had no JWT_SECRET source — every push failed bootstrap. **Fix (corrective commit):** renamed service to `agent`, added `.github/workflows/bootstrap-render-base.yml` as a one-shot to set JWT_SECRET via Render API without dashboard clicks, added `timeout-minutes: 20` + reduced polling on pr-preview.yml to prevent indefinite hangs, improved the no-preview-service error message.
* **Preview service inherited no JWT_SECRET at creation.** When Render auto-creates a preview service (before Blueprint is connected), env vars are copied from the base service at creation time. Preview `agent-pr-36-dejf` was created when base had no JWT_SECRET, so the preview also had none, and bootstrap.guard fired even after the base was fixed. **Fix (a2c0761):** extended pr-preview.yml to set JWT_SECRET on the preview alongside DATABASE_URL when missing or a known placeholder. Becomes a no-op once Blueprint's `generateValue: true` is providing per-preview secrets.
* **Neon GitHub Integration does not auto-comment on PRs.** User expected a Neon-authored PR comment when `preview/pr-36` was created; none appeared. Verified against https://neon.com/docs/guides/neon-github-integration : the integration installs `NEON_API_KEY` + `NEON_PROJECT_ID` and offers a workflow snippet whose default behavior is create/delete branches only. PR commenting is opt-in via `neondatabase/schema-diff-action@v1`, which only posts when schemas differ. Also: project's default branch is `production` (Console-created, user's case), not `main` as docs claimed. **Fix:** added `expires_at` (14-day safety net) and `schema-diff-action` (with `continue-on-error: true` since zero-diff behavior is undocumented) to pr-preview.yml, enhanced the combined preview-ready PR comment with a Neon section (branch, parent, expiry, console link), corrected `main` → `production` across docs.

## Pending Tasks (Phase 2.1)
* Manual QA: Apply migrations 007-011 on Neon branch and verify with psql
* Wait for ADR-0002 (Workflow Control Plane) acceptance
* Update backend/docs/ARCHITECTURE.md with Phase 2.1 schema diagrams
* Merge Phase 2.1 PR after Phase 1b prerequisites are met

## Pending Tasks (Phase 1b)
* Provision Neon Postgres instance and configure database branching strategy.
* Run integration tests with real Postgres to validate RLS isolation.
* Set app.tenant_id session variable per database client in DatabaseModule.
* Add integration/E2E tests (Supertest against live NestJS app).
* Review ADR-0001 with stakeholders and get formal sign-off.
* Begin Phase 2: Workflow Control Plane.

## Pending Tasks (PR Preview Automation - Issue #35, post ADR-0002)
* Apply Neon migrations 001..005 to the Neon `main` branch (one-time prerequisite — every preview is a copy-on-write clone of `main`).
* Connect Render Blueprint: Render Dashboard → New → Blueprint → select repo → provide the four `sync: false` values (DATABASE_URL pointing at Neon main, AWS_*, S3_BUCKET, CORS_ORIGINS).
* End-to-end verification on a throwaway PR (see ADR-0002 §Test strategy): confirm preview JWT_SECRET differs from base JWT_SECRET (validates `generateValue` per-preview behavior).
* Get formal sign-off on ADR-0002 (currently Proposed).

## Phase 2 readiness gates (block implementation start)
* [ ] Phase 1b closed (all bullets above checked off).
* [ ] Self-evolution #39 merged — `01_backend_feature.yml` strengthened so future phase issues are born meeting Definition of Ready.
* [ ] ADR-0002 (Workflow Control Plane) drafted with all 11 open questions resolved in the options table, `Status: Accepted` recorded by `rinzler-vicky`. Tracked by the ADR-0002 child issue under #25.
* [ ] Then: begin Phase 2 implementation per the child issues linked from #25 (execution order: 2.1 schema → 2.2 compiler / 2.3 n8n adapter (parallel) → 2.4 lifecycle+proposal API → 2.5 execution+streaming+previews+failure-hook).

## Phase 3 readiness gates (block implementation start/open + merge)

Phase 3 (Connector & Tool Layer) is tracked at #26 with seven child issues #49–#55. No Phase 3 implementation PR may be opened or merged until every gate below is ticked.

* [ ] Phase 1b items above closed (Neon, RLS integration tests, `app.tenant_id`, ADR-0001 sign-off).
* [ ] PR #46 merged (strengthens `01_backend_feature.yml` and adds Phase 2 readiness gates).
* [ ] Phase 2 fully closed: #25 + all child issues #40 (ADR-0002 accepted), #41, #42, #43, #44, #45.
* [ ] ADR-0003 drafted and `Status: Accepted` recorded by `rinzler-vicky` (Phase 3 child #49). All 17 open architectural questions enumerated in #26 must have populated options tables and explicit decisions before signoff.

After all readiness gates are cleared, execute Phase 3 implementation in this order: #50 (schema) → {#51 (broker), #52 (policy)} → #53 (execution + tool-failure hook) → #54 (`/v1/tool-proposals` endpoint, mirrors Phase 2's `/v1/workflow-proposals`) → #55 (common connectors + branch-preview parity).
