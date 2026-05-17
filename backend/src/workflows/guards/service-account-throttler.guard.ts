import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';

/**
 * ThrottlerGuard subclass that keys per-route rate limits on the
 * authenticated service-account subject rather than the request IP.
 *
 * The default tracker hashes `req.ip`, which has two problems on the
 * proposal endpoint:
 *   1. A runaway agent can bypass the 30/min budget by rotating source
 *      IPs (cloud workers, NAT, etc.).
 *   2. Multiple tenants behind the same NAT throttle each other.
 *
 * Keying on `req.user.sub` (the service-account id from the JWT) gives
 * each service account its own bucket and is exactly the entity Phase 5
 * will replace with adaptive per-actor budgets.
 *
 * Falls back to IP when `req.user` is absent — the guard chain should
 * normally have run `JwtAuthGuard` first, so this fallback only fires on
 * misconfiguration.
 */
@Injectable()
export class ServiceAccountThrottlerGuard extends ThrottlerGuard {
  protected async getTracker(req: Record<string, any>): Promise<string> {
    const sub: string | undefined = req?.user?.sub;
    if (sub) return `sa:${sub}`;
    const tenantId: string | undefined = req?.user?.tenantId;
    if (tenantId) return `tenant:${tenantId}`;
    return req?.ip ?? 'anonymous';
  }
}
