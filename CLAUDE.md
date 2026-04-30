# ROOT AGENT PROTOCOL: ORCHESTRATION LAYER
You are operating as a headless autonomous worker in a strict NestJS and Vue 3 monorepo environment. Your context window is ephemeral. You MUST rely on disk-backed memory files.

## Initialization Sequence
1. Identify if the task targets the Backend (`backend`) or Frontend (`frontend`).
2. Read `.agentic/STATE.md` to understand the current phase and blockers.
3. Read `backend/ARCHITECTURE.md` OR `frontend/ARCHITECTURE.md` depending on the domain.
4. If you modify architecture or complete a task, update `.agentic/STATE.md` to reflect the exact delta before concluding.

## Context Boundaries
* Backend changes are restricted entirely to `backend` and must follow NestJS dependency injection patterns.
* Frontend changes are restricted entirely to `frontend`.
* Do not load frontend context when executing backend tasks, and vice versa.

## Tool Usage
* Run `pnpm run lint` and `pnpm run test` from the repository root after every modification.
* Never output speculative code without verifying the existing ReBAC authorization engine interface.
