import { Injectable, NestMiddleware } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { JwtPayload } from './auth.service';

declare global {
  namespace Express {
    interface Request {
      tenantId?: string;
      userId?: string;
    }
  }
}

@Injectable()
export class TenantMiddleware implements NestMiddleware {
  constructor(
    private readonly jwtService: JwtService,
    private readonly config: ConfigService,
  ) {}

  use(req: Request, res: Response, next: NextFunction) {
    // Try to extract tenant from JWT
    const authHeader = req.headers['authorization'];
    if (authHeader?.startsWith('Bearer ')) {
      try {
        const token = authHeader.slice(7);
        const payload = this.jwtService.verify(token, {
          secret: this.config.get<string>('JWT_SECRET', 'change-me-in-production'),
        }) as JwtPayload;
        req.tenantId = payload.tenantId;
        req.userId = payload.sub;
      } catch {
        // Token invalid or expired — middleware just skips; guards enforce auth
      }
    }

    // Also accept explicit tenant header only when processing API key auth (x-api-key present)
    // Trusting x-tenant-id from unauthenticated requests would allow cross-tenant access
    if (!req.tenantId && req.headers['x-tenant-id'] && req.headers['x-api-key']) {
      req.tenantId = req.headers['x-tenant-id'] as string;
    }

    next();
  }
}
