import { Inject, Injectable, OnModuleInit, forwardRef } from '@nestjs/common';
import { dirname } from 'node:path';
import { OneDriveAdapter } from 'src/adapters/onedrive.adapter';
import { SystemConfig } from 'src/config';
import { OnEvent, OnJob } from 'src/decorators';
import { CloudStorageProvider, JobName, JobStatus, QueueName } from 'src/enum';
import { AssetRepository } from 'src/repositories/asset.repository';
import { CloudStorageSyncRepository } from 'src/repositories/cloud-storage-sync.repository';
import { ArgOf } from 'src/repositories/event.repository';
import { JobRepository } from 'src/repositories/job.repository';
import { LoggingRepository } from 'src/repositories/logging.repository';
import { StorageRepository } from 'src/repositories/storage.repository';
import { SystemConfigService } from 'src/services/system-config.service';
import { JobOf } from 'src/types';
import { mimeTypes } from 'src/utils/mime-types';

const LOCAL_ORIGINAL_CLEANUP_DELAY = 15 * 60 * 1000;

@Injectable()
export class CloudStorageService implements OnModuleInit {
  private activeProvider: CloudStorageProvider | null = null;
  private config: SystemConfig | null = null;

  constructor(
    private oneDriveAdapter: OneDriveAdapter,
    @Inject(forwardRef(() => SystemConfigService))
    private systemConfigService: SystemConfigService,
    private assetRepository: AssetRepository,
    private storageRepository: StorageRepository,
    private cloudStorageSyncRepository: CloudStorageSyncRepository,
    private jobRepository: JobRepository,
    private logger: LoggingRepository,
  ) {
    this.logger.setContext(CloudStorageService.name);
  }

  async onModuleInit(): Promise<void> {
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
      } else {
        this.activeProvider = null;
      }
    } catch (error) {
      this.logger.error('Failed to load cloud storage config:', error);
    }
  }

  getAdapter(provider?: CloudStorageProvider): OneDriveAdapter | null {
    const p = provider || this.activeProvider;
    return p === CloudStorageProvider.ONEDRIVE ? this.oneDriveAdapter : null;
  }

  isConfigured(): boolean {
    return this.activeProvider !== null;
  }

  setActiveProvider(provider: CloudStorageProvider | null): void {
    this.activeProvider = provider;
  }

  getActiveProvider(): CloudStorageProvider | null {
    return this.activeProvider;
  }

  async getQuota(): Promise<{ used: number; total: number } | null> {
    await this.loadActiveProvider();
    if (this.activeProvider !== CloudStorageProvider.ONEDRIVE) {
      return null;
    }

    try {
      return await this.oneDriveAdapter.getQuota();
    } catch (error) {
      this.logger.warn(`Unable to load OneDrive quota: ${error}`);
      return null;
    }
  }

  // Event listeners
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

  // Job handlers
  @OnJob({ name: JobName.CloudSync, queue: QueueName.CloudSync })
  async handleCloudSync({ id }: JobOf<JobName.CloudSync>): Promise<JobStatus> {
    await this.loadActiveProvider();
    if (this.activeProvider !== CloudStorageProvider.ONEDRIVE) {
      return JobStatus.Skipped;
    }

    try {
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

      const exists = await this.storageRepository.checkFileExists(localPath);
      if (!exists) {
        this.logger.warn(`Cloud sync: local file not found at ${localPath}`);
        return JobStatus.Failed;
      }

      const mimeType = mimeTypes.lookup(localPath);
      const cloudPath = this.buildCloudPath(localPath, asset.ownerId);
      await this.cloudStorageSyncRepository.upsertPending({
        assetId: asset.id,
        localPath,
        cloudPath,
        provider: CloudStorageProvider.ONEDRIVE,
      });

      const result = await this.oneDriveAdapter.uploadFile(localPath, cloudPath, mimeType);
      await this.cloudStorageSyncRepository.markSynced({
        assetId: asset.id,
        cloudPath: result.cloudPath,
        provider: CloudStorageProvider.ONEDRIVE,
      });
      await this.jobRepository.queue({
        name: JobName.CloudSyncCleanup,
        data: { id: asset.id, delay: LOCAL_ORIGINAL_CLEANUP_DELAY },
      });
      this.logger.log(`Cloud primary upload complete: asset ${id} -> ${result.cloudPath} (${result.size} bytes)`);

      return JobStatus.Success;
    } catch (error: Error | any) {
      await this.cloudStorageSyncRepository.markFailed({
        assetId: id,
        provider: CloudStorageProvider.ONEDRIVE,
        error: error?.message || String(error),
      });
      this.logger.error(`Cloud sync failed for asset ${id}:`, error);
      return JobStatus.Failed;
    }
  }

  @OnJob({ name: JobName.CloudSyncCleanup, queue: QueueName.CloudSync })
  async handleCloudSyncCleanup({ id }: JobOf<JobName.CloudSyncCleanup>): Promise<JobStatus> {
    await this.loadActiveProvider();
    if (this.activeProvider !== CloudStorageProvider.ONEDRIVE) {
      return JobStatus.Skipped;
    }

    const record = await this.cloudStorageSyncRepository.getByAssetId(id, CloudStorageProvider.ONEDRIVE);
    if (!record || record.status !== 'synced') {
      return JobStatus.Skipped;
    }

    const exists = await this.storageRepository.checkFileExists(record.localPath);
    if (!exists) {
      return JobStatus.Success;
    }

    await this.storageRepository.unlink(record.localPath);
    this.logger.log(`Removed local original after OneDrive upload: asset ${id}`);
    return JobStatus.Success;
  }

  @OnJob({ name: JobName.CloudSyncQueueAll, queue: QueueName.CloudSync })
  async handleCloudSyncQueueAll({ force }: JobOf<JobName.CloudSyncQueueAll>): Promise<JobStatus> {
    await this.loadActiveProvider();
    if (this.activeProvider !== CloudStorageProvider.ONEDRIVE) {
      return JobStatus.Skipped;
    }

    let queue: { name: JobName.CloudSync; data: { id: string } }[] = [];
    const queueAll = async () => {
      await this.jobRepository.queueAll(queue);
      queue = [];
    };

    const assets = this.cloudStorageSyncRepository.streamForSync(CloudStorageProvider.ONEDRIVE, force);
    for await (const asset of assets) {
      queue.push({ name: JobName.CloudSync, data: { id: asset.id } });
      if (queue.length >= 1000) {
        await queueAll();
      }
    }

    await queueAll();
    return JobStatus.Success;
  }

  @OnJob({ name: JobName.CloudSyncDelete, queue: QueueName.CloudSync })
  async handleCloudSyncDelete({ id }: JobOf<JobName.CloudSyncDelete>): Promise<JobStatus> {
    await this.loadActiveProvider();
    if (this.activeProvider !== CloudStorageProvider.ONEDRIVE) {
      return JobStatus.Skipped;
    }

    try {
      const records = this.cloudStorageSyncRepository.streamForDelete(CloudStorageProvider.ONEDRIVE, id);
      for await (const record of records) {
        try {
          await this.oneDriveAdapter.delete(record.cloudPath);
          await this.cloudStorageSyncRepository.markDeleted(record.id);
        } catch (error: Error | any) {
          await this.cloudStorageSyncRepository.markDeleteFailed(record.id, error?.message || String(error));
          throw error;
        }
      }
      this.logger.log(`Cloud sync delete acknowledged for asset ${id}`);
      return JobStatus.Success;
    } catch (error) {
      this.logger.error(`Cloud sync delete failed for asset ${id}:`, error);
      return JobStatus.Failed;
    }
  }

  // Helpers
  /**
   * Build a relative cloud path from the local asset path.
   * Strips the upload/library prefix to create a clean cloud hierarchy.
   * e.g. "/upload/user-id/ab/cd/file.jpg" -> "ab/cd/file.jpg"
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

  async ensureOriginalLocal(assetId: string, localPath: string): Promise<string> {
    const exists = await this.storageRepository.checkFileExists(localPath);
    if (exists) {
      return localPath;
    }

    await this.loadActiveProvider();
    if (this.activeProvider !== CloudStorageProvider.ONEDRIVE) {
      return localPath;
    }

    const record = await this.cloudStorageSyncRepository.getByAssetId(assetId, CloudStorageProvider.ONEDRIVE);
    if (!record || record.status !== 'synced') {
      return localPath;
    }

    this.storageRepository.mkdirSync(dirname(localPath));
    await this.oneDriveAdapter.downloadFile(record.cloudPath, localPath);
    this.logger.log(`Materialized OneDrive original for asset ${assetId}`);
    return localPath;
  }
}
