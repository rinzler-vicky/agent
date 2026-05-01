#!/usr/bin/env node
/**
 * Simple migration runner for Phase 1 SQL migrations.
 * Usage: node scripts/migrate.js up | down
 */
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const migrationsDir = path.join(__dirname, '..', 'db', 'migrations');

async function run() {
  const direction = process.argv[2] ?? 'up';
  const client = await pool.connect();

  try {
    // Create migrations tracking table
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    if (direction === 'up') {
      const files = fs.readdirSync(migrationsDir)
        .filter(f => f.endsWith('.sql') && !f.startsWith('006_'))
        .sort();

      for (const file of files) {
        const { rows } = await client.query(
          'SELECT 1 FROM schema_migrations WHERE filename = $1', [file]
        );
        if (rows.length > 0) {
          console.log(`  ⏭  Skipping ${file} (already applied)`);
          continue;
        }
        console.log(`  ▶  Applying ${file}...`);
        const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations(filename) VALUES($1)', [file]);
        console.log(`  ✓  Applied ${file}`);
      }
    } else if (direction === 'down') {
      console.log('  ▼  Running down migration...');
      const sql = fs.readFileSync(path.join(migrationsDir, '006_down.sql'), 'utf8');
      await client.query(sql);
      await client.query('DELETE FROM schema_migrations');
      console.log('  ✓  Down migration complete');
    } else {
      console.error('Usage: node scripts/migrate.js up | down');
      process.exit(1);
    }
  } finally {
    client.release();
    await pool.end();
  }
}

run().catch(err => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});
