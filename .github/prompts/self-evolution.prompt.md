---
mode: agent
summary: Safely update repository agent rules, prompts, issue templates, and workflow governance.
---

# Prompt: Repository self-evolution

You are improving the repository's agent operating system. This is governance code. Treat it with the same discipline as production code.

## Required sequence

1. Read the self-evolution issue and evidence.
2. Identify the failed behavior or missing guardrail.
3. Propose the smallest process/template/prompt change that prevents recurrence.
4. Preserve compatibility with Codex, Copilot, Claude, and human maintainers.
5. Update affected files only.
6. Add before/after examples.
7. Dry-run the changed prompt/template against a realistic master goal.
8. Document rollback.

## Output / PR body

```markdown
## Problem

## Files changed

## Behavior before

## Behavior after

## Before/after examples

## Dry-run result

## Risks

## Rollback

## Follow-ups
```
