import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import { createScheduler } from '../../src/checks/scheduler.js';
import { withUser } from '../../src/db.js';
import { createTeam, join, SERVICE, signUp, startApp, type TestApp } from './helpers.js';

let target: TestApp;
let owner: pg.Client;
beforeAll(async () => {
  target = await startApp();
  owner = new pg.Client({ connectionString: inject('ownerUrl') });
  await owner.connect();
});
afterAll(async () => {
  await owner.end();
  await target.close();
});
// Test files share one database. Pausing also cancels jobs left by earlier tests.
beforeEach(() => owner.query('UPDATE services SET enabled = false'));

async function setUp() {
  const user = await signUp(target);
  const team = await createTeam(user);
  const base = `/api/teams/${team.id}`;
  const created = await user.request('POST', `${base}/services`, SERVICE);
  const serviceId = created.body.service.id as string;
  const path = `${base}/services/${serviceId}`;
  return { user, team, base, serviceId, path };
}

const makeDue = (serviceId: string) =>
  owner.query('UPDATE services SET next_check_at = now() WHERE id = $1', [serviceId]);

const expireLeases = () =>
  owner.query(`UPDATE check_jobs SET leased_until = now() - interval '1 second'`);

async function schedule() {
  const { rows } = await target.db.query<{ created: number }>(
    'SELECT schedule_check_jobs(100) AS created',
  );
  return rows[0]!.created;
}

/** Does what a worker does: takes jobs without reporting results yet. */
async function lease() {
  const { rows } = await target.db.query<{ job_id: string }>(
    'SELECT job_id FROM lease_check_jobs(10, 60)',
  );
  return rows.map((row) => row.job_id);
}

async function complete(job: string, ok: boolean) {
  const { rows } = await target.db.query<{ recorded: boolean }>(
    'SELECT complete_check_job($1, $2, $3, 5, $4) AS recorded',
    [job, ok, ok ? 200 : 500, ok ? null : 'HTTP 500'],
  );
  return rows[0]!.recorded;
}

/** Waits until a query containing `text` is waiting for a lock. */
async function waitUntilBlocked(text: string) {
  const watcher = new pg.Client({ connectionString: inject('ownerUrl') });
  await watcher.connect();
  try {
    await expect
      .poll(async () => {
        const { rowCount } = await watcher.query(
          `SELECT 1 FROM pg_stat_activity
           WHERE datname = current_database() AND wait_event_type = 'Lock'
             AND strpos(query, $1) > 0`,
          [text],
        );
        return rowCount;
      })
      .toBe(1);
  } finally {
    await watcher.end();
  }
}

/** One full check of a service with a chosen outcome. */
async function checkOnce(serviceId: string, ok: boolean) {
  await makeDue(serviceId);
  await schedule();
  const [job] = await lease();
  expect(await complete(job!, ok)).toBe(true);
}

async function count(table: 'check_results' | 'check_jobs' | 'incidents', serviceId: string) {
  const { rows } = await owner.query<{ n: number }>(
    `SELECT count(*)::integer AS n FROM ${table} WHERE service_id = $1`,
    [serviceId],
  );
  return rows[0]!.n;
}

describe('check jobs', () => {
  it('hands an interrupted check out again, and records it once', async () => {
    const { serviceId } = await setUp();
    await schedule();
    const [abandoned] = await lease(); // this worker "dies"

    const survivor = createScheduler({
      db: target.db,
      probe: async () => ({ ok: true, statusCode: 200, latencyMs: 1, error: null }),
    });
    expect(await survivor.runBatch()).toBe(0); // still leased
    await expireLeases();
    expect(await survivor.runBatch()).toBe(1);

    // The first worker was only slow, and reports after all.
    expect(await complete(abandoned!, false)).toBe(false);
    expect(await count('check_results', serviceId)).toBe(1);
    expect(await count('check_jobs', serviceId)).toBe(0);
  });

  it('records a result delivered twice at the same time only once', async () => {
    const { serviceId } = await setUp();
    await schedule();
    const [job] = await lease();
    const outcomes = await Promise.all([complete(job!, false), complete(job!, false)]);
    expect(outcomes.sort()).toEqual([false, true]);
    expect(await count('check_results', serviceId)).toBe(1);
  });

  it('keeps at most one job per service, however overdue it is', async () => {
    const { serviceId } = await setUp();
    expect(await schedule()).toBe(1);
    await makeDue(serviceId);
    expect(await schedule()).toBe(0);
    expect(await count('check_jobs', serviceId)).toBe(1);
  });

  it('cancels the job when the service is paused or deleted', async () => {
    const paused = await setUp();
    const deleted = await setUp();
    await schedule();
    const jobs = await lease();
    expect(jobs).toHaveLength(2);

    await paused.user.request('PATCH', paused.path, { enabled: false });
    await deleted.user.request('DELETE', deleted.path);

    for (const job of jobs) expect(await complete(job, true)).toBe(false);
    expect(await count('check_results', paused.serviceId)).toBe(0);
  });

  it('does not deadlock when a result arrives during an edit', async () => {
    const { serviceId } = await setUp();
    await schedule();
    const [job] = await lease();

    // Hold the service the way an edit does, let the result queue behind it,
    // then change the URL, which cancels the job.
    await owner.query('BEGIN');
    await owner.query('SELECT 1 FROM services WHERE id = $1 FOR UPDATE', [serviceId]);
    const result = complete(job!, false);
    result.catch(() => {}); // asserted below
    await waitUntilBlocked('complete_check_job');
    await owner.query(`UPDATE services SET url = 'https://example.org/' WHERE id = $1`, [
      serviceId,
    ]);
    await owner.query('COMMIT');

    await expect(result).resolves.toBe(false);
  });

  it('is invisible to the application role', async () => {
    await expect(target.db.query('SELECT * FROM check_jobs')).rejects.toThrow(/permission denied/);
  });
});

describe('incidents', () => {
  it('opens after two failures in a row, once, and resolves on success', async () => {
    const { user, base, serviceId } = await setUp();
    const incidents = async () => (await user.request('GET', `${base}/incidents`)).body.incidents;

    await checkOnce(serviceId, false);
    expect(await incidents()).toEqual([]);
    await checkOnce(serviceId, false);
    await checkOnce(serviceId, false);
    expect(await incidents()).toEqual([
      {
        id: expect.any(String),
        serviceId,
        serviceName: SERVICE.name,
        openedAt: expect.any(String),
        resolvedAt: null,
        error: 'HTTP 500',
      },
    ]);

    await checkOnce(serviceId, true);
    expect((await incidents())[0].resolvedAt).toEqual(expect.any(String));

    await checkOnce(serviceId, false);
    await checkOnce(serviceId, false);
    const all = await incidents();
    expect(all).toHaveLength(2);
    expect(all[0].resolvedAt).toBeNull(); // open incidents come first
  });

  it('does not open for failures separated by a success', async () => {
    const { serviceId } = await setUp();
    for (const ok of [false, true, false, true]) await checkOnce(serviceId, ok);
    expect(await count('incidents', serviceId)).toBe(0);
  });

  it('is not opened twice by a repeated result', async () => {
    const { serviceId } = await setUp();
    await checkOnce(serviceId, false);
    await makeDue(serviceId);
    await schedule();
    const [job] = await lease();
    await Promise.all([complete(job!, false), complete(job!, false), complete(job!, false)]);
    expect(await count('incidents', serviceId)).toBe(1);
  });

  it('ends when the service is paused, and starts counting again afterwards', async () => {
    const { user, base, serviceId, path } = await setUp();
    await checkOnce(serviceId, false);
    await checkOnce(serviceId, false);
    await user.request('PATCH', path, { enabled: false });
    const list = await user.request('GET', `${base}/incidents`);
    expect(list.body.incidents[0].resolvedAt).toEqual(expect.any(String));

    await user.request('PATCH', path, { enabled: true });
    await checkOnce(serviceId, false);
    expect(await count('incidents', serviceId)).toBe(1);
  });

  it('is forgotten with the rest of the history when the URL changes', async () => {
    const { user, serviceId, path } = await setUp();
    await checkOnce(serviceId, false);
    await checkOnce(serviceId, false);
    await user.request('PATCH', path, { url: 'https://example.org/' });
    expect(await count('incidents', serviceId)).toBe(0);
  });

  it('is readable by the team and nobody else', async () => {
    const { user, team, base, serviceId } = await setUp();
    await checkOnce(serviceId, false);
    await checkOnce(serviceId, false);
    const member = await signUp(target);
    await join(user, member, team.id, 'member');
    const outsider = await signUp(target);

    expect((await member.request('GET', `${base}/incidents`)).body.incidents).toHaveLength(1);
    expect((await outsider.request('GET', `${base}/incidents`)).status).toBe(404);
    // Row-level security holds even without the API's role check.
    const seenBy = (userId: string) =>
      withUser(
        target.db,
        userId,
        async (tx) =>
          (await tx.query('SELECT 1 FROM incidents WHERE team_id = $1', [team.id])).rowCount,
      );
    expect(await seenBy(member.id)).toBe(1);
    expect(await seenBy(outsider.id)).toBe(0);
    await expect(
      withUser(target.db, user.id, (tx) => tx.query('DELETE FROM incidents')),
    ).rejects.toThrow(/permission denied/);
  });
});
