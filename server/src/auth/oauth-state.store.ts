import { randomUUID } from 'node:crypto';
import { CloudStorageProvider } from 'src/enum';

type OAuthProviderConfig =
  | { clientId: string }
  | { clientId: string; clientSecret: string };

interface OAuthState {
  provider: CloudStorageProvider;
  providerConfig: OAuthProviderConfig;
  /** PKCE code_verifier — stored here so the callback can retrieve it */
  codeVerifier?: string;
  clientOrigin?: string;
  createdAt: Date;
}

const STATE_EXPIRY_MS = 10 * 60 * 1000; // 10 minutes

const stateStore = new Map<string, OAuthState>();

setInterval(() => {
  const now = new Date();
  for (const [state, data] of stateStore) {
    if (now.getTime() - data.createdAt.getTime() > STATE_EXPIRY_MS) {
      stateStore.delete(state);
    }
  }
}, STATE_EXPIRY_MS);

export function createOAuthState(
  provider: CloudStorageProvider,
  providerConfig: OAuthProviderConfig,
  codeVerifier?: string,
  clientOrigin?: string,
): string {
  const state = randomUUID();
  stateStore.set(state, { provider, providerConfig, codeVerifier, clientOrigin, createdAt: new Date() });
  return state;
}

export function validateOAuthState(
  state: string,
): { valid: boolean; provider?: CloudStorageProvider; providerConfig?: OAuthProviderConfig; codeVerifier?: string; clientOrigin?: string } {
  const data = stateStore.get(state);
  if (!data) {
    return { valid: false };
  }

  const now = Date.now();
  if (now - data.createdAt.getTime() > STATE_EXPIRY_MS) {
    stateStore.delete(state);
    return { valid: false };
  }

  stateStore.delete(state);
  return { valid: true, provider: data.provider, providerConfig: data.providerConfig, codeVerifier: data.codeVerifier, clientOrigin: data.clientOrigin };
}
