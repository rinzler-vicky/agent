import { Injectable, Inject, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Pool } from 'pg';
import * as bcrypt from 'bcrypt';
import { DATABASE_POOL } from '../database/database.module';

export interface JwtPayload {
  sub: string;
  email: string;
  tenantId: string;
  role: string;
  type: 'user' | 'service_account';
  scopes?: string[];
}

@Injectable()
export class AuthService {
  constructor(
    @Inject(DATABASE_POOL) private readonly pool: Pool,
    private readonly jwtService: JwtService,
  ) {}

  async validateUser(email: string, password: string, tenantSlug: string): Promise<any> {
    const result = await this.pool.query(
      `SELECT u.*, t.id as tenant_id, t.slug as tenant_slug
       FROM users u
       JOIN tenants t ON t.id = u.tenant_id
       WHERE u.email = $1 AND t.slug = $2 AND u.is_active = true`,
      [email, tenantSlug],
    );

    const user = result.rows[0];
    if (!user) throw new UnauthorizedException('Invalid credentials');

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) throw new UnauthorizedException('Invalid credentials');

    return user;
  }

  async login(user: any) {
    const payload: JwtPayload = {
      sub: user.id,
      email: user.email,
      tenantId: user.tenant_id,
      role: user.role,
      type: 'user',
    };
    return { access_token: this.jwtService.sign(payload) };
  }

  /**
   * Mint a JWT for a validated service account. Service-account JWTs carry
   * the `scopes` claim drawn from `service_accounts.scopes`; downstream
   * guards (e.g. ServiceAccountScopeGuard) gate routes on that claim.
   */
  async loginServiceAccount(sa: any) {
    const payload: JwtPayload = {
      sub: sa.id,
      email: sa.slug ?? sa.id,
      tenantId: sa.tenant_id,
      role: 'service',
      type: 'service_account',
      scopes: Array.isArray(sa.scopes) ? sa.scopes : [],
    };
    return { access_token: this.jwtService.sign(payload) };
  }

  async validateServiceAccount(apiKey: string): Promise<any> {
    // API keys are stored as "id.secret" format; use indexOf to allow dots in the secret
    const separatorIndex = apiKey.indexOf('.');
    if (separatorIndex === -1) throw new UnauthorizedException('Invalid API key');

    const id = apiKey.slice(0, separatorIndex);
    const secret = apiKey.slice(separatorIndex + 1);
    if (!id || !secret) throw new UnauthorizedException('Invalid API key');

    const result = await this.pool.query(
      `SELECT sa.*, t.id as tenant_id FROM service_accounts sa
       JOIN tenants t ON t.id = sa.tenant_id
       WHERE sa.id = $1 AND sa.is_active = true`,
      [id],
    );

    const sa = result.rows[0];
    if (!sa) throw new UnauthorizedException('Invalid API key');

    const valid = await bcrypt.compare(secret, sa.api_key_hash);
    if (!valid) throw new UnauthorizedException('Invalid API key');

    return sa;
  }
}
