import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { client, signUp, startApp, type TestApp } from './helpers.js';

let target: TestApp;
beforeAll(async () => {
  target = await startApp();
});
afterAll(() => target.close());

describe('accounts and sessions', () => {
  it('signs up, signs out and signs in again', async () => {
    const user = await signUp(target, 'Ada');
    expect((await user.request('GET', '/api/auth/me')).body.user.name).toBe('Ada');

    expect((await user.request('POST', '/api/auth/logout')).status).toBe(204);
    expect((await user.request('GET', '/api/auth/me')).status).toBe(401);

    const login = await user.request('POST', '/api/auth/login', {
      email: user.email.toUpperCase(),
      password: user.password,
    });
    expect(login.status).toBe(200);
    expect((await user.request('GET', '/api/auth/me')).status).toBe(200);
  });

  it('revokes the session on the server, not just in the browser', async () => {
    const user = await signUp(target);
    const stolen = client(target);
    Object.assign(stolen.jar, user.jar);
    await user.request('POST', '/api/auth/logout');
    expect((await stolen.request('GET', '/api/auth/me')).status).toBe(401);
  });

  it('gives the same answer for a wrong password and an unknown email', async () => {
    const user = await signUp(target);
    const visitor = client(target);
    const wrong = await visitor.request('POST', '/api/auth/login', {
      email: user.email,
      password: 'not the password',
    });
    const unknown = await visitor.request('POST', '/api/auth/login', {
      email: 'nobody@example.com',
      password: 'not the password',
    });
    expect(wrong.status).toBe(401);
    expect(unknown).toEqual(wrong);
  });

  it('refuses duplicate emails and short passwords', async () => {
    const user = await signUp(target);
    const again = await client(target).request('POST', '/api/auth/register', {
      email: user.email.toUpperCase(),
      name: 'Copy',
      password: 'long enough password',
    });
    expect(again.status).toBe(409);
    const weak = await client(target).request('POST', '/api/auth/register', {
      email: 'weak@example.com',
      name: 'Weak',
      password: 'short',
    });
    expect(weak.status).toBe(400);
  });

  it('sets a cookie that scripts and cross-site requests cannot use', async () => {
    const response = await target.app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email: 'cookie@example.com', name: 'C', password: 'long enough password' },
    });
    expect(response.cookies[0]).toMatchObject({
      name: 'pb_session',
      httpOnly: true,
      sameSite: 'Lax',
    });
  });

  it('marks the cookie Secure when served over https', async () => {
    const secure = await startApp({ APP_URL: 'https://pulse.example.com' });
    const response = await secure.app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email: 'tls@example.com', name: 'T', password: 'long enough password' },
    });
    expect(response.cookies[0]).toMatchObject({ name: '__Host-pb_session', secure: true });
    await secure.close();
  });

  it('refuses cross-origin and non-JSON writes', async () => {
    const payload = { email: 'x@example.com', password: 'whatever whatever' };
    const crossOrigin = await target.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { origin: 'https://evil.example' },
      payload,
    });
    expect(crossOrigin.statusCode).toBe(403);
    const form = await target.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'content-type': 'text/plain' },
      payload: JSON.stringify(payload),
    });
    expect(form.statusCode).toBe(415);
  });

  it('rate limits repeated sign-in attempts, ignoring spoofed forwarding headers', async () => {
    const limited = await startApp({ AUTH_RATE_LIMIT: '3' });
    const attempt = (n: number) =>
      limited.app.inject({
        method: 'POST',
        url: '/api/auth/login',
        headers: { 'x-forwarded-for': `203.0.114.${n}` },
        payload: { email: 'x@example.com', password: 'whatever whatever' },
      });
    const statuses: number[] = [];
    for (let n = 1; n <= 4; n++) statuses.push((await attempt(n)).statusCode);
    expect(statuses).toEqual([401, 401, 401, 429]);
    await limited.close();
  });

  it('answers 400, not 500, to text the database cannot store', async () => {
    const response = await client(target).request('POST', '/api/auth/register', {
      email: 'nul@example.com',
      name: 'a\u0000b',
      password: 'long enough password',
    });
    expect(response.status).toBe(400);
  });

  it('uses the address added by a trusted proxy for rate limits', async () => {
    const proxied = await startApp({ AUTH_RATE_LIMIT: '1', TRUST_PROXY: '1' });
    const attempt = async (forwardedFor: string) =>
      (
        await proxied.app.inject({
          method: 'POST',
          url: '/api/auth/login',
          headers: { 'x-forwarded-for': forwardedFor },
          payload: { email: 'x@example.com', password: 'whatever whatever' },
        })
      ).statusCode;
    expect(await attempt('203.0.114.1')).toBe(401);
    expect(await attempt('203.0.114.2')).toBe(401);
    // Entries to the left of the proxy's own are client-controlled and ignored.
    expect(await attempt('198.51.100.9, 203.0.114.1')).toBe(429);
    await proxied.close();
  });

  it('publishes an OpenAPI description', async () => {
    const response = await target.app.inject({ url: '/api/docs/json' });
    expect(Object.keys(response.json().paths)).toContain('/api/teams/{teamId}/services');
    expect((await target.app.inject({ url: '/api/ready' })).statusCode).toBe(200);
  });
});
