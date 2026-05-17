# Architecture Decision Records

This page is the index of Architecture Decision Records (ADRs) for this project. ADRs document significant architectural choices, the options considered, and the rationale for the decision made.

Raw ADR files live in [`docs/adr/`](https://github.com/rinzler-vicky/agent/tree/main/docs/adr) in the main repository. The template is at [`docs/adr/ADR-template.md`](https://github.com/rinzler-vicky/agent/blob/main/docs/adr/ADR-template.md).

---

## ADR Index

### ADR-0001 — Phase 1: Foundation & Database Layer

- **Status:** Accepted
- **Date:** 2026-05-01
- **File:** [`docs/adr/ADR-0001-phase-1-foundation-database-layer.md`](https://github.com/rinzler-vicky/agent/blob/main/docs/adr/ADR-0001-phase-1-foundation-database-layer.md)
- **Related issues:** #4, #6

#### Key decisions

| Decision | Chosen | Rejected alternatives |
|----------|--------|-----------------------|
| Database driver | Raw `pg` (no ORM) | TypeORM, Prisma |
| Tenant isolation | Shared DB + RLS (`current_setting('app.tenant_id')`) | Separate DB per tenant |
| Authentication | Passport JWT + bcrypt API keys | Custom JWT middleware |
| Migration runner | Lightweight Node.js script (`scripts/migrate.js`) | Flyway, Liquibase, Alembic |
| Object storage | AWS S3 SDK v3 (pre-signed URLs) | Direct upload |

#### Consequences

- Complete tenant isolation at the DB layer; no application-level WHERE clauses needed.
- Immutable audit trail tamper-proofed at the database level via Postgres RULE.
- Raw SQL means developers must write parameterized queries carefully.
- `app.tenant_id` must be set on every DB client before tenant-scoped queries.

---

### ADR-0002 — Render Blueprint + Neon Branching for PR Preview Environments

- **Status:** Proposed
- **Date:** 2026-05-17
- **File:** [`docs/adr/ADR-0002-render-blueprint-neon-branching.md`](https://github.com/rinzler-vicky/agent/blob/main/docs/adr/ADR-0002-render-blueprint-neon-branching.md)
- **Related issues:** #35, PR #36

#### Key decisions

| Decision | Chosen | Rejected alternatives |
|----------|--------|-----------------------|
| Service declaration | Render Blueprint (`render.yaml`) | Imperative Render API patching |
| `JWT_SECRET` provisioning | `generateValue: true` in Blueprint | Workflow-generated secret PUT via API |
| Database per preview | Neon copy-on-write branch per PR | Shared preview DB |
| Shared env vars | `envVarGroups: agent-shared` | `sync: false` per-service env vars |
| Docker registry | Removed (Render builds from source) | GHCR |

#### Why imperative patching was replaced

The original implementation used GitHub Actions to PATCH the Render service's build/start commands and PUT a generated `JWT_SECRET` before each deploy. This caused a race condition: Render auto-deploys on every push and the bootstrap guard fires before the workflow's env-var PATCH lands. Declaring everything in `render.yaml` eliminates the race by making Render responsible for the values at service creation time.

---

### ADR-0002 (Workflow Control Plane) — Phase 2: Workflow Control Plane

> **Note:** Two ADRs share the `ADR-0002` prefix due to a numbering collision. A follow-up will reconcile numbering.

- **Status:** Accepted
- **Date:** 2026-05-17
- **File:** [`docs/adr/ADR-0002-workflow-control-plane.md`](https://github.com/rinzler-vicky/agent/blob/main/docs/adr/ADR-0002-workflow-control-plane.md)
- **Related issues:** #4, #25, #47

#### Key decisions

| Decision | Chosen | Rationale |
|----------|--------|-----------|
| Lifecycle state | Column on `workflow_versions` | Avoids separate drafts table; simpler queries |
| Proposal metadata | Columns on `workflow_versions` | Avoids 1:1 proposal table; co-located with version |
| Event streaming | SSE + Postgres LISTEN/NOTIFY | No additional broker; works with Neon |
| Execution engine discriminator | Column on `workflow_runs` | Enables multi-engine support without schema changes |
| Failure hook storage | `proposal_triggers` table | Decoupled from run lifecycle; queryable |
| Phase 2 publish gate | Simple `role: admin` check | Full approval routing deferred to Phase 5 |

---

## Creating a New ADR

Use the template at `docs/adr/ADR-template.md`:

```bash
cp docs/adr/ADR-template.md docs/adr/ADR-000N-short-title.md
```

Fill in:
- **Status:** Proposed | Accepted | Deprecated | Superseded
- **Context:** What problem does this decision address?
- **Decision:** What was decided?
- **Options considered:** Table of alternatives with pros/cons/risks.
- **Consequences:** Positive, negative, and neutral outcomes.
- **Security implications:** Any security impact.
- **Follow-up issues:** What is deferred or requires future action?

Open a PR with the new ADR. The ADR status becomes `Accepted` when a human maintainer approves the PR and changes the status field.

---

## ADR Principles

- ADRs are **append-only**. Once accepted, do not edit an ADR's decision section — create a new ADR that supersedes it.
- ADRs are required for: new features with architectural impact, database schema changes, new dependencies, new workflow engines or integrations, auth/security changes.
- ADRs are **not** required for: bug fixes, documentation changes, test additions, refactors within an existing architectural boundary.

---

## Related Pages

- [Architecture Overview](Architecture-Overview) — system design summary.
- [Contributing](Contributing) — when ADRs are required.
