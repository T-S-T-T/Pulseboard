/** Tenant isolation, checked both through the API and directly against RLS. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withUser } from '../../src/db.js';
import {
  createTeam,
  SERVICE,
  signUp,
  startApp,
  type SignedInUser,
  type TestApp,
} from './helpers.js';

let target: TestApp;
let alice: SignedInUser;
let mallory: SignedInUser;
let teamId: string;
let ownTeamId: string;
let serviceId: string;

beforeAll(async () => {
  target = await startApp();
  alice = await signUp(target, 'Alice');
  mallory = await signUp(target, 'Mallory');
  teamId = (await createTeam(alice, 'Alice Co')).id;
  ownTeamId = (await createTeam(mallory, 'Mallory Co')).id;
  const created = await alice.request('POST', `/api/teams/${teamId}/services`, SERVICE);
  serviceId = created.body.service.id;
  await target.db.query('SELECT record_check($1, $2, true, 200, 5, NULL)', [
    serviceId,
    SERVICE.url,
  ]);
});
afterAll(() => target.close());

describe('API isolation', () => {
  it('hides another team completely', async () => {
    const base = `/api/teams/${teamId}`;
    for (const url of [base, `${base}/services`]) {
      expect((await mallory.request('GET', url)).status).toBe(404);
    }
    expect((await mallory.request('POST', `${base}/services`, SERVICE)).status).toBe(404);
    expect((await mallory.request('DELETE', `${base}/services/${serviceId}`)).status).toBe(404);
    const list = await mallory.request('GET', '/api/teams');
    expect(list.body.teams.map((t: { id: string }) => t.id)).toEqual([ownTeamId]);
  });

  it('cannot reach a foreign service through its own team', async () => {
    const url = `/api/teams/${ownTeamId}/services/${serviceId}`;
    expect((await mallory.request('PATCH', url, { name: 'owned' })).status).toBe(404);
    expect((await mallory.request('DELETE', url)).status).toBe(404);
  });

  it('requires a session', async () => {
    const response = await target.app.inject({ url: `/api/teams/${teamId}/services` });
    expect(response.statusCode).toBe(401);
  });
});

describe('row-level security without any application checks', () => {
  const asMallory = <T>(sql: string, values: unknown[] = []) =>
    withUser(target.db, mallory.id, (tx) => tx.query(sql, values)) as Promise<T>;
  type Result = { rows: unknown[]; rowCount: number };

  it.each(['teams', 'memberships', 'services', 'check_results', 'invites'])(
    'filters %s to the current user',
    async (table) => {
      const column = table === 'teams' ? 'id' : 'team_id';
      const result = await asMallory<Result>(`SELECT * FROM ${table} WHERE ${column} = $1`, [
        teamId,
      ]);
      expect(result.rows).toEqual([]);
    },
  );

  it('shows nothing when no user is set', async () => {
    expect((await target.db.query('SELECT * FROM services')).rows).toEqual([]);
  });

  it('does not leak the user to the next query on a pooled connection', async () => {
    await withUser(target.db, alice.id, (tx) => tx.query('SELECT 1'));
    const results = await Promise.all(
      Array.from({ length: 20 }, () => target.db.query('SELECT * FROM teams')),
    );
    expect(results.every((r) => r.rows.length === 0)).toBe(true);
  });

  it('ignores updates and deletes aimed at another team', async () => {
    const update = await asMallory<Result>(`UPDATE services SET name = 'x' WHERE id = $1`, [
      serviceId,
    ]);
    const remove = await asMallory<Result>('DELETE FROM services WHERE id = $1', [serviceId]);
    expect([update.rowCount, remove.rowCount]).toEqual([0, 0]);
  });

  it('rejects inserts into another team', async () => {
    await expect(
      asMallory(`INSERT INTO services (team_id, name, url) VALUES ($1, 'x', $2)`, [
        teamId,
        SERVICE.url,
      ]),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('rejects moving a service into another team', async () => {
    await expect(asMallory('UPDATE services SET team_id = $1', [teamId])).rejects.toMatchObject({
      code: '42501',
    });
  });

  it.each([
    'SELECT * FROM users',
    'SELECT * FROM sessions',
    'SELECT * FROM user_identities',
    'SELECT * FROM schema_migrations',
    `INSERT INTO memberships (team_id, user_id, role) VALUES (gen_random_uuid(), gen_random_uuid(), 'owner')`,
    'UPDATE services SET last_ok = true',
    'DELETE FROM check_results',
    `UPDATE teams SET slug = 'taken'`,
    'CREATE TABLE sneaky (id int)',
  ])('denies: %s', async (sql) => {
    await expect(asMallory(sql)).rejects.toMatchObject({ code: '42501' });
  });

  it('returns no members for another team', async () => {
    const result = await asMallory<Result>('SELECT * FROM list_team_members($1)', [teamId]);
    expect(result.rows).toEqual([]);
  });
});
