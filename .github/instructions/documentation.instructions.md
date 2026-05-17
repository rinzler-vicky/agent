---
applyTo: "docs/wiki/**/*.md"
---

# Documentation path instructions

The `docs/wiki/` directory is the source of truth for all user and contributor-facing documentation. Changes to wiki pages automatically sync to the GitHub Wiki via `.github/workflows/sync-wiki.yml` when merged to `main`.

## When to update wiki pages

Update the relevant wiki page(s) whenever you:

- Add, modify, or remove API endpoints or request/response schemas
- Change environment variable names, defaults, or validation rules
- Update installation steps, secret configuration, or deployment procedures
- Modify workflow triggers, inputs, outputs, or failure behaviors
- Change database schema, migrations, or RLS policies
- Add, remove, or alter architectural layers, tech stack components, or module boundaries
- Update PR preview environment lifecycle, Render Blueprint config, or Neon branching behavior
- Fix bugs that have troubleshooting implications
- Change testing, linting, build, or commit conventions
- Create or update Architecture Decision Records (ADRs)
- Modify agent governance rules, prompt workflows, or self-evolution procedures

## Wiki page mapping

| Wiki Page | Update when you change... |
|-----------|---------------------------|
| `Home.md` | Navigation links, quick-start steps, high-level system diagram |
| `Installation.md` | Secrets, labels, Render/Neon setup, env var names/defaults |
| `Usage.md` | Issue templates, agent triggers, PR lifecycle, memory files, architecture constraints |
| `Architecture-Overview.md` | System layers, tech stack, multi-tenancy model, module structure, DB schema |
| `Contributing.md` | Issue/PR/commit guidelines, layer-specific rules, ADR process, monorepo structure |
| `Troubleshooting.md` | Agent failures, preview environment issues, database/migration errors, local dev problems |
| `PR-Preview-Environments.md` | Render Blueprint, Neon branching, per-PR lifecycle, reviewer workflows |
| `Workflow-Reference.md` | GitHub Actions workflows (triggers, steps, secrets, failure handling) |
| `Architecture-Decision-Records.md` | ADR index, new ADR entries, ADR metadata (status, date, participants) |

## Documentation quality standards

- Keep instructions concise and actionable.
- Use code blocks with language tags for commands, file paths, and config snippets.
- Include links to official docs for external services (Render, Neon, GitHub Actions).
- Add examples for complex config patterns or multi-step procedures.
- Update tables of contents or navigation links when adding sections.
- Preserve existing Markdown formatting conventions (headers, lists, code blocks).
- Test commands and paths before documenting them.
- Cross-reference related wiki pages when appropriate.
- Use relative links for intra-wiki references (`[[Page-Name]]` or `[Page Name](Page-Name.md)`).

## Sync workflow behavior

- Trigger: push to `main` when `docs/wiki/**` changes (or `workflow_dispatch`)
- Target: `<repo>.wiki.git` (GitHub Wiki repository)
- Operation: idempotent copy (no commit if no diff)
- Edits: all wiki edits go through PRs against `docs/wiki/`, not direct wiki edits

## What NOT to do

- Do not edit wiki pages directly via GitHub Wiki UI (changes will be overwritten).
- Do not duplicate content between wiki and `backend/docs/` or `docs/adr/` (cross-link instead).
- Do not add generated build artifacts, logs, or screenshots as separate files (embed or reference external assets).
- Do not use wiki pages for internal planning, scratch notes, or temp documentation (use `.agentic/STATE.md` or issue comments).
