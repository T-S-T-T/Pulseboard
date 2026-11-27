import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Config } from '../config.js';
import type { Db } from '../db.js';
import { HttpError } from '../errors.js';
import { createToken, hashToken } from '../security/tokens.js';

export interface User {
  id: string;
  email: string;
  name: string;
}

const SESSION_DAYS = 14;

export function createSessions(db: Db, config: Config) {
  const secure = config.APP_URL.startsWith('https://');
  // The __Host- prefix stops sibling subdomains from overwriting the cookie.
  const cookieName = secure ? '__Host-pb_session' : 'pb_session';
  const cookie = { path: '/', httpOnly: true, sameSite: 'lax', secure } as const;

  async function currentUser(request: FastifyRequest): Promise<User | undefined> {
    const token = request.cookies[cookieName];
    if (!token) return undefined;
    const { rows } = await db.query<User>('SELECT * FROM auth_session_user($1)', [
      hashToken(token),
    ]);
    return rows[0];
  }

  async function destroy(request: FastifyRequest): Promise<void> {
    const token = request.cookies[cookieName];
    if (token) await db.query('SELECT auth_delete_session($1)', [hashToken(token)]);
  }

  return {
    secure,
    currentUser,

    async requireUser(request: FastifyRequest): Promise<User> {
      const user = await currentUser(request);
      if (!user) throw new HttpError(401, 'Sign in to continue');
      return user;
    },

    async signIn(request: FastifyRequest, reply: FastifyReply, userId: string): Promise<void> {
      await destroy(request); // never carry an old session across a sign-in
      const { token, hash } = createToken();
      const expires = new Date(Date.now() + SESSION_DAYS * 86_400_000);
      await db.query('SELECT auth_create_session($1, $2, $3)', [userId, hash, expires]);
      reply.setCookie(cookieName, token, { ...cookie, expires });
    },

    async signOut(request: FastifyRequest, reply: FastifyReply): Promise<void> {
      await destroy(request);
      reply.clearCookie(cookieName, cookie);
    },
  };
}

export type Sessions = ReturnType<typeof createSessions>;
