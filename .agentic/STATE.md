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
* PR Preview Environments: Docker-based deployment with GHCR for container registry, Render deployment integration with manual PR preview mode.

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
  - Created backend/Dockerfile: Multi-stage build for NestJS backend with health checks (fixed husky prepare script issue with --ignore-scripts flag)
  - Created backend/.dockerignore: Optimized Docker context for backend builds
  - Created docker-compose.yml: Orchestration for backend + PostgreSQL with health checks
  - Created .dockerignore: Root-level Docker ignore for monorepo context
  - Created .github/workflows/pr-preview.yml: Automated PR preview deployment workflow with GHCR, Render deployment (johnbeynon/render-deploy-action@v0.0.8), GitHub Deployments API, and peter-evans/create-or-update-comment integration
  - Configured Render manual PR preview mode with service URL: https://agent-wmia.onrender.com
  - Created docs/PR_PREVIEWS.md: Comprehensive documentation for PR preview environments
  - Updated README.md: Added section 7 for PR Preview Environments with quick start guide

## Pending Tasks (Phase 1b)
* Provision Neon Postgres instance and configure database branching strategy.
* Run integration tests with real Postgres to validate RLS isolation.
* Set app.tenant_id session variable per database client in DatabaseModule.
* Add integration/E2E tests (Supertest against live NestJS app).
* Review ADR-0001 with stakeholders and get formal sign-off.
* Begin Phase 2: Workflow Control Plane.

## Pending Tasks (PR Preview Automation - Issue #35)
* Test PR preview workflow with Render deployment (mark PR as ready for review to trigger)
* Verify preview URLs work correctly with Render service: https://agent-wmia.onrender.com
* Verify teardown works correctly on PR close/merge
* Consider migrating to isolated PR environments (Fly.io/Railway) if shared environment becomes limiting
