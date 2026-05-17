# Phase 2.4 Implementation Summary

## Overview

Phase 2.4 adds the HTTP surface that drives the workflow control plane shipped in Phases 2.1–2.3:

- **Human draft + lifecycle controller** (`WorkflowsController`) for create-draft, edit-draft (immutable supersede), validate, publish, rollback, and diff.
- **Agent proposal controller** (`ProposalsController`) for `POST /v1/workflow-proposals` — the headline endpoint that lets a service-account agent submit a canonical patch in reaction to a failing `step_run_id`, lands it as a draft `workflow_version` with `proposal_source='failure_recovery'`, and audit-links the failing step to the new draft.
- **Service-account JWT minting** (`POST /v1/auth/service-account/token`) so the proposal endpoint can be authenticated by the same Bearer-token pattern as human routes; the JWT carries a `scopes` claim drawn from `service_accounts.scopes`.
- **`ServiceAccountScopeGuard`** that gates the proposal endpoint on `type=service_account` + `workflows:propose`.
- **Throttler enforcement**: `ThrottlerGuard` bound via `APP_GUARD` (was previously inert), with a stricter 30/min override on the proposal endpoint.

No schema migrations: every column this phase touches was provisioned by Phase 2.1.

## Files changed

```
backend/src/auth/auth.service.ts         + loginServiceAccount; JwtPayload.scopes
backend/src/auth/auth.controller.ts      + POST /v1/auth/service-account/token
backend/src/auth/jwt.strategy.ts         (comment; scopes flows through validate())
backend/src/app.module.ts                + APP_GUARD: ThrottlerGuard; ttl in ms
backend/src/workflows/workflows.module.ts + WorkflowsController, ProposalsController, services
backend/src/workflows/workflows.controller.ts NEW
backend/src/workflows/workflows.service.ts    NEW
backend/src/workflows/proposals.controller.ts NEW
backend/src/workflows/proposals.service.ts    NEW
backend/src/workflows/diff.ts                  NEW (thin wrapper over rfc6902)
backend/src/workflows/guards/service-account-scope.guard.ts NEW
backend/src/workflows/dto/workflow-lifecycle.dto.ts NEW
backend/src/workflows/dto/workflow-proposal.dto.ts  (DTO refresh for #44 field names)
backend/test/workflow-lifecycle.e2e-spec.ts   NEW
backend/test/workflow-proposals.e2e-spec.ts   NEW
docs/wiki/Workflow-Control-Plane.md           NEW
docs/wiki/Home.md                             + nav entry
backend/package.json                          + rfc6902 ^5.2.0 (dependency-free)
```

## Acceptance criteria (issue #44)

| AC | Covered by |
|---|---|
| Draft → validate → publish → rollback flow via supertest | `workflow-lifecycle.e2e-spec.ts` |
| Publish fails for non-admin JWT with 403 | `RolesGuard` + `@Roles('admin')`; covered in unit + e2e |
| `POST /v1/workflow-proposals` with service-account JWT + failing `step_run_id` creates draft with `proposal_source='failure_recovery'`, `proposal_context` populated, audit event | `proposals.service.spec.ts` + `workflow-proposals.e2e-spec.ts` |
| Proposal endpoint rejects user-type JWTs with 403 | `ServiceAccountScopeGuard` |
| Proposal endpoint rejects service-account JWTs missing `workflows:propose` scope | `ServiceAccountScopeGuard` |
| Validation rejects malformed canonical JSON with compiler's structured error list | `validateById` + `publish` both surface compiler errors; e2e covers 400 |
| Rollback restores prior published row and triggers re-sync via 2.3 | `WorkflowsService.rollback` calls `N8nSyncService.syncPublishedVersion` post-commit |
| Rate limits enforced | `APP_GUARD: ThrottlerGuard` + `@Throttle({ default: { ttl: 60_000, limit: 30 } })` on proposal endpoint |

## Architectural decisions worth keeping in mind

1. **JWT vs raw API key on the proposal endpoint.** The issue spec names "service-account JWT" explicitly, and a JWT carries `scopes` natively. We added a thin `/v1/auth/service-account/token` exchange so the API key stays as the bootstrap credential and the JWT travels on subsequent requests. Tradeoff: a stolen JWT lives until expiry (default 1h via `JWT_EXPIRES_IN`).

2. **Publish is non-atomic across DB and n8n** — same trade-off Phase 2.3 already accepted. We commit DB state first, then call `N8nSyncService.syncPublishedVersion`. A sync failure leaves the DB published but n8n stale; we surface 502, write `syncError` into the audit row, and recovery is "rollback or re-publish."

3. **Edit creates a new immutable row.** `PATCH /v1/workflows/:id` inserts a new draft `workflow_versions` and supersedes the prior draft. This deviates from typical REST PATCH semantics but preserves the Phase 1 immutable-versions invariant. The Swagger description documents this on the route.

4. **Diff over compiled output, not raw spec.** The `rfc6902.createPatch` runs on the *compiled* workflow (sorted-by-id nodes/edges, resolved adjacency). Reordering the input spec's arrays produces no diff. Trade-off: fields the compiler discards don't show up in the diff.

5. **`workflow_versions` has no RLS** (only `workflow_defs` does). Every read in `WorkflowsService` JOINs through `workflow_defs` with an explicit `AND d.tenant_id = $tenant`, matching the pattern in `N8nSyncService.loadVersion`.

6. **ThrottlerGuard was inert pre-2.4.** `ThrottlerModule.forRoot` was already wired but no guard read its config. Phase 2.4 binds `ThrottlerGuard` via `APP_GUARD` so both the global fallback (100/min) and the per-route override (30/min on the proposal endpoint) actually enforce. Also fixed: the global `ttl` value to be in milliseconds (60_000) rather than the prior `60` — `@nestjs/throttler` v6 expects ms.

## Trial / Errors

- **Initial diff utility was hand-rolled**, then replaced with the `rfc6902` package after user feedback ("try using a npm package for json diff instead of writing your own"). Outcome: cleaner code, RFC-standard output, applicable via `applyPatch`. Lesson saved to memory under `feedback_prefer_npm_packages.md`.
- **First diff.spec used `log` node type** which isn't in the canonical node registry; surfaced 6 test failures at first run. Fixed by using the same `start → http.request → end` triplet that the canonical compiler spec uses.
- **`workflow_versions.lifecycle_state` ENUM is implicit.** No DB CHECK constraint enforces the state list; the application layer is the gate. Considered adding a CHECK in this PR but kept consistent with how Phase 2.1 left it — a `CHECK` would be its own migration and Phase 5 may add more states (`rejected_with_appeal`, …).

## Self-modification surface (ARCHITECTURE.md §3 Class C/D)

- **Class C (agent-authored drafts)** is the proposal endpoint. The mechanism is shipped; the *policy* (when an agent decides to call it, retry budgets, dedup against `proposal_triggers`) lands in Phase 4 (memory/planner).
- **Class D (publish gate)** is currently the `@Roles('admin')` placeholder. Phase 5 will replace it with full approval routing (SLA, multi-reviewer, escalation). The PR description for #44 documents this hand-off.

## Validation evidence

- `pnpm --filter @agent/backend test` — 176 tests passing across 23 suites.
- `pnpm --filter @agent/backend check:swagger` — exit 0; every new controller route has `@ApiTags` + `@ApiOperation`.
- `pnpm --filter @agent/backend lint` — exit 0 (108 pre-existing warnings, no new errors).
- `pnpm --filter @agent/backend build` — exit 0.
- `pnpm --filter @agent/backend test:integration` — requires `DATABASE_URL` (matches the existing `rls-isolation.e2e-spec.ts` pattern). Tests parse cleanly under `jest --listTests`.

## Follow-ups (not in scope of #44)

- Phase 2.5 (#45): consume `proposal_triggers`, wire SSE for run events, attach the failure → proposal hook.
- Phase 4: the planner / memory layer that decides *when* an agent submits a proposal.
- Phase 5: real approval routing — replace `@Roles('admin')` with SLA-tracked multi-reviewer flow.
