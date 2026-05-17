status: IN_PROGRESS
current_phase: 1.0
active_domain: backend

# AGENT STATE TRACKER
This file serves as the hot memory. Read at the start of every execution; update before opening a Pull Request.

## Current Objective
Phase 1 (Foundation & Database Layer) — implementation complete, pending Phase 1b integration tests and Neon provisioning.
PR Preview Automation — implementing ephemeral environments for pull requests (Issue #35).

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
* Created backend/scripts/migrate.js: simple migration runner tracking applied migrations in schema_migrations table.
* Created backend/.env.example with all documented env vars.
* 24/24 unit tests passing (health, tenants, audit, auth, storage services).
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
