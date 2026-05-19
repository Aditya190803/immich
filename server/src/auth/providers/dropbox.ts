export const DROPBOX_AUTH_URL = 'https://dropbox.com/oauth2/authorize';
export const DROPBOX_TOKEN_URL = 'https://api.dropboxapi.com/oauth2/token';
export const DROPBOX_SCOPES = 'files.content.write files.content.read';

export interface DropboxOAuthConfig {
  clientId: string;
  clientSecret: string;
}

export interface DropboxTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  tokenType: string;
}

export function buildDropboxAuthUrl(config: DropboxOAuthConfig, state: string): string {
  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: `${process.env.IMMICH_PUBLIC_LOGIN_PAGE_URI || 'http://localhost:2283'}/api/cloud-storage/callback/dropbox`,
    response_type: 'code',
    token_access_type: 'offline',
    state,
  });
  return `${DROPBOX_AUTH_URL}?${params.toString()}`;
}

export async function exchangeDropboxCode(config: DropboxOAuthConfig, code: string): Promise<DropboxTokens> {
  const response = await fetch(DROPBOX_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code,
      grant_type: 'authorization_code',
      redirect_uri: `${process.env.IMMICH_PUBLIC_LOGIN_PAGE_URI || 'http://localhost:2283'}/api/cloud-storage/callback/dropbox`,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Dropbox token exchange failed: ${error}`);
  }

  const data = await response.json();
  const expiresAt = data.expires_in ? Date.now() + data.expires_in * 1000 : Date.now() + 14_400 * 1000;

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || '',
    expiresAt,
    tokenType: 'Bearer',
  };
}

export async function refreshDropboxTokens(config: DropboxOAuthConfig, refreshToken: string): Promise<DropboxTokens> {
  const response = await fetch(DROPBOX_TOKEN_URL, {
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
    throw new Error(`Dropbox token refresh failed: ${error}`);
  }

  const data = await response.json();
  const expiresAt = data.expires_in ? Date.now() + data.expires_in * 1000 : Date.now() + 14_400 * 1000;

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || refreshToken,
    expiresAt,
    tokenType: 'Bearer',
  };
}

export async function createDropboxFolder(accessToken: string): Promise<string> {
  const response = await fetch('https://api.dropboxapi.com/2/files/create_folder_v2', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      path: '/Immich',
      autorename: true,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to create Dropbox folder: ${error}`);
  }

  const data = await response.json();
  return data.metadata.id;
}

export async function getDropboxQuota(accessToken: string): Promise<{ used: number; total: number }> {
  const response = await fetch('https://api.dropboxapi.com/2/users/get_space_usage', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to get Dropbox quota: ${error}`);
  }

  const data = await response.json();
  return {
    used: data.used,
    total: data.allocation.allocated,
  };
}
