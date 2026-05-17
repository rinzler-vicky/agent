# Contributing

This page explains how to contribute to this repository — whether you're a human contributor or an AI agent.

---

## Ways to Contribute

| Method | Description |
|--------|-------------|
| **Open an Issue** | The primary way to request new features or report bugs. AI agents will implement approved features automatically. |
| **Review a PR** | Read the AI Gatekeeper's review comment, then add your own review before merging. |
| **Update documentation** | Edit files in `docs/wiki/` (for wiki pages) or `docs/` (for ADRs and runbooks) and open a PR. |
| **Update architecture constraints** | Edit `backend/ARCHITECTURE.md` or `frontend/ARCHITECTURE.md` through an approved issue. |
| **Self-evolution** | Changes to agent governance files (AGENTS.md, prompts, workflows) must go through a `self-evolution` issue. |

---

## Issue Guidelines

Follow the issue template in [Usage — Writing a Good Issue](Usage#writing-a-good-issue).

### Issue Labels

| Label | Effect |
|-------|--------|
| `route: claude-backend` | Triggers the Headless Claude Backend Dispatcher workflow. |

### Issue Quality Bar

Before applying the routing label, confirm your issue has:

- [ ] Clear problem statement
- [ ] Scope and non-goals
- [ ] Affected surfaces (backend / frontend / both)
- [ ] Architecture plan or explicit statement that no architecture change is needed
- [ ] Phase checklist
- [ ] Acceptance criteria
- [ ] QA plan

Issues that are too vague will produce vague code. The agent implements what is specified.

---

## Pull Request Guidelines

### Opening a PR (human-authored)

1. Create a branch from `main`.
2. Make your changes.
3. Ensure `pnpm run lint` and `pnpm run test` pass locally.
4. Open a PR — the AI Gatekeeper will review it automatically.
5. Read the Gatekeeper's review comment before requesting human review.

### Reviewing a PR (AI-authored)

1. Read the AI Gatekeeper's review comment (posted automatically).
2. Check the PR diff against the architecture rules in [Architecture Overview](Architecture-Overview).
3. Verify `.agentic/STATE.md` was updated.
4. Run the preview environment to test interactively (see [PR Preview Environments](PR-Preview-Environments)).
5. Approve and merge, or request changes.

---

## Commit Style

This repository uses [Conventional Commits](https://www.conventionalcommits.org/):

| Prefix | Use for |
|--------|---------|
| `feat:` | New feature or capability |
| `fix:` | Bug fix |
| `docs:` | Documentation changes |
| `test:` | Adding or updating tests |
| `refactor:` | Code change that is not a feature or fix |
| `chore:` | Maintenance (dependencies, CI config, etc.) |

**PR title format:** `[Phase N] <short outcome>`

Examples:
- `feat: add conversation orchestrator service`
- `fix: resolve RLS bypass in task_graphs query`
- `docs: add Phase 2.1 architecture diagram to wiki`
- `[Phase 2.1] execution schema migrations`

Commits are validated by `commitlint` on push.

---

## Architecture Constraints

Contributors must respect these constraints enforced by the AI Gatekeeper:

### Backend

- Controllers: HTTP routing, DTO validation, response formatting only. **No business logic.**
- Services: all business logic and database interaction.
- Authorization: ReBAC engine in `backend/src/auth/`. No module may bypass it.
- Every new endpoint needs: policy defined + resource registered + controller decorated.

### Frontend

- All components use Vue 3 `<script setup>`. Options API is forbidden.
- Shared state in Pinia stores at `frontend/src/stores/`.
- Vuetify 3 components before custom CSS.
- API calls only in composables or Pinia actions.
- Navigation via Vue Router only.

### Database

- Schema changes via migrations in `backend/db/migrations/`.
- Every migration must have a corresponding rollback step.
- RLS policies required on all new tenant-scoped tables.
- Never modify existing migration files — create a new migration instead.

---

## Adding New Dependencies

New production dependencies require:

1. A short justification in the PR description.
2. Human maintainer approval before merging.

Do not add new workflow engines, frameworks, ORMs, auth providers, observability vendors, UI libraries, or cloud services without an Architecture Decision Record (ADR).

---

## Documentation Changes

### Wiki Pages

Wiki content lives in `docs/wiki/`. To update:

1. Edit the relevant `.md` file in `docs/wiki/`.
2. Open a PR — the wiki sync workflow pushes the changes to the GitHub Wiki automatically on merge to `main`.

### ADRs

Architecture Decision Records live in `docs/adr/`. See [Architecture Decision Records](Architecture-Decision-Records) for the current index and the ADR template at `docs/adr/ADR-template.md`.

### Agent Governance Files

Files in `.github/agents/`, `.github/prompts/`, `AGENTS.md`, `CLAUDE.md`, and `.github/copilot-instructions.md` are agent governance files. Changes must be tracked through an approved `self-evolution` issue.

---

## Monorepo Structure

```
/
├── .agentic/
│   └── STATE.md                  # Hot memory — project save state
├── .github/
│   ├── copilot-instructions.md   # Copilot Workspace frontend rules
│   └── workflows/                # All GitHub Actions workflows
├── backend/                      # NestJS application
│   ├── src/                      # Source code
│   ├── db/migrations/            # Database migration SQL files
│   ├── docs/                     # Backend-specific documentation
│   ├── scripts/                  # Migration runner and utilities
│   └── test/                     # Integration / E2E tests
├── docs/
│   ├── adr/                      # Architecture Decision Records
│   ├── qa/                       # QA templates
│   ├── wiki/                     # GitHub Wiki source files (this directory)
│   └── PR_PREVIEWS.md            # PR preview runbook
├── frontend/                     # Vue 3 + Vuetify application
├── AGENTS.md                     # Agent operating contract
├── CLAUDE.md                     # Claude-specific rules
├── render.yaml                   # Render Blueprint
└── docker-compose.yml            # Local development
```

---

## Related Pages

- [Usage](Usage) — how the agent system works.
- [Architecture Overview](Architecture-Overview) — system design.
- [Architecture Decision Records](Architecture-Decision-Records) — rationale log.
- [Troubleshooting](Troubleshooting) — common issues.
