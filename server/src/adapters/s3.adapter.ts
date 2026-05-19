import { Injectable, Inject, forwardRef } from '@nestjs/common';
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, HeadObjectCommand, ListObjectsV2Command, HeadBucketCommand } from '@aws-sdk/client-s3';
import { CloudStorageProvider } from 'src/enum';
import { StorageAdapter, StorageUploadResult, StorageQuota, CloudFileMetadata } from 'src/interfaces/storage.adapter';
import { SystemConfigService } from 'src/services/system-config.service';

@Injectable()
export class S3Adapter implements StorageAdapter {
  readonly name = 'S3 Compatible';
  readonly provider = CloudStorageProvider.S3_COMPATIBLE;
  readonly requiresOAuth = false;

  private client: S3Client | null = null;
  private bucket: string = '';
  private config: any = null;

  constructor(
    @Inject(forwardRef(() => SystemConfigService))
    private systemConfigService: SystemConfigService,
  ) {}

  private async initClient(): Promise<void> {
    if (this.client) {return;}

    const config = await this.systemConfigService.getSystemConfig();
    this.config = config.cloudStorage?.s3;
    this.bucket = this.config?.bucket || '';

    if (!this.config?.endpoint || !this.config?.accessKey || !this.config?.secretKey || !this.bucket) {
      throw new Error('S3 not configured');
    }

    this.client = new S3Client({
      endpoint: this.config.endpoint,
      region: this.config.region || 'us-east-1',
      credentials: {
        accessKeyId: this.config.accessKey,
        secretAccessKey: this.config.secretKey,
      },
      forcePathStyle: true,
    });
  }

  async upload(buffer: Buffer, path: string, mimeType: string): Promise<StorageUploadResult> {
    await this.initClient();
    const key = `immich/${path}`;

    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      Body: new Uint8Array(buffer),
      ContentType: mimeType,
    });

    const result = await this.client!.send(command);

    return {
      cloudId: key,
      cloudPath: key,
      size: buffer.length,
      etag: result.ETag,
    };
  }

  async download(cloudPath: string): Promise<Buffer> {
    await this.initClient();

    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: cloudPath,
    });

    const result = await this.client!.send(command);
    if (!result.Body) {
      throw new Error('Empty response from S3');
    }

    const stream = result.Body as any;
    const chunks: Uint8Array[] = [];
    for await (const chunk of stream) {
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }

  async delete(cloudPath: string): Promise<void> {
    await this.initClient();

    const command = new DeleteObjectCommand({
      Bucket: this.bucket,
      Key: cloudPath,
    });

    await this.client!.send(command);
  }

  async getMetadata(cloudPath: string): Promise<CloudFileMetadata> {
    await this.initClient();

    const command = new HeadObjectCommand({
      Bucket: this.bucket,
      Key: cloudPath,
    });

    const result = await this.client!.send(command);
    const fileName = cloudPath.split('/').pop() || 'file';

    return {
      id: cloudPath,
      name: fileName,
      size: result.ContentLength || 0,
      mimeType: result.ContentType || 'application/octet-stream',
      createdAt: result.LastModified || new Date(),
      modifiedAt: result.LastModified || new Date(),
    };
  }

  async list(prefix: string): Promise<CloudFileMetadata[]> {
    await this.initClient();
    const prefixKey = prefix ? `immich/${prefix}` : 'immich';

    const command = new ListObjectsV2Command({
      Bucket: this.bucket,
      Prefix: prefixKey,
    });

    const result = await this.client!.send(command);
    return (result.Contents || []).map((item: any) => ({
      id: item.Key,
      name: item.Key?.split('/').pop() || 'file',
      size: item.Size,
      mimeType: 'application/octet-stream',
      createdAt: item.LastModified,
      modifiedAt: item.LastModified,
    }));
  }

  async exists(cloudPath: string): Promise<boolean> {
    await this.initClient();

    try {
      const command = new HeadObjectCommand({
        Bucket: this.bucket,
        Key: cloudPath,
      });
      await this.client!.send(command);
      return true;
    } catch {
      return false;
    }
  }

  async getQuota(): Promise<StorageQuota> {
    await this.initClient();

    try {
      const command = new HeadBucketCommand({
        Bucket: this.bucket,
      });
      await this.client!.send(command);
    } catch (error) {
      console.error('Error getting S3 bucket info:', error);
    }

    return {
      used: 0,
      total: 0,
    };
  }
}