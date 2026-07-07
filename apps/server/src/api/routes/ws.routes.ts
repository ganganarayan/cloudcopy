import type { FastifyInstance } from 'fastify';
import type { WebSocket } from '@fastify/websocket';
import type { AppContext } from '../server.js';

/**
 * Live progress feed. For single-instance mode we broadcast every engine event;
 * the client filters by job. (Per-job server-side subscription slots in when we
 * move fan-out to Redis pub/sub.)
 */
export function registerWsRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/ws', { websocket: true }, (socket: WebSocket) => {
    const unsubscribe = ctx.bus.subscribe((event) => {
      if (socket.readyState === socket.OPEN) {
        try {
          socket.send(JSON.stringify(event));
        } catch {
          /* client gone */
        }
      }
    });
    socket.on('close', unsubscribe);
    socket.on('error', unsubscribe);
  });
}
