# Agent — Fully Autonomous Agentic Development

This project is built and maintained **entirely by AI agents**. There is no manual coding. The only human action required is opening a GitHub Issue describing the module or feature to be built.

---

## Table of Contents

1. [How It Works — The Big Picture](#1-how-it-works--the-big-picture)
2. [Your Only Job: Writing a Good Issue](#2-your-only-job-writing-a-good-issue)
3. [Triggering the Backend Agent](#3-triggering-the-backend-agent)
4. [What Happens Next (Fully Automated)](#4-what-happens-next-fully-automated)
5. [The Autonomous Feedback Loop](#5-the-autonomous-feedback-loop)
6. [The AI Gatekeeper (Structural Review)](#6-the-ai-gatekeeper-structural-review)
7. [Repository Memory Files](#7-repository-memory-files)
8. [Architecture Constraints](#8-architecture-constraints)
9. [Monorepo Structure](#9-monorepo-structure)
10. [Secrets Required](#10-secrets-required)
11. [Workflow Reference](#11-workflow-reference)

---

## 1. How It Works — The Big Picture

```
  YOU                    GITHUB                        AI AGENTS
  ──────                 ──────────────────────        ──────────────────────────────────
  Open Issue        →    Issue Created
  Apply Label       →    Workflow Triggered        →    Claude reads STATE.md + ARCHITECTURE.md
                                                        Claude writes code in /backend
                                                        Claude runs lint + tests
                                                        Claude opens a Pull Request
                         PR Opened                 →    Gemini reviews diff vs architecture rules
                         CI Runs                   →    If tests fail → Claude self-heals the branch
                         PR Ready for merge             Human reviews Gemini report, merges PR
```

The entire implementation cycle — scaffolding, coding, testing, linting, PR creation, and self-healing — happens without any human writing a single line of code.

---

## 2. Your Only Job: Writing a Good Issue

When you want a new module or feature built, open a GitHub Issue. The quality of the output depends on the quality of the issue. Follow this template:

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

**Good issue example:**
> **Feature:** User Profile API  
> **Domain:** Backend  
> **Requirements:**  
> - `GET /users/:id` returns the profile of the authenticated user.  
> - Only the user themselves or an admin may access the endpoint (ReBAC policy required).  
> - A `UserProfileService` must handle data retrieval; the controller must not query the database directly.  
> **Acceptance Criteria:**  
> - [ ] 401 returned for unauthenticated requests.  
> - [ ] 403 returned when a non-admin accesses another user's profile.  
> - [ ] All service methods have unit tests.

---

## 3. Triggering the Backend Agent

After creating your issue, apply the label **`route: claude-backend`** to it.

> **That's it.** The GitHub Actions workflow fires automatically.

If the label does not exist yet, create it once in your repository's Labels page (`Settings → Labels → New label`, name: `route: claude-backend`).

---

## 4. What Happens Next (Fully Automated)

Once the label is applied, the **Headless Claude Backend Dispatcher** (`.github/workflows/claude-agent.yml`) executes the following steps autonomously:

| Step | What the Agent Does |
|------|---------------------|
| 1 | Reads `.agentic/STATE.md` to understand the current project phase and any blockers. |
| 2 | Reads `backend/ARCHITECTURE.md` to load immutable structural constraints (controller rules, ReBAC policy engine location, etc.). |
| 3 | Implements the feature described in the issue inside the `backend` directory, following NestJS dependency injection patterns. |
| 4 | Runs `pnpm run lint` and `pnpm run test`. Fixes any issues before proceeding. |
| 5 | Updates `.agentic/STATE.md` to record what was built and mark the task complete. |
| 6 | Opens a Pull Request referencing the original issue. |

You will receive a GitHub notification when the PR is opened.

---

## 5. The Autonomous Feedback Loop

If the CI suite (`pnpm run lint` + `pnpm run test`) fails on the opened PR, the **Autonomous CI Feedback Loop** (`.github/workflows/autonomous-feedback.yml`) activates:

1. The full error trace (lint output + test output) is captured.
2. Claude is dispatched again with the error trace as context.
3. Claude reads the architecture constraints, identifies the root cause, fixes the failing files, and pushes a corrective commit directly to the PR branch.
4. The pipeline re-runs automatically.

This loop means **a failing build is self-healing** — you do not need to intervene unless the agent exhausts its retry budget (25 turns for the initial run, 20 turns for remediation).

---

## 6. The AI Gatekeeper (Structural Review)

Every PR — regardless of whether it was AI-generated or not — is reviewed by the **AI Gatekeeper** (`.github/workflows/gemini-gatekeeper.yml`) using Gemini.

Gemini acts as a Principal Architect and audits the PR diff against:

- `backend/ARCHITECTURE.md` — NestJS structural rules and ReBAC policy constraints.
- `frontend/ARCHITECTURE.md` — Vue 3 + Vuetify component and state management rules.
- `.agentic/STATE.md` — Confirms the agent updated the project state.

Gemini posts a Markdown review comment on the PR identifying any architectural violations or approving the change. **This is the human review checkpoint** — read the Gemini report before merging.

---

## 7. Repository Memory Files

Agents have no persistent memory between runs. These disk-backed files act as the project's shared brain:

| File | Purpose |
|------|---------|
| `/.agentic/STATE.md` | **Hot memory.** Tracks current phase, decisions made, and pending tasks. Read and updated by every agent run. |
| `/CLAUDE.md` | **Root protocol.** Tells Claude which domain files to load and enforces context boundaries. |
| `/.github/copilot-instructions.md` | **Copilot rules.** Restricts GitHub Copilot Workspace to Vue 3 + Vuetify conventions for frontend PRs. |
| `/backend/ARCHITECTURE.md` | **Backend cold constraints.** Immutable NestJS rules; the agent must never violate these. |
| `/frontend/ARCHITECTURE.md` | **Frontend cold constraints.** Immutable Vue 3 rules; the agent must never violate these. |

> **Important:** Do not delete or rename these files. They are the only mechanism by which agents understand prior decisions.

When a task is completed, `/.agentic/STATE.md` is automatically updated by the agent. You can read it at any time to understand the current project state without opening the codebase.

---

## 8. Architecture Constraints

These are enforced by the AI Gatekeeper on every PR and baked into the agent's context. They cannot be bypassed.

### Backend (`/backend`)
- **Controllers** handle HTTP routing, DTO validation, and response formatting only. No business logic.
- **Services** own all business logic and database interaction.
- **Direct database queries from controllers are forbidden.**
- **Authorization** is handled exclusively by the ReBAC engine (Oso/Cerbos) in `/backend/src/auth/`. No module may bypass it to make access decisions.
- Every new endpoint must have a policy defined, the resource registered, and the controller decorated with the ReBAC check.
- Unit tests must prove unauthorized access is rejected.

### Frontend (`/frontend`)
- All components use Vue 3 `<script setup>` syntax. Options API is forbidden.
- Shared state lives in Pinia stores at `/frontend/src/stores/`.
- Vuetify 3 components and utility classes must be used before any custom CSS is written.
- All API calls are encapsulated in composables or Pinia store actions. Components must not call APIs directly.
- Navigation uses Vue Router only.

---

## 9. Monorepo Structure

```
/
├── .agentic/
│   └── STATE.md                  # Hot memory — project save state
├── .github/
│   ├── copilot-instructions.md   # Copilot Workspace frontend rules
│   └── workflows/
│       ├── claude-agent.yml      # Headless backend agent dispatcher
│       ├── autonomous-feedback.yml # Self-healing CI feedback loop
│       └── gemini-gatekeeper.yml # Architectural debt review
├── backend/                      # NestJS application
│   └── ARCHITECTURE.md           # Immutable backend constraints
├── frontend/                     # Vue 3 + Vuetify application
│   └── ARCHITECTURE.md           # Immutable frontend constraints
└── CLAUDE.md                     # Root agent orchestration protocol
```

---

## 10. Secrets Required

Configure these in your repository's **Settings → Secrets and variables → Actions**:

| Secret | Description |
|--------|-------------|
| `ANTHROPIC_API_KEY` | API key for Claude (powers the backend agent and self-healing loop). |
| `GEMINI_API_KEY` | API key for Gemini (powers the AI Gatekeeper structural review). |

Without these secrets, the workflows will fail immediately. No code will be generated.

---

## 11. Workflow Reference

| Workflow | File | Trigger | Purpose |
|----------|------|---------|---------|
| Headless Claude Backend Dispatcher | `.github/workflows/claude-agent.yml` | Issue labeled `route: claude-backend` | Implements the feature described in the issue and opens a PR. |
| Autonomous CI Feedback Loop | `.github/workflows/autonomous-feedback.yml` | PR opened or updated targeting `main` | Catches CI failures and dispatches Claude to self-heal the branch. |
| AI Gatekeeper — Structural Debt Review | `.github/workflows/gemini-gatekeeper.yml` | PR opened or updated | Audits the PR diff against architecture rules and posts a review report. |

---

## Quick-Start Checklist

- [ ] Add `ANTHROPIC_API_KEY` secret to the repository.
- [ ] Add `GEMINI_API_KEY` secret to the repository.
- [ ] Create the label `route: claude-backend` in the repository Labels page.
- [ ] Open a GitHub Issue describing the first module to build (see [Section 2](#2-your-only-job-writing-a-good-issue)).
- [ ] Apply the label `route: claude-backend` to the issue.
- [ ] Wait for the agent to open a PR, then read the Gemini gatekeeper report before merging.