import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS "cloud_storage_sync" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      "assetId" uuid NOT NULL,
      "localPath" varchar(1024) NOT NULL,
      "cloudPath" varchar(1024) NOT NULL,
      "provider" varchar(50) NOT NULL,
      "status" varchar(20) DEFAULT 'pending',
      "errorMessage" text,
      "attempts" integer DEFAULT 0,
      "syncedAt" timestamp with time zone,
      "deletedAt" timestamp with time zone,
      "createdAt" timestamp with time zone DEFAULT NOW(),
      "updatedAt" timestamp with time zone DEFAULT NOW()
    );
  `.execute(db);

  await sql`
    CREATE INDEX IF NOT EXISTS "cloud_storage_sync_asset_id_idx" ON "cloud_storage_sync" ("assetId");
  `.execute(db);

  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS "cloud_storage_sync_asset_provider_idx"
    ON "cloud_storage_sync" ("assetId", "provider")
    WHERE "assetId" IS NOT NULL;
  `.execute(db);

  await sql`
    CREATE INDEX IF NOT EXISTS "cloud_storage_sync_status_idx" ON "cloud_storage_sync" ("status");
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP INDEX IF EXISTS "cloud_storage_sync_asset_id_idx";`.execute(db);
  await sql`DROP INDEX IF EXISTS "cloud_storage_sync_asset_provider_idx";`.execute(db);
  await sql`DROP INDEX IF EXISTS "cloud_storage_sync_status_idx";`.execute(db);
  await sql`DROP TABLE IF EXISTS "cloud_storage_sync";`.execute(db);
}
