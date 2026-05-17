# Repository Learnings

Agents may append concise, factual learnings here only when they are supported by merged work or approved decisions.

Format:

```markdown
## YYYY-MM-DD — <topic>

- Context:
- Learning:
- Evidence:
- Affected files/patterns:
```

Do not store secrets, speculation, private data, or unresolved architecture debates here.

## 2026-05-17 — Swagger annotations as an explicit governance rule

- Context: PR #61 added a new NestJS controller route (`POST /v1/n8n/webhooks/execution`) without `@ApiTags` / `@ApiOperation`, so the endpoint did not appear in `/api/docs` and the gap was only caught in human review.
- Learning: Treat OpenAPI annotations as first-class API documentation. Any new/modified `*.controller.ts` must include `@ApiTags(...)` on the class and `@ApiOperation(...)` on every HTTP-verb handler; enforce it with a script + pre-commit + CI backstop + in-session hook.
- Evidence: PR #61 commit `838f0c1` (missing Swagger) and fix commit `9283202` (adds `backend/scripts/check-swagger.js`, `.husky/pre-commit`, `.github/workflows/swagger-check.yml`, `.claude/hooks/check-swagger-on-edit.cjs`).
- Affected files/patterns: `backend/src/**/*.controller.ts`, `@nestjs/swagger` decorators, `pnpm --filter @agent/backend check:swagger`.
