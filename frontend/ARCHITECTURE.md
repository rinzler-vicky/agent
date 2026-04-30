# VUE 3 FRONTEND ARCHITECTURE: COLD CONSTRAINTS
This file defines the immutable constraints for the frontend domain. Reference it before modifying the Vue 3 application structure.

## Structural Boundaries
* **Components:** Must use Vue 3 `<script setup>` syntax exclusively. Options API is strictly forbidden.
* **State Management:** All shared state must be managed via Pinia stores located in `frontend/src/stores/`.
* **UI Components:** Utilize Vuetify 3 components. Do not invent custom CSS when a Vuetify utility class or component exists.
* **Composables:** Reusable logic must be extracted into composables located in `frontend/src/composables/`.

## API Integration Constraints
* Backend API contracts are immutable from the frontend perspective. Do not modify backend code to accommodate frontend needs.
* All API calls must be encapsulated within composables or Pinia store actions. Direct `fetch`/`axios` calls from components are forbidden.
* Use environment variables for API base URLs. Never hardcode endpoint URLs in components.

## Routing
* Vue Router is the sole routing mechanism. Do not use `window.location` for navigation.
* Route guards must enforce authentication state from the Pinia auth store before allowing access to protected routes.
