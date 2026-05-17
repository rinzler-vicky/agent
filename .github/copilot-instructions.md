# GitHub Copilot Repository Instructions

Follow `AGENTS.md` first. This repository uses issues as executable specifications. Do not implement beyond the issue scope.

## Mandatory behavior

- Read the parent issue and all linked child issues before coding.
- Confirm whether the issue is in Discovery, Architecture Review, Implementation, QA, or Done.
- If architecture is not approved for a new feature, schema change, workflow change, integration, auth/security change, or dependency addition, produce a plan and stop.
- Keep changes minimal and phase-scoped.
- Run and report relevant checks. Never say a check passed unless you ran it.
- Update docs, tests, and decision records when behavior changes.
- **Update `docs/wiki/**` pages** when changes affect installation, usage, architecture, troubleshooting, workflows, PR previews, ADRs, or contributing guidelines. The wiki is the source of truth for user and contributor documentation.
- Record trial/errors and learnings in the PR body.

## Preferred response structure for coding tasks

1. Understanding
2. Repo observations
3. Plan
4. Implementation summary
5. Validation performed
6. Risks and follow-ups

## Prohibited

- No hidden prompt/workflow changes.
- No broad rewrites without approval.
- No new dependencies without justification and approval.
- No generated secrets or placeholder production credentials.
