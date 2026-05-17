import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Type,
  mixin,
} from '@nestjs/common';

/**
 * Factory producing a guard that admits only service-account JWTs carrying
 * a specific scope. Use after `JwtAuthGuard` in the guard chain, e.g.:
 *
 *   @UseGuards(JwtAuthGuard, ServiceAccountScopeGuard('workflows:propose'))
 *
 * The 403 (not 401) is intentional: the issue spec says reject user-type
 * tokens with 403 — they are authenticated, just not authorized for the
 * agent-facing route. Same for missing-scope.
 */
export const ServiceAccountScopeGuard = (requiredScope: string): Type<CanActivate> => {
  @Injectable()
  class Mixin implements CanActivate {
    canActivate(context: ExecutionContext): boolean {
      const req = context.switchToHttp().getRequest();
      const user = req.user;
      if (!user) {
        // JwtAuthGuard should have populated req.user; if it didn't, fail
        // closed rather than letting an unauthenticated caller through.
        throw new ForbiddenException('authentication required');
      }
      if (user.type !== 'service_account') {
        throw new ForbiddenException(
          'this route is only callable by service accounts; user-type tokens are rejected',
        );
      }
      const scopes: string[] = Array.isArray(user.scopes) ? user.scopes : [];
      if (!scopes.includes(requiredScope)) {
        throw new ForbiddenException(`missing required scope: ${requiredScope}`);
      }
      return true;
    }
  }
  return mixin(Mixin);
};
