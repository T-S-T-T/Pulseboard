import { z } from 'zod';

const bool = z.enum(['true', 'false']).transform((v) => v === 'true');

const schema = z
  .object({
    DATABASE_URL: z.string().min(1),
    /** Public origin of the web app, used for CSRF checks, cookies and links. */
    APP_URL: z.url().transform((v) => new URL(v).origin),
    HOST: z.string().default('127.0.0.1'),
    PORT: z.coerce.number().int().default(4000),
    /** Number of reverse proxies in front of the API. */
    TRUST_PROXY: z.coerce.number().int().min(0).default(0),
    SCHEDULER_ENABLED: bool.default(true),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'silent']).default('info'),
    AUTH_RATE_LIMIT: z.coerce.number().int().positive().default(10),
    OIDC_ISSUER: z.url().optional(),
    OIDC_CLIENT_ID: z.string().optional(),
    OIDC_CLIENT_SECRET: z.string().optional(),
    OIDC_NAME: z.string().default('single sign-on'),
  })
  .refine(
    (c) => !c.OIDC_ISSUER || (c.OIDC_CLIENT_ID && c.OIDC_CLIENT_SECRET),
    'OIDC_CLIENT_ID and OIDC_CLIENT_SECRET are required when OIDC_ISSUER is set',
  );

export type Config = z.infer<typeof schema>;

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  // A blank line such as `OIDC_ISSUER=` in .env means "not set".
  const present = Object.fromEntries(Object.entries(env).filter(([, value]) => value !== ''));
  const result = schema.safeParse(present);
  if (!result.success) {
    throw new Error(`Invalid configuration:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}
