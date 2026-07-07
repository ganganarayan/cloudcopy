import { OAuth2Client } from 'google-auth-library';

export const DRIVE_SCOPES = [
  'openid',
  'email',
  'profile',
  'https://www.googleapis.com/auth/drive',
];

export interface GoogleOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export function createOAuthClient(cfg: GoogleOAuthConfig): OAuth2Client {
  return new OAuth2Client({
    clientId: cfg.clientId,
    clientSecret: cfg.clientSecret,
    redirectUri: cfg.redirectUri,
  });
}

/** URL the browser is redirected to for consent. `state` carries our CSRF/return token. */
export function buildConsentUrl(cfg: GoogleOAuthConfig, state: string): string {
  return createOAuthClient(cfg).generateAuthUrl({
    access_type: 'offline', // request a refresh token
    prompt: 'consent', // force refresh_token issuance on re-consent
    scope: DRIVE_SCOPES,
    state,
  });
}

export interface GoogleIdentity {
  sub: string;
  email: string;
  name?: string;
  picture?: string;
  refreshToken: string;
  accessToken: string;
  expiryDate?: number;
}

/** Exchange an authorization code for tokens + verified identity. */
export async function exchangeCode(
  cfg: GoogleOAuthConfig,
  code: string,
): Promise<GoogleIdentity> {
  const client = createOAuthClient(cfg);
  const { tokens } = await client.getToken(code);
  if (!tokens.refresh_token) {
    throw new Error(
      'Google did not return a refresh token. Revoke the app at myaccount.google.com/permissions and reconnect.',
    );
  }
  client.setCredentials(tokens);
  const ticket = await client.verifyIdToken({
    idToken: tokens.id_token!,
    audience: cfg.clientId,
  });
  const payload = ticket.getPayload();
  if (!payload?.sub || !payload.email) throw new Error('Google id token missing sub/email');
  return {
    sub: payload.sub,
    email: payload.email,
    name: payload.name,
    picture: payload.picture,
    refreshToken: tokens.refresh_token,
    accessToken: tokens.access_token ?? '',
    expiryDate: tokens.expiry_date ?? undefined,
  };
}
