---
applyTo: "AGENTS.md,CLAUDE.md,.github/copilot-instructions.md,.github/prompts/**/*.md,.github/ISSUE_TEMPLATE/**/*.yml,.agent/**/*"
---

# Agent governance instructions

These files define how agents behave. Treat them like product code.

- Only modify through an approved self-evolution issue.
- Include before/after behavior, motivation, risk, tests, and rollback plan.
- Preserve compatibility with Codex, Copilot, Claude, and human maintainers.
- Prefer small, explicit rules over vague policy language.
- Add examples for any new workflow or prompt contract.
