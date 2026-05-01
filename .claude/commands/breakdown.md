---
description: Break down a master goal issue into phased child issues.
argument-hint: "<issue-url-or-number>"
---

Read `AGENTS.md` and `.github/prompts/breakdown-master-goal.prompt.md`.

For issue `$ARGUMENTS`:

1. Read the issue and relevant repo files.
2. Produce a phase-wise plan.
3. Produce child issue bodies.
4. Produce JSON conforming to `.agent/schemas/phase-plan.schema.json`.
5. Stop for human architecture confirmation before implementation.
