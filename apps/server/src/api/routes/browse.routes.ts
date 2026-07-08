import type { FastifyInstance } from 'fastify';
import { and, eq } from 'drizzle-orm';
import type { AppContext } from '../server.js';
import { providerAccounts } from '../../db/schema.js';
import type { AccountRow } from '../../providers/registry.js';

export function registerBrowseRoutes(app: FastifyInstance, ctx: AppContext): void {
  async function accountRow(id: string): Promise<AccountRow | null> {
    const rows = await ctx.db
      .select({ id: providerAccounts.id, providerId: providerAccounts.providerId, authBlob: providerAccounts.authBlob })
      .from(providerAccounts)
      .where(and(eq(providerAccounts.id, id), eq(providerAccounts.userId, ctx.defaultUserId)))
      .limit(1);
    return rows[0] ?? null;
  }

  // Combined folders + files listing for the dual-pane browser.
  app.get('/accounts/:id/browse', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { parentId } = req.query as { parentId?: string };
    const account = await accountRow(id);
    if (!account) return reply.status(404).send({ statusCode: 404, error: 'NotFound', message: 'account not found' });
    try {
      const provider = await ctx.engine.getRegistry().connect(account);
      const [folders, files] = await Promise.all([
        provider.listFolders(parentId ?? null),
        provider.listFiles(parentId ?? null),
      ]);
      return {
        folders: folders.map((f) => ({ id: f.id, name: f.name, isFolder: true })),
        files: files.map((f) => ({ id: f.id, name: f.name, size: f.size, isFolder: false })),
      };
    } catch (err) {
      ctx.engine.getRegistry().invalidate(id);
      return reply.status(502).send({ statusCode: 502, error: 'ProviderError', message: (err as Error).message });
    }
  });

  // Find folders anywhere in the account by name — reaches Drive "Computers"
  // roots and other folders not under the browsable root.
  app.get('/accounts/:id/search', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { q } = req.query as { q?: string };
    const account = await accountRow(id);
    if (!account) return reply.status(404).send({ statusCode: 404, error: 'NotFound', message: 'account not found' });
    if (!q || q.trim().length < 1) return { folders: [] };
    try {
      const provider = await ctx.engine.getRegistry().connect(account);
      const folders = provider.searchFolders ? await provider.searchFolders(q.trim()) : [];
      return { folders: folders.map((f) => ({ id: f.id, name: f.name, isFolder: true })) };
    } catch (err) {
      return reply.status(502).send({ statusCode: 502, error: 'ProviderError', message: (err as Error).message });
    }
  });

  // Metadata for a single node — used to open a folder pasted as a link/ID.
  app.get('/accounts/:id/meta', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { fileId } = req.query as { fileId?: string };
    const account = await accountRow(id);
    if (!account) return reply.status(404).send({ statusCode: 404, error: 'NotFound', message: 'account not found' });
    if (!fileId) return reply.status(400).send({ statusCode: 400, error: 'BadRequest', message: 'fileId required' });
    try {
      const provider = await ctx.engine.getRegistry().connect(account);
      const m = await provider.getMetadata(fileId);
      return { id: m.id, name: m.name, isFolder: m.isFolder };
    } catch (err) {
      return reply.status(404).send({ statusCode: 404, error: 'NotFound', message: (err as Error).message });
    }
  });

  app.get('/accounts/:id/quota', async (req, reply) => {
    const { id } = req.params as { id: string };
    const account = await accountRow(id);
    if (!account) return reply.status(404).send({ statusCode: 404, error: 'NotFound', message: 'account not found' });
    const provider = await ctx.engine.getRegistry().connect(account);
    return provider.quota();
  });
}
