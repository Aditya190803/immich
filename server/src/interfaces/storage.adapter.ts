import { CloudStorageProvider } from 'src/enum';

export interface CloudFileMetadata {
  id: string;
  name: string;
  size: number;
  mimeType: string;
  createdAt: Date;
  modifiedAt: Date;
  webUrl?: string;
}

export interface StorageUploadResult {
  cloudId: string;
  cloudPath: string;
  size: number;
  etag?: string;
}

export interface StorageQuota {
  used: number;
  total: number;
}

export abstract class StorageAdapter {
  abstract readonly name: string;
  abstract readonly provider: CloudStorageProvider;
  abstract readonly requiresOAuth: boolean;

  abstract upload(buffer: Buffer, path: string, mimeType: string): Promise<StorageUploadResult>;
  abstract download(cloudPath: string): Promise<Buffer>;
  abstract delete(cloudPath: string): Promise<void>;
  abstract getMetadata(cloudPath: string): Promise<CloudFileMetadata>;
  abstract list(prefix: string): Promise<CloudFileMetadata[]>;
  abstract exists(cloudPath: string): Promise<boolean>;
  abstract getQuota(): Promise<StorageQuota>;
}