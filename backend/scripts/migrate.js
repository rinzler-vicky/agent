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
      // Up migrations: any .sql file that does NOT end with '_down.sql'
      const files = fs.readdirSync(migrationsDir)
        .filter(f => f.endsWith('.sql') && !f.endsWith('_down.sql'))
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
      // Run rollback migrations in reverse order
      const rollbackFiles = ['013_rollback_down.sql', '012_rollback_phase_2_1_down.sql', '006_rollback_down.sql'];
      for (const file of rollbackFiles) {
        const filePath = path.join(migrationsDir, file);
        if (fs.existsSync(filePath)) {
          console.log(`  ▶  Running ${file}...`);
          const sql = fs.readFileSync(filePath, 'utf8');
          await client.query(sql);
          console.log(`  ✓  Completed ${file}`);
        }
      }
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
