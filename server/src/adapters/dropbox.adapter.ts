import { Injectable } from '@nestjs/common';
import { CloudStorageProvider } from 'src/enum';
import { StorageAdapter, StorageUploadResult, StorageQuota, CloudFileMetadata } from 'src/interfaces/storage.adapter';
import { OAuthService } from 'src/services/oauth.service';

const DROPBOX_API = 'https://api.dropboxapi.com/2';
const CONTENT_API = 'https://content.dropboxapi.com/2';

@Injectable()
export class DropboxAdapter implements StorageAdapter {
  readonly name = 'Dropbox';
  readonly provider = CloudStorageProvider.DROPBOX;
  readonly requiresOAuth = true;

  constructor(private oauthService: OAuthService) {}

  private async getAccessToken(): Promise<string> {
    return this.oauthService.getValidToken(CloudStorageProvider.DROPBOX);
  }

  async upload(buffer: Buffer, path: string, _mimeType: string): Promise<StorageUploadResult> {
    const accessToken = await this.getAccessToken();
    const uploadPath = `/Immich/${path}`;

    const response = await fetch(`${CONTENT_API}/files/upload`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/octet-stream',
        'Dropbox-API-Arg': JSON.stringify({
          path: uploadPath,
          mode: 'add',
          autorename: true,
          mute: false,
        }),
      },
      body: new Uint8Array(buffer),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Dropbox upload failed: ${error}`);
    }

    const data = await response.json();
    return {
      cloudId: data.id,
      cloudPath: data.path_display,
      size: data.size,
      etag: data.content_hash,
    };
  }

  async download(cloudPath: string): Promise<Buffer> {
    const accessToken = await this.getAccessToken();

    const response = await fetch(`${CONTENT_API}/files/download`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Dropbox-API-Arg': JSON.stringify({
          path: cloudPath,
        }),
      },
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Dropbox download failed: ${error}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }

  async delete(cloudPath: string): Promise<void> {
    const accessToken = await this.getAccessToken();
    const response = await fetch(`${DROPBOX_API}/files/delete_v2`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ path: cloudPath }),
    });

    if (!response.ok && response.status !== 404) {
      const error = await response.text();
      throw new Error(`Dropbox delete failed: ${error}`);
    }
  }

  async getMetadata(cloudPath: string): Promise<CloudFileMetadata> {
    const accessToken = await this.getAccessToken();
    const response = await fetch(`${DROPBOX_API}/files/get_metadata`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ path: cloudPath }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Dropbox getMetadata failed: ${error}`);
    }

    const data = await response.json();
    return {
      id: data.id,
      name: data.name,
      size: data.size,
      mimeType: data.name.split('.').pop() ? `application/${data.name.split('.').pop()}` : 'application/octet-stream',
      createdAt: new Date(data.client_modified),
      modifiedAt: new Date(data.client_modified),
    };
  }

  async list(prefix: string): Promise<CloudFileMetadata[]> {
    const accessToken = await this.getAccessToken();
    const folderPath = prefix ? `/Immich/${prefix}` : '/Immich';

    const response = await fetch(`${DROPBOX_API}/files/list_folder`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        path: folderPath,
        recursive: false,
        include_media_info: false,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Dropbox list failed: ${error}`);
    }

    const data = await response.json();
    return (data.entries || []).map((item: any) => ({
      id: item.id,
      name: item.name,
      size: item.size,
      mimeType: item.name.split('.').pop() ? `application/${item.name.split('.').pop()}` : 'application/octet-stream',
      createdAt: new Date(item.client_modified),
      modifiedAt: new Date(item.client_modified),
    }));
  }

  async exists(cloudPath: string): Promise<boolean> {
    const accessToken = await this.getAccessToken();
    const response = await fetch(`${DROPBOX_API}/files/get_metadata`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ path: cloudPath }),
    });
    return response.ok;
  }

  async getQuota(): Promise<StorageQuota> {
    const accessToken = await this.getAccessToken();
    const response = await fetch(`${DROPBOX_API}/users/get_space_usage`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
      },
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Dropbox getQuota failed: ${error}`);
    }

    const data = await response.json();
    return {
      used: data.used,
      total: data.allocation.allocated,
    };
  }
}
