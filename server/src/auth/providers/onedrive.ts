// IMMICH_ONEDRIVE_TENANT controls which Microsoft accounts are supported:
//   'common'    — personal + work/school accounts (default)
//   'consumers' — personal accounts only
//   'organizations' — work/school accounts only
//   '<tenant-id>' — specific Azure AD tenant only
const TENANT = process.env.IMMICH_ONEDRIVE_TENANT || 'common';

export const ONEDRIVE_AUTH_URL = `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/authorize`;
export const ONEDRIVE_TOKEN_URL = `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`;
export const ONEDRIVE_SCOPES = 'Files.ReadWrite.All offline_access';

export interface OneDriveOAuthConfig {
  clientId: string;
}

interface OAuthTokenResponse {
  access_token: string;
  refresh_token?: string;
  token_type: string;
  expires_in: number;
  refresh_in?: number;
}

export interface OneDriveTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  tokenType: string;
}

// ─── PKCE helpers ────────────────────────────────────────────────────
import { randomBytes, createHash } from 'node:crypto';

/**
 * Generate a PKCE code_verifier (43–128 URL-safe chars) and its
 * SHA-256 code_challenge.
 */
export function generatePkce(): { codeVerifier: string; codeChallenge: string } {
  const codeVerifier = randomBytes(32)
    .toString('base64url')
    .slice(0, 128);
  const codeChallenge = createHash('sha256')
    .update(codeVerifier)
    .digest('base64url');
  return { codeVerifier, codeChallenge };
}

// ─── Auth URL ────────────────────────────────────────────────────────
export function buildOneDriveAuthUrl(
  config: OneDriveOAuthConfig,
  state: string,
  codeChallenge: string,
): string {
  const params = new URLSearchParams({
    client_id: config.clientId,
    response_type: 'code',
    redirect_uri: `${process.env.IMMICH_PUBLIC_LOGIN_PAGE_URI || 'http://localhost:2283'}/api/cloud-storage/callback/onedrive`,
    scope: ONEDRIVE_SCOPES,
    state,
    // PKCE parameters — makes client_secret unnecessary
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  });
  return `${ONEDRIVE_AUTH_URL}?${params.toString()}`;
}

// ─── Token exchange (using PKCE code_verifier instead of secret) ─────
export async function exchangeOneDriveCode(
  config: OneDriveOAuthConfig,
  code: string,
  codeVerifier: string,
): Promise<OneDriveTokens> {
  const bodyParams = new URLSearchParams({
    client_id: config.clientId,
    code,
    redirect_uri: `${process.env.IMMICH_PUBLIC_LOGIN_PAGE_URI || 'http://localhost:2283'}/api/cloud-storage/callback/onedrive`,
    grant_type: 'authorization_code',
    // PKCE: send the verifier so Microsoft can validate against the challenge
    code_verifier: codeVerifier,
  });

  const origin = new URL(process.env.IMMICH_PUBLIC_LOGIN_PAGE_URI || 'http://localhost:2283').origin;
  const response = await fetch(ONEDRIVE_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Origin': origin,
    },
    body: bodyParams,
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`OneDrive token exchange failed: ${error}`);
  }

  const data: OAuthTokenResponse & { expires_in: number; refresh_in: number } = await response.json();
  const expiresAt = Date.now() + data.expires_in * 1000;

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || '',
    expiresAt,
    tokenType: data.token_type,
  };
}

// ─── Token refresh ───────────────────────────────────────────────────
export async function refreshOneDriveTokens(
  config: OneDriveOAuthConfig,
  refreshToken: string,
): Promise<OneDriveTokens> {
  const origin = new URL(process.env.IMMICH_PUBLIC_LOGIN_PAGE_URI || 'http://localhost:2283').origin;
  const response = await fetch(ONEDRIVE_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Origin': origin,
    },
    body: new URLSearchParams({
      client_id: config.clientId,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`OneDrive token refresh failed: ${error}`);
  }

  const data: OAuthTokenResponse & { expires_in: number; refresh_in: number } = await response.json();
  const expiresAt = Date.now() + data.expires_in * 1000;

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || refreshToken,
    expiresAt,
    tokenType: data.token_type,
  };
}

// ─── Folder creation ─────────────────────────────────────────────────
export async function createOneDriveFolder(accessToken: string): Promise<string> {
  const response = await fetch('https://graph.microsoft.com/v1.0/me/drive/root/children', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name: 'Immich',
      folder: {},
      '@microsoft.graph.conflictBehavior': 'rename',
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to create OneDrive folder: ${error}`);
  }

  const data = await response.json();
  return data.id;
}

// ─── Quota ───────────────────────────────────────────────────────────
export async function getOneDriveQuota(accessToken: string): Promise<{ used: number; total: number }> {
  const response = await fetch('https://graph.microsoft.com/v1.0/me/drive', {
    headers: {
      'Authorization': `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to get OneDrive quota: ${error}`);
  }

  const data = await response.json();
  return {
    used: data.quota.used,
    total: data.quota.total,
  };
}
