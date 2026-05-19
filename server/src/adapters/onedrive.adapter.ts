import { Injectable } from '@nestjs/common';
import { createReadStream, createWriteStream } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { CloudStorageProvider } from 'src/enum';
import { CloudFileMetadata, StorageAdapter, StorageQuota, StorageUploadResult } from 'src/interfaces/storage.adapter';
import { OAuthService } from 'src/services/oauth.service';

const DRIVE_API = 'https://graph.microsoft.com/v1.0/me/drive';
const SIMPLE_UPLOAD_LIMIT = 4 * 1024 * 1024;
const UPLOAD_CHUNK_SIZE = 8 * 1024 * 1024;

const encodeDrivePath = (path: string) => path.split('/').map(encodeURIComponent).join('/');

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

    const response = await fetch(`${DRIVE_API}/root:/${encodeDrivePath(uploadPath)}:/content`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${accessToken}`,
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
      cloudPath: uploadPath,
      size: data.size,
      etag: data.eTag,
    };
  }

  async uploadFile(localPath: string, path: string, mimeType: string): Promise<StorageUploadResult> {
    const accessToken = await this.getAccessToken();
    const uploadPath = `Immich/${path}`;
    const { size } = await stat(localPath);

    if (size > SIMPLE_UPLOAD_LIMIT) {
      return this.uploadLargeFile(accessToken, localPath, uploadPath, size);
    }

    const response = await fetch(`${DRIVE_API}/root:/${encodeDrivePath(uploadPath)}:/content`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': mimeType,
        'Content-Length': String(size),
      },
      body: createReadStream(localPath) as any,
      duplex: 'half',
    } as any);

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`OneDrive upload failed: ${error}`);
    }

    const data = await response.json();
    return {
      cloudId: data.id,
      cloudPath: uploadPath,
      size: data.size,
      etag: data.eTag,
    };
  }

  private async uploadLargeFile(
    accessToken: string,
    localPath: string,
    uploadPath: string,
    size: number,
  ): Promise<StorageUploadResult> {
    const sessionResponse = await fetch(`${DRIVE_API}/root:/${encodeDrivePath(uploadPath)}:/createUploadSession`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ item: { '@microsoft.graph.conflictBehavior': 'replace' } }),
    });

    if (!sessionResponse.ok) {
      const error = await sessionResponse.text();
      throw new Error(`OneDrive upload session failed: ${error}`);
    }

    const session = await sessionResponse.json();
    const file = await open(localPath, 'r');
    let item: any;

    try {
      for (let start = 0; start < size; start += UPLOAD_CHUNK_SIZE) {
        const end = Math.min(start + UPLOAD_CHUNK_SIZE, size) - 1;
        const length = end - start + 1;
        const buffer = Buffer.allocUnsafe(length);
        await file.read(buffer, 0, length, start);

        const response = await fetch(session.uploadUrl, {
          method: 'PUT',
          headers: {
            'Content-Length': String(length),
            'Content-Range': `bytes ${start}-${end}/${size}`,
          },
          body: new Uint8Array(buffer),
        });

        if (!response.ok) {
          const error = await response.text();
          throw new Error(`OneDrive chunk upload failed: ${error}`);
        }

        item = await response.json();
      }
    } finally {
      await file.close();
    }

    return {
      cloudId: item.id,
      cloudPath: uploadPath,
      size: item.size,
      etag: item.eTag,
    };
  }

  async download(cloudPath: string): Promise<Buffer> {
    const accessToken = await this.getAccessToken();
    const response = await fetch(`${DRIVE_API}/root:/${encodeDrivePath(cloudPath)}:/content`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`OneDrive download failed: ${error}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }

  async downloadFile(cloudPath: string, localPath: string): Promise<void> {
    const accessToken = await this.getAccessToken();
    const response = await fetch(`${DRIVE_API}/root:/${encodeDrivePath(cloudPath)}:/content`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    if (!response.ok || !response.body) {
      const error = await response.text();
      throw new Error(`OneDrive download failed: ${error}`);
    }

    await pipeline(response.body as any, createWriteStream(localPath));
  }

  async delete(cloudPath: string): Promise<void> {
    const accessToken = await this.getAccessToken();
    const response = await fetch(`${DRIVE_API}/root:/${encodeDrivePath(cloudPath)}:`, {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    if (!response.ok && response.status !== 404) {
      const error = await response.text();
      throw new Error(`OneDrive delete failed: ${error}`);
    }
  }

  async getMetadata(cloudPath: string): Promise<CloudFileMetadata> {
    const accessToken = await this.getAccessToken();
    const response = await fetch(`${DRIVE_API}/root:/${encodeDrivePath(cloudPath)}:`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
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

    const response = await fetch(`${DRIVE_API}/root:/${encodeDrivePath(folderPath)}:/children`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
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
    const response = await fetch(`${DRIVE_API}/root:/${encodeDrivePath(cloudPath)}:`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });
    return response.ok;
  }

  async getQuota(): Promise<StorageQuota> {
    const accessToken = await this.getAccessToken();
    const response = await fetch(`${DRIVE_API}`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
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
