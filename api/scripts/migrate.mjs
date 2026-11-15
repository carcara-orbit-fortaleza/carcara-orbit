import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';

const { Client } = pg;

function databaseUrl() {
  const explicit = process.env.DATABASE_URL?.trim();
  if (explicit) return explicit;

  const user = process.env.DB_USER?.trim();
  const password = process.env.DB_PASSWORD;
  const name = process.env.DB_NAME?.trim();
  if (!user || !password || !name) return null;

  const host = process.env.DB_HOST?.trim() || 'db';
  const port = process.env.DB_PORT?.trim() || '5432';
  const encodedUser = encodeURIComponent(user);
  const encodedPassword = encodeURIComponent(password);
  return `postgresql://${encodedUser}:${encodedPassword}@${host}:${port}/${name}`;
}

const url = databaseUrl();
if (!url) {
  console.error(
    'DATABASE_URL (or DB_USER/DB_PASSWORD/DB_NAME) is required to run migrations.',
  );
  process.exit(1);
}

const migrationsDir = join(process.cwd(), 'db', 'migrations');
const files = readdirSync(migrationsDir)
  .filter((file) => file.endsWith('.sql'))
  .sort();

const client = new Client({ connectionString: url });

try {
  await client.connect();
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  const { rows } = await client.query('SELECT version FROM schema_migrations');
  const applied = new Set(rows.map((row) => row.version));

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = readFileSync(join(migrationsDir, file), 'utf8');

    await client.query('BEGIN');
    try {
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [file]);
      await client.query('COMMIT');
      console.log(`Applied migration ${file}`);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  }

  console.log(`Database is up to date (${files.length} migration(s)).`);
} finally {
  await client.end().catch(() => undefined);
}
