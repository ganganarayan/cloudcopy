import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../server.js';

const megaBody = z.object({
  label: z.string().optional().default(''),
  email: z.string().email(),
  password: z.string().min(1),
});

export function registerAccountRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/accounts', async () => ({ accounts: await ctx.accounts.list(ctx.defaultUserId) }));

  app.post('/accounts/mega', async (req, reply) => {
    const body = megaBody.parse(req.body);
    try {
      const account = await ctx.accounts.addMega(ctx.defaultUserId, body.label, body.email, body.password);
      return { account };
    } catch (err) {
      ctx.log.warn('auth', 'MEGA connect failed', { err: (err as Error).message });
      return reply.status(400).send({ statusCode: 400, error: 'MegaAuthError', message: (err as Error).message });
    }
  });

  // Returns the Google consent URL for the browser to open.
  app.get('/accounts/gdrive/connect', async (_req, reply) => {
    try {
      return { url: ctx.accounts.startDriveConnect(ctx.defaultUserId) };
    } catch (err) {
      return reply.status(400).send({ statusCode: 400, error: 'ConfigError', message: (err as Error).message });
    }
  });

  // Google redirects here after consent. Persist the account, then bounce to the UI.
  app.get('/accounts/gdrive/callback', async (req, reply) => {
    const q = req.query as { code?: string; state?: string; error?: string };
    if (q.error || !q.code || !q.state) {
      return reply.redirect(`/?drive=error`);
    }
    try {
      await ctx.accounts.finishDriveConnect(q.state, q.code);
      return reply.redirect(`/?drive=connected`);
    } catch (err) {
      ctx.log.warn('auth', 'Drive connect failed', { err: (err as Error).message });
      return reply.redirect(`/?drive=error`);
    }
  });

  app.delete('/accounts/:id', async (req) => {
    const { id } = req.params as { id: string };
    ctx.engine.getRegistry().invalidate(id);
    await ctx.accounts.remove(ctx.defaultUserId, id);
    return { ok: true };
  });
}
