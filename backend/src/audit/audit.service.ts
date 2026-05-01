import { Injectable, Inject } from '@nestjs/common';
import { Pool } from 'pg';
import { DATABASE_POOL } from '../database/database.module';

export interface AuditEventData {
  tenantId?: string;
  actorId?: string;
  actorType?: 'user' | 'service_account' | 'system';
  action: string;
  resourceType: string;
  resourceId?: string;
  beforeState?: Record<string, any>;
  afterState?: Record<string, any>;
  metadata?: Record<string, any>;
  ipAddress?: string;
  userAgent?: string;
}

@Injectable()
export class AuditService {
  constructor(@Inject(DATABASE_POOL) private readonly pool: Pool) {}

  async log(event: AuditEventData): Promise<void> {
    await this.pool.query(
      `INSERT INTO audit_events
         (tenant_id, actor_id, actor_type, action, resource_type, resource_id,
          before_state, after_state, metadata, ip_address, user_agent)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        event.tenantId ?? null,
        event.actorId ?? null,
        event.actorType ?? 'system',
        event.action,
        event.resourceType,
        event.resourceId ?? null,
        event.beforeState ? JSON.stringify(event.beforeState) : null,
        event.afterState ? JSON.stringify(event.afterState) : null,
        JSON.stringify(event.metadata ?? {}),
        event.ipAddress ?? null,
        event.userAgent ?? null,
      ],
    );
  }

  async query(filters: {
    tenantId?: string;
    actorId?: string;
    resourceType?: string;
    resourceId?: string;
    limit?: number;
    offset?: number;
  }) {
    const conditions: string[] = [];
    const values: any[] = [];
    let idx = 1;

    if (filters.tenantId) { conditions.push(`tenant_id = $${idx++}`); values.push(filters.tenantId); }
    if (filters.actorId) { conditions.push(`actor_id = $${idx++}`); values.push(filters.actorId); }
    if (filters.resourceType) { conditions.push(`resource_type = $${idx++}`); values.push(filters.resourceType); }
    if (filters.resourceId) { conditions.push(`resource_id = $${idx++}`); values.push(filters.resourceId); }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = filters.limit ?? 50;
    const offset = filters.offset ?? 0;

    const result = await this.pool.query(
      `SELECT * FROM audit_events ${where} ORDER BY occurred_at DESC LIMIT $${idx++} OFFSET $${idx}`,
      [...values, limit, offset],
    );
    return result.rows;
  }
}
