import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { withUser } from '../db.js';
import { HttpError } from '../errors.js';
import { createToken, hashToken } from '../security/tokens.js';
import { requireRole, roleSchema, type App, type Context, type Role } from './context.js';

const teamName = z.string().trim().min(1).max(80);
const teamSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  slug: z.string(),
  statusPageEnabled: z.boolean(),
  role: roleSchema,
});
const memberSchema = z.object({
  userId: z.uuid(),
  name: z.string(),
  email: z.string(),
  role: roleSchema,
});
const teamParams = z.object({ teamId: z.uuid() });
const memberParams = teamParams.extend({ userId: z.uuid() });

const SELECT_TEAM = `SELECT id, name, slug, status_page_enabled AS "statusPageEnabled",
                            team_role(id) AS role FROM teams`;
const INVITE_DAYS = 7;

function slugify(name: string): string {
  const base = name
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, 40)
    .replace(/^-+|-+$/g, '');
  return `${base || 'team'}-${randomBytes(4).toString('hex')}`;
}

type Team = z.infer<typeof teamSchema>;

export function teamRoutes(app: App, { config, db, sessions }: Context): void {
  const tags = ['teams'];

  app.get(
    '/api/teams',
    { schema: { tags, response: { 200: z.object({ teams: z.array(teamSchema) }) } } },
    async (request) => {
      const user = await sessions.requireUser(request);
      return withUser(db, user.id, async (tx) => {
        const { rows } = await tx.query<Team>(`${SELECT_TEAM} ORDER BY created_at, id`);
        return { teams: rows };
      });
    },
  );

  app.post(
    '/api/teams',
    {
      schema: {
        tags,
        body: z.object({ name: teamName }),
        response: { 201: z.object({ team: teamSchema }) },
      },
    },
    async (request, reply) => {
      const user = await sessions.requireUser(request);
      const team = await withUser(db, user.id, async (tx) => {
        const created = await tx.query<{ id: string }>('SELECT create_team($1, $2) AS id', [
          request.body.name,
          slugify(request.body.name),
        ]);
        const { rows } = await tx.query<Team>(`${SELECT_TEAM} WHERE id = $1`, [
          created.rows[0]!.id,
        ]);
        return rows[0]!;
      });
      reply.code(201);
      return { team };
    },
  );

  app.get(
    '/api/teams/:teamId',
    {
      schema: {
        tags,
        params: teamParams,
        response: { 200: z.object({ team: teamSchema, members: z.array(memberSchema) }) },
      },
    },
    async (request) => {
      const user = await sessions.requireUser(request);
      const { teamId } = request.params;
      return withUser(db, user.id, async (tx) => {
        await requireRole(tx, teamId, 'member');
        const team = await tx.query<Team>(`${SELECT_TEAM} WHERE id = $1`, [teamId]);
        const members = await tx.query<z.infer<typeof memberSchema>>(
          'SELECT user_id AS "userId", name, email, role FROM list_team_members($1)',
          [teamId],
        );
        return { team: team.rows[0]!, members: members.rows };
      });
    },
  );

  app.patch(
    '/api/teams/:teamId',
    {
      schema: {
        tags,
        params: teamParams,
        body: z.object({ name: teamName.optional(), statusPageEnabled: z.boolean().optional() }),
        response: { 200: z.object({ team: teamSchema }) },
      },
    },
    async (request) => {
      const user = await sessions.requireUser(request);
      const { teamId } = request.params;
      return withUser(db, user.id, async (tx) => {
        await requireRole(tx, teamId, 'admin');
        await tx.query(
          `UPDATE teams SET name = coalesce($2, name),
             status_page_enabled = coalesce($3, status_page_enabled)
           WHERE id = $1`,
          [teamId, request.body.name ?? null, request.body.statusPageEnabled ?? null],
        );
        const { rows } = await tx.query<Team>(`${SELECT_TEAM} WHERE id = $1`, [teamId]);
        return { team: rows[0]! };
      });
    },
  );

  app.patch(
    '/api/teams/:teamId/members/:userId',
    { schema: { tags, params: memberParams, body: z.object({ role: roleSchema }) } },
    async (request, reply) => {
      const user = await sessions.requireUser(request);
      const { teamId, userId } = request.params;
      await withUser(db, user.id, async (tx) => {
        await requireRole(tx, teamId, 'owner');
        const result = await tx.query(
          'UPDATE memberships SET role = $3 WHERE team_id = $1 AND user_id = $2',
          [teamId, userId, request.body.role],
        );
        if (!result.rowCount) throw new HttpError(404, 'Member not found');
      });
      return reply.code(204).send();
    },
  );

  /** Owners can remove anyone; everyone else can only remove themselves (leave). */
  app.delete(
    '/api/teams/:teamId/members/:userId',
    { schema: { tags, params: memberParams } },
    async (request, reply) => {
      const user = await sessions.requireUser(request);
      const { teamId, userId } = request.params;
      await withUser(db, user.id, async (tx) => {
        const minimum: Role = userId === user.id ? 'member' : 'owner';
        await requireRole(tx, teamId, minimum);
        const result = await tx.query(
          'DELETE FROM memberships WHERE team_id = $1 AND user_id = $2',
          [teamId, userId],
        );
        if (!result.rowCount) throw new HttpError(404, 'Member not found');
      });
      return reply.code(204).send();
    },
  );

  app.post(
    '/api/teams/:teamId/invites',
    {
      schema: {
        tags,
        params: teamParams,
        body: z.object({ role: z.enum(['admin', 'member']).default('member') }),
        response: { 201: z.object({ url: z.string(), expiresAt: z.string() }) },
      },
    },
    async (request, reply) => {
      const user = await sessions.requireUser(request);
      const { teamId } = request.params;
      const { role } = request.body;
      const { token, hash } = createToken();
      const expiresAt = new Date(Date.now() + INVITE_DAYS * 86_400_000);
      await withUser(db, user.id, async (tx) => {
        await requireRole(tx, teamId, role === 'admin' ? 'owner' : 'admin');
        await tx.query(
          `INSERT INTO invites (team_id, token_hash, role, created_by, expires_at)
           VALUES ($1, $2, $3, $4, $5)`,
          [teamId, hash, role, user.id, expiresAt],
        );
      });
      reply.code(201);
      // The token sits after "#", so browsers never send it to server logs.
      return { url: `${config.APP_URL}/invite#${token}`, expiresAt: expiresAt.toISOString() };
    },
  );

  app.post(
    '/api/invites/accept',
    {
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
      schema: {
        tags,
        body: z.object({ token: z.string().min(1).max(100) }),
        response: { 200: z.object({ teamId: z.uuid() }) },
      },
    },
    async (request) => {
      const user = await sessions.requireUser(request);
      return withUser(db, user.id, async (tx) => {
        const { rows } = await tx.query<{ id: string }>('SELECT accept_invite($1) AS id', [
          hashToken(request.body.token),
        ]);
        return { teamId: rows[0]!.id };
      });
    },
  );
}
