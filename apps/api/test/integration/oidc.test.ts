/** Single sign-on against a minimal stand-in for an OpenID Connect provider. */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { APP_URL, client, signUp, startApp, type TestApp } from './helpers.js';

let target: TestApp;
let provider: Server;
let issuer: string;
let claims: Record<string, unknown> = {};
let nonce = '';

beforeAll(async () => {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
  provider = createServer((request, response) => {
    void (async () => {
      const send = (body: object) => {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify(body));
      };
      const path = request.url!.split('?')[0];
      if (path === '/.well-known/openid-configuration') {
        return send({
          issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          jwks_uri: `${issuer}/jwks`,
          response_types_supported: ['code'],
          subject_types_supported: ['public'],
          id_token_signing_alg_values_supported: ['RS256'],
          code_challenge_methods_supported: ['S256'],
        });
      }
      if (path === '/jwks') return send({ keys: [jwk] });
      const idToken = await new SignJWT({ nonce, ...claims })
        .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
        .setIssuer(issuer)
        .setAudience('pulseboard')
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(privateKey);
      send({ access_token: 'unused', token_type: 'Bearer', id_token: idToken });
    })();
  });
  await new Promise<void>((resolve) => provider.listen(0, '127.0.0.1', resolve));
  issuer = `http://127.0.0.1:${(provider.address() as AddressInfo).port}`;
  target = await startApp({
    OIDC_ISSUER: issuer,
    OIDC_CLIENT_ID: 'pulseboard',
    OIDC_CLIENT_SECRET: 'test-secret',
  });
});
afterAll(async () => {
  await target.close();
  provider.close();
});

/** Walks the redirect flow and returns where the API sends the browser. */
async function signInWithProvider(user = client(target), stateOverride?: string) {
  const start = await target.app.inject({ url: '/api/auth/oidc/start' });
  const authorize = new URL(start.headers.location as string);
  expect(authorize.searchParams.get('code_challenge_method')).toBe('S256');
  nonce = authorize.searchParams.get('nonce')!;
  const state = stateOverride ?? authorize.searchParams.get('state')!;
  const callback = await target.app.inject({
    url: `/api/auth/oidc/callback?code=abc&state=${state}`,
    cookies: Object.fromEntries(start.cookies.map((c) => [c.name, c.value])),
  });
  for (const c of callback.cookies) if (c.value) user.jar[c.name] = c.value;
  return { location: callback.headers.location, user };
}

describe('single sign-on', () => {
  it('creates an account once and reuses it', async () => {
    claims = { sub: 'sub-1', email: 'sso@example.com', email_verified: true, name: 'Grace' };
    const first = await signInWithProvider();
    expect(first.location).toBe(`${APP_URL}/dashboard`);
    const me = await first.user.request('GET', '/api/auth/me');
    expect(me.body.user).toMatchObject({ email: 'sso@example.com', name: 'Grace' });

    const second = await signInWithProvider();
    const again = await second.user.request('GET', '/api/auth/me');
    expect(again.body.user.id).toBe(me.body.user.id);
  });

  it('does not take over a password account with the same email', async () => {
    const existing = await signUp(target);
    claims = { sub: 'sub-2', email: existing.email, email_verified: true };
    const result = await signInWithProvider();
    expect(result.location).toBe(`${APP_URL}/login?error=email_in_use`);
    expect(result.user.jar).toEqual({});
  });

  it('requires a verified email', async () => {
    claims = { sub: 'sub-3', email: 'new@example.com', email_verified: false };
    const result = await signInWithProvider();
    expect(result.location).toBe(`${APP_URL}/login?error=email_unverified`);
  });

  it('rejects a mismatched state and a callback with no flow cookie', async () => {
    claims = { sub: 'sub-4', email: 'state@example.com', email_verified: true };
    const forged = await signInWithProvider(client(target), 'forged');
    expect(forged.location).toBe(`${APP_URL}/login?error=sso_failed`);
    const bare = await target.app.inject({ url: '/api/auth/oidc/callback?code=a&state=b' });
    expect(bare.headers.location).toBe(`${APP_URL}/login?error=sso_failed`);
  });
});
