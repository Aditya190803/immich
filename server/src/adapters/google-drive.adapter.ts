import { Injectable } from '@nestjs/common';
import { CloudStorageProvider } from 'src/enum';
import { StorageAdapter, StorageUploadResult, StorageQuota, CloudFileMetadata } from 'src/interfaces/storage.adapter';
import { OAuthService } from 'src/services/oauth.service';

const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3';

@Injectable()
export class GoogleDriveAdapter implements StorageAdapter {
  readonly name = 'Google Drive';
  readonly provider = CloudStorageProvider.GOOGLE_DRIVE;
  readonly requiresOAuth = true;

  constructor(private oauthService: OAuthService) {}

  private async getAccessToken(): Promise<string> {
    return this.oauthService.getValidToken(CloudStorageProvider.GOOGLE_DRIVE);
  }

  async upload(buffer: Buffer, path: string, mimeType: string): Promise<StorageUploadResult> {
    const accessToken = await this.getAccessToken();
    const filePath = `Immich/${path}`;
    const fileName = path.split('/').pop() || 'file';
    const parentFolderId = await this.getOrCreateFolder('Immich');

    const metadata = {
      name: fileName,
      parents: [parentFolderId],
    };

    const form = new FormData();
    form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
    form.append('file', new Blob([new Uint8Array(buffer)], { type: mimeType }));

    const response = await fetch(`${UPLOAD_API}/files?uploadType=multipart`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
      },
      body: form as any,
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Google Drive upload failed: ${error}`);
    }

    const data = await response.json();
    return {
      cloudId: data.id,
      cloudPath: filePath,
      size: buffer.length,
      etag: data.etag,
    };
  }

  async download(cloudPath: string): Promise<Buffer> {
    const accessToken = await this.getAccessToken();
    const fileId = await this.getFileId(cloudPath);

    const response = await fetch(`${DRIVE_API}/files/${fileId}?alt=media`, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
      },
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Google Drive download failed: ${error}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }

  async delete(cloudPath: string): Promise<void> {
    const accessToken = await this.getAccessToken();
    const fileId = await this.getFileId(cloudPath);

    const response = await fetch(`${DRIVE_API}/files/${fileId}`, {
      method: 'DELETE',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
      },
    });

    if (!response.ok && response.status !== 404) {
      const error = await response.text();
      throw new Error(`Google Drive delete failed: ${error}`);
    }
  }

  async getMetadata(cloudPath: string): Promise<CloudFileMetadata> {
    const accessToken = await this.getAccessToken();
    const fileId = await this.getFileId(cloudPath);

    const response = await fetch(`${DRIVE_API}/files/${fileId}?fields=id,name,size,mimeType,createdTime,modifiedTime,webViewLink`, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
      },
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Google Drive getMetadata failed: ${error}`);
    }

    const data = await response.json();
    return {
      id: data.id,
      name: data.name,
      size: Number.parseInt(data.size, 10),
      mimeType: data.mimeType,
      createdAt: new Date(data.createdTime),
      modifiedAt: new Date(data.modifiedTime),
      webUrl: data.webViewLink,
    };
  }

  async list(prefix: string): Promise<CloudFileMetadata[]> {
    const accessToken = await this.getAccessToken();
    const folderId = await this.getOrCreateFolder(`Immich${prefix ? '/' + prefix : ''}`);

    const response = await fetch(
      `${DRIVE_API}/files?q='${folderId}'%20in%20parents&fields=files(id,name,size,mimeType,createdTime,modifiedTime,webViewLink)`,
      {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
        },
      }
    );

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Google Drive list failed: ${error}`);
    }

    const data = await response.json();
    return (data.files || []).map((item: any) => ({
      id: item.id,
      name: item.name,
      size: Number.parseInt(item.size, 10),
      mimeType: item.mimeType,
      createdAt: new Date(item.createdTime),
      modifiedAt: new Date(item.modifiedTime),
      webUrl: item.webViewLink,
    }));
  }

  async exists(cloudPath: string): Promise<boolean> {
    try {
      await this.getFileId(cloudPath);
      return true;
    } catch {
      return false;
    }
  }

  async getQuota(): Promise<StorageQuota> {
    const accessToken = await this.getAccessToken();
    const response = await fetch(`${DRIVE_API}/about?fields=storageQuota`, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
      },
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Google Drive getQuota failed: ${error}`);
    }

    const data = await response.json();
    return {
      used: Number.parseInt(data.storageQuota.usage, 10),
      total: Number.parseInt(data.storageQuota.limit, 10),
    };
  }

  private async getFileId(cloudPath: string): Promise<string> {
    const accessToken = await this.getAccessToken();
    const pathParts = cloudPath.split('/');
    let parentId = await this.getOrCreateFolder('Immich');

    for (let i = 0; i < pathParts.length - 1; i++) {
      parentId = await this.getOrCreateFolder(pathParts[i], parentId);
    }

    const fileName = pathParts.at(-1);
    const response = await fetch(
      `${DRIVE_API}/files?q=name='${fileName}'%20and%20'${parentId}'%20in%20parents&fields=files(id)`,
      {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
        },
      }
    );

    if (!response.ok) {
      throw new Error(`Failed to get file ID: ${await response.text()}`);
    }

    const data = await response.json();
    if (!data.files || data.files.length === 0) {
      throw new Error(`File not found: ${cloudPath}`);
    }

    return data.files[0].id;
  }

  private async getOrCreateFolder(name: string, parentId?: string): Promise<string> {
    const accessToken = await this.getAccessToken();
    let query = `name='${name}' and mimeType='application/vnd.google-apps.folder'`;
    query += parentId ? ` and '${parentId}' in parents` : ` and 'root' in parents`;

    const searchResponse = await fetch(`${DRIVE_API}/files?q=${encodeURIComponent(query)}&fields=files(id)`, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
      },
    });

    const searchData = await searchResponse.json();
    if (searchData.files && searchData.files.length > 0) {
      return searchData.files[0].id;
    }

    const createResponse = await fetch(`${DRIVE_API}/files`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name,
        mimeType: 'application/vnd.google-apps.folder',
        parents: parentId ? [parentId] : ['root'],
      }),
    });

    const createData = await createResponse.json();
    return createData.id;
  }
}