import { CloudStorageProvider } from 'src/enum';
import { z } from 'zod';

export const CloudStorageS3ConfigSchema = z.object({
  endpoint: z.string().optional(),
  region: z.string().optional(),
  bucket: z.string().optional(),
  accessKey: z.string().optional(),
  secretKey: z.string().optional(),
});

export type CloudStorageS3Config = z.infer<typeof CloudStorageS3ConfigSchema>;

export const CloudStorageConfigSchema = z.object({
  enabled: z.boolean(),
  provider: z.nativeEnum(CloudStorageProvider).nullable(),
  s3: CloudStorageS3ConfigSchema,
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

export const CloudStorageTestConnectionSchema = z.object({
  success: z.boolean(),
  error: z.string().optional(),
});

export type CloudStorageTestConnection = z.infer<typeof CloudStorageTestConnectionSchema>;