import { z } from 'zod';
import { HttpError } from '../errors.js';
import { hashPassword, verifyPassword } from '../security/password.js';
import type { App, Context } from './context.js';

const userSchema = z.object({ id: z.uuid(), email: z.string(), name: z.string() });
const email = z.string().trim().max(254).pipe(z.email());
const password = z.string().min(10).max(128);

// Verified against when the account does not exist, so that response time does
// not reveal which email addresses are registered.
const decoyHash = hashPassword('decoy-password-for-timing');

export function authRoutes(app: App, { config, db, sessions }: Context): void {
  const rateLimit = { rateLimit: { max: config.AUTH_RATE_LIMIT, timeWindow: '1 minute' } };

  app.post(
    '/api/auth/register',
    {
      config: rateLimit,
      schema: {
        tags: ['auth'],
        body: z.object({ email, password, name: z.string().trim().min(1).max(80) }),
        response: { 201: z.object({ user: userSchema }) },
      },
    },
    async (request, reply) => {
      const body = request.body;
      const hash = await hashPassword(body.password);
      let id: string;
      try {
        const { rows } = await db.query<{ id: string }>('SELECT auth_register($1, $2, $3) AS id', [
          body.email,
          body.name,
          hash,
        ]);
        id = rows[0]!.id;
      } catch (error) {
        if ((error as { code?: string }).code === '23505') {
          throw new HttpError(409, 'An account with this email already exists');
        }
        throw error;
      }
      await sessions.signIn(request, reply, id);
      reply.code(201);
      return { user: { id, email: body.email, name: body.name } };
    },
  );

  app.post(
    '/api/auth/login',
    {
      config: rateLimit,
      schema: {
        tags: ['auth'],
        body: z.object({ email, password: z.string().max(128) }),
        response: { 200: z.object({ user: userSchema }) },
      },
    },
    async (request, reply) => {
      const { rows } = await db.query<{
        id: string;
        email: string;
        name: string;
        password_hash: string | null;
      }>('SELECT * FROM auth_find_by_email($1)', [request.body.email]);
      const user = rows[0];
      const valid = await verifyPassword(
        request.body.password,
        user?.password_hash ?? (await decoyHash),
      );
      if (!user?.password_hash || !valid) {
        throw new HttpError(401, 'Email or password is incorrect');
      }
      await sessions.signIn(request, reply, user.id);
      return { user: { id: user.id, email: user.email, name: user.name } };
    },
  );

  app.post('/api/auth/logout', { schema: { tags: ['auth'] } }, async (request, reply) => {
    await sessions.signOut(request, reply);
    return reply.code(204).send();
  });

  app.get(
    '/api/auth/me',
    { schema: { tags: ['auth'], response: { 200: z.object({ user: userSchema }) } } },
    async (request) => ({ user: await sessions.requireUser(request) }),
  );
}
