import { Injectable } from '@nestjs/common';
import { CloudStorageProvider, SystemMetadataKey } from 'src/enum';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository';

interface CloudStorageCredentialsMap {
  [provider: string]: StoredCloudCredentials;
}

export interface StoredCloudCredentials {
  provider: CloudStorageProvider;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  tokenType: string;
  rootFolderId: string;
  createdAt: Date;
  updatedAt: Date;
}

@Injectable()
export class CloudStorageCredentialsRepository {
  constructor(private systemMetadataRepository: SystemMetadataRepository) {}

  async getCredentials(provider: CloudStorageProvider): Promise<StoredCloudCredentials | null> {
    const allCredentials = await this.systemMetadataRepository.get(SystemMetadataKey.CloudStorageCredentials) as CloudStorageCredentialsMap | null;
    if (!allCredentials || !allCredentials[provider]) {
      return null;
    }
    return allCredentials[provider];
  }

  async setCredentials(provider: CloudStorageProvider, credentials: Omit<StoredCloudCredentials, 'createdAt' | 'updatedAt'>): Promise<void> {
    const allCredentials = (await this.systemMetadataRepository.get(SystemMetadataKey.CloudStorageCredentials) as CloudStorageCredentialsMap) || {};
    allCredentials[provider] = {
      ...credentials,
      createdAt: allCredentials[provider]?.createdAt || new Date(),
      updatedAt: new Date(),
    };
    await this.systemMetadataRepository.set(SystemMetadataKey.CloudStorageCredentials, allCredentials);
  }

  async deleteCredentials(provider: CloudStorageProvider): Promise<void> {
    const allCredentials = await this.systemMetadataRepository.get(SystemMetadataKey.CloudStorageCredentials) as CloudStorageCredentialsMap;
    if (allCredentials && allCredentials[provider]) {
      delete allCredentials[provider];
      await this.systemMetadataRepository.set(SystemMetadataKey.CloudStorageCredentials, allCredentials);
    }
  }

  async hasCredentials(provider: CloudStorageProvider): Promise<boolean> {
    const credentials = await this.getCredentials(provider);
    return credentials !== null;
  }
}