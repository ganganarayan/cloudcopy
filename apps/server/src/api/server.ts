import Fastify, { type FastifyError } from 'fastify';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import websocket from '@fastify/websocket';
import type { AppConfig } from '../config.js';
import type { Db } from '../db/client.js';
import type { LogService } from '../services/log.service.js';
import type { EventService } from '../services/event.service.js';
import type { FlagsService } from '../services/flags.service.js';
import type { ProviderAccountService } from '../services/provider-account.service.js';
import type { Metrics } from '../observability/metrics.js';
import type { TransferEngine } from '../engine/engine.js';
import type { ProgressBus } from '../realtime/bus.js';
import { registerAccountRoutes } from './routes/accounts.routes.js';
import { registerBrowseRoutes } from './routes/browse.routes.js';
import { registerJobRoutes } from './routes/jobs.routes.js';
import { registerWsRoutes } from './routes/ws.routes.js';

export interface AppContext {
  config: AppConfig;
  db: Db;
  log: LogService;
  events: EventService;
  flags: FlagsService;
  metrics: Metrics;
  accounts: ProviderAccountService;
  engine: TransferEngine;
  bus: ProgressBus;
  /** Single-user mode: every request acts as this user. */
  defaultUserId: string;
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
  await app.register(websocket);

  await app.register(
    async (api) => {
      registerAccountRoutes(api, ctx);
      registerBrowseRoutes(api, ctx);
      registerJobRoutes(api, ctx);
      registerWsRoutes(api, ctx);
    },
    { prefix: '/api/v1' },
  );

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

  // Serve the built web app (SPA) when present. In dev the Vite server proxies
  // /api instead, so a missing dist is fine.
  const { existsSync } = await import('node:fs');
  const { join, dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const here = dirname(fileURLToPath(import.meta.url));
  const webDist = [join(process.cwd(), 'apps/web/dist'), join(here, '../../../web/dist')].find((p) => existsSync(p));
  if (webDist) {
    const staticPlugin = (await import('@fastify/static')).default;
    await app.register(staticPlugin, { root: webDist, wildcard: false });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api') || req.url.startsWith('/metrics') || req.url.startsWith('/healthz')) {
        return reply.status(404).send({ statusCode: 404, error: 'NotFound', message: 'route not found' });
      }
      return reply.sendFile('index.html');
    });
    ctx.log.info('api', 'serving web build', { webDist });
  }

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
