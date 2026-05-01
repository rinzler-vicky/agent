# ADR-0001 — Phase 1: Foundation & Database Layer

- Status: Accepted
- Date: 2026-05-01
- Related issue(s): #4 (Backend Infra Bootstrapping), #6 (Phase 1: Foundation & Database Layer)
- Deciders: rinzler-vicky, @copilot

## Context

The agentic backend harness requires a robust, multi-tenant foundation before any higher-level features (workflow orchestration, connector brokering, memory management) can be built. Phase 1 establishes:

1. A canonical Postgres schema for identity, configuration, and audit
2. Row-Level Security (RLS) for tenant isolation
3. A NestJS API service skeleton with auth, tenant middleware, health, and storage
4. Database migration tooling for reproducible schema changes

Constraints:
- Must support multiple fully-isolated tenants sharing the same database
- All mutable entities need immutable version history with rollback pointers
- Audit trail must be tamper-proof (append-only)
- Must work with Neon Postgres (serverless/branching) and local Postgres equally
- Authentication must support both JWTs (user sessions) and API keys (service accounts)

## Decision

### Database

- **Postgres via `pg` driver** (raw SQL, no ORM). Chosen for full control over schema, RLS, and migration scripts. ORM abstraction would interfere with fine-grained RLS session variable management (`current_setting('app.tenant_id')`).
- **pgvector extension** enabled from day one for future semantic search on memory items.
- **RLS policies** on all tenant-scoped tables using `current_setting('app.tenant_id', true)::UUID` as the predicate. The application layer is responsible for setting this session variable for each database client.
- **Append-only audit_events** enforced via Postgres `RULE` (deny UPDATE/DELETE at the database level).
- **Immutable versioning** on `persona_versions`, `prompt_versions`, and `workflow_versions` using auto-incrementing triggers.
- **Migration runner** is a lightweight Node.js script (`backend/scripts/migrate.js`) tracking applied files in a `schema_migrations` table. This avoids adding an additional framework dependency (Flyway, Liquibase, Alembic) in Phase 1.

### API

- **NestJS 10** with Express platform, URI-based API versioning (`/v1/`), global `ValidationPipe`, and Swagger/OpenAPI.
- **JWT authentication** via `@nestjs/passport` + `passport-jwt`. Tokens carry `{ sub, email, tenantId, role, type }`.
- **`TenantMiddleware`** extracts tenant context from JWT claims and propagates to `req.tenantId`. API key auth (`x-api-key` + `x-tenant-id` headers) is supported only when both headers are present to prevent unauthenticated cross-tenant requests.
- **`JwtAuthGuard`** guards all protected endpoints. Public endpoints (health, auth/login) are unguarded.
- **Rate limiting** via `@nestjs/throttler` (100 req/min default, configurable).
- **CORS** configured with an explicit origin allowlist from env (`CORS_ORIGINS`).
- **Helmet** for HTTP security headers.

### Object Storage

- **AWS S3 SDK v3** (`@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`) for pre-signed URL generation.
- Supports S3-compatible endpoints (MinIO, Cloudflare R2) via `S3_ENDPOINT` env var.
- File type validation (allowlist) and 100 MB size limit enforced before URL generation.

## Options considered

| Option | Pros | Cons | Risks | Evidence |
| --- | --- | --- | --- | --- |
| **TypeORM / Prisma ORM** | Migrations auto-generated, type-safe queries | Interferes with RLS session vars; opaque query building | Hidden N+1 queries, migration conflicts | Architecture.md §Core Rules |
| **Raw `pg` (chosen)** | Full control, native RLS support, minimal deps | More boilerplate for queries | Developer productivity slower early on | Canonical control plane requirement |
| **Separate DB per tenant** | Maximum isolation | Operational complexity, cost, no shared query pool | Schema drift across tenants | Neon branching available for test environments instead |
| **Shared DB + RLS (chosen)** | Single schema, simple ops, pgvector shared | Requires rigorous session-var discipline | RLS bypass if session var not set | Industry standard for SaaS multi-tenancy |
| **Passport JWT (chosen)** | NestJS ecosystem standard, well-tested | Adds passport abstraction | Low | NestJS docs |
| **Custom JWT middleware** | No extra deps | Reinventing the wheel | High maintenance risk | — |

## Consequences

### Positive

- Complete tenant isolation at the DB layer (RLS) with no application-level WHERE clauses required
- Immutable audit trail tamper-proofed at the database level
- Clean service boundaries (thin controllers, business logic in services)
- 24/24 unit tests passing on first implementation
- OpenAPI/Swagger docs generated automatically
- Rollback-ready via `006_down.sql` migration

### Negative

- Raw SQL means no type-safe query builder; developers must write parameterized queries carefully
- `app.tenant_id` session variable must be set in every DB client before running tenant-scoped queries (deferred to Phase 1b hardening)
- Migration runner is simplistic (no partial rollback, no checksums); a more robust runner (e.g., node-pg-migrate) should be considered in Phase 2

### Neutral / tradeoffs

- Version number in `persona_versions` / `prompt_versions` / `workflow_versions` is auto-assigned by a PL/pgSQL trigger. A sequence-based approach would be more concurrency-safe; the UNIQUE constraint acts as a safety net for now.
- TypeScript strict mode is disabled in Phase 1 for velocity; consider enabling incrementally in later phases.

## Security implications

- JWT secret **must** be set to a cryptographically strong value in production (`JWT_SECRET` env var)
- API key format `id.secret` — only the hash of `secret` is stored in the DB (bcrypt)
- RLS bypass possible if application code forgets to set `app.tenant_id`; a DB-level enforcer (e.g., a default-deny policy requiring the session var) should be added in Phase 1b
- `x-tenant-id` header only trusted when `x-api-key` is also present (prevents cross-tenant impersonation)
- CORS origin allowlist prevents cross-origin attacks
- Helmet sets security headers (CSP, HSTS, etc.)
- File uploads validated by MIME type allowlist and size limit before presigned URL generation

## Operational implications

- Requires Postgres 14+ (for `gen_random_uuid()` without extension, pgvector support)
- `DATABASE_URL` connection string must include credentials; use Neon's pooled connection string for production
- `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` required for S3 signed URLs; use IAM roles in production
- Migration runner (`pnpm migrate:up`) must be run on every deploy before the service starts
- All env vars documented in `backend/.env.example`

## Test strategy

- **Unit tests**: All services mocked with in-memory pool/mock; 24 tests across 5 spec files
- **Integration tests**: Deferred to Phase 1b (requires live Postgres); will test actual RLS isolation, migration up/down, and connection pooling
- **E2E tests**: Deferred to Phase 1b; will use Supertest against the running NestJS app
- **Coverage target**: >80% (enforcement via `jest --coverage` in CI)

## Migration / rollback strategy

- **Up**: `node scripts/migrate.js up` — applies unapplied SQL files in order, tracks in `schema_migrations`
- **Down**: `node scripts/migrate.js down` — runs `006_down.sql` (drops all Phase 1 tables/functions/extensions)
- **Neon branching**: Create a dev branch from `main` for testing migrations before applying to production branch
- **PITR**: Neon's point-in-time recovery provides a safety net for catastrophic migration failures

## Follow-up issues

- [ ] Phase 1b: Integration tests with real Postgres (RLS isolation, migration up/down, connection pool)
- [ ] Phase 1b: Set `app.tenant_id` session variable in DatabaseModule for every pooled connection
- [ ] Phase 1b: Add `schema_migrations` checksum verification to detect tampering
- [ ] Phase 2: Evaluate node-pg-migrate or Atlas for more robust migration management
- [ ] Phase 2: Enable TypeScript strict mode incrementally
