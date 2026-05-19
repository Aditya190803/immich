import 'package:drift/drift.dart';
import 'package:drift/native.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:immich_mobile/domain/models/album/local_album.model.dart';
import 'package:immich_mobile/domain/models/asset/base_asset.model.dart';
import 'package:immich_mobile/domain/models/timeline.model.dart';
import 'package:immich_mobile/infrastructure/entities/local_album.entity.drift.dart';
import 'package:immich_mobile/infrastructure/entities/local_album_asset.entity.drift.dart';
import 'package:immich_mobile/infrastructure/entities/local_asset.entity.drift.dart';
import 'package:immich_mobile/infrastructure/entities/trash_sync.entity.dart';
import 'package:immich_mobile/infrastructure/entities/trash_sync.entity.drift.dart';
import 'package:immich_mobile/infrastructure/entities/trashed_local_asset.entity.dart';
import 'package:immich_mobile/infrastructure/entities/trashed_local_asset.entity.drift.dart';
import 'package:immich_mobile/infrastructure/repositories/db.repository.dart';
import 'package:immich_mobile/infrastructure/repositories/timeline.repository.dart';
import 'package:intl/date_symbol_data_local.dart';

void main() {
  late Drift db;
  late DriftTimelineRepository repository;

  setUpAll(() async {
    await initializeDateFormatting('en');
  });

  setUp(() {
    db = Drift(DatabaseConnection(NativeDatabase.memory(), closeStreamsSynchronously: true));
    repository = DriftTimelineRepository(db);
  });

  tearDown(() async {
    await db.close();
  });

  Future<void> insertLocalAsset({required String id, required String checksum, required DateTime createdAt}) {
    return db
        .into(db.localAssetEntity)
        .insert(
          LocalAssetEntityCompanion.insert(
            id: id,
            checksum: Value(checksum),
            name: '$id.jpg',
            type: AssetType.image,
            createdAt: Value(createdAt),
            updatedAt: Value(createdAt),
          ),
        );
  }

  Future<void> insertLocalAlbum({required String id, BackupSelection backupSelection = BackupSelection.selected}) {
    return db
        .into(db.localAlbumEntity)
        .insert(LocalAlbumEntityCompanion.insert(id: id, name: id, backupSelection: backupSelection));
  }

  Future<void> insertLocalAlbumAsset({required String albumId, required String assetId}) {
    return db
        .into(db.localAlbumAssetEntity)
        .insert(LocalAlbumAssetEntityCompanion.insert(albumId: albumId, assetId: assetId));
  }

  /// Seeds a pending-review trash_sync_entity row for [localAssetId].
  ///
  /// The new single-table design keys decisions by local_asset_id (not
  /// checksum), so each pending review must reference an existing local
  /// asset. The checksum is stored alongside for cross-matching with
  /// remote_asset rows during cleanup.
  Future<void> insertTrashSync({required String localAssetId, String? checksum}) {
    final now = DateTime(2025, 1, 10, 12);
    return db
        .into(db.trashSyncEntity)
        .insert(
          TrashSyncEntityCompanion.insert(
            localAssetId: localAssetId,
            checksum: Value(checksum),
            decision: TrashStateDecision.pendingReview,
            triggerSource: TrashTriggerSource.remoteSync,
            remoteDeletedAt: Value(now),
            name: '$localAssetId.jpg',
            type: AssetType.image,
            createdAt: Value(now),
            updatedAt: Value(now),
          ),
        );
  }

  Future<void> insertTrashedLocalAsset(String checksum, {String? id}) {
    final now = DateTime(2025, 1, 10, 12);
    return db
        .into(db.trashedLocalAssetEntity)
        .insert(
          TrashedLocalAssetEntityCompanion.insert(
            id: id ?? 'trashed-$checksum',
            albumId: 'album-$checksum',
            checksum: Value(checksum),
            name: 'trashed-$checksum.jpg',
            type: AssetType.image,
            createdAt: Value(now),
            updatedAt: Value(now),
            source: TrashOrigin.localSync,
          ),
        );
  }

  group('toTrashSyncReview', () {
    test('returns local assets with a pending-review trash state in backup-selected albums', () async {
      await insertLocalAlbum(id: 'selected-album');
      await insertLocalAlbum(id: 'unselected-album', backupSelection: BackupSelection.none);

      // Two local copies of the same remote asset. The new schema records
      // a pending state per local asset id, so we seed it for the one we
      // expect to be shown for review.
      await insertLocalAsset(id: 'a-duplicate', checksum: 'duplicate-checksum', createdAt: DateTime(2025, 1, 1, 12));
      await insertLocalAsset(
        id: 'z-newer-duplicate',
        checksum: 'duplicate-checksum',
        createdAt: DateTime(2025, 1, 2, 12),
      );
      await insertLocalAsset(id: 'single', checksum: 'single-checksum', createdAt: DateTime(2025, 1, 3, 12));
      await insertLocalAsset(id: 'unselected', checksum: 'unselected-checksum', createdAt: DateTime(2025, 1, 5, 12));

      await insertLocalAlbumAsset(albumId: 'selected-album', assetId: 'a-duplicate');
      await insertLocalAlbumAsset(albumId: 'selected-album', assetId: 'z-newer-duplicate');
      await insertLocalAlbumAsset(albumId: 'selected-album', assetId: 'single');
      await insertLocalAlbumAsset(albumId: 'unselected-album', assetId: 'unselected');

      // The service-level `recordRemoteTrash` dedupes by local_asset_id and
      // only writes a state row for the first-found local copy of a given
      // remote — so for the duplicate checksum case we seed exactly one row.
      await insertTrashSync(localAssetId: 'a-duplicate', checksum: 'duplicate-checksum');
      await insertTrashSync(localAssetId: 'single', checksum: 'single-checksum');
      await insertTrashSync(localAssetId: 'unselected', checksum: 'unselected-checksum');

      final query = repository.toTrashSyncReview(GroupAssetsBy.day);

      final assets = await query.assetSource(0, 10);
      final localIds = assets.whereType<LocalAsset>().map((asset) => asset.id).toList();

      expect(localIds, ['single', 'a-duplicate']);
      // z-newer-duplicate has no state row → not shown.
      expect(localIds, isNot(contains('z-newer-duplicate')));
      // unselected has a state row but is only in an unselected album.
      expect(localIds, isNot(contains('unselected')));

      final buckets = await query.bucketSource().first;
      expect(buckets.map((bucket) => bucket.assetCount), [1, 1]);
    });

    test('shows the alive local copy even when a same-checksum sibling exists in local trash', () async {
      await insertLocalAlbum(id: 'selected-album');

      await insertLocalAsset(id: 'alive-copy', checksum: 'shared-checksum', createdAt: DateTime(2025, 1, 1, 12));
      await insertLocalAlbumAsset(albumId: 'selected-album', assetId: 'alive-copy');
      await insertTrashSync(localAssetId: 'alive-copy', checksum: 'shared-checksum');
      await insertTrashedLocalAsset('shared-checksum', id: 'trashed-copy');

      final query = repository.toTrashSyncReview(GroupAssetsBy.day);

      final assets = await query.assetSource(0, 10);
      final localIds = assets.whereType<LocalAsset>().map((asset) => asset.id).toList();

      expect(localIds, ['alive-copy']);
    });
  });
}
