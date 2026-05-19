import { CloudStorageProvider } from 'src/enum';
import { z } from 'zod';

export const CloudStorageConfigSchema = z.object({
  enabled: z.boolean(),
  provider: z.nativeEnum(CloudStorageProvider).nullable(),
});

export type CloudStorageConfig = z.infer<typeof CloudStorageConfigSchema>;

export const CloudStorageStatusSchema = z.object({
  connected: z.boolean(),
  provider: z.nativeEnum(CloudStorageProvider).nullable(),
  quota: z
    .object({
      used: z.number(),
      total: z.number(),
    })
    .optional(),
  folderName: z.string().optional(),
});

export type CloudStorageStatus = z.infer<typeof CloudStorageStatusSchema>;

export const CloudStorageConnectResponseSchema = z.object({
  url: z.string(),
});

export type CloudStorageConnectResponse = z.infer<typeof CloudStorageConnectResponseSchema>;
