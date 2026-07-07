import { and, eq } from 'drizzle-orm';
import { MegaProvider } from '../providers/mega/mega.provider.js';
import { GDriveProvider } from '../providers/gdrive/gdrive.provider.js';
import { buildConsentUrl, type GoogleOAuthConfig } from '../providers/gdrive/oauth.js';
import { googleOAuthConfig } from '../providers/registry.js';
import { sealJson } from '../security/crypto.js';
import type { AppConfig } from '../config.js';
import type { Db } from '../db/client.js';
import { providerAccounts } from '../db/schema.js';

export interface AccountSummary {
  id: string;
  providerId: string;
  label: string;
  status: string;
  email: string;
  quotaTotal: number | null;
  quotaUsed: number | null;
}

/** Connects and persists provider accounts (credentials sealed at rest). */
export class ProviderAccountService {
  private readonly key: Buffer;
  /** Short-lived OAuth state → userId map (CSRF + which user is connecting). */
  private oauthState = new Map<string, { userId: string; at: number }>();

  constructor(
    private readonly config: AppConfig,
    private readonly db: Db,
  ) {
    this.key = Buffer.from(config.CREDENTIALS_KEY, 'base64');
  }

  async list(userId: string): Promise<AccountSummary[]> {
    const rows = await this.db.select().from(providerAccounts).where(eq(providerAccounts.userId, userId));
    return rows.map((r) => ({
      id: r.id,
      providerId: r.providerId,
      label: r.label,
      status: r.status,
      email: String((r.authMeta as Record<string, unknown>).email ?? ''),
      quotaTotal: r.quotaTotal,
      quotaUsed: r.quotaUsed,
    }));
  }

  /** Connect a MEGA account with email/password. Only the session is persisted. */
  async addMega(userId: string, label: string, email: string, password: string): Promise<AccountSummary> {
    const provider = new MegaProvider();
    const state = await provider.authenticate({ kind: 'password', email, password });
    const [row] = await this.db
      .insert(providerAccounts)
      .values({
        userId,
        providerId: 'mega',
        label: label || email,
        authBlob: sealJson(state, this.key),
        authMeta: state.meta,
        status: 'active',
      })
      .onConflictDoUpdate({
        target: [providerAccounts.userId, providerAccounts.providerId, providerAccounts.label],
        set: { authBlob: sealJson(state, this.key), authMeta: state.meta, status: 'active' },
      })
      .returning();
    return this.summary(row!);
  }

  driveConfig(): GoogleOAuthConfig {
    return googleOAuthConfig(this.config);
  }

  /** Begin the Drive OAuth flow; returns the Google consent URL. */
  startDriveConnect(userId: string): string {
    const state = `${userId}.${Math.floor(Date.now() / 1000)}.${cryptoRandom()}`;
    this.oauthState.set(state, { userId, at: Date.now() });
    this.gcOauthState();
    return buildConsentUrl(this.driveConfig(), state);
  }

  /** Complete the Drive OAuth flow from the callback code+state. */
  async finishDriveConnect(state: string, code: string): Promise<AccountSummary> {
    const entry = this.oauthState.get(state);
    if (!entry) throw new Error('Invalid or expired OAuth state');
    this.oauthState.delete(state);
    const provider = new GDriveProvider(this.driveConfig());
    const authState = await provider.authenticate({ kind: 'oauth_code', code, redirectUri: this.driveConfig().redirectUri });
    const label = String(authState.meta.email ?? 'Google Drive');
    const [row] = await this.db
      .insert(providerAccounts)
      .values({
        userId: entry.userId,
        providerId: 'gdrive',
        label,
        authBlob: sealJson(authState, this.key),
        authMeta: authState.meta,
        status: 'active',
      })
      .onConflictDoUpdate({
        target: [providerAccounts.userId, providerAccounts.providerId, providerAccounts.label],
        set: { authBlob: sealJson(authState, this.key), authMeta: authState.meta, status: 'active' },
      })
      .returning();
    return this.summary(row!);
  }

  async remove(userId: string, accountId: string): Promise<void> {
    await this.db
      .delete(providerAccounts)
      .where(and(eq(providerAccounts.id, accountId), eq(providerAccounts.userId, userId)));
  }

  private summary(r: typeof providerAccounts.$inferSelect): AccountSummary {
    return {
      id: r.id,
      providerId: r.providerId,
      label: r.label,
      status: r.status,
      email: String((r.authMeta as Record<string, unknown>).email ?? ''),
      quotaTotal: r.quotaTotal,
      quotaUsed: r.quotaUsed,
    };
  }

  private gcOauthState(): void {
    const cutoff = Date.now() - 10 * 60 * 1000;
    for (const [k, v] of this.oauthState) if (v.at < cutoff) this.oauthState.delete(k);
  }
}

function cryptoRandom(): string {
  return Math.random().toString(36).slice(2, 10);
}
