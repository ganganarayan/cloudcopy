/**
 * Credential shapes. What gets sealed (AES-256-GCM) and persisted is the
 * AuthState — never raw passwords. MEGA: the serialized session only.
 */
export type ProviderCredentials =
  | { kind: 'password'; email: string; password: string } // in-memory only, never persisted
  | { kind: 'oauth_code'; code: string; redirectUri: string }
  | { kind: 'session'; session: string } // previously persisted AuthState re-hydrated
  | { kind: 'oauth_tokens'; refreshToken: string; accessToken?: string; expiresAt?: number };

/** What the adapter returns after authenticate()/refresh() — this is what gets sealed + stored. */
export interface AuthState {
  /** Opaque serialized session/token material. NEVER contains a user password. */
  session: string;
  /** Non-secret display metadata (email, account id, scopes) stored in plaintext columns. */
  meta: Record<string, string>;
  /** Epoch ms when the session/access token expires, if known. */
  expiresAt?: number;
}
