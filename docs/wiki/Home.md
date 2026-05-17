# Agent — Fully Autonomous Agentic Development

Welcome to the **Agent** wiki. This repository is built and maintained entirely by AI agents. The only human action required is opening a GitHub Issue describing what to build.

---

## Navigation

| Page | Description |
|------|-------------|
| [Installation](Installation) | Secrets, labels, and first-time setup |
| [Usage](Usage) | Writing issues, triggering agents, understanding the output |
| [Architecture Overview](Architecture-Overview) | System design, layers, and technology choices |
| [PR Preview Environments](PR-Preview-Environments) | Ephemeral preview deploys per pull request |
| [Workflow Reference](Workflow-Reference) | GitHub Actions workflows and triggers |
| [Workflow Control Plane](Workflow-Control-Plane) | HTTP API for the workflow lifecycle and agent-authored proposals |
| [Contributing](Contributing) | Commit style, PR guidelines, agent governance |
| [Troubleshooting](Troubleshooting) | Common problems and fixes |
| [Architecture Decision Records](Architecture-Decision-Records) | ADR index and rationale |

---

## Quick-Start

```
1. Add ANTHROPIC_API_KEY to repo Secrets (required).
2. Create the label `route: claude-backend` in the Labels page.
3. Open a GitHub Issue describing the feature.
4. Apply the label — the agent takes it from there.
```

For full details, see the [Installation](Installation) and [Usage](Usage) pages.

---

## How It Works

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

The entire cycle — scaffolding, coding, testing, linting, PR creation, and self-healing — happens without any human writing a single line of code.

---

## Repository Source Files

The raw source for all wiki pages lives in [`docs/wiki/`](https://github.com/rinzler-vicky/agent/tree/main/docs/wiki) in the main repository. A GitHub Actions workflow ([`.github/workflows/sync-wiki.yml`](https://github.com/rinzler-vicky/agent/blob/main/.github/workflows/sync-wiki.yml)) pushes those files to this wiki automatically on every merge to `main`.

To propose documentation changes, open a PR editing the files in `docs/wiki/`.
