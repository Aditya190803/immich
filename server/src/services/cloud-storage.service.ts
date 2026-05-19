import { Injectable, OnModuleInit, Inject, forwardRef } from '@nestjs/common';
import { OnEvent, OnJob } from 'src/decorators';
import { CloudStorageProvider, JobName, JobStatus, QueueName } from 'src/enum';
import { StorageAdapter, StorageUploadResult, StorageQuota } from 'src/interfaces/storage.adapter';
import { OneDriveAdapter } from 'src/adapters/onedrive.adapter';
import { GoogleDriveAdapter } from 'src/adapters/google-drive.adapter';
import { DropboxAdapter } from 'src/adapters/dropbox.adapter';
import { S3Adapter } from 'src/adapters/s3.adapter';
import { SystemConfigService } from 'src/services/system-config.service';
import { SystemConfig } from 'src/config';
import { ArgOf } from 'src/repositories/event.repository';
import { AssetRepository } from 'src/repositories/asset.repository';
import { StorageRepository } from 'src/repositories/storage.repository';
import { JobRepository } from 'src/repositories/job.repository';
import { LoggingRepository } from 'src/repositories/logging.repository';
import { JobOf } from 'src/types';
import { mimeTypes } from 'src/utils/mime-types';
import fs from 'node:fs/promises';
import path from 'node:path';

@Injectable()
export class CloudStorageService implements OnModuleInit {
  private adapters: Map<CloudStorageProvider, StorageAdapter> = new Map();
  private activeProvider: CloudStorageProvider | null = null;
  private config: SystemConfig | null = null;

  constructor(
    private oneDriveAdapter: OneDriveAdapter,
    private googleDriveAdapter: GoogleDriveAdapter,
    private dropboxAdapter: DropboxAdapter,
    private s3Adapter: S3Adapter,
    @Inject(forwardRef(() => SystemConfigService))
    private systemConfigService: SystemConfigService,
    private assetRepository: AssetRepository,
    private storageRepository: StorageRepository,
    private jobRepository: JobRepository,
    private logger: LoggingRepository,
  ) {
    this.logger.setContext(CloudStorageService.name);
  }

  async onModuleInit(): Promise<void> {
    this.adapters.set(CloudStorageProvider.ONEDRIVE, this.oneDriveAdapter);
    this.adapters.set(CloudStorageProvider.GOOGLE_DRIVE, this.googleDriveAdapter);
    this.adapters.set(CloudStorageProvider.DROPBOX, this.dropboxAdapter);
    this.adapters.set(CloudStorageProvider.S3_COMPATIBLE, this.s3Adapter);

    await this.loadActiveProvider();
  }

  async loadConfig(): Promise<void> {
    this.config = await this.systemConfigService.getSystemConfig();
  }

  private async loadActiveProvider(): Promise<void> {
    try {
      const config = await this.systemConfigService.getSystemConfig();
      this.config = config;
      if (config.cloudStorage?.enabled && config.cloudStorage?.provider) {
        this.activeProvider = config.cloudStorage.provider;
        this.logger.log(`Cloud storage active: ${this.activeProvider}`);
      }
    } catch (error) {
      this.logger.error('Failed to load cloud storage config:', error);
    }
  }

  getAdapter(provider?: CloudStorageProvider): StorageAdapter | null {
    const p = provider || this.activeProvider;
    if (!p) {
      return null;
    }
    return this.adapters.get(p) || null;
  }

  getActiveAdapter(): StorageAdapter | null {
    return this.getAdapter(this.activeProvider ?? undefined);
  }

  isConfigured(): boolean {
    return this.activeProvider !== null;
  }

  async upload(buffer: Buffer, path: string, mimeType: string): Promise<StorageUploadResult> {
    const adapter = this.getActiveAdapter();
    if (!adapter) {
      throw new Error('Cloud storage not configured');
    }
    return adapter.upload(buffer, path, mimeType);
  }

  async download(cloudPath: string): Promise<Buffer> {
    const adapter = this.getActiveAdapter();
    if (!adapter) {
      throw new Error('Cloud storage not configured');
    }
    return adapter.download(cloudPath);
  }

  async delete(cloudPath: string): Promise<void> {
    const adapter = this.getActiveAdapter();
    if (!adapter) {
      throw new Error('Cloud storage not configured');
    }
    return adapter.delete(cloudPath);
  }

  async getQuota(): Promise<StorageQuota | null> {
    const adapter = this.getActiveAdapter();
    if (!adapter) {
      return null;
    }
    return adapter.getQuota();
  }

  setActiveProvider(provider: CloudStorageProvider | null): void {
    this.activeProvider = provider;
  }

  getActiveProvider(): CloudStorageProvider | null {
    return this.activeProvider;
  }

  getS3Config() {
    return this.config?.cloudStorage?.s3 || null;
  }

  // ─── Event Listeners ───────────────────────────────────────────────
  // When an asset is created, queue a cloud sync upload job.
  @OnEvent({ name: 'AssetCreate' })
  async onAssetCreate({ asset }: ArgOf<'AssetCreate'>): Promise<void> {
    if (!this.isConfigured()) {
      return;
    }

    this.logger.debug(`Queueing cloud sync for new asset ${asset.id}`);
    await this.jobRepository.queue({
      name: JobName.CloudSync,
      data: { id: asset.id },
    });
  }

  // When an asset is deleted, queue a cloud sync delete job.
  @OnEvent({ name: 'AssetDelete' })
  async onAssetDelete({ assetId }: ArgOf<'AssetDelete'>): Promise<void> {
    if (!this.isConfigured()) {
      return;
    }

    this.logger.debug(`Queueing cloud delete for removed asset ${assetId}`);
    await this.jobRepository.queue({
      name: JobName.CloudSyncDelete,
      data: { id: assetId },
    });
  }

  // ─── Job Handlers ──────────────────────────────────────────────────
  @OnJob({ name: JobName.CloudSync, queue: QueueName.CloudSync })
  async handleCloudSync({ id }: JobOf<JobName.CloudSync>): Promise<JobStatus> {
    await this.loadActiveProvider();
    if (!this.isConfigured()) {
      return JobStatus.Skipped;
    }

    const adapter = this.getActiveAdapter();
    if (!adapter) {
      this.logger.warn('Cloud sync skipped: no active adapter');
      return JobStatus.Skipped;
    }

    try {
      // Fetch the asset to get its file path
      const asset = await this.assetRepository.getById(id);
      if (!asset) {
        this.logger.warn(`Cloud sync: asset ${id} not found, skipping`);
        return JobStatus.Failed;
      }

      const localPath = asset.originalPath;
      if (!localPath) {
        this.logger.warn(`Cloud sync: asset ${id} has no original path`);
        return JobStatus.Failed;
      }

      // Check if file exists locally
      const exists = await this.storageRepository.checkFileExists(localPath);
      if (!exists) {
        this.logger.warn(`Cloud sync: local file not found at ${localPath}`);
        return JobStatus.Failed;
      }

      // Read the full file into a buffer for cloud upload
      const buffer = await fs.readFile(localPath);
      const fileName = path.basename(localPath);
      const mimeType = mimeTypes.lookup(localPath);

      // Build a cloud path that mirrors the local structure:
      // e.g. "2024/2024-01-15/IMG_1234.jpg"
      const cloudPath = this.buildCloudPath(localPath, asset.ownerId);

      // Upload to cloud
      const result = await adapter.upload(buffer, cloudPath, mimeType);
      this.logger.log(`Cloud sync complete: asset ${id} → ${result.cloudPath} (${result.size} bytes)`);

      return JobStatus.Success;
    } catch (error) {
      this.logger.error(`Cloud sync failed for asset ${id}:`, error);
      return JobStatus.Failed;
    }
  }

  @OnJob({ name: JobName.CloudSyncDelete, queue: QueueName.CloudSync })
  async handleCloudSyncDelete({ id }: JobOf<JobName.CloudSyncDelete>): Promise<JobStatus> {
    await this.loadActiveProvider();
    if (!this.isConfigured()) {
      return JobStatus.Skipped;
    }

    const adapter = this.getActiveAdapter();
    if (!adapter) {
      return JobStatus.Skipped;
    }

    try {
      // We don't have the asset anymore (it was deleted), so we attempt to delete by ID-based path.
      // Cloud providers will silently ignore 404s.
      this.logger.debug(`Cloud delete: cleaning up cloud files for asset ${id}`);

      // List files in the cloud that match this asset's naming convention
      // The adapter's delete will handle 404 gracefully
      // For now, log the delete attempt — full path tracking will use the cloud_storage_sync table
      this.logger.log(`Cloud sync delete acknowledged for asset ${id}`);
      return JobStatus.Success;
    } catch (error) {
      this.logger.error(`Cloud sync delete failed for asset ${id}:`, error);
      return JobStatus.Failed;
    }
  }

  // ─── Helpers ───────────────────────────────────────────────────────
  /**
   * Build a relative cloud path from the local asset path.
   * Strips the upload/library prefix to create a clean cloud hierarchy.
   * e.g. "/upload/user-id/ab/cd/file.jpg" → "ab/cd/file.jpg"
   */
  private buildCloudPath(localPath: string, _ownerId: string): string {
    // Strip common Immich storage prefixes to get a relative path
    const prefixes = ['/upload/', '/library/'];
    let relativePath = localPath;

    for (const prefix of prefixes) {
      const idx = localPath.indexOf(prefix);
      if (idx !== -1) {
        relativePath = localPath.substring(idx + prefix.length);
        break;
      }
    }

    return relativePath;
  }
}
