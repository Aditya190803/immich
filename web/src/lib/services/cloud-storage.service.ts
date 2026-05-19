import { get, type Writable } from 'svelte/store';
import { handleError } from '$lib/utils/handle-error';

export enum CloudStorageProvider {
  ONEDRIVE = 'onedrive',
  GOOGLE_DRIVE = 'google_drive',
  DROPBOX = 'dropbox',
  S3_COMPATIBLE = 's3_compatible',
}

export interface CloudStorageStatus {
  connected: boolean;
  provider: CloudStorageProvider | null;
  quota?: {
    used: number;
    total: number;
  };
  folderName?: string;
}

export interface CloudStorageConnectResponse {
  url: string;
}

export interface CloudStorageTestConnection {
  success: boolean;
  error?: string;
}

export interface CloudStorageConfig {
  s3: {
    endpoint: string;
    region: string;
    bucket: string;
    accessKey: string;
    secretKey: string;
  };
  enabled: boolean;
  provider: string | null;
}

export const cloudStorageStatus: Writable<CloudStorageStatus | null> = { subscribe: () => () => {} } as any;

export async function fetchCloudStorageStatus(): Promise<CloudStorageStatus> {
  try {
    const response = await fetch('/api/cloud-storage/status');
    if (response.ok) {
      const data = (await response.json()) as CloudStorageStatus;
      cloudStorageStatus.set(data);
      return data;
    }
    throw new Error('Failed to fetch cloud storage status');
  } catch (error) {
    handleError(error, 'Failed to fetch cloud storage status');
    throw error;
  }
}

export async function connectCloudStorage(provider: string): Promise<CloudStorageConnectResponse> {
  try {
    const response = await fetch(`/api/cloud-storage/connect/${provider}`, { method: 'POST' });
    if (response.ok) {
      const data = (await response.json()) as CloudStorageConnectResponse;
      return data;
    }
    throw new Error('Failed to connect to cloud storage');
  } catch (error) {
    handleError(error, 'Failed to connect to cloud storage');
    throw error;
  }
}

export async function disconnectCloudStorage(): Promise<void> {
  try {
    const response = await fetch('/api/cloud-storage/disconnect', { method: 'DELETE' });
    if (response.status === 200 || response.status === 204) {
      cloudStorageStatus.set({ connected: false, provider: null });
      return;
    }
    throw new Error('Failed to disconnect cloud storage');
  } catch (error) {
    handleError(error, 'Failed to disconnect cloud storage');
    throw error;
  }
}

export async function testCloudStorageConnection(
  provider: string,
  config: CloudStorageConfig['s3'],
): Promise<CloudStorageTestConnection> {
  try {
    const params = new URLSearchParams(
      Object.entries(config).flatMap(([key, value]) => (value ? [[key, value]] : [])),
    );
    const response = await fetch(`/api/cloud-storage/test-connection/${provider}?${params.toString()}`, {
      method: 'POST',
    });
    if (response.ok) {
      const data = (await response.json()) as CloudStorageTestConnection;
      return data;
    }
    throw new Error('Failed to test connection');
  } catch (error) {
    handleError(error, 'Failed to test cloud storage connection');
    throw error;
  }
}

export async function getCloudStorageConfig(): Promise<CloudStorageConfig> {
  try {
    const response = await fetch('/api/cloud-storage/config');
    if (response.ok) {
      const data = (await response.json()) as CloudStorageConfig;
      return data;
    }
    throw new Error('Failed to fetch cloud storage config');
  } catch (error) {
    handleError(error, 'Failed to fetch cloud storage config');
    throw error;
  }
}

export function initializeCloudStorageApi() {
  cloudStorageStatus.set = (value: CloudStorageStatus | null) => {
    const subscribers = (cloudStorageStatus as any)._subscribers || [];
    (cloudStorageStatus as any)._value = value;
    subscribers.forEach((fn: (val: CloudStorageStatus) => void) => fn(value as CloudStorageStatus));
  };
}
