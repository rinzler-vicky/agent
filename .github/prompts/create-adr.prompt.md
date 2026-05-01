---
mode: agent
summary: Create an ADR from an approved architecture decision.
---

# Prompt: Create ADR

Use this prompt after architecture approval.

Create a new ADR in `docs/adr/ADR-<number>-<slug>.md` using `docs/adr/ADR-template.md`.

The ADR must include:

- Status
- Context
- Decision
- Options considered
- Consequences
- Security implications
- Operational implications
- Test strategy
- Rollback / migration strategy
- Follow-up issues

Do not implement code while creating the ADR unless the issue explicitly asks for documentation-only changes.
