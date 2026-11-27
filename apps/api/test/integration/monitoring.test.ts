import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import pg from 'pg';
import { inject } from 'vitest';
import { createScheduler } from '../../src/checks/scheduler.js';
import { createTeam, SERVICE, signUp, startApp, type TestApp } from './helpers.js';

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
// Test files share one database. Park services created by earlier tests.
beforeEach(() => owner.query('UPDATE services SET enabled = false'));

const down = async () => ({
  ok: false,
  statusCode: 500,
  latencyMs: 12,
  error: 'HTTP 500',
});

const makeDue = (serviceId: string) =>
  owner.query('UPDATE services SET next_check_at = now() WHERE id = $1', [serviceId]);

/** Does what a worker does: takes a job without reporting a result yet. */
async function lease() {
  await target.db.query('SELECT schedule_check_jobs(100)');
  const { rows } = await target.db.query<{ job_id: string }>(
    'SELECT job_id FROM lease_check_jobs(10, 60)',
  );
  return rows[0]?.job_id;
}

async function complete(job: string, ok: boolean) {
  const { rows } = await target.db.query<{ recorded: boolean }>(
    'SELECT complete_check_job($1, $2, $3, 5, $4) AS recorded',
    [job, ok, ok ? 200 : 500, ok ? null : 'HTTP 500'],
  );
  return rows[0]!.recorded;
}

async function setUp(extra: object = {}) {
  const user = await signUp(target);
  const team = await createTeam(user);
  const base = `/api/teams/${team.id}`;
  const created = await user.request('POST', `${base}/services`, { ...SERVICE, ...extra });
  return { user, team, base, service: created.body.service };
}

describe('services', () => {
  it.each([
    'http://localhost/',
    'http://127.0.0.1/',
    'http://2130706433/',
    'http://169.254.169.254/latest/meta-data',
    'http://[::1]/',
    'http://db:5432/',
    'ftp://example.com/',
    'https://user:pass@example.com/',
    'https://example.com:22/',
    'not a url',
  ])('refuses to monitor %s', async (url) => {
    const { user, base, service } = await setUp();
    expect((await user.request('POST', `${base}/services`, { name: 'x', url })).status).toBe(400);
    const update = await user.request('PATCH', `${base}/services/${service.id}`, { url });
    expect(update.status).toBe(400);
  });

  it('changes only the fields that are sent', async () => {
    const { user, base, service } = await setUp({ method: 'HEAD', intervalSeconds: 600 });
    const response = await user.request('PATCH', `${base}/services/${service.id}`, {
      name: 'Renamed',
    });
    expect(response.body.service).toMatchObject({
      name: 'Renamed',
      method: 'HEAD',
      intervalSeconds: 600,
    });
  });

  it('enforces bounds and the per-team limit', async () => {
    const { user, base } = await setUp();
    const fast = await user.request('POST', `${base}/services`, {
      ...SERVICE,
      intervalSeconds: 1,
    });
    expect(fast.status).toBe(400);
    for (let i = 1; i < 20; i++) await user.request('POST', `${base}/services`, SERVICE);
    expect((await user.request('POST', `${base}/services`, SERVICE)).status).toBe(409);
  });
});

describe('scheduler', () => {
  it('checks due services once per interval and records the result', async () => {
    const { user, base, service } = await setUp();
    const scheduler = createScheduler({ db: target.db, probe: down });
    expect(await scheduler.runBatch()).toBe(1);
    expect(await scheduler.runBatch()).toBe(0);

    const list = await user.request('GET', `${base}/services`);
    expect(list.body.services[0]).toMatchObject({
      id: service.id,
      lastOk: false,
      lastStatusCode: 500,
      lastError: 'HTTP 500',
    });
    expect(list.body.services[0].recentChecks).toHaveLength(1);
  });

  it('never gives one service to two schedulers', async () => {
    for (let i = 0; i < 4; i++) await setUp();
    let calls = 0;
    const counting = async () => {
      calls++;
      return down();
    };
    const a = createScheduler({ db: target.db, probe: counting });
    const b = createScheduler({ db: target.db, probe: counting });
    await Promise.all([a.runBatch(), b.runBatch()]);
    expect(calls).toBe(4);
  });

  it('records a blocked check when a public name resolves to a private address', async () => {
    // localtest-style names pass the static check; only DNS reveals the target.
    const { user, base, service } = await setUp({ url: 'http://private.example.com/' });
    const { probe } = await import('../../src/checks/probe.js');
    const { publicPolicy } = await import('../../src/security/ssrf.js');
    const scheduler = createScheduler({
      db: target.db,
      probe: (request) =>
        probe(request, {
          ...publicPolicy,
          resolve: async () => [{ address: '10.0.0.5', family: 4 }],
        }),
    });
    await scheduler.runBatch();
    const list = await user.request('GET', `${base}/services`);
    expect(list.body.services[0]).toMatchObject({
      id: service.id,
      lastOk: false,
      lastError: 'Blocked: Hostname resolves to a non-public address',
    });
  });

  it('forgets history when the URL changes and drops the pending result', async () => {
    const { user, base, service } = await setUp();
    await createScheduler({ db: target.db, probe: down }).runBatch();
    await makeDue(service.id);
    const job = (await lease())!;
    const changed = await user.request('PATCH', `${base}/services/${service.id}`, {
      url: 'https://example.org/',
    });
    expect(changed.body.service).toMatchObject({ lastOk: null, recentChecks: [] });

    // A check of the old URL that finishes late.
    expect(await complete(job, true)).toBe(false);
    const list = await user.request('GET', `${base}/services`);
    expect(list.body.services[0].recentChecks).toEqual([]);
  });

  it('starts, checks and stops cleanly', async () => {
    await setUp();
    let checked!: () => void;
    const done = new Promise<void>((resolve) => (checked = resolve));
    const errors: unknown[] = [];
    const scheduler = createScheduler({
      db: target.db,
      pollMs: 10,
      probe: async () => {
        checked();
        return down();
      },
      onError: (error) => errors.push(error),
    });
    scheduler.start();
    await done;
    await scheduler.stop();
    expect(errors).toEqual([]);
  });

  it('purges old results', async () => {
    const { service } = await setUp();
    await createScheduler({ db: target.db, probe: down }).runBatch();
    await owner.query(
      `UPDATE check_results SET checked_at = now() - interval '40 days' WHERE service_id = $1`,
      [service.id],
    );
    await target.db.query('SELECT purge_expired(30)');
    const left = await owner.query('SELECT 1 FROM check_results WHERE service_id = $1', [
      service.id,
    ]);
    expect(left.rowCount).toBe(0);
  });
});

describe('public status page', () => {
  it('is private until published and shows only public services', async () => {
    const { user, team, base } = await setUp({ isPublic: true });
    await user.request('POST', `${base}/services`, {
      name: 'Internal admin',
      url: 'https://admin.example.com/secret',
    });
    await createScheduler({ db: target.db, probe: down }).runBatch();
    const read = () => target.app.inject({ url: `/api/status/${team.slug}` });

    expect((await read()).statusCode).toBe(404);
    await user.request('PATCH', base, { statusPageEnabled: true });

    const page = await read();
    expect(page.statusCode).toBe(200);
    expect(page.json().services).toEqual([
      {
        name: 'Website',
        ok: false,
        lastCheckedAt: expect.any(String),
        uptime24h: 0,
        recent: [{ ok: false, checkedAt: expect.any(String) }],
      },
    ]);
    expect(page.body).not.toMatch(/example\.com|Internal admin|HTTP 500/);
  });
});
