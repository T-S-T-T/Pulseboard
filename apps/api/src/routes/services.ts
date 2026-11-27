import { z } from 'zod';
import { withUser, type Tx } from '../db.js';
import { HttpError } from '../errors.js';
import { parseTarget, UnsafeTargetError, type TargetPolicy } from '../security/ssrf.js';
import { requireRole, type App, type Context } from './context.js';

const fields = {
  name: z.string().trim().min(1).max(80),
  url: z.string().trim().max(2000),
  method: z.enum(['GET', 'HEAD']),
  intervalSeconds: z.number().int().min(60).max(3600),
  timeoutMs: z.number().int().min(1000).max(15000),
  enabled: z.boolean(),
  isPublic: z.boolean(),
};

const createSchema = z.object({
  name: fields.name,
  url: fields.url,
  method: fields.method.default('GET'),
  intervalSeconds: fields.intervalSeconds.default(60),
  timeoutMs: fields.timeoutMs.default(5000),
  enabled: fields.enabled.default(true),
  isPublic: fields.isPublic.default(false),
});

// No defaults here: an omitted field must stay unchanged.
const updateSchema = z.object(fields).partial();

const checkSchema = z.object({
  ok: z.boolean(),
  statusCode: z.number().nullable(),
  latencyMs: z.number().nullable(),
  error: z.string().nullable(),
  checkedAt: z.string(),
});

const serviceSchema = z.object({
  id: z.uuid(),
  ...fields,
  lastOk: z.boolean().nullable(),
  lastStatusCode: z.number().nullable(),
  lastLatencyMs: z.number().nullable(),
  lastError: z.string().nullable(),
  lastCheckedAt: z.string().nullable(),
  /** Newest last. */
  recentChecks: z.array(checkSchema),
});

type ServiceRow = Omit<z.infer<typeof serviceSchema>, 'lastCheckedAt' | 'recentChecks'> & {
  lastCheckedAt: Date | null;
};
type CheckRow = Omit<z.infer<typeof checkSchema>, 'checkedAt'> & {
  serviceId: string;
  checkedAt: Date;
};

const SELECT_SERVICE = `
  SELECT id, name, url, method, interval_seconds AS "intervalSeconds", timeout_ms AS "timeoutMs",
         enabled, is_public AS "isPublic", last_ok AS "lastOk",
         last_status_code AS "lastStatusCode", last_latency_ms AS "lastLatencyMs",
         last_error AS "lastError", last_checked_at AS "lastCheckedAt"
  FROM services`;

/** Fetches a team's services, or one of them, each with its latest checks. */
async function loadServices(tx: Tx, teamId: string, serviceId: string | null = null) {
  const services = await tx.query<ServiceRow>(
    `${SELECT_SERVICE} WHERE team_id = $1 AND ($2::uuid IS NULL OR id = $2)
     ORDER BY created_at, id`,
    [teamId, serviceId],
  );
  const checks = await tx.query<CheckRow>(
    `SELECT s.id AS "serviceId", c.ok, c.status_code AS "statusCode",
            c.latency_ms AS "latencyMs", c.error, c.checked_at AS "checkedAt"
     FROM services s
     CROSS JOIN LATERAL (
       SELECT * FROM check_results r WHERE r.service_id = s.id
       ORDER BY r.checked_at DESC LIMIT 30
     ) c
     WHERE s.team_id = $1 AND ($2::uuid IS NULL OR s.id = $2)
     ORDER BY c.checked_at`,
    [teamId, serviceId],
  );
  return services.rows.map((row) => ({
    ...row,
    lastCheckedAt: row.lastCheckedAt?.toISOString() ?? null,
    recentChecks: checks.rows
      .filter((c) => c.serviceId === row.id)
      .map(({ ok, statusCode, latencyMs, error, checkedAt }) => ({
        ok,
        statusCode,
        latencyMs,
        error,
        checkedAt: checkedAt.toISOString(),
      })),
  }));
}

export function serviceRoutes(
  app: App,
  { db, sessions }: Context,
  targetPolicy: TargetPolicy,
): void {
  const tags = ['services'];
  const teamParams = z.object({ teamId: z.uuid() });
  const serviceParams = teamParams.extend({ serviceId: z.uuid() });
  const one = z.object({ service: serviceSchema });

  /** Rejects obviously unsafe URLs early; the probe repeats this and checks DNS. */
  function validateUrl(raw: string): string {
    try {
      return parseTarget(raw, targetPolicy).url.href;
    } catch (error) {
      if (error instanceof UnsafeTargetError) throw new HttpError(400, error.message);
      throw error;
    }
  }

  app.get(
    '/api/teams/:teamId/services',
    {
      schema: {
        tags,
        params: teamParams,
        response: { 200: z.object({ services: z.array(serviceSchema) }) },
      },
    },
    async (request) => {
      const user = await sessions.requireUser(request);
      const { teamId } = request.params;
      return withUser(db, user.id, async (tx) => {
        await requireRole(tx, teamId, 'member');
        return { services: await loadServices(tx, teamId) };
      });
    },
  );

  app.post(
    '/api/teams/:teamId/services',
    { schema: { tags, params: teamParams, body: createSchema, response: { 201: one } } },
    async (request, reply) => {
      const user = await sessions.requireUser(request);
      const { teamId } = request.params;
      const body = request.body;
      const url = validateUrl(body.url);
      const service = await withUser(db, user.id, async (tx) => {
        await requireRole(tx, teamId, 'admin');
        const { rows } = await tx.query<{ id: string }>(
          `INSERT INTO services
             (team_id, name, url, method, interval_seconds, timeout_ms, enabled, is_public)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
          [
            teamId,
            body.name,
            url,
            body.method,
            body.intervalSeconds,
            body.timeoutMs,
            body.enabled,
            body.isPublic,
          ],
        );
        return (await loadServices(tx, teamId, rows[0]!.id))[0]!;
      });
      reply.code(201);
      return { service };
    },
  );

  app.patch(
    '/api/teams/:teamId/services/:serviceId',
    { schema: { tags, params: serviceParams, body: updateSchema, response: { 200: one } } },
    async (request) => {
      const user = await sessions.requireUser(request);
      const { teamId, serviceId } = request.params;
      const body = request.body;
      const url = body.url === undefined ? null : validateUrl(body.url);
      return withUser(db, user.id, async (tx) => {
        await requireRole(tx, teamId, 'admin');
        const result = await tx.query(
          `UPDATE services SET
             name = coalesce($3, name),
             url = coalesce($4, url),
             method = coalesce($5, method),
             interval_seconds = coalesce($6, interval_seconds),
             timeout_ms = coalesce($7, timeout_ms),
             enabled = coalesce($8, enabled),
             is_public = coalesce($9, is_public)
           WHERE team_id = $1 AND id = $2`,
          [
            teamId,
            serviceId,
            body.name ?? null,
            url,
            body.method ?? null,
            body.intervalSeconds ?? null,
            body.timeoutMs ?? null,
            body.enabled ?? null,
            body.isPublic ?? null,
          ],
        );
        if (!result.rowCount) throw new HttpError(404, 'Service not found');
        return { service: (await loadServices(tx, teamId, serviceId))[0]! };
      });
    },
  );

  app.delete(
    '/api/teams/:teamId/services/:serviceId',
    { schema: { tags, params: serviceParams } },
    async (request, reply) => {
      const user = await sessions.requireUser(request);
      const { teamId, serviceId } = request.params;
      await withUser(db, user.id, async (tx) => {
        await requireRole(tx, teamId, 'admin');
        const result = await tx.query('DELETE FROM services WHERE team_id = $1 AND id = $2', [
          teamId,
          serviceId,
        ]);
        if (!result.rowCount) throw new HttpError(404, 'Service not found');
      });
      return reply.code(204).send();
    },
  );
}
