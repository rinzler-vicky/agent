import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { ServiceAccountScopeGuard } from './service-account-scope.guard';

const makeCtx = (user: any): ExecutionContext =>
  ({
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  }) as unknown as ExecutionContext;

describe('ServiceAccountScopeGuard', () => {
  it('admits a service_account JWT whose scopes contain the required scope', () => {
    const Guard = ServiceAccountScopeGuard('workflows:propose');
    const guard = new Guard();
    expect(
      guard.canActivate(
        makeCtx({ type: 'service_account', scopes: ['workflows:propose', 'tools:invoke'] }),
      ),
    ).toBe(true);
  });

  it('rejects when req.user is missing (defense in depth — JwtAuthGuard normally fills this)', () => {
    const Guard = ServiceAccountScopeGuard('workflows:propose');
    const guard = new Guard();
    expect(() => guard.canActivate(makeCtx(undefined))).toThrow(ForbiddenException);
  });

  it('rejects user-type tokens with 403 (per #44 AC)', () => {
    const Guard = ServiceAccountScopeGuard('workflows:propose');
    const guard = new Guard();
    expect(() =>
      guard.canActivate(makeCtx({ type: 'user', scopes: ['workflows:propose'] })),
    ).toThrow(ForbiddenException);
  });

  it('rejects service_account tokens missing the required scope', () => {
    const Guard = ServiceAccountScopeGuard('workflows:propose');
    const guard = new Guard();
    expect(() =>
      guard.canActivate(makeCtx({ type: 'service_account', scopes: ['tools:invoke'] })),
    ).toThrow(ForbiddenException);
  });

  it('rejects when scopes is absent / not an array', () => {
    const Guard = ServiceAccountScopeGuard('workflows:propose');
    const guard = new Guard();
    expect(() =>
      guard.canActivate(makeCtx({ type: 'service_account' })),
    ).toThrow(ForbiddenException);
  });
});
