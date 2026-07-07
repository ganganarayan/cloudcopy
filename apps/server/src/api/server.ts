import Fastify, { type FastifyError } from 'fastify';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import type { AppConfig } from '../config.js';
import type { Db } from '../db/client.js';
import type { LogService } from '../services/log.service.js';
import type { EventService } from '../services/event.service.js';
import type { FlagsService } from '../services/flags.service.js';
import type { Metrics } from '../observability/metrics.js';

export interface AppContext {
  config: AppConfig;
  db: Db;
  log: LogService;
  events: EventService;
  flags: FlagsService;
  metrics: Metrics;
}

declare module 'fastify' {
  interface FastifyInstance {
    ctx: AppContext;
  }
}

const startedAt = Date.now();

export async function buildServer(ctx: AppContext) {
  const app = Fastify({
    loggerInstance: ctx.log.pino.child({ category: 'api' }),
    disableRequestLogging: ctx.config.NODE_ENV === 'production',
  });

  app.decorate('ctx', ctx);

  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'Cloud Copy API',
        description: 'Cloud-to-cloud data movement platform',
        version: '0.1.0',
      },
      servers: ctx.config.PUBLIC_URL ? [{ url: ctx.config.PUBLIC_URL }] : [],
    },
  });
  await app.register(swaggerUi, { routePrefix: '/api/docs' });

  app.get(
    '/healthz',
    {
      schema: {
        response: {
          200: {
            type: 'object',
            properties: {
              status: { type: 'string' },
              version: { type: 'string' },
              uptimeSec: { type: 'number' },
            },
          },
        },
      },
    },
    async () => ({
      status: 'ok' as const,
      version: '0.1.0',
      uptimeSec: Math.round((Date.now() - startedAt) / 1000),
    }),
  );

  app.get('/metrics', async (_req, reply) => {
    reply.header('content-type', ctx.metrics.registry.contentType);
    return ctx.metrics.registry.metrics();
  });

  app.setErrorHandler((err: FastifyError, req, reply) => {
    const statusCode = err.statusCode ?? 500;
    if (statusCode >= 500) {
      ctx.log.error('api', 'unhandled request error', {
        err: err.message,
        stack: err.stack,
        url: req.url,
        method: req.method,
      });
    }
    reply.status(statusCode).send({
      statusCode,
      error: err.name ?? 'InternalServerError',
      message: statusCode >= 500 && ctx.config.NODE_ENV === 'production' ? 'Internal server error' : err.message,
    });
  });

  return app;
}
