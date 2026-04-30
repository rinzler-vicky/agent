# NESTJS BACKEND ARCHITECTURE: COLD CONSTRAINTS
This file defines the immutable constraints for the backend domain. Reference it before modifying the NestJS application structure.

## Structural Boundaries
* **Controllers:** MUST NOT contain business logic. They handle HTTP routing, DTO validation, and response formatting.
* **Services:** MUST handle all business logic and persistence layer interaction.
* **Data Access:** Direct database queries from controllers are strictly forbidden.

## Authorization Engine Constraints (ReBAC)
The backend utilizes a granular Role and Resource-Based Access Control (ReBAC) engine powered by Oso/Cerbos. The policy engine is isolated in `backend/src/auth/`. No other module may directly query user roles from the database to make authorization decisions.

When creating a new entity or endpoint, you must define the specific action policy, register the resource, and decorate the controller endpoint to enforce the ReBAC check. Write comprehensive unit tests proving unauthorized access is rejected.
