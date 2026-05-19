<script lang="ts">
  import SettingAccordion from '$lib/components/shared-components/settings/SettingAccordion.svelte';
  import SettingInputField from '$lib/components/shared-components/settings/SettingInputField.svelte';
  import SettingButtonsRow from '$lib/components/shared-components/settings/SystemConfigButtonRow.svelte';
  import { SettingInputFieldType } from '$lib/constants';
  import { featureFlagsManager } from '$lib/managers/feature-flags-manager.svelte';
  import { systemConfigManager } from '$lib/managers/system-config-manager.svelte';
  import { handleError } from '$lib/utils/handle-error';
  import { Button, Text } from '@immich/ui';
  import { onMount } from 'svelte';

  const CloudStorageProvider = {
    ONEDRIVE: 'onedrive',
    GOOGLE_DRIVE: 'google_drive',
    DROPBOX: 'dropbox',
    S3_COMPATIBLE: 's3_compatible',
  } as const;

  type CloudStorageProvider = (typeof CloudStorageProvider)[keyof typeof CloudStorageProvider];

  type CloudStorageStatus = {
    connected: boolean;
    provider: CloudStorageProvider | null;
    quota?: {
      used: number;
      total: number;
    };
    folderName?: string;
  };

  const disabled = $derived(featureFlagsManager.value.configFile);
  const config = $derived(systemConfigManager.value);
  let configToEdit = $state(systemConfigManager.cloneValue());

  let loading = $state(true);
  let connecting = $state(false);
  let status: CloudStorageStatus | null = $state(null);
  let error = $state<string | null>(null);

  const providers = [
    {
      id: CloudStorageProvider.ONEDRIVE,
      name: 'OneDrive',
      icon: '☁️',
      description: 'Click to sign in with your Microsoft account',
    },
  ];

  onMount(async () => {
    // Check if we were redirected back from OAuth
    const params = new URLSearchParams(globalThis.location?.search || '');
    if (params.get('cloud-storage') === 'connected') {
      // Clean the URL
      const url = new URL(globalThis.location.href);
      url.searchParams.delete('cloud-storage');
      globalThis.history.replaceState({}, '', url.toString());
    }

    await fetchStatus();
  });

  async function fetchStatus() {
    try {
      loading = true;
      const response = await fetch('/api/cloud-storage/status');
      if (!response.ok) {
        throw new Error('Failed to fetch cloud storage status');
      }

      status = (await response.json()) as CloudStorageStatus;
    } catch (err) {
      handleError(err, 'Failed to fetch cloud storage status');
    } finally {
      loading = false;
    }
  }

  async function connectProvider(provider: CloudStorageProvider) {
    try {
      connecting = true;
      error = null;
      const response = await fetch(`/api/cloud-storage/connect/${provider}`, {
        method: 'POST',
      });

      if (!response.ok) {
        const message = await response.text();
        throw new Error(message || 'Failed to connect');
      }

      const data = (await response.json()) as { url?: string };
      if (data?.url) {
        // Open the OAuth page in a NEW TAB so the user can authorize
        window.open(data.url, '_blank', 'noopener,noreferrer');
      }
    } catch (err: any) {
      error = err.message || 'Failed to connect';
      handleError(err, 'Failed to connect to cloud storage');
    } finally {
      connecting = false;
    }
  }

  async function disconnect() {
    try {
      connecting = true;
      const response = await fetch('/api/cloud-storage/disconnect', {
        method: 'DELETE',
      });

      if (!response.ok) {
        throw new Error('Failed to disconnect cloud storage');
      }

      status = { connected: false, provider: null };
    } catch (err) {
      handleError(err, 'Failed to disconnect cloud storage');
    } finally {
      connecting = false;
    }
  }

  function formatBytes(bytes: number): string {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }

  function providerDisplayName(id: string | null): string {
    switch (id) {
      case 'onedrive':
        return 'OneDrive';
      case 'google_drive':
        return 'Google Drive';
      case 'dropbox':
        return 'Dropbox';
      case 's3_compatible':
        return 'S3';
      default:
        return id ?? 'Unknown';
    }
  }
</script>

<div>
  <form autocomplete="off" onsubmit={(e) => e.preventDefault()}>
    <div class="ms-4 mt-4 flex flex-col">
      <SettingAccordion
        key="cloud-storage"
        title="Cloud Storage"
        subtitle="Connect OneDrive, Google Drive, or Dropbox to store your photos in the cloud"
      >
        <div class="ms-4 mt-4 flex flex-col gap-4">
          <Text size="small">
            Connect a cloud storage provider to automatically sync your uploaded photos. For OneDrive, just enter your
            Azure App Client ID below and click <strong>Connect OneDrive</strong> — a new browser tab will open for you
            to sign in with your Microsoft account. No secrets or tokens needed in environment variables.
          </Text>

          <!-- OneDrive — only needs a Client ID (PKCE, no secret) -->
          <div class="rounded-xl border border-gray-200 p-4 dark:border-gray-700">
            <p class="font-medium">☁️ OneDrive</p>
            <p class="mb-4 text-sm text-gray-500">
              Register an app at <a
                href="https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade"
                target="_blank"
                class="text-blue-600 underline dark:text-blue-400"
              >
                Azure Portal → App registrations
              </a>
              and paste the <strong>Application (client) ID</strong> below. Set the redirect URI to:
            </p>
            <code class="mb-4 block rounded bg-gray-100 px-2 py-1 text-sm dark:bg-gray-800">
              {globalThis?.location?.origin || 'https://your-immich.example.com'}/api/cloud-storage/callback/onedrive
            </code>

            <SettingInputField
              inputType={SettingInputFieldType.TEXT}
              label="onedrive_client_id"
              bind:value={configToEdit.cloudStorage.onedrive.clientId}
              required={false}
              disabled={disabled}
              isEdited={!(configToEdit.cloudStorage.onedrive.clientId === config.cloudStorage.onedrive.clientId)}
            />
          </div>



          <SettingButtonsRow {disabled} keys={['cloudStorage']} bind:configToEdit />

          <hr />

          <div class="flex items-center gap-2">
            <h3 class="text-lg font-semibold">Connection Status</h3>
            {#if status?.connected}
              <span class="rounded-full bg-green-100 px-2 py-1 text-xs font-medium text-green-900 dark:bg-green-900/30 dark:text-green-100">
                Connected
              </span>
            {:else}
              <span class="rounded-full bg-gray-100 px-2 py-1 text-xs font-medium text-gray-700 dark:bg-gray-800 dark:text-gray-300">
                Not connected
              </span>
            {/if}
          </div>

          {#if loading}
            <div class="text-sm text-gray-500">Loading...</div>
          {:else if error}
            <div class="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-600 dark:border-red-800 dark:bg-red-900/20 dark:text-red-400">
              {error}
            </div>
          {:else if status?.connected}
            <div class="rounded-xl border border-green-200 bg-green-50 p-4 dark:border-green-800 dark:bg-green-900/20">
              <div class="flex items-center justify-between gap-4">
                <div>
                  <p class="font-medium text-green-900 dark:text-green-100">
                    ✓ Connected to {providerDisplayName(status.provider)}
                  </p>
                  {#if status.quota}
                    <p class="text-sm text-green-700 dark:text-green-300">
                      {formatBytes(status.quota.used)} / {formatBytes(status.quota.total)} used
                    </p>
                  {/if}
                  {#if status.folderName}
                    <p class="text-sm text-green-700 dark:text-green-300">Syncing to: /{status.folderName}</p>
                  {/if}
                </div>

                <Button size="small" variant="outline" onclick={disconnect} disabled={connecting}>Disconnect</Button>
              </div>
            </div>
          {:else}
            <Text size="small">
              Save your credentials above first, then click a provider to open the authorization page in a new tab.
            </Text>

            <div class="grid grid-cols-1 gap-4 md:grid-cols-3">
              {#each providers as provider}
                <button
                  class="flex flex-col items-center gap-2 rounded-xl border border-gray-200 p-6 text-center transition-all hover:border-blue-500 hover:bg-blue-50 hover:shadow-md active:scale-[0.98] dark:border-gray-700 dark:hover:bg-blue-900/20"
                  onclick={() => connectProvider(provider.id)}
                  disabled={connecting}
                >
                  <span class="text-2xl">{provider.icon}</span>
                  <span class="font-medium">{provider.name}</span>
                  <span class="text-xs text-gray-500">{provider.description}</span>
                </button>
              {/each}
            </div>
          {/if}

          <div class="rounded-xl border border-gray-200 p-4 dark:border-gray-700">
            <h3 class="font-medium mb-2">S3-Compatible Storage</h3>
            <p class="text-sm text-gray-500">
              S3-compatible storage remains configuration-based and does not use OAuth credentials.
            </p>
          </div>
        </div>
      </SettingAccordion>
    </div>
  </form>
</div>
