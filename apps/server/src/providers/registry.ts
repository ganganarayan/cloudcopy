import type { AuthState, CloudProvider } from '@cloudcopy/provider-sdk';
import type { AppConfig } from '../config.js';
import { openJson } from '../security/crypto.js';
import { GDriveProvider } from './gdrive/gdrive.provider.js';
import { MegaProvider } from './mega/mega.provider.js';
import type { GoogleOAuthConfig } from './gdrive/oauth.js';

export interface AccountRow {
  id: string;
  providerId: string;
  authBlob: Buffer;
}

/** Registry contract — lets the engine accept a fake registry in tests. */
export interface IProviderRegistry {
  connect(account: AccountRow): Promise<CloudProvider>;
  invalidate(accountId: string): void;
}

export function googleOAuthConfig(config: AppConfig): GoogleOAuthConfig {
  if (!config.GOOGLE_CLIENT_ID || !config.GOOGLE_CLIENT_SECRET) {
    throw new Error('GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET are not configured');
  }
  const base = config.PUBLIC_URL ?? `http://localhost:${config.PORT}`;
  return {
    clientId: config.GOOGLE_CLIENT_ID,
    clientSecret: config.GOOGLE_CLIENT_SECRET,
    redirectUri: `${base}/api/v1/accounts/gdrive/callback`,
  };
}

/**
 * Instantiates connected providers from stored accounts. Caches instances by
 * account id — MEGA re-hydration in particular is expensive and worth reusing.
 */
export class ProviderRegistry implements IProviderRegistry {
  private cache = new Map<string, { provider: CloudProvider; at: number }>();
  private readonly key: Buffer;

  constructor(private readonly config: AppConfig) {
    this.key = Buffer.from(config.CREDENTIALS_KEY, 'base64');
  }

  private unseal(account: AccountRow): AuthState {
    return openJson<AuthState>(account.authBlob, this.key);
  }

  async connect(account: AccountRow): Promise<CloudProvider> {
    const cached = this.cache.get(account.id);
    if (cached && Date.now() - cached.at < 30 * 60 * 1000) return cached.provider;
    const state = this.unseal(account);
    let provider: CloudProvider;
    if (account.providerId === 'gdrive') {
      provider = new GDriveProvider(
        googleOAuthConfig(this.config),
        JSON.parse(state.session) as { refreshToken: string; sub: string; email: string },
      );
    } else if (account.providerId === 'mega') {
      provider = await MegaProvider.fromSession(state.session);
    } else {
      throw new Error(`Unknown provider ${account.providerId}`);
    }
    this.cache.set(account.id, { provider, at: Date.now() });
    return provider;
  }

  invalidate(accountId: string): void {
    this.cache.delete(accountId);
  }
}
