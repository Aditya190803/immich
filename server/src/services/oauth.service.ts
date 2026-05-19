import { Injectable } from '@nestjs/common';
import { createOAuthState } from 'src/auth/oauth-state.store';
import * as onedrive from 'src/auth/providers/onedrive';
import { SystemConfig } from 'src/config';
import { CloudStorageProvider } from 'src/enum';
import { CloudStorageCredentialsRepository } from 'src/repositories/cloud-storage-credentials.repository';
import { SystemConfigService } from 'src/services/system-config.service';

export interface ConnectionStatus {
  connected: boolean;
  provider: CloudStorageProvider | null;
  quota?: { used: number; total: number };
  folderName?: string;
}

@Injectable()
export class OAuthService {
  constructor(
    private credentialsRepository: CloudStorageCredentialsRepository,
    private systemConfigService: SystemConfigService,
  ) {}

  private async getCloudStorageConfig(): Promise<SystemConfig['cloudStorage']> {
    const config = await this.systemConfigService.getSystemConfig();
    return config.cloudStorage;
  }

  private async getOneDriveConfig() {
    const config = await this.getCloudStorageConfig();
    // Client ID can come from the admin UI (system config) or env var
    const clientId = config.onedrive.clientId || process.env.IMMICH_ONEDRIVE_CLIENT_ID || '';

    if (!clientId) {
      throw new Error(
        'OneDrive client ID is not configured. Enter your Azure AD Application (client) ID in the Cloud Storage admin settings, or set IMMICH_ONEDRIVE_CLIENT_ID in your environment.',
      );
    }

    return { clientId };
  }

  async connect(provider: CloudStorageProvider, clientOrigin?: string): Promise<{ url: string }> {
    let url: string;

    switch (provider) {
      case CloudStorageProvider.ONEDRIVE: {
        const config = await this.getOneDriveConfig();
        // Generate PKCE pair — store verifier in state, send challenge to Microsoft
        const { codeVerifier, codeChallenge } = onedrive.generatePkce();
        const state = createOAuthState(provider, config, codeVerifier, clientOrigin);
        url = onedrive.buildOneDriveAuthUrl(config, state, codeChallenge);
        break;
      }
      default: {
        throw new Error(`Unsupported provider: ${provider}`);
      }
    }

    return { url };
  }

  async callback(
    provider: CloudStorageProvider,
    providerConfig: { clientId: string } | { clientId: string; clientSecret: string },
    code: string,
    codeVerifier?: string,
  ): Promise<void> {
    let tokens: { accessToken: string; refreshToken: string; expiresAt: number; tokenType: string };
    let rootFolderId: string;

    switch (provider) {
      case CloudStorageProvider.ONEDRIVE: {
        // PKCE flow: pass the code_verifier so Microsoft can validate
        tokens = await onedrive.exchangeOneDriveCode(
          providerConfig as { clientId: string },
          code,
          codeVerifier || '',
        );
        rootFolderId = await onedrive.createOneDriveFolder(tokens.accessToken);
        break;
      }
      default: {
        throw new Error(`Unsupported provider: ${provider}`);
      }
    }

    await this.credentialsRepository.setCredentials(provider, {
      provider,
      ...tokens,
      rootFolderId,
    });
  }

  async disconnect(provider: CloudStorageProvider): Promise<void> {
    await this.credentialsRepository.deleteCredentials(provider);
  }

  async getValidToken(provider: CloudStorageProvider): Promise<string> {
    const credentials = await this.credentialsRepository.getCredentials(provider);
    if (!credentials) {
      throw new Error(`No credentials found for provider: ${provider}`);
    }

    const now = Date.now();
    if (credentials.expiresAt - 60 * 1000 < now) {
      let newTokens: { accessToken: string; refreshToken: string; expiresAt: number; tokenType: string };

      switch (provider) {
        case CloudStorageProvider.ONEDRIVE: {
          newTokens = await onedrive.refreshOneDriveTokens(await this.getOneDriveConfig(), credentials.refreshToken);
          break;
        }
        default: {
          throw new Error(`Unsupported provider: ${provider}`);
        }
      }

      await this.credentialsRepository.setCredentials(provider, {
        provider,
        ...newTokens,
        rootFolderId: credentials.rootFolderId,
      });

      return newTokens.accessToken;
    }

    return credentials.accessToken;
  }

  async isConnected(provider: CloudStorageProvider): Promise<boolean> {
    return this.credentialsRepository.hasCredentials(provider);
  }

  async getConnectionStatus(provider: CloudStorageProvider): Promise<ConnectionStatus> {
    const credentials = await this.credentialsRepository.getCredentials(provider);
    
    if (!credentials) {
      return { connected: false, provider };
    }

    let quota: { used: number; total: number } | undefined;
    try {
      const token = await this.getValidToken(provider);
      switch (provider) {
        case CloudStorageProvider.ONEDRIVE: {
          quota = await onedrive.getOneDriveQuota(token);
          break;
        }
      }
    } catch (error) {
      console.error(`Failed to get quota for ${provider}:`, error);
    }

    return {
      connected: true,
      provider,
      quota,
      folderName: 'Immich',
    };
  }
}
