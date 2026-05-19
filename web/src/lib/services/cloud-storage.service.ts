import { get, type Writable } from 'svelte/store';
import { handleError } from '$lib/utils/handle-error';

export enum CloudStorageProvider {
  ONEDRIVE = 'onedrive',
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

export interface CloudStorageConfig {
  enabled: boolean;
  provider: CloudStorageProvider | null;
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
