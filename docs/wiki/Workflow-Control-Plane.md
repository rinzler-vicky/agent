# Workflow Control Plane API

The workflow control plane is the HTTP surface that drives the canonical workflow lifecycle — draft → validate → publish → rollback — plus the agent-facing proposal endpoint that lets a service-account agent submit a canonical patch in response to a failing run.

This page documents the surface shipped in Phase 2.4 (issue [#44](https://github.com/rinzler-vicky/agent/issues/44)). The schema it operates on landed in Phase 2.1, the compiler in 2.2, and the n8n adapter in 2.3.

---

## Authentication

Every route requires a JWT. Two flavors:

| Token type | Issued by | Carries |
|---|---|---|
| User JWT | `POST /v1/auth/login` (email + password) | `type: 'user'`, `role: 'admin' \| 'member' \| ...` |
| Service-account JWT | `POST /v1/auth/service-account/token` (API key) | `type: 'service_account'`, `scopes: string[]` |

Get a service-account JWT by exchanging the bootstrap API key:

```bash
curl -X POST https://api.example.com/v1/auth/service-account/token \
  -H "x-api-key: $AGENT_API_KEY"
# → { "access_token": "eyJhbGc…" }
```

The API key format is `<id>.<secret>` (stored as bcrypt hash on the `service_accounts` row). The JWT lifetime is controlled by `JWT_EXPIRES_IN` (default 1h).

---

## Lifecycle routes (human-facing)

All routes require `Authorization: Bearer <user JWT>` and are mounted under `/v1/workflows`.

### `POST /v1/workflows` — create a draft

Two body shapes:

```jsonc
// Add a new draft version to an existing def
{ "workflowDefId": "<uuid>", "spec": { ... }, "changelog": "string?" }

// Create a new def + first draft in one call
{ "slug": "my-workflow", "displayName": "My Workflow", "spec": { ... } }
```

Returns the inserted `workflow_versions` row (always lifecycle_state=`draft`, auto-incrementing `versionNumber`).

### `PATCH /v1/workflows/:id` — edit a draft

`workflow_versions` is immutable, so this **inserts a new draft row** carrying the replacement spec and demotes the prior draft to `superseded`. The new row id is returned. Only draft versions can be patched.

### `POST /v1/workflows/:id/validate`

Runs the Phase 2.2 compiler on the stored spec. No DB mutation, no audit. Returns:

```jsonc
{ "ok": true,  "errors": [], "hash": "<sha256>" }
// OR
{ "ok": false, "errors": [{ "code": "CYCLE_DETECTED", "path": "…", "message": "…" }] }
```

### `POST /v1/workflows/:id/publish` — admin only

`@Roles('admin')` placeholder (Phase 5 will replace with full approval routing). On success:

1. Compile-or-fail (returns 400 with structured errors on failure).
2. Demote the prior published row of the same def to `superseded`.
3. Set the target row to `lifecycle_state='published'`, `published_at=now()`.
4. Update `workflow_defs.active_version_id` and `rollback_target_id` (= the prior active).
5. Call the n8n sync service. On sync failure: DB stays published but the route returns **502** and the audit row records `syncError`.

### `POST /v1/workflows/:id/rollback` — admin only

Promotes `workflow_defs.rollback_target_id` back to `published`, demotes the current active to `superseded`, swaps `active_version_id` / `rollback_target_id`, re-syncs n8n.

### `GET /v1/workflows/:id/diff?from=<verNum>&to=<verNum>`

Returns an [RFC 6902 JSON Patch](https://datatracker.ietf.org/doc/html/rfc6902) describing the structural difference between two version_numbers of the same `workflow_def`. The diff is computed over the **compiled** workflows (deterministic, sorted-by-id) and is applyable via `rfc6902.applyPatch`.

```jsonc
{
  "fromVersion": 1,
  "toVersion": 2,
  "fromHash": "abc…",
  "toHash":   "def…",
  "patch": [
    { "op": "replace", "path": "/nodes/http1/config/url", "value": "https://new.example.com" }
  ]
}
```

---

## Proposal route (agent-facing)

### `POST /v1/workflow-proposals`

**Auth:** service-account JWT (`type=service_account`) whose `scopes` claim contains `workflows:propose`. User-type JWTs are rejected with 403; service-account JWTs missing the scope are also rejected with 403.

**Rate limit:** 30 requests per 60 seconds (stricter than the global 100/60s default). Phase 5 will replace this with adaptive per-actor budgets.

**Body:**

```jsonc
{
  "workflowDefId":   "<uuid>",
  "parentVersionId": "<uuid>",          // the published version this patch derives from
  "spec":            { ... },           // canonical workflow JSON; validated by the compiler
  "stepRunId":       "<uuid>?",         // present → proposal_source=failure_recovery
  "workflowRunId":   "<uuid>?",
  "errorFingerprint":"HTTP_TIMEOUT@http1",
  "rationale":       "increase upstream timeout",
  "changelog":       "string?"
}
```

**Behavior:**

1. `compile(spec)` runs first; on failure, returns 400 with the compiler's structured error list.
2. Inserts a draft `workflow_versions` row with:
   - `proposal_source = 'failure_recovery'` (when `stepRunId` is provided) or `'agent_reflection'`.
   - `proposal_context` = `{ workflowRunId?, stepRunId?, errorFingerprint? }`.
   - `proposal_rationale = rationale`.
   - `parent_version_id = parentVersionId`.
   - `created_by_actor = <service-account id>`.
3. Writes an audit event `workflow.proposal.created` with `resource_id = newDraftVersionId` — so the failing-step → draft linkage is queryable directly from the audit log.

**Curl example (end-to-end agent flow):**

```bash
TOKEN=$(curl -s -X POST https://api.example.com/v1/auth/service-account/token \
  -H "x-api-key: $AGENT_API_KEY" | jq -r .access_token)

curl -X POST https://api.example.com/v1/workflow-proposals \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d @proposal.json
# → 201 with the new draft workflow_version row
```

---

## State machine (workflow_versions.lifecycle_state)

```
                ┌──── (publish) ───────► published ──┐
                │                          │         │
                │                          │ (rollback / new publish)
   draft ───────┤                          ▼         │
                │                      superseded ◄──┘
                │
                └──── (edit-via-patch) ──► superseded
                       (new draft inserted)
```

`rejected` is reserved for Phase 5 approval routing; no Phase 2.4 transition writes it.

---

## Audit trail

Every mutation writes exactly one `audit_events` row:

| Action | When | Notable metadata |
|---|---|---|
| `workflow.draft.created` | `POST /v1/workflows` | `workflowDefId`, `versionNumber` |
| `workflow.draft.updated` | `PATCH /v1/workflows/:id` | `supersededVersionId`, `newVersionNumber` |
| `workflow.published` | publish ok or sync failed | `priorActiveId`, `syncAction`, `syncError?` |
| `workflow.rolled_back` | rollback ok or sync failed | `fromVersionId`, `toVersionId`, `syncError?` |
| `workflow.proposal.created` | `POST /v1/workflow-proposals` | `parentVersionId`, `proposalSource`, `stepRunId`, `workflowRunId`, `errorFingerprint`, `canonicalHash` |

---

## See also

- [`backend/docs/ARCHITECTURE.md`](https://github.com/rinzler-vicky/agent/blob/main/backend/docs/ARCHITECTURE.md) §3 Governed Self-Modification (Classes A–D).
- [`docs/adr/ADR-0002-...md`](https://github.com/rinzler-vicky/agent/blob/main/docs/adr) — lifecycle column placement, proposal context shape, admin-gate placeholder.
- [Phase 2.4 summary](https://github.com/rinzler-vicky/agent/blob/main/backend/docs/PHASE_2_4_SUMMARY.md) — implementation log, trial/error, learnings.
