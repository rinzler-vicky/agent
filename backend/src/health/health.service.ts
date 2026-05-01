import { Injectable, Inject } from '@nestjs/common';
import { Pool } from 'pg';
import { DATABASE_POOL } from '../database/database.module';

@Injectable()
export class HealthService {
  constructor(@Inject(DATABASE_POOL) private readonly pool: Pool) {}

  async check() {
    const dbStatus = await this.checkDatabase();
    return {
      status: dbStatus ? 'ok' : 'degraded',
      timestamp: new Date().toISOString(),
      checks: {
        database: dbStatus ? 'ok' : 'error',
      },
    };
  }

  version() {
    return {
      name: 'agent-backend',
      version: process.env.npm_package_version ?? '0.1.0',
      phase: 1,
      timestamp: new Date().toISOString(),
    };
  }

  private async checkDatabase(): Promise<boolean> {
    try {
      const client = await this.pool.connect();
      await client.query('SELECT 1');
      client.release();
      return true;
    } catch {
      return false;
    }
  }
}
