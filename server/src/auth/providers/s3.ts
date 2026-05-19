import { S3Client, HeadBucketCommand, GetBucketLocationCommand } from '@aws-sdk/client-s3';

export interface S3Config {
  endpoint: string;
  region: string;
  bucket: string;
  accessKey: string;
  secretKey: string;
}

export interface BucketInfo {
  name: string;
  region: string;
}

export async function validateS3Credentials(config: S3Config): Promise<boolean> {
  try {
    const client = new S3Client({
      endpoint: config.endpoint || undefined,
      region: config.region || 'us-east-1',
      credentials: {
        accessKeyId: config.accessKey,
        secretAccessKey: config.secretKey,
      },
      forcePathStyle: !!config.endpoint,
    });

    await client.send(new HeadBucketCommand({ Bucket: config.bucket }));
    return true;
  } catch (error) {
    console.error('S3 credential validation failed:', error);
    return false;
  }
}

export async function getS3BucketInfo(config: S3Config): Promise<BucketInfo> {
  const client = new S3Client({
    endpoint: config.endpoint || undefined,
    region: config.region || 'us-east-1',
    credentials: {
      accessKeyId: config.accessKey,
      secretAccessKey: config.secretKey,
    },
    forcePathStyle: !!config.endpoint,
  });

  let region = config.region || 'us-east-1';
  try {
    const locationResponse = await client.send(new GetBucketLocationCommand({ Bucket: config.bucket }));
    if (locationResponse.LocationConstraint) {
      region = locationResponse.LocationConstraint;
    }
  } catch (error) {
    console.warn('Could not get bucket location, using configured region:', error);
  }

  return {
    name: config.bucket,
    region,
  };
}

export function getS3Quota(_config: S3Config): { used: number; total: number } {
  return {
    used: 0,
    total: 0,
  };
}
