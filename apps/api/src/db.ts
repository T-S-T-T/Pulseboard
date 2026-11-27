import pg from 'pg';

export type Db = pg.Pool;
export type Tx = pg.PoolClient;

export function createPool(connectionString: string): Db {
  const pool = new pg.Pool({
    connectionString,
    max: 10,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 10_000,
  });
  // An idle client erroring (e.g. database restart) must not crash the process.
  pool.on('error', (error) => console.error('Idle database connection failed:', error.message));
  return pool;
}

/**
 * Runs `fn` in a transaction scoped to one user. Row-level security policies read
 * app.user_id; `set_config(..., true)` discards it when the transaction ends, so
 * it cannot leak to the next request that borrows this connection.
 */
export async function withUser<T>(db: Db, userId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const client = await db.connect();
  let broken = false;
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.user_id', $1, true)`, [userId]);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {
      broken = true;
    });
    throw error;
  } finally {
    client.release(broken);
  }
}
