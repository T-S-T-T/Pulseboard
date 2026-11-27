export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

/** Exceptions raised on purpose by database functions and triggers. */
const RAISED: Record<string, [number, string]> = {
  last_owner: [409, 'A team must keep at least one owner'],
  service_limit: [409, 'A team can monitor at most 20 services'],
  team_limit: [409, 'You can own at most 5 teams'],
  invalid_invite: [404, 'This invite is invalid, expired or already used'],
  email_in_use: [409, 'An account with this email already exists'],
};

export function fromDatabaseError(error: unknown): HttpError | undefined {
  const { code, message } = error as { code?: string; message?: string };
  if (code === 'P0001' && message && RAISED[message]) return new HttpError(...RAISED[message]);
  // Text PostgreSQL cannot store, such as a NUL byte.
  if (code === '22021' || code === '22P05')
    return new HttpError(400, 'Invalid characters in input');
  // Row-level security rejected a write.
  if (code === '42501') return new HttpError(403, 'You do not have permission to do that');
  return undefined;
}
