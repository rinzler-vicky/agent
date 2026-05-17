# Agentic Repository Workflow

## Issue states

- `status:intake` — raw request, not ready for implementation.
- `needs:breakdown` — master goal requires child issue plan.
- `needs:research` — facts or architecture are unknown.
- `needs:decision` — maintainer must approve architecture.
- `status:planned` — phase issue has ready criteria.
- `status:in-progress` — implementation active.
- `status:qa` — implementation complete, validation/review active.
- `status:done` — accepted and merged.
- `status:blocked` — cannot proceed; blocker documented.

## Default phase gates

### Phase 0 — Discovery / Research / ADR

Exit criteria:
- Repo surfaces identified.
- Options compared.
- Recommendation made.
- ADR drafted if needed.
- Human confirms architecture.

### Phase 1 — Contracts / Schema / Skeleton

Exit criteria:
- API/data/workflow contracts defined.
- Migrations drafted where relevant.
- Test scaffolding exists.
- No broad implementation beyond contract skeleton.

### Phase 2 — Backend implementation

Exit criteria:
- Backend acceptance criteria satisfied.
- Unit/integration/API/migration checks pass.
- If any `backend/src/**/*.controller.ts` changed: `pnpm --filter @agent/backend check:swagger` passes.
- Observability/security notes complete.

### Phase 3 — Frontend implementation

Exit criteria:
- UX states implemented.
- Accessibility smoke check done.
- Component/e2e checks pass.
- Screenshots/visual evidence attached.

### Phase 4 — Integration / QA / Docs

Exit criteria:
- End-to-end flow passes.
- Docs updated.
- Release/rollback plan exists.

### Phase 5 — Hardening / Learnings / Self-evolution

Exit criteria:
- Repeated agent mistakes converted into self-evolution issues.
- Follow-ups created.
- Post-phase outcome documented.
