# AGENTS.md — Repository Operating Contract

This file is the source of truth for Codex, Copilot, Claude, Cursor, and any other coding agent working in this repository.

## Prime directive

Build only from an approved issue plan. Do not freestyle architecture, folder structure, dependencies, data models, APIs, or UI behavior. When the task is ambiguous, stop and produce a short research/decision note instead of implementing.

## Required workflow

Every meaningful change must pass through these gates:

1. Intake
   - Read `.agentic/STATE.md` (hot memory) to understand current project state, active domain, and pending tasks.
   - Read the parent issue, linked child issues, existing ADRs, README, package files, test config, and relevant source paths.
   - Restate the goal, non-goals, affected surfaces, risks, and assumptions.
   - Identify whether the task is backend, frontend, full-stack, infra, bug, research, or self-evolution.

2. Research
   - Inspect current code first.
   - Search official docs or primary sources for unfamiliar frameworks, libraries, APIs, security rules, or breaking changes.
   - Record the exact architecture options considered, tradeoffs, and rejected options in the issue or ADR.

3. Architecture confirmation
   - For new features, migrations, public APIs, database schema changes, workflow/orchestration changes, auth/security changes, or new dependencies: do not implement until the architecture plan is explicitly accepted by a human maintainer.
   - Small contained fixes may proceed when the issue has clear acceptance criteria and no architectural uncertainty.

4. Phase plan
   - Split work into phases. Each phase must include tasks, subtasks, acceptance criteria, QA plan, risks, trial/errors, learnings, and outcomes.
   - Complete one phase at a time. Do not start the next phase until the current phase has passing checks and documented outcomes.

5. Implementation
   - Make the smallest coherent change set.
   - Preserve existing public behavior unless the issue explicitly requires a change.
   - Avoid broad rewrites. Avoid drive-by refactors.
   - If a refactor is required, isolate it in its own commit/PR or subtask.

6. Validation
   - Run the narrowest relevant tests first, then the broader suite required by the task.
   - Include typecheck, lint, formatting, build, migrations, seed checks, API contract tests, component tests, e2e tests, and security checks where relevant.
   - Never claim a check passed unless it was actually run.

7. Documentation
   - Update README, docs, ADRs, examples, env docs, API docs, schema docs, and prompt/workflow docs when behavior changes.
   - Add a brief "Learnings / Trial and Error" note to the issue or PR for agent continuity.
   - Update `.agentic/STATE.md` with current phase, active domain, decisions made, and pending tasks before opening a PR.

8. PR
   - The PR body must include: parent issue, phase, summary, changed surfaces, validation evidence, screenshots/logs where relevant, risks, rollback plan, and follow-up issues.

## Hard constraints

- Do not invent APIs, env vars, commands, dependencies, labels, tables, or endpoints. Verify them in the repo or official docs.
- Do not bypass failing tests. Fix, quarantine with explicit maintainer approval, or document as pre-existing with evidence.
- Do not add production dependencies without a short justification and human approval.
- Do not commit secrets, tokens, private URLs, credentials, personal data, or generated build artifacts.
- Do not modify agent governance files (`AGENTS.md`, `CLAUDE.md`, `.github/copilot-instructions.md`, `.github/prompts/**`, `.github/ISSUE_TEMPLATE/**`, `.agent/**`) unless working from an approved `self-evolution` issue.
- Do not delete tests to make the suite pass.
- Do not change database schema without a migration, rollback note, and data compatibility note.
- Do not introduce a new workflow engine, framework, queue, ORM, auth provider, observability vendor, UI library, or cloud service without an ADR.

## Definition of ready

An issue is ready for implementation only when it has:

- Clear problem statement
- Scope and non-goals
- Affected surfaces
- Architecture plan or explicit statement that no architecture change is needed
- Phase checklist
- Acceptance criteria
- QA plan
- Rollback plan for risky changes
- Human confirmation for architecture-sensitive work

## Definition of done

A task is done only when:

- Acceptance criteria are met
- Tests/checks listed in the issue were run and documented
- New behavior is documented
- Migration/rollback notes are included if applicable
- Learnings, trial/errors, and outcomes are recorded
- Follow-up issues are created for anything intentionally deferred

## Backend development rules

- Prefer explicit service boundaries: API layer, domain/service layer, persistence layer, integration/adapters layer.
- Keep business logic out of route handlers/controllers when possible.
- Validate inputs at system boundaries.
- Use typed DTOs/schemas for public inputs and outputs.
- Make database changes through migrations only.
- Add integration tests for database, queue, auth, workflow engine, and external adapter behavior.
- Add contract tests for public APIs and workflow event schemas.
- External integrations must use adapters with deterministic test doubles.
- All long-running or async work must be idempotent, retry-safe, observable, and resumable where feasible.

## Frontend development rules

- Preserve accessible UI semantics: labels, keyboard navigation, focus states, contrast, ARIA only when needed.
- Keep data fetching, state transitions, and presentation separated.
- Add loading, empty, error, success, and permission-denied states.
- Do not hardcode server shapes. Use shared/generated types where available.
- Add component tests for stateful components and e2e tests for critical user flows.
- Include screenshots or visual notes for visible UI changes.

## Agentic workflow/product rules

- Workflows are versioned assets, not hidden prompt blobs.
- Every workflow must define: trigger, input schema, state shape, task list, gates, retry policy, escalation policy, output schema, observability events, and rollback behavior.
- Agents may propose workflow updates but must not silently mutate production workflow behavior.
- Self-evolution changes must be traceable through issues, ADRs, tests, and changelog entries.

## Commit and PR style

- Use conventional commits when possible: `feat:`, `fix:`, `docs:`, `test:`, `refactor:`, `chore:`.
- Keep commits scoped to one concern.
- PR title format: `[Phase N] <short outcome>`.
- Link all child issues to the parent master goal.

## Output format for agent plans

When asked to plan, produce:

```markdown
# Plan

## Goal

## Non-goals

## Current repo observations

## Research required

## Architecture options

## Recommended architecture

## Human confirmation needed

## Phases
### Phase 0 — Discovery and architecture confirmation
- Tasks
- Subtasks
- Acceptance criteria
- QA
- Risks
- Trial/errors log
- Outcome

### Phase 1 — ...

## Validation matrix

## Rollback plan

## Follow-up issues
```
