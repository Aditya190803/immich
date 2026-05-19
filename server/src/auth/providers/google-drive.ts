export const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const GOOGLE_SCOPES = 'https://www.googleapis.com/auth/drive.file';

export interface GoogleDriveOAuthConfig {
  clientId: string;
  clientSecret: string;
}

export interface GoogleDriveTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  tokenType: string;
}

export function buildGoogleDriveAuthUrl(config: GoogleDriveOAuthConfig, state: string): string {
  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: `${process.env.IMMICH_PUBLIC_LOGIN_PAGE_URI || 'http://localhost:2283'}/api/cloud-storage/callback/google_drive`,
    response_type: 'code',
    scope: GOOGLE_SCOPES,
    access_type: 'offline',
    prompt: 'consent',
    state,
  });
  return `${GOOGLE_AUTH_URL}?${params.toString()}`;
}

export async function exchangeGoogleDriveCode(config: GoogleDriveOAuthConfig, code: string): Promise<GoogleDriveTokens> {
  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code,
      grant_type: 'authorization_code',
      redirect_uri: `${process.env.IMMICH_PUBLIC_LOGIN_PAGE_URI || 'http://localhost:2283'}/api/cloud-storage/callback/google_drive`,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Google Drive token exchange failed: ${error}`);
  }

  const data = await response.json();
  const expiresAt = Date.now() + data.expires_in * 1000;

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt,
    tokenType: data.token_type,
  };
}

export async function refreshGoogleDriveTokens(
  config: GoogleDriveOAuthConfig,
  refreshToken: string,
): Promise<GoogleDriveTokens> {
  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Google Drive token refresh failed: ${error}`);
  }

  const data = await response.json();
  const expiresAt = Date.now() + (data.expires_in || 3600) * 1000;

  return {
    accessToken: data.access_token,
    refreshToken,
    expiresAt,
    tokenType: data.token_type || 'Bearer',
  };
}

export async function createGoogleDriveFolder(accessToken: string): Promise<string> {
  const response = await fetch('https://www.googleapis.com/drive/v3/files', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name: 'Immich',
      mimeType: 'application/vnd.google-apps.folder',
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to create Google Drive folder: ${error}`);
  }

  const data = await response.json();
  return data.id;
}

export async function getGoogleDriveQuota(accessToken: string): Promise<{ used: number; total: number }> {
  const response = await fetch('https://www.googleapis.com/drive/v3/about?fields=storageQuota', {
    headers: {
      'Authorization': `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to get Google Drive quota: ${error}`);
  }

  const data = await response.json();
  return {
    used: Number.parseInt(data.storageQuota.usage, 10),
    total: Number.parseInt(data.storageQuota.limit, 10),
  };
}
