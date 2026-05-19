import { BadRequestException, Controller, Delete, Get, Param, Post, Query, Req, Res } from '@nestjs/common';
import { ApiParam, ApiTags } from '@nestjs/swagger';
import { Request, Response } from 'express';
import { validateOAuthState } from 'src/auth/oauth-state.store';
import { Endpoint } from 'src/decorators';
import { CloudStorageConnectResponse, CloudStorageStatus } from 'src/dtos/cloud-storage.dto';
import { ApiTag, CloudStorageProvider, Permission } from 'src/enum';
import { Authenticated } from 'src/middleware/auth.guard';
import { CloudStorageService } from 'src/services/cloud-storage.service';
import { OAuthService } from 'src/services/oauth.service';
import { SystemConfigService } from 'src/services/system-config.service';

@ApiTags(ApiTag.CloudStorage)
@Controller('cloud-storage')
export class CloudStorageController {
  constructor(
    private oauthService: OAuthService,
    private cloudStorageService: CloudStorageService,
    private systemConfigService: SystemConfigService,
  ) {}

  @Get('status')
  @Authenticated({ permission: Permission.SystemConfigRead, admin: true })
  @Endpoint({
    summary: 'Get cloud storage status',
    description: 'Get the current connection status of cloud storage.',
  })
  async getStatus(): Promise<CloudStorageStatus> {
    const provider = this.cloudStorageService.getActiveProvider();
    if (!provider) {
      return { connected: false, provider: null };
    }

    return this.oauthService.getConnectionStatus(provider);
  }

  @Post('connect/:provider')
  @Authenticated({ permission: Permission.SystemConfigUpdate, admin: true })
  @ApiParam({ name: 'provider', enum: CloudStorageProvider })
  @Endpoint({
    summary: 'Connect to cloud storage provider',
    description: 'Initiate OAuth flow to connect to a cloud storage provider.',
  })
  async connect(@Param('provider') provider: string, @Req() req: Request): Promise<CloudStorageConnectResponse> {
    const cloudProvider = provider as CloudStorageProvider;
    if (cloudProvider !== CloudStorageProvider.ONEDRIVE) {
      throw new BadRequestException('Only OneDrive cloud storage is supported right now');
    }

    const config = await this.systemConfigService.getSystemConfig();
    await this.systemConfigService.updateSystemConfig({
      ...config,
      cloudStorage: {
        ...config.cloudStorage,
        enabled: true,
        provider: cloudProvider,
      },
    });

    // Dynamically retrieve SvelteKit/Immich Web frontend origin from Referer/Origin headers
    let clientOrigin = '';
    const referer = req.headers.referer;
    const origin = req.headers.origin;
    if (referer) {
      try {
        clientOrigin = new URL(referer).origin;
      } catch {}
    } else if (origin) {
      try {
        clientOrigin = new URL(origin as string).origin;
      } catch {}
    }

    const result = await this.oauthService.connect(cloudProvider, clientOrigin || undefined);
    this.cloudStorageService.setActiveProvider(cloudProvider);
    return result;
  }

  @Get('callback/:provider')
  @ApiParam({ name: 'provider', enum: CloudStorageProvider })
  @Endpoint({
    summary: 'OAuth callback',
    description: 'Callback endpoint for OAuth flow.',
  })
  async callback(
    @Param('provider') provider: string,
    @Query('code') code: string,
    @Query('state') state: string,
    @Res() res: Response,
  ): Promise<void> {
    const cloudProvider = provider as CloudStorageProvider;
    const oauthState = validateOAuthState(state);

    if (!oauthState.valid || oauthState.provider !== cloudProvider || !oauthState.providerConfig) {
      throw new Error('Invalid or expired OAuth state');
    }

    await this.oauthService.callback(cloudProvider, oauthState.providerConfig, code, oauthState.codeVerifier);

    const targetOrigin = oauthState.clientOrigin || process.env.IMMICH_PUBLIC_LOGIN_PAGE_URI || 'http://localhost:2283';
    res.redirect(`${targetOrigin}/admin/system-settings?cloud-storage=connected`);
  }

  @Delete('disconnect')
  @Authenticated({ permission: Permission.SystemConfigUpdate, admin: true })
  @Endpoint({
    summary: 'Disconnect cloud storage',
    description: 'Disconnect from the current cloud storage provider.',
  })
  async disconnect(): Promise<void> {
    const provider = this.cloudStorageService.getActiveProvider();
    if (provider) {
      await this.oauthService.disconnect(provider);
    }

    const config = await this.systemConfigService.getSystemConfig();
    await this.systemConfigService.updateSystemConfig({
      ...config,
      cloudStorage: {
        ...config.cloudStorage,
        enabled: false,
        provider: null,
      },
    });

    this.cloudStorageService.setActiveProvider(null);
  }

  @Get('config')
  @Authenticated({ permission: Permission.SystemConfigRead, admin: true })
  @Endpoint({
    summary: 'Get cloud storage config',
    description: 'Get cloud storage configuration.',
  })
  getConfig(): { enabled: boolean; provider: string | null } {
    const provider = this.cloudStorageService.getActiveProvider();
    return {
      enabled: this.cloudStorageService.isConfigured(),
      provider,
    };
  }
}
