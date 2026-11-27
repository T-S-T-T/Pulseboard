import { readdir, readFile } from 'node:fs/promises';
import pg from 'pg';

const MIGRATIONS_DIR = new URL('../migrations/', import.meta.url);
const LOCK_ID = 727_274;

export interface MigrateOptions {
  /** Connection string for the schema owner. */
  ownerUrl: string;
  /** If given, sets the password of the pulseboard_app login role. */
  appPassword?: string;
}

export async function migrate({ ownerUrl, appPassword }: MigrateOptions): Promise<string[]> {
  const client = new pg.Client({ connectionString: ownerUrl });
  await client.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_ID]);
    await client.query(`
      DO $$ BEGIN
        CREATE ROLE pulseboard_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
      EXCEPTION WHEN duplicate_object OR unique_violation THEN NULL;
      END $$`);
    if (appPassword) {
      await client.query(`ALTER ROLE pulseboard_app PASSWORD ${client.escapeLiteral(appPassword)}`);
    }
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`);

    const done = new Set(
      (await client.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map(
        (row) => row.name,
      ),
    );
    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
    const applied: string[] = [];

    for (const file of files) {
      if (done.has(file)) continue;
      const sql = await readFile(new URL(file, MIGRATIONS_DIR), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
      applied.push(file);
    }
    return applied;
  } finally {
    // Closing the connection also releases the advisory lock.
    await client.end();
  }
}
