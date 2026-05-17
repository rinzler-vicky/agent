# Architecture Overview

This page summarizes the system architecture for the Agent backend harness. For full technical detail see [`backend/docs/ARCHITECTURE.md`](https://github.com/rinzler-vicky/agent/blob/main/backend/docs/ARCHITECTURE.md).

---

## Core Architectural Principles

1. **Postgres as Canonical System of Record** — All state, configuration, workflows, and audit trails live in a single authoritative database.
2. **Workflow-First Execution** — Every non-trivial request becomes a task graph and then a workflow run before execution.
3. **Governed Self-Modification** — Agents can propose changes to prompts, personas, workflows, and DB state, but changes are observable, reversible, and policy-controlled.
4. **Multi-Frontend Support** — The backend serves multiple client surfaces (opencode, LM Studio, custom UI) without changing business logic.
5. **Strict Tenant Isolation** — Complete isolation at tenant/workspace level via Row-Level Security (RLS) and default-deny policies.

---

## Technology Stack

| Layer | Technology | Notes |
|-------|-----------|-------|
| API framework | **NestJS 10** (Express) | URI versioning (`/v1/`), global `ValidationPipe`, Swagger/OpenAPI |
| Database | **Neon Postgres** (`pg` driver, no ORM) | Raw SQL for full RLS control; pgvector for semantic search |
| Workflow engine | **n8n** | Queue-mode scaling with Redis; canonical definitions stored in DB |
| Connector/tool broker | **Composio** | 1000+ toolkits, managed auth, MCP/direct APIs |
| Object storage | **AWS S3 / S3-compatible** | Pre-signed URLs via AWS SDK v3; MinIO / Cloudflare R2 supported |
| Authentication | **JWT + bcrypt** | `@nestjs/passport`; API key format `id.secret` (only hash stored) |
| Container | **Docker** | Multi-stage build; health check on `/v1/health` |
| Preview deploy | **Render Blueprint** + **Neon branching** | One isolated Postgres branch per PR; `generateValue: true` for `JWT_SECRET` |

---

## System Layers

```
  ┌─────────────────────────────────────────────┐
  │           Client Surfaces                   │
  │   opencode · LM Studio · Custom UI          │
  └───────────────────┬─────────────────────────┘
                      │ HTTP / WebSocket / SSE / MCP
  ┌───────────────────▼─────────────────────────┐
  │           API Gateway Layer                 │
  │   Auth · Policy · Tenant Guardrails         │
  └───────────────────┬─────────────────────────┘
                      │
  ┌───────────────────▼─────────────────────────┐
  │         Orchestration Layer                 │
  │  Conversation Orchestrator · Planner        │
  │  Workflow + Persona Registry                │
  └───────────────────┬─────────────────────────┘
                      │
  ┌───────────────────▼─────────────────────────┐
  │          Execution Layer                    │
  │   n8n Workflow Engine                       │
  │   (Optional: LangGraph / Temporal)          │
  └────────┬──────────┬──────────┬──────────────┘
           │          │          │
  ┌────────▼──┐  ┌────▼────┐  ┌─▼──────────────┐
  │  Memory   │  │ Storage │  │  Connector      │
  │  Service  │  │  Layer  │  │  Layer          │
  │ pgvector  │  │   S3    │  │  Composio       │
  └───────────┘  └─────────┘  └────────────────┘
           │          │
  ┌────────▼──────────▼──────────────────────────┐
  │   Postgres Control Plane (Neon)              │
  │   All state · Audit · Workflow definitions   │
  └──────────────────────────────────────────────┘
```

---

## Multi-Tenancy

Tenant isolation is enforced at the database layer using PostgreSQL **Row-Level Security (RLS)**:

- Every tenant-scoped table has an RLS policy that filters on `current_setting('app.tenant_id', true)::UUID`.
- The application sets this session variable for every database connection before executing queries.
- `TenantMiddleware` extracts the tenant from the JWT claim or `x-tenant-id` + `x-api-key` headers.

Direct cross-tenant data access is impossible at the database level even if application code has a bug.

---

## Module Structure (`backend/src/`)

| Module | Responsibility |
|--------|---------------|
| `DatabaseModule` | Global pg Pool (`DATABASE_POOL` injection token) |
| `AuthModule` | JWT strategy, `JwtAuthGuard`, login, API key validation |
| `TenantMiddleware` | Extracts tenant context; sets `app.tenant_id` session var |
| `TenantsModule` | Tenant CRUD |
| `HealthModule` | `/v1/health` and `/v1/health/version` endpoints |
| `AuditModule` | Append-only audit log |
| `StorageModule` | S3 pre-signed upload/download URL generation |

---

## Database Schema (Phase 1)

```
tenants
  └── workspaces
        ├── users
        ├── service_accounts
        ├── personas / persona_versions
        ├── prompt_templates / prompt_versions
        ├── workflow_defs / workflow_versions
        └── audit_events (append-only)
```

**Phase 2.1 additions** (execution schema):

```
conversations / messages
task_graphs / tasks / task_edges
workflow_runs / step_runs / run_events (append-only)
proposal_triggers
```

All tables enforce tenant isolation via RLS. `run_events` and `audit_events` are made append-only at the database level using Postgres `RULE`.

---

## API Design

- **URI versioning**: all endpoints under `/v1/`.
- **Controllers**: HTTP routing, DTO validation, response formatting only — no business logic.
- **Services**: all business logic and database interaction.
- **Authorization**: ReBAC engine in `backend/src/auth/`. Controllers must not make access decisions directly.
- **OpenAPI docs**: auto-generated at `/api/docs` (development mode).

---

## Immutable Versioning

Personas, prompt templates, and workflow definitions use an **immutable versioning** pattern:

- A parent record (`workflow_defs`) holds identity and metadata.
- Version records (`workflow_versions`) are created for each change and are immutable once published.
- Auto-incrementing triggers assign version numbers. A UNIQUE constraint on `(def_id, version_number)` prevents collisions.
- Published versions cannot be mutated; a new version must be created instead.

---

## Related Pages

- [Installation](Installation) — set up the environment.
- [Architecture Decision Records](Architecture-Decision-Records) — rationale for key choices.
- [Contributing](Contributing) — how to work within these constraints.
- Full architecture doc: [`backend/docs/ARCHITECTURE.md`](https://github.com/rinzler-vicky/agent/blob/main/backend/docs/ARCHITECTURE.md)
