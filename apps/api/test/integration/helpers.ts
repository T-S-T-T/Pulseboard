import { randomBytes } from 'node:crypto';
import { inject } from 'vitest';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { createPool } from '../../src/db.js';

export const APP_URL = 'http://localhost:3000';

export async function startApp(env: Record<string, string> = {}) {
  const config = loadConfig({
    DATABASE_URL: inject('appUrl'),
    APP_URL,
    LOG_LEVEL: 'silent',
    AUTH_RATE_LIMIT: '1000',
    ...env,
  });
  const db = createPool(config.DATABASE_URL);
  const app = await buildApp({ config, db });
  await app.ready();
  return {
    app,
    db,
    async close() {
      await app.close();
      await db.end();
    },
  };
}

export type TestApp = Awaited<ReturnType<typeof startApp>>;

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';

/** A signed-in browser: remembers its session cookie. */
export function client(target: TestApp) {
  const jar: Record<string, string> = {};
  return {
    jar,
    async request(method: Method, url: string, body?: object) {
      const response = await target.app.inject({
        method,
        url,
        cookies: jar,
        headers: { origin: APP_URL },
        ...(body ? { payload: body } : {}),
      });
      for (const c of response.cookies) {
        if (c.value) jar[c.name] = c.value;
        else delete jar[c.name];
      }
      return {
        status: response.statusCode,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        body: (response.body ? response.json() : undefined) as any,
      };
    },
  };
}

export async function signUp(target: TestApp, name = 'Test User') {
  const user = client(target);
  const email = `${randomBytes(6).toString('hex')}@example.com`;
  const password = 'correct horse battery';
  const response = await user.request('POST', '/api/auth/register', { email, name, password });
  if (response.status !== 201) throw new Error(`Sign-up failed: ${response.status}`);
  return { ...user, id: response.body.user.id as string, email, password };
}

export type SignedInUser = Awaited<ReturnType<typeof signUp>>;

export async function createTeam(user: SignedInUser, name = 'Platform') {
  const response = await user.request('POST', '/api/teams', { name });
  if (response.status !== 201) throw new Error(`Team creation failed: ${response.status}`);
  return response.body.team as { id: string; slug: string };
}

/** Adds `joiner` to a team through a real invite. */
export async function join(
  inviter: SignedInUser,
  joiner: SignedInUser,
  teamId: string,
  role: 'admin' | 'member',
) {
  const token = await invite(inviter, teamId, role);
  const response = await joiner.request('POST', '/api/invites/accept', { token });
  if (response.status !== 200) throw new Error(`Join failed: ${response.status}`);
}

export async function invite(inviter: SignedInUser, teamId: string, role: 'admin' | 'member') {
  const response = await inviter.request('POST', `/api/teams/${teamId}/invites`, { role });
  if (response.status !== 201) throw new Error(`Invite failed: ${response.status}`);
  return (response.body.url as string).split('#')[1]!;
}

export const SERVICE = { name: 'Website', url: 'https://example.com/health' };
