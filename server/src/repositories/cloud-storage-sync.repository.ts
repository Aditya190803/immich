import { Injectable } from '@nestjs/common';
import { Insertable, Kysely, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { CloudStorageProvider } from 'src/enum';
import { DB } from 'src/schema';
import { CloudStorageSyncTable } from 'src/schema/tables/cloud-storage-sync.table';
import { asUuid } from 'src/utils/database';

export type CloudStorageSyncStatus = 'pending' | 'synced' | 'failed' | 'deleted';

type Upsert = Insertable<CloudStorageSyncTable>;

@Injectable()
export class CloudStorageSyncRepository {
  constructor(@InjectKysely() private db: Kysely<DB>) {}

  upsertPending(dto: { assetId: string; localPath: string; cloudPath: string; provider: CloudStorageProvider }) {
    return this.db
      .insertInto('cloud_storage_sync')
      .values({
        assetId: dto.assetId,
        localPath: dto.localPath,
        cloudPath: dto.cloudPath,
        provider: dto.provider,
        status: 'pending',
        errorMessage: null,
      } as Upsert)
      .onConflict((oc) =>
        oc.columns(['assetId', 'provider']).doUpdateSet((eb) => ({
          localPath: eb.ref('excluded.localPath'),
          cloudPath: eb.ref('excluded.cloudPath'),
          status: 'pending',
          errorMessage: null,
          updatedAt: sql`now()`,
        })),
      )
      .execute();
  }

  markSynced(dto: { assetId: string; cloudPath: string; provider: CloudStorageProvider }) {
    return this.db
      .updateTable('cloud_storage_sync')
      .set({
        cloudPath: dto.cloudPath,
        status: 'synced',
        errorMessage: null,
        syncedAt: new Date(),
        updatedAt: new Date(),
      })
      .where('assetId', '=', asUuid(dto.assetId))
      .where('provider', '=', dto.provider)
      .execute();
  }

  markFailed(dto: { assetId: string; provider: CloudStorageProvider; error: string }) {
    return this.db
      .updateTable('cloud_storage_sync')
      .set((eb) => ({
        status: 'failed',
        errorMessage: dto.error.slice(0, 4000),
        attempts: eb('attempts', '+', 1),
        updatedAt: new Date(),
      }))
      .where('assetId', '=', asUuid(dto.assetId))
      .where('provider', '=', dto.provider)
      .execute();
  }

  getByAssetId(assetId: string, provider: CloudStorageProvider) {
    return this.db
      .selectFrom('cloud_storage_sync')
      .selectAll()
      .where('assetId', '=', asUuid(assetId))
      .where('provider', '=', provider)
      .executeTakeFirst();
  }

  async markDeleted(id: string) {
    await this.db
      .updateTable('cloud_storage_sync')
      .set({ status: 'deleted', deletedAt: new Date(), updatedAt: new Date() })
      .where('id', '=', asUuid(id))
      .execute();
  }

  async markDeleteFailed(id: string, error: string) {
    await this.db
      .updateTable('cloud_storage_sync')
      .set((eb) => ({
        status: 'failed',
        errorMessage: error.slice(0, 4000),
        attempts: eb('attempts', '+', 1),
        updatedAt: new Date(),
      }))
      .where('id', '=', asUuid(id))
      .execute();
  }

  streamForSync(provider: CloudStorageProvider, force?: boolean) {
    return this.db
      .selectFrom('asset')
      .leftJoin('cloud_storage_sync', (join) =>
        join.onRef('cloud_storage_sync.assetId', '=', 'asset.id').on('cloud_storage_sync.provider', '=', provider),
      )
      .select(['asset.id'])
      .where('asset.deletedAt', 'is', null)
      .$if(!force, (qb) =>
        qb.where((eb) =>
          eb.or([
            eb('cloud_storage_sync.id', 'is', null),
            eb('cloud_storage_sync.status', 'in', ['pending', 'failed']),
          ]),
        ),
      )
      .stream();
  }

  streamForDelete(provider: CloudStorageProvider, assetId: string) {
    return this.db
      .selectFrom('cloud_storage_sync')
      .selectAll()
      .where('provider', '=', provider)
      .where('assetId', '=', asUuid(assetId))
      .where('status', '!=', 'deleted')
      .stream();
  }
}
