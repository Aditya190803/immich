import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS "cloud_storage_sync" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      "asset_id" uuid REFERENCES "asset"("id") ON DELETE CASCADE,
      "local_path" varchar(1024) NOT NULL,
      "cloud_path" varchar(1024) NOT NULL,
      "provider" varchar(50) NOT NULL,
      "status" varchar(20) DEFAULT 'pending',
      "error_message" text,
      "synced_at" timestamp with time zone,
      "created_at" timestamp with time zone DEFAULT NOW(),
      "updated_at" timestamp with time zone DEFAULT NOW()
    );
  `.execute(db);

  await sql`
    CREATE INDEX IF NOT EXISTS "cloud_storage_sync_asset_id_idx" ON "cloud_storage_sync" ("asset_id");
  `.execute(db);

  await sql`
    CREATE INDEX IF NOT EXISTS "cloud_storage_sync_status_idx" ON "cloud_storage_sync" ("status");
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP INDEX IF EXISTS "cloud_storage_sync_asset_id_idx";`.execute(db);
  await sql`DROP INDEX IF EXISTS "cloud_storage_sync_status_idx";`.execute(db);
  await sql`DROP TABLE IF EXISTS "cloud_storage_sync";`.execute(db);
}
