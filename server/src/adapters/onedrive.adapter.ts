import { Injectable } from '@nestjs/common';
import { CloudStorageProvider } from 'src/enum';
import { StorageAdapter, StorageUploadResult, StorageQuota, CloudFileMetadata } from 'src/interfaces/storage.adapter';
import { OAuthService } from 'src/services/oauth.service';

const DRIVE_API = 'https://graph.microsoft.com/v1.0/me/drive';

@Injectable()
export class OneDriveAdapter implements StorageAdapter {
  readonly name = 'OneDrive';
  readonly provider = CloudStorageProvider.ONEDRIVE;
  readonly requiresOAuth = true;

  constructor(private oauthService: OAuthService) {}

  private async getAccessToken(): Promise<string> {
    return this.oauthService.getValidToken(CloudStorageProvider.ONEDRIVE);
  }

  async upload(buffer: Buffer, path: string, mimeType: string): Promise<StorageUploadResult> {
    const accessToken = await this.getAccessToken();
    const uploadPath = `Immich/${path}`;

    const response = await fetch(`${DRIVE_API}/root:/${encodeURIComponent(uploadPath)}:/content`, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': mimeType,
      },
      body: new Uint8Array(buffer),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`OneDrive upload failed: ${error}`);
    }

    const data = await response.json();
    return {
      cloudId: data.id,
      cloudPath: data.parentReference.path + '/' + data.name,
      size: data.size,
      etag: data.eTag,
    };
  }

  async download(cloudPath: string): Promise<Buffer> {
    const accessToken = await this.getAccessToken();
    const response = await fetch(`${DRIVE_API}/root:/${encodeURIComponent(cloudPath)}:/content`, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
      },
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`OneDrive download failed: ${error}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }

  async delete(cloudPath: string): Promise<void> {
    const accessToken = await this.getAccessToken();
    const response = await fetch(`${DRIVE_API}/root:/${encodeURIComponent(cloudPath)}:`, {
      method: 'DELETE',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
      },
    });

    if (!response.ok && response.status !== 404) {
      const error = await response.text();
      throw new Error(`OneDrive delete failed: ${error}`);
    }
  }

  async getMetadata(cloudPath: string): Promise<CloudFileMetadata> {
    const accessToken = await this.getAccessToken();
    const response = await fetch(`${DRIVE_API}/root:/${encodeURIComponent(cloudPath)}:`, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
      },
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`OneDrive getMetadata failed: ${error}`);
    }

    const data = await response.json();
    return {
      id: data.id,
      name: data.name,
      size: data.size,
      mimeType: data.file?.mimeType || 'application/octet-stream',
      createdAt: new Date(data.createdDateTime),
      modifiedAt: new Date(data.lastModifiedDateTime),
      webUrl: data.webUrl,
    };
  }

  async list(prefix: string): Promise<CloudFileMetadata[]> {
    const accessToken = await this.getAccessToken();
    const folderPath = prefix ? `Immich/${prefix}` : 'Immich';
    
    const response = await fetch(`${DRIVE_API}/root:/${encodeURIComponent(folderPath)}:/children`, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
      },
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`OneDrive list failed: ${error}`);
    }

    const data = await response.json();
    return (data.value || []).map((item: any) => ({
      id: item.id,
      name: item.name,
      size: item.size,
      mimeType: item.file?.mimeType || 'application/octet-stream',
      createdAt: new Date(item.createdDateTime),
      modifiedAt: new Date(item.lastModifiedDateTime),
      webUrl: item.webUrl,
    }));
  }

  async exists(cloudPath: string): Promise<boolean> {
    const accessToken = await this.getAccessToken();
    const response = await fetch(`${DRIVE_API}/root:/${encodeURIComponent(cloudPath)}:`, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
      },
    });
    return response.ok;
  }

  async getQuota(): Promise<StorageQuota> {
    const accessToken = await this.getAccessToken();
    const response = await fetch(`${DRIVE_API}`, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
      },
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`OneDrive getQuota failed: ${error}`);
    }

    const data = await response.json();
    return {
      used: data.quota.used,
      total: data.quota.total,
    };
  }
}