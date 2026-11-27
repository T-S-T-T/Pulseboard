import type {
  FastifyBaseLogger,
  FastifyInstance,
  RawReplyDefaultExpression,
  RawRequestDefaultExpression,
  RawServerDefault,
} from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Sessions } from '../auth/session.js';
import type { Config } from '../config.js';
import type { Db, Tx } from '../db.js';
import { HttpError } from '../errors.js';

export type App = FastifyInstance<
  RawServerDefault,
  RawRequestDefaultExpression,
  RawReplyDefaultExpression,
  FastifyBaseLogger,
  ZodTypeProvider
>;

export interface Context {
  config: Config;
  db: Db;
  sessions: Sessions;
}

export const roleSchema = z.enum(['owner', 'admin', 'member']);
export type Role = z.infer<typeof roleSchema>;

const RANK: Record<Role, number> = { member: 0, admin: 1, owner: 2 };

/**
 * Gives a clear 404 or 403. Row-level security enforces the same rules again in
 * the database, so a missing call here cannot expose another team's data.
 */
export async function requireRole(tx: Tx, teamId: string, minimum: Role): Promise<Role> {
  const { rows } = await tx.query<{ role: Role | null }>('SELECT team_role($1) AS role', [teamId]);
  const role = rows[0]?.role;
  // Outsiders cannot tell whether a team exists.
  if (!role) throw new HttpError(404, 'Team not found');
  if (RANK[role] < RANK[minimum]) throw new HttpError(403, 'You do not have permission to do that');
  return role;
}
