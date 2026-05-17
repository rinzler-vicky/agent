# Usage

This page explains how to use the Agent system: how to describe work via GitHub Issues, how to trigger the AI agents, and what to expect at each stage.

---

## The Core Concept

You write a GitHub Issue. You apply a label. The agent does the rest.

There is no manual coding required. The AI agent reads your issue, implements the feature in the codebase, runs lint and tests, and opens a Pull Request — all automatically.

---

## Writing a Good Issue

The quality of the agent's output depends entirely on the quality of your issue. Use this template:

```markdown
## Feature / Module
Brief name of what should be built (e.g., "User Authentication Module").

## Domain
Backend | Frontend | Both

## Requirements
- Bullet-point list of what the module must do.
- Be specific about inputs, outputs, and edge cases.
- Mention any entities, endpoints, or UI components expected.

## Acceptance Criteria
- [ ] Unit tests cover all service methods.
- [ ] Unauthorized access is rejected with a 403.
- [ ] STATE.md is updated reflecting this task as complete.
```

### Good Issue Example

> **Feature:** User Profile API  
> **Domain:** Backend  
> **Requirements:**  
> - `GET /users/:id` returns the profile of the authenticated user.  
> - Only the user themselves or an admin may access the endpoint.  
> - A `UserProfileService` must handle data retrieval; the controller must not query the database directly.  
>
> **Acceptance Criteria:**  
> - [ ] 401 returned for unauthenticated requests.  
> - [ ] 403 returned when a non-admin accesses another user's profile.  
> - [ ] All service methods have unit tests.

### Tips for Better Issues

- **Be specific about inputs and outputs.** The agent cannot infer business rules it hasn't been told.
- **Reference existing patterns.** Mention similar modules to guide consistency (e.g., "follows the same pattern as `TenantsModule`").
- **List edge cases explicitly.** The agent will implement what's specified; unspecified edge cases may be missed.
- **Include acceptance criteria.** These become the pass/fail bar for the agent's self-checks.

---

## Triggering the Backend Agent

After creating your issue, apply the label **`route: claude-backend`**.

> **That's it.** The GitHub Actions workflow fires automatically.

If the label does not exist yet, create it once: **Issues → Labels → New label**, name: `route: claude-backend`.

---

## What Happens Automatically

Once the label is applied, the **Headless Claude Backend Dispatcher** (`.github/workflows/claude-agent.yml`) runs:

| Step | What the Agent Does |
|------|---------------------|
| 1 | Reads `.agentic/STATE.md` to understand the current project phase and any blockers. |
| 2 | Reads architecture constraint files to load immutable structural rules. |
| 3 | Implements the feature described in the issue, following NestJS dependency injection patterns. |
| 4 | Runs `pnpm run lint` and `pnpm run test`. Fixes any issues before proceeding. |
| 5 | Updates `.agentic/STATE.md` to record what was built and mark the task complete. |
| 6 | Opens a Pull Request referencing the original issue. |

You receive a GitHub notification when the PR is opened.

---

## The Autonomous Self-Healing Loop

If the CI suite fails on the opened PR, the **Autonomous CI Feedback Loop** (`.github/workflows/autonomous-feedback.yml`) activates:

1. The full error trace (lint + test output) is captured.
2. Claude is dispatched again with the error trace as context.
3. Claude identifies the root cause, fixes the failing files, and pushes a corrective commit to the PR branch.
4. The pipeline re-runs automatically.

This loop repeats until CI passes or the retry budget is exhausted (25 turns for the initial run, 20 turns for remediation). **A failing build is self-healing** — you do not need to intervene unless the budget is exhausted.

---

## The AI Gatekeeper

Every PR — AI-generated or not — is reviewed by the **AI Gatekeeper** (`.github/workflows/gemini-gatekeeper.yml`).

The workflow uses Gemini (if `GEMINI_API_KEY` is configured) or Claude as fallback. The reviewer acts as a Principal Architect and audits the PR diff against:

- Backend architecture rules (NestJS structural rules, ReBAC policy constraints)
- Frontend architecture rules (Vue 3 + Vuetify component and state management rules)
- `.agentic/STATE.md` — confirms the agent updated the project state

The AI posts a Markdown review comment on the PR with any architectural violations or an approval. **Read this report before merging.**

---

## PR Lifecycle

```
Issue opened + label applied
    ↓
Claude implements + opens PR
    ↓
CI runs (lint + tests)
    ↓ (if fails)
Self-healing loop kicks in → fixes → CI re-runs
    ↓ (when CI passes)
AI Gatekeeper posts review
    ↓
Human reads review → merges (or requests changes)
    ↓
PR ready for review → Render + Neon preview spins up
```

---

## Repository Memory Files

These files act as the project's shared brain across agent runs:

| File | Purpose |
|------|---------|
| `.agentic/STATE.md` | **Hot memory.** Current phase, decisions, and pending tasks. Read and updated every run. |
| `AGENTS.md` | **Root operating contract.** Governs all agent behavior in this repo. |
| `CLAUDE.md` | **Claude-specific rules.** Tells Claude which files to load and enforces context boundaries. |
| `backend/ARCHITECTURE.md` | **Backend constraints.** Immutable NestJS rules. |
| `frontend/ARCHITECTURE.md` | **Frontend constraints.** Immutable Vue 3 rules. |

> Do not delete or rename these files. They are the mechanism by which agents understand prior decisions.

---

## Architecture Constraints

These are enforced by the AI Gatekeeper on every PR.

### Backend (`backend/`)
- **Controllers** handle HTTP routing, DTO validation, and response formatting only. No business logic.
- **Services** own all business logic and database interaction.
- **Direct database queries from controllers are forbidden.**
- Authorization is handled exclusively by the ReBAC engine in `backend/src/auth/`.
- Every new endpoint must have a policy defined, the resource registered, and the controller decorated with the ReBAC check.

### Frontend (`frontend/`)
- All components use Vue 3 `<script setup>` syntax. Options API is forbidden.
- Shared state lives in Pinia stores at `frontend/src/stores/`.
- Vuetify 3 components and utility classes must be used before any custom CSS is written.
- All API calls are encapsulated in composables or Pinia store actions. Components must not call APIs directly.
- Navigation uses Vue Router only.

---

## Related Pages

- [Installation](Installation) — set up secrets and labels.
- [Architecture Overview](Architecture-Overview) — understand the system design.
- [Workflow Reference](Workflow-Reference) — GitHub Actions workflow details.
- [Troubleshooting](Troubleshooting) — if something doesn't work as expected.
