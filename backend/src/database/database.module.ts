import { Module, Global } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';

export const DATABASE_POOL = 'DATABASE_POOL';

@Global()
@Module({
  providers: [
    {
      provide: DATABASE_POOL,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        return new Pool({
          connectionString: config.get<string>('DATABASE_URL'),
          max: config.get<number>('DB_POOL_MAX', 10),
          idleTimeoutMillis: 30000,
          connectionTimeoutMillis: 5000,
          // DATABASE_SSL_REJECT_UNAUTHORIZED defaults to true (validates the cert).
          // Set to 'false' only for Neon/Supabase which use self-signed certs on pooler endpoints.
          ssl: config.get<string>('DATABASE_SSL') === 'true'
            ? { rejectUnauthorized: config.get<string>('DATABASE_SSL_REJECT_UNAUTHORIZED', 'true') !== 'false' }
            : false,
        });
      },
    },
  ],
  exports: [DATABASE_POOL],
})
export class DatabaseModule {}
