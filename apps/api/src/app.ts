import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import Fastify from 'fastify';
import {
  hasZodFastifySchemaValidationErrors,
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { createSessions } from './auth/session.js';
import type { Config } from './config.js';
import type { Db } from './db.js';
import { fromDatabaseError, HttpError } from './errors.js';
import { authRoutes } from './routes/auth.js';
import type { Context } from './routes/context.js';
import { oidcRoutes } from './routes/oidc.js';
import { publicRoutes } from './routes/public.js';
import { serviceRoutes } from './routes/services.js';
import { teamRoutes } from './routes/teams.js';
import { publicPolicy, type TargetPolicy } from './security/ssrf.js';

export interface AppOptions {
  config: Config;
  db: Db;
  targetPolicy?: TargetPolicy;
}

export async function buildApp({ config, db, targetPolicy = publicPolicy }: AppOptions) {
  const hops = config.TRUST_PROXY;
  const app = Fastify({
    logger:
      config.LOG_LEVEL === 'silent'
        ? false
        : {
            level: config.LOG_LEVEL,
            // Callback URLs carry one-time codes, so query strings are not logged.
            serializers: {
              req: (request: { method: string; url: string; ip: string }) => ({
                method: request.method,
                url: request.url.split('?')[0],
                ip: request.ip,
              }),
            },
          },
    trustProxy: hops > 0 ? (_address: string, hop: number) => hop < hops : false,
    bodyLimit: 32 * 1024,
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  // JSON is the only accepted body type. A cross-site HTML form cannot send it.
  app.removeContentTypeParser('text/plain');

  await app.register(helmet);
  await app.register(cookie);
  await app.register(rateLimit, { max: 300, timeWindow: '1 minute' });
  await app.register(swagger, {
    openapi: { info: { title: 'Pulseboard API', version: '0.1.0' } },
    transform: jsonSchemaTransform,
  });
  await app.register(swaggerUi, { routePrefix: '/api/docs' });

  // CSRF defence in depth, alongside SameSite cookies: browsers always send
  // Origin on cross-site writes, and it must match the web app.
  app.addHook('onRequest', async (request) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return;
    const { origin } = request.headers;
    if (origin && origin !== config.APP_URL) {
      throw new HttpError(403, 'Cross-origin request refused');
    }
  });

  app.addHook('onSend', async (request, reply) => {
    if (!request.url.startsWith('/api/docs')) reply.header('cache-control', 'no-store');
  });

  app.setErrorHandler((error, request, reply) => {
    if (hasZodFastifySchemaValidationErrors(error)) {
      const message = error.validation
        .map((issue) => `${issue.instancePath.slice(1) || 'request'}: ${issue.message}`)
        .join('; ');
      return reply.code(400).send({ error: message });
    }
    const known = error instanceof HttpError ? error : fromDatabaseError(error);
    if (known) return reply.code(known.statusCode).send({ error: known.message });

    const { statusCode, message } = error as { statusCode?: number; message: string };
    if (statusCode && statusCode < 500) return reply.code(statusCode).send({ error: message });
    request.log.error({ err: error }, 'Unhandled error');
    return reply.code(500).send({ error: 'Something went wrong' });
  });

  app.setNotFoundHandler((_request, reply) => reply.code(404).send({ error: 'Not found' }));

  const context: Context = { config, db, sessions: createSessions(db, config) };
  authRoutes(app, context);
  oidcRoutes(app, context);
  teamRoutes(app, context);
  serviceRoutes(app, context, targetPolicy);
  publicRoutes(app, context);

  return app;
}
