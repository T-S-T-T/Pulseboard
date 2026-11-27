import { z } from 'zod';
import { HttpError } from '../errors.js';
import type { App, Context } from './context.js';

const statusSchema = z.object({
  team: z.string(),
  services: z.array(
    z.object({
      name: z.string(),
      ok: z.boolean().nullable(),
      lastCheckedAt: z.string().nullable(),
      uptime24h: z.number().nullable(),
      recent: z.array(z.object({ ok: z.boolean(), checkedAt: z.string() })),
    }),
  ),
});

/** Routes that need no sign-in. */
export function publicRoutes(app: App, { db }: Context): void {
  app.get(
    '/api/status/:slug',
    {
      schema: {
        tags: ['status'],
        params: z.object({ slug: z.string().max(60) }),
        response: { 200: statusSchema },
      },
    },
    async (request) => {
      const { rows } = await db.query<{ page: z.infer<typeof statusSchema> | null }>(
        'SELECT public_status($1) AS page',
        [request.params.slug],
      );
      const page = rows[0]?.page;
      if (!page) throw new HttpError(404, 'Status page not found');
      return page;
    },
  );

  // Liveness: the process is up. Readiness: it can also reach the database.
  app.get('/api/health', { config: { rateLimit: false } }, async () => ({ status: 'ok' }));

  app.get('/api/ready', { config: { rateLimit: false } }, async (request, reply) => {
    try {
      await db.query('SELECT 1');
      return { status: 'ready' };
    } catch (error) {
      request.log.error({ err: error }, 'Database is unreachable');
      return reply.code(503).send({ status: 'unavailable' });
    }
  });
}
