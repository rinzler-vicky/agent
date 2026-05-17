---
applyTo: "**/{api,server,backend,src}/**/*.{ts,tsx,js,jsx,py,go,rs,java,cs}"
---

# Backend path instructions

- Keep route/controller code thin.
- Validate all external inputs.
- Keep domain logic in services/modules with unit tests.
- Add or update migrations for schema changes.
- Add integration tests for persistence, queues, workflow execution, and external adapters.
- Document env vars and config defaults.
- Ensure idempotency for retries and workflow tasks.
- **Update `docs/wiki/Architecture-Overview.md`** when adding/changing modules, layers, or DB schema.
- **Update `docs/wiki/Installation.md`** when adding/changing environment variables.
- **Update `docs/wiki/Troubleshooting.md`** when adding error handling or failure modes.
