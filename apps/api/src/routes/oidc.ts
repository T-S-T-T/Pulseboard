import * as oidc from 'openid-client';
import { z } from 'zod';
import { HttpError } from '../errors.js';
import type { App, Context } from './context.js';

const FLOW_COOKIE = 'pb_oidc';
const flowSchema = z.object({ verifier: z.string(), state: z.string(), nonce: z.string() });

/** Optional sign-in through any OpenID Connect provider (authorization code + PKCE). */
export function oidcRoutes(app: App, { config, db, sessions }: Context): void {
  const { OIDC_ISSUER: issuer, OIDC_CLIENT_ID: clientId, OIDC_CLIENT_SECRET: secret } = config;

  app.get(
    '/api/auth/providers',
    {
      schema: {
        tags: ['auth'],
        response: { 200: z.object({ oidc: z.object({ name: z.string() }).nullable() }) },
      },
    },
    async () => ({ oidc: issuer ? { name: config.OIDC_NAME } : null }),
  );

  if (!issuer || !clientId || !secret) return;

  const redirectUri = `${config.APP_URL}/api/auth/oidc/callback`;
  const cookie = {
    path: '/api/auth/oidc',
    httpOnly: true,
    sameSite: 'lax',
    secure: sessions.secure,
  } as const;

  // Discovered on first use, so a provider outage cannot stop the API starting.
  let discovered: Promise<oidc.Configuration> | undefined;
  function provider(): Promise<oidc.Configuration> {
    const url = new URL(issuer!);
    // Plain http is accepted only for a provider on this machine (tests, local dev).
    const local = url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname);
    discovered ??= oidc
      .discovery(url, clientId!, secret, undefined, {
        execute: local ? [oidc.allowInsecureRequests] : [],
      })
      .catch((error: unknown) => {
        discovered = undefined;
        throw error;
      });
    return discovered;
  }

  app.get('/api/auth/oidc/start', { schema: { tags: ['auth'] } }, async (_request, reply) => {
    const flow = {
      verifier: oidc.randomPKCECodeVerifier(),
      state: oidc.randomState(),
      nonce: oidc.randomNonce(),
    };
    const url = oidc.buildAuthorizationUrl(await provider(), {
      redirect_uri: redirectUri,
      scope: 'openid email profile',
      code_challenge: await oidc.calculatePKCECodeChallenge(flow.verifier),
      code_challenge_method: 'S256',
      state: flow.state,
      nonce: flow.nonce,
    });
    reply.setCookie(FLOW_COOKIE, JSON.stringify(flow), { ...cookie, maxAge: 600 });
    return reply.redirect(url.href);
  });

  app.get('/api/auth/oidc/callback', { schema: { tags: ['auth'] } }, async (request, reply) => {
    const stored = request.cookies[FLOW_COOKIE];
    reply.clearCookie(FLOW_COOKIE, cookie);
    const fail = (reason: string) => reply.redirect(`${config.APP_URL}/login?error=${reason}`);
    try {
      if (!stored) throw new HttpError(400, 'Sign-in expired');
      const flow = flowSchema.parse(JSON.parse(stored));
      const tokens = await oidc.authorizationCodeGrant(
        await provider(),
        new URL(request.url, config.APP_URL),
        {
          pkceCodeVerifier: flow.verifier,
          expectedState: flow.state,
          expectedNonce: flow.nonce,
          idTokenExpected: true,
        },
      );
      const claims = tokens.claims()!;
      if (typeof claims.email !== 'string' || claims.email_verified !== true) {
        return fail('email_unverified');
      }
      const name =
        (typeof claims.name === 'string' && claims.name.trim()) || claims.email.split('@')[0]!;
      const { rows } = await db.query<{ id: string }>(
        'SELECT auth_oidc_login($1, $2, $3, $4) AS id',
        [claims.iss, claims.sub, claims.email, name.slice(0, 80)],
      );
      await sessions.signIn(request, reply, rows[0]!.id);
      return reply.redirect(`${config.APP_URL}/dashboard`);
    } catch (error) {
      request.log.warn({ err: error }, 'OIDC sign-in failed');
      return fail((error as Error).message === 'email_in_use' ? 'email_in_use' : 'sso_failed');
    }
  });
}
