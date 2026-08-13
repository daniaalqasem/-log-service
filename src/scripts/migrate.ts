import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Pool } from 'pg';

async function connectWithRetry(pool: Pool, maxAttempts = 10): Promise<void> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await pool.query('SELECT 1');
      return;
    } catch (error) {
      console.log(`DB not ready yet (attempt ${attempt}/${maxAttempts}), retrying in 2s...`);
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
  throw new Error('Could not connect to database after multiple attempts');
}

async function runMigrations() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  await connectWithRetry(pool);
  const migrationsDir = join(__dirname, '..', 'db', 'migrations');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS __migrations_applied (
      name TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  for (const file of files) {
    const { rows } = await pool.query(
      'SELECT 1 FROM __migrations_applied WHERE name = $1',
      [file]
    );
    if (rows.length > 0) continue;

    const sql = readFileSync(join(migrationsDir, file), 'utf-8');
    await pool.query(sql);
    await pool.query('INSERT INTO __migrations_applied (name) VALUES ($1)', [file]);
    console.log(`Applied migration: ${file}`);
  }

  await pool.end();
}

runMigrations()
  .then(() => {
    console.log('Migrations complete');
    process.exit(0);
  })
  .catch((error) => {
    console.error('Migration failed:', error);
    process.exit(1);
  });
