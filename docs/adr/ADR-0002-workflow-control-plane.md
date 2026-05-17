# ADR-0002 — Phase 2: Workflow Control Plane (with agent self-modification)

- Status: Proposed
- Date: 2026-05-17
- Related issue(s): #4 (Backend Infra Bootstrapping), #25 (Phase 2: Workflow Control Plane), #47 (ADR draft PR)
- Deciders: rinzler-vicky (pending), @codex[agent] (draft author)

## Context

Phase 2 adds the “workflow control plane”: a database-canonical representation of task graphs and workflows, lifecycle management (draft → validate → publish → rollback), execution tracking (runs, steps, events), and an adapter to a concrete workflow runtime (n8n) backed by queue infrastructure (Redis).

This phase is also the first time the architecture explicitly enables governed agent self-modification (per `backend/docs/ARCHITECTURE.md` “Governed Mutation Model”): in response to a failed run, an authenticated agent must be able to create a draft workflow change (Class C) and request publication (Class D placeholder in Phase 2; full routing in Phase 5).

Constraints and invariants carried forward from Phase 1:

- Postgres (Neon) is the canonical system of record; runtime artifacts (e.g., n8n JSON) are derived, not authoritative.
- Multi-tenancy isolation is enforced at the database layer (RLS on tenant-scoped tables).
- Workflows and other publishable configuration are versioned; versions are treated as immutable artifacts with explicit publish/rollback pointers.
- Phase 2 must include branch-preview ergonomics: a draft workflow version + a Neon DB branch + an ephemeral runtime instance should form a preview environment (mirroring PR preview behavior), and the same mechanism must be usable for agent-authored proposals.
- Phase 2 is allowed to ship the mechanism for proposals and publishing gates, but not the Phase 5 approval routing/policy layer.

Hard prerequisites (block-on for implementation PRs; this ADR can be drafted before they close):

- Phase 1b closed (per `.agentic/STATE.md`: Neon provisioned; integration tests validating RLS; `app.tenant_id` set on pooled clients; ADR-0001 signed off).
- #39 merged (issue template strengthening).

Repository note:

- `docs/adr/ADR-0002-render-blueprint-neon-branching.md` already exists and uses the same ADR number prefix. This ADR follows the issue tracker’s requested filename (`ADR-0002-workflow-control-plane.md`); a follow-up should reconcile ADR numbering for long-term clarity.

## Decision

Phase 2 adopts these decisions (resolved open questions 1–11):

1. Workflow lifecycle storage: add an explicit lifecycle state to `workflow_versions` (no separate drafts table).
2. Agent proposal schema: store proposal metadata directly on the proposed `workflow_versions` row (no separate 1:1 proposals table in Phase 2).
3. Preview binding: Neon branch per draft/proposal + ephemeral n8n instance per preview environment.
4. Preview spawn authority: PR/CI and authenticated service-account agents (rate-limited); not end-users.
5. Compilation strategy: canonical-first workflow spec stored in DB; compile to runtime artifacts via an `n8n-adapter`.
6. Execution router: add an `execution_engine` discriminator on `workflow_runs` now for forward extensibility.
7. Event streaming: SSE for client transport, with Postgres `run_events` as source-of-truth and `LISTEN/NOTIFY` for “push” wakeups.
8. Failure → proposal hook: `proposal_triggers` table written by the orchestrator; an agent worker drains triggers and submits proposals.
9. Publish gate: Phase 2 uses a simple `role:admin` JWT gate for publish/rollback; Phase 5 replaces with approval routing.
10. Cycle detection: iterative DFS (color marking) for cycle detection in task graphs.
11. Migration tooling: keep `backend/scripts/migrate.js` for Phase 2 migrations; revisit a framework migrator later if needed.

## Options considered

### 1) Workflow lifecycle storage shape

| Option | Pros | Cons | Risks | Evidence |
| --- | --- | --- | --- | --- |
| Add `lifecycle_state` column on `workflow_versions` (Chosen) | Minimal schema surface; keeps version lineage in one place; aligns with Phase 1 version numbering trigger | Requires careful rules so “draft edits” remain append-only versions; publish/rollback are updates to state fields | Mixing “approval” and “lifecycle” concepts if not clearly separated | Phase 1 already uses `workflow_defs` + `workflow_versions` with `approval_state` and version triggers (`backend/db/migrations/004_config_tables.sql`) |
| Separate `workflow_drafts` table | Clean separation between mutable drafts and immutable versions; avoids updating versions | More schema and joins; more lifecycle complexity | Risk of divergence between draft and version semantics; more endpoints/logic | Phase 1 schema does not include drafts table; would be a net-new lifecycle model |
| New `workflow_proposals` table as the lifecycle authority | Proposal concept becomes first-class; can unify draft/proposal | Conflates draft lifecycle with proposal metadata; forces every draft through “proposal” even for human-authored drafts | Could over-constrain non-agent authoring flows | #25 scope distinguishes human draft lifecycle from agent proposals (mechanism is shared, but semantics differ) |

Decision details:

- Phase 2 introduces `lifecycle_state` (e.g., `draft`, `published`, `superseded`, `rejected`) on `workflow_versions`. `approval_state` remains for policy/approval semantics (Phase 5).
- Draft “edits” are represented as new `workflow_versions` rows (version-numbered) in `draft` lifecycle state; publishing selects a specific draft version and flips lifecycle state and/or sets `published_at`, and updates `workflow_defs.active_version_id`.

### 2) Agent proposal schema

| Option | Pros | Cons | Risks | Evidence |
| --- | --- | --- | --- | --- |
| Proposal fields on `workflow_versions` (Chosen) | Single-row read for proposed draft + metadata; no extra join; leverages existing `created_by_actor`/`created_from_run_id` columns | Adds nullable columns that are only populated for agent proposals | Table bloat if proposal context is large; requires indexing strategy for JSON fields | Phase 1 already stores version metadata on version rows (e.g., `created_from_run_id`, `changelog`, `published_at`) |
| `workflow_proposals` table 1:1 with `workflow_versions` | Separates concerns; can evolve proposal schema independently | More joins and more write paths; dual-row consistency to maintain | Risk of orphan rows / mismatch between proposal and version | Phase 2 wants minimal moving parts before Phase 5 governance layer |

Decision details:

- Add proposal metadata columns on `workflow_versions` for proposal-authored drafts (e.g., `parent_version_id`, `proposal_source`, `proposal_context` JSONB, `proposal_rationale`).
- Use existing audit linkage fields where possible: `created_by_actor` identifies the proposing service account; `created_from_run_id` links to the triggering run.

### 3) Branch-preview binding

| Option | Pros | Cons | Risks | Evidence |
| --- | --- | --- | --- | --- |
| Neon branch per draft + ephemeral n8n per preview (Chosen) | Strong isolation; matches desired “preview env = draft + branch + runtime” ergonomics; enables safe self-test | Higher infra churn; requires Neon API access and n8n orchestration | Rate-limit and cleanup required to avoid runaway previews | #25 explicitly requires branch-preview ergonomics; Neon branching is a core platform choice from Phase 1 |
| Shared dev DB with `workflow_environment_id` | Cheaper; fewer moving parts | Isolation via namespacing only; harder to guarantee “preview = reality” | Cross-contamination between previews; hard-to-debug state leakage | Conflicts with requirement that previews mirror PR preview semantics |
| One shared n8n instance with namespaced credentials | Simple runtime ops | Still shares global runtime state; harder isolation for secrets and queues | Credential leakage/misconfiguration | Phase 2 adds Redis-backed queue mode; namespacing is non-trivial and fragile |

Decision details:

- “Preview environment” is defined as `{neon_branch_id, workflow_version_id(s), n8n_instance_id}` and is created on PR open and on agent proposal submission.

### 4) Who can spawn previews

| Option | Pros | Cons | Risks | Evidence |
| --- | --- | --- | --- | --- |
| PR/CI only | Tight control; fewer surprise resources | Blocks agent self-test loop; forces humans to open PRs for proposals | Undermines Phase 2’s self-modification mechanism | #25 scope requires agent proposals to auto-spawn previews for self-testing |
| PR/CI + authenticated service-account agents (Chosen) | Enables agent self-test loop; keeps auth and rate limiting manageable | Requires policy for rate limiting and cleanup | Abuse/DoS by compromised service account; cost spikes | Governed mutation model expects privileged service identities for controlled mutations (`backend/docs/ARCHITECTURE.md`) |

Decision details:

- Preview creation is allowed from CI for PRs and from the proposals API when authenticated as a service account; both flows must enforce per-tenant quotas and TTL cleanup.

### 5) Task graph compilation strategy

| Option | Pros | Cons | Risks | Evidence |
| --- | --- | --- | --- | --- |
| Single compiler emits canonical + n8n JSON | Fewer moving parts | Harder to support multiple runtimes; risks coupling canonical spec to n8n quirks | Canonical spec may drift toward n8n-only features | “Database-First Authority” rule: canonical is stored in DB and adapters compile to runtimes (`backend/docs/ARCHITECTURE.md`) |
| Canonical-first with `n8n-adapter` (Chosen) | Clean boundary; enables future runtimes (durable engine) without rewriting canonical layer | More modules to maintain | Adapter drift if not tested; requires determinism tests | Phase 1 schema already has `workflow_adapter_artifacts` for runtime-specific compiled artifacts |

Decision details:

- Store canonical workflow JSON in `workflow_versions.spec`.
- Compile into `workflow_adapter_artifacts` for `adapter_type='n8n'` (and future adapter types).

### 6) Execution router extensibility

| Option | Pros | Cons | Risks | Evidence |
| --- | --- | --- | --- | --- |
| Add `execution_engine` discriminator now (Chosen) | Minimal schema cost; supports future “durable” engine without breaking history | Adds a field that may not be used immediately | Poorly-defined enum early on may ossify | Phase 2 explicitly mentions “execution router (ephemeral vs durable)” in `backend/docs/IMPLEMENTATION_PLAN.md` |
| Add later | Avoids premature design | Requires migration and backfill later; risks changing API semantics | Harder to unify eventing and run status across engines later | Execution surfaces are core data models; retrofits are costly |

Decision details:

- Phase 2 introduces `execution_engine` (e.g., `n8n_queue`) on `workflow_runs`. Future engines (e.g., durable execution) use new discriminator values without schema redesign.

### 7) Event streaming transport

| Option | Pros | Cons | Risks | Evidence |
| --- | --- | --- | --- | --- |
| SSE (Chosen, for client transport) | Simple browser/client support; works with HTTP infrastructure; good for append-only event streams | Server → client only (no bidirectional) | Connection management at scale; needs backfill/reconnect semantics | #25 explicitly scopes `/events` as SSE; event stream is append-only by design |
| WebSocket | Bidirectional; flexible | Higher operational complexity; harder auth/infra | More moving parts than needed for Phase 2 | Phase 2 does not require client-to-server realtime control beyond normal APIs |
| `LISTEN/NOTIFY` + adapter (Chosen, as internal wakeup) | Low-latency push without an external broker; aligns with Postgres as authority | Not a durable transport (must still persist events); requires connection management | If `NOTIFY` is missed, clients must fall back to DB polling | “Database-first authority” suggests persisting to `run_events` and treating push as an optimization (`backend/docs/ARCHITECTURE.md`) |

Decision details:

- `run_events` is the durable, ordered event log (source-of-truth).
- `LISTEN/NOTIFY` is used only to wake SSE handlers to fetch new rows; reconnect/backfill uses `run_events` sequence/offset.
- Event payload requirements (to support agent proposals) include: error class/fingerprint, step inputs, and a last-checkpoint signal sufficient for proposal construction.

### 8) Failure → proposal hook shape

| Option | Pros | Cons | Risks | Evidence |
| --- | --- | --- | --- | --- |
| Inline orchestrator callback | Fast path; fewer tables | Couples orchestrator to agent runtime; hard retries and idempotency | Risk of cascading failures during incidents | Phase 2 introduces async work (n8n + Redis); hook should be resilient |
| Agent subscribes to events | Decouples; uses streaming layer | Agent must be “always on”; harder to guarantee at-least-once processing | Missed failures if subscriber down; tricky checkpointing | Event stream is necessary but not sufficient for reliable processing |
| `proposal_triggers` table + worker drain (Chosen) | Durable queue semantics using DB; idempotent processing; decouples orchestrator and agent | Adds a table and worker logic | Requires careful dedupe and TTL cleanup | #25 explicitly mentions `proposal_triggers` as a candidate; fits DB-first authority rule |

Decision details:

- Orchestrator writes `proposal_triggers` row when a step/run hits a proposal-worthy failure condition.
- An agent worker drains triggers, gathers context (run/step/events), and submits `POST /v1/workflow-proposals` to create a draft version linked to the failure.

### 9) Publish gate in Phase 2

| Option | Pros | Cons | Risks | Evidence |
| --- | --- | --- | --- | --- |
| `role:admin` JWT gate only (Chosen) | Minimal; unblocks Phase 2 implementation while deferring Phase 5 governance | Coarse control; no multi-step approvals or routing | Overuse of admin credentials; audit requirements must be strict | #25 explicitly defines Phase 2 as “mechanism now, policy later” |
| Minimal approvals table now | More explicit governance early | Schema and workflow overhead; likely to be replaced in Phase 5 | Rework risk when Phase 5 lands | Non-goal: Phase 5 approval routing is deferred |

Decision details:

- Phase 2 publish/rollback endpoints require `role:admin` JWT and write explicit audit events.
- Phase 5 replaces this with approval routing and policy gates (no change to Phase 2 data model assumptions beyond adding approval entities).

### 10) Cycle detection algorithm

| Option | Pros | Cons | Risks | Evidence |
| --- | --- | --- | --- | --- |
| Iterative DFS with color marking (Chosen) | Simple; well-understood; provides a concrete cycle path for error messages | Not as feature-rich as SCC listing | If graph size grows, naive implementations can be slow | Task graphs are expected to be small-to-medium; Phase 2 needs actionable error messages |
| Tarjan’s SCC | Finds all SCCs; efficient | More complex implementation and harder to debug | Overkill for Phase 2 needs | Not required by acceptance criteria; only “detect and reject cycles” |

Decision details:

- Implement iterative DFS with explicit stack to avoid recursion limits; return an example cycle path for user/agent debugging.

### 11) Migration runner upgrade

| Option | Pros | Cons | Risks | Evidence |
| --- | --- | --- | --- | --- |
| Keep `backend/scripts/migrate.js` (Chosen) | No new dependency; consistent with ADR-0001; simple mental model | Fewer features (transactions per file, JS migrations, etc.) | As migrations grow, runner limitations may appear | ADR-0001 selected this runner explicitly to avoid dependency weight in early phases |
| Adopt `node-pg-migrate` | Mature tooling; better ergonomics | New dependency + migration style; conversion effort | Risk of partial migration/dual systems | Hard constraint: new deps require justification and review; Phase 2 is already complex |

Decision details:

- Phase 2 continues with SQL-file migrations and the existing runner. Revisit adoption of a migration framework after Phase 2 stabilizes (or earlier if the runner becomes a bottleneck).

## Consequences

### Positive

- Preserves a single source-of-truth for workflows in Postgres with deterministic compilation to runtime artifacts.
- Enables the core Phase 2 product loop: failure → proposal → preview self-test → admin-gated publish.
- Keeps Phase 2 governance intentionally minimal while creating explicit extension points for Phase 5.

### Negative

- Preview environments (Neon branches + n8n instances) add operational complexity and cost; strong cleanup and quotas are required.
- Storing proposal context on `workflow_versions` increases schema width and requires disciplined indexing and payload sizing.

### Neutral / tradeoffs

- SSE + `LISTEN/NOTIFY` uses Postgres as the durable log with push as an optimization; it may later be replaced or augmented by Redis/Kafka without changing the client contract if `run_events` remains authoritative.
- Adding `execution_engine` early introduces a field that might be lightly used in Phase 2 but avoids costly retrofits later.

## Security implications

- `POST /v1/workflow-proposals` must require authenticated service-account credentials; proposals are Class C mutations and must be fully audited (who/what/why/parent version).
- Publish/rollback endpoints are Class D mutations; Phase 2 gates them with `role:admin` JWT and requires tamper-evident audit events.
- All new tenant-scoped tables (task graphs, runs, events, proposal triggers) must carry `tenant_id` and have default-deny RLS policies (consistent with Phase 1).
- n8n encryption: n8n’s credential encryption key must be treated as a high-sensitivity secret; rotation and separation between preview and production environments must be planned (no shared key between tenants/environments).

## Operational implications

- Redis becomes a Phase 2 hard dependency for n8n queue mode; operational runbooks must cover availability, persistence, and safe restarts.
- Neon API access is required to create/delete branches for previews and (optionally) agent proposal previews; quotas, TTL cleanup, and failure handling are required.
- n8n must be version-pinned (container image tag) to avoid workflow JSON / execution behavior drift.
- Secrets management must support per-preview isolation: preview n8n instances must not share credentials with production.

## Test strategy

- Unit tests:
  - Task graph compilation and validation (including cycle detection).
  - Canonical → n8n compilation determinism (same canonical input yields byte-stable artifact JSON).
  - Lifecycle state transitions for workflow versions.
- Integration tests:
  - RLS isolation on new tables.
  - `run_events` ordering and SSE reconnect/backfill behavior.
  - Proposal trigger draining and idempotency.
- E2E tests:
  - Minimal workflow executes through n8n queue mode with events streamed to a client.
  - Failure induces a proposal trigger, a draft proposal is created, and the preview environment can execute the fixed workflow.

## Migration / rollback strategy

- Gate all Phase 2 runtime behavior behind a feature flag (API routes can exist, but “execute” can be disabled in production until ready).
- Every migration must have a reversible down path (Phase 2 PRs must include a rollback note and down migration behavior).
- Preview environments must be disposable: deleting the preview branch and tearing down the n8n instance is the rollback for proposal self-tests.
- Neon PITR window remains the “break glass” option for catastrophic schema or data issues; expected retention and operational steps must be documented in Phase 1b.

## Follow-up issues

- Reconcile ADR numbering collision between `docs/adr/ADR-0002-render-blueprint-neon-branching.md` and this ADR file.
- Confirm the exact `lifecycle_state` vs `approval_state` semantics (and allowed state machine) and document them in the Phase 2 implementation issues.
- Validate Neon + Postgres `LISTEN/NOTIFY` behavior under Neon’s operational model (and document fallback if required).
- Define preview quotas/TTLs and cleanup strategy for Neon branches and preview n8n instances (rate limiting and garbage collection).
- Define proposal-context size limits and indexing strategy for `proposal_context` JSONB.
