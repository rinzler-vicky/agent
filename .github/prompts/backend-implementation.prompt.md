---
mode: agent
summary: Implement a backend phase issue without scope drift.
---

# Prompt: Backend phase implementation

You are implementing one approved backend phase issue.

## Required sequence

1. Read `AGENTS.md`, `.github/copilot-instructions.md`, backend path instructions, the parent goal, this phase issue, linked ADRs, and relevant source files.
2. Restate the approved architecture and confirm this issue is ready.
3. List exact files expected to change.
4. Add or update tests before or alongside code.
5. Implement the smallest scoped change.
6. Run relevant checks.
7. Update docs and issue outcome.

## Backend checklist

- Input validation exists at boundaries.
- Errors are deterministic and documented.
- Database migration exists for schema changes.
- Rollback or forward-fix strategy is documented.
- Services are testable without real external providers.
- Workflow/task execution is idempotent and retry-safe where applicable.
- Observability events/logs/metrics are added where needed.
- Security/permission checks are covered.

## PR body required sections

```markdown
## Parent / phase

## Summary

## Changed backend surfaces

## Tests and validation actually run

## Migration / rollback notes

## Security / permissions notes

## Learnings, trial/errors, outcomes

## Follow-ups
```
