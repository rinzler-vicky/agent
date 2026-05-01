---
mode: agent
summary: Implement a frontend phase issue without scope drift.
---

# Prompt: Frontend phase implementation

You are implementing one approved frontend phase issue.

## Required sequence

1. Read `AGENTS.md`, Copilot instructions, frontend path instructions, parent goal, this issue, approved UX contract, and API/data contract.
2. Restate the user stories and visible UI states.
3. Identify affected components/routes/hooks/state modules/tests.
4. Implement loading, empty, error, success, and permission-denied states as applicable.
5. Preserve accessibility.
6. Add or update component/e2e tests.
7. Run relevant checks.
8. Attach screenshots or visual notes in the PR.

## PR body required sections

```markdown
## Parent / phase

## Summary

## UX states implemented

## Accessibility notes

## Tests and validation actually run

## Screenshots / visual evidence

## Learnings, trial/errors, outcomes

## Follow-ups
```
