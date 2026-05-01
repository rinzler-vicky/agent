import { Injectable, Inject, NotFoundException, ConflictException } from '@nestjs/common';
import { Pool } from 'pg';
import { DATABASE_POOL } from '../database/database.module';

export interface Tenant {
  id: string;
  slug: string;
  display_name: string;
  plan: string;
  config: Record<string, any>;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
}

@Injectable()
export class TenantsService {
  constructor(@Inject(DATABASE_POOL) private readonly pool: Pool) {}

  async create(data: { slug: string; displayName: string; plan?: string }): Promise<Tenant> {
    try {
      const result = await this.pool.query<Tenant>(
        `INSERT INTO tenants (slug, display_name, plan)
         VALUES ($1, $2, $3)
         RETURNING *`,
        [data.slug, data.displayName, data.plan ?? 'free'],
      );
      return result.rows[0];
    } catch (err: unknown) {
      if (typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505') {
        throw new ConflictException(`Tenant slug '${data.slug}' already exists`);
      }
      throw err;
    }
  }

  async findAll(): Promise<Tenant[]> {
    const result = await this.pool.query<Tenant>(
      'SELECT * FROM tenants WHERE is_active = true ORDER BY created_at DESC',
    );
    return result.rows;
  }

  async findById(id: string): Promise<Tenant> {
    const result = await this.pool.query<Tenant>(
      'SELECT * FROM tenants WHERE id = $1',
      [id],
    );
    if (!result.rows[0]) throw new NotFoundException(`Tenant ${id} not found`);
    return result.rows[0];
  }

  async findBySlug(slug: string): Promise<Tenant> {
    const result = await this.pool.query<Tenant>(
      'SELECT * FROM tenants WHERE slug = $1',
      [slug],
    );
    if (!result.rows[0]) throw new NotFoundException(`Tenant '${slug}' not found`);
    return result.rows[0];
  }

  async update(id: string, data: Partial<{ displayName: string; plan: string; config: Record<string, any> }>): Promise<Tenant> {
    const sets: string[] = [];
    const values: any[] = [];
    let idx = 1;

    if (data.displayName !== undefined) { sets.push(`display_name = $${idx++}`); values.push(data.displayName); }
    if (data.plan !== undefined) { sets.push(`plan = $${idx++}`); values.push(data.plan); }
    if (data.config !== undefined) { sets.push(`config = $${idx++}`); values.push(data.config); }
    sets.push(`updated_at = now()`);
    values.push(id);

    const result = await this.pool.query<Tenant>(
      `UPDATE tenants SET ${sets.join(', ')} WHERE id = $${idx} RETURNING *`,
      values,
    );
    if (!result.rows[0]) throw new NotFoundException(`Tenant ${id} not found`);
    return result.rows[0];
  }

  async deactivate(id: string): Promise<void> {
    const result = await this.pool.query(
      'UPDATE tenants SET is_active = false, updated_at = now() WHERE id = $1',
      [id],
    );
    if (result.rowCount === 0) throw new NotFoundException(`Tenant ${id} not found`);
  }
}
