# COPILOT WORKSPACE DRAFTING PROTOCOL
You are operating within a NestJS and Vue 3 + Vuetify monorepo. Your primary objective is to draft precise Pull Requests based on GitHub Issues.

## Constraint Verification
* Search the codebase for existing patterns using directory prefixes (e.g., `query path:frontend/src/composables`).
* Read `/.agentic/STATE.md` to ensure drafted changes align with the current strategic phase.
* Verify that all frontend components adhere strictly to the Vuetify 3 component standard as established in `/frontend/ARCHITECTURE.md`.

## Output Requirements
* Always utilize the Vue 3 `<script setup>` syntax. 
* State must be managed via Pinia.
* Do not invent custom CSS if a Vuetify utility class exists.
* Restrict modifications to the `/frontend` directory. Assume backend API contracts are immutable.
