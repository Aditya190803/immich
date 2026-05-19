import 'package:drift/drift.dart' hide isNotNull, isNull;
import 'package:drift/native.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:immich_mobile/domain/models/album/local_album.model.dart';
import 'package:immich_mobile/domain/models/asset/base_asset.model.dart';
import 'package:immich_mobile/infrastructure/entities/local_album.entity.drift.dart';
import 'package:immich_mobile/infrastructure/entities/local_album_asset.entity.drift.dart';
import 'package:immich_mobile/infrastructure/entities/local_asset.entity.drift.dart';
import 'package:immich_mobile/infrastructure/entities/trash_sync.entity.dart';
import 'package:immich_mobile/infrastructure/entities/trash_sync.entity.drift.dart';
import 'package:immich_mobile/infrastructure/entities/remote_asset.entity.drift.dart';
import 'package:immich_mobile/infrastructure/entities/user.entity.drift.dart';
import 'package:immich_mobile/infrastructure/repositories/db.repository.dart';
import 'package:immich_mobile/infrastructure/repositories/local_asset.repository.dart';
import 'package:immich_mobile/infrastructure/repositories/trash_sync.repository.dart';
import 'package:immich_mobile/repositories/asset_media.repository.dart';
import 'package:mocktail/mocktail.dart';

class _MockAssetMediaRepository extends Mock implements AssetMediaRepository {}

void main() {
  late Drift db;
  late DriftTrashSyncRepository repository;

  setUp(() async {
    db = Drift(DatabaseConnection(NativeDatabase.memory(), closeStreamsSynchronously: true));
    // The state-machine entry points (recordRemoteTrash, applyReviewDecision,
    // etc.) are tested separately at the service-equivalent layer via the
    // mocked repositories below. This test focuses on the low-level table
    // writes, watch streams, and cleanup — none of which call the injected
    // collaborators.
    repository = DriftTrashSyncRepository(db, DriftLocalAssetRepository(db), _MockAssetMediaRepository());
    await db
        .into(db.userEntity)
        .insert(UserEntityCompanion.insert(id: 'user-1', name: 'user-1', email: 'user-1@example.com'));
  });

  tearDown(() async {
    await db.close();
  });

  // ---------------------------------------------------------------------
  // Test fixtures
  // ---------------------------------------------------------------------

  TrashSyncCandidate candidate({
    required String localAssetId,
    String? checksum,
    String? albumId,
    DateTime? remoteDeletedAt,
    TrashTriggerSource triggerSource = TrashTriggerSource.remoteSync,
  }) {
    final now = DateTime(2025, 1, 1);
    return TrashSyncCandidate(
      localAssetId: localAssetId,
      checksum: checksum,
      albumId: albumId,
      remoteDeletedAt: remoteDeletedAt ?? now,
      triggerSource: triggerSource,
      name: '$localAssetId.jpg',
      type: AssetType.image,
      createdAt: now,
      updatedAt: now,
      width: 100,
      height: 100,
      durationMs: 0,
      isFavorite: false,
      orientation: 0,
      playbackStyle: AssetPlaybackStyle.image,
    );
  }

  Future<void> insertStateRow({
    required String localAssetId,
    String? checksum,
    TrashStateDecision decision = TrashStateDecision.pendingReview,
    TrashTriggerSource triggerSource = TrashTriggerSource.remoteSync,
    String? albumId,
    DateTime? remoteDeletedAt,
  }) async {
    final now = DateTime(2025, 1, 1);
    await db
        .into(db.trashSyncEntity)
        .insert(
          TrashSyncEntityCompanion.insert(
            localAssetId: localAssetId,
            checksum: Value(checksum),
            decision: decision,
            triggerSource: triggerSource,
            albumId: Value(albumId),
            remoteDeletedAt: Value(remoteDeletedAt ?? now),
            name: '$localAssetId.jpg',
            type: AssetType.image,
            createdAt: Value(now),
            updatedAt: Value(now),
            width: const Value(100),
            height: const Value(100),
            durationMs: const Value(0),
            isFavorite: const Value(false),
            orientation: const Value(0),
            playbackStyle: const Value(AssetPlaybackStyle.image),
          ),
        );
  }

  Future<void> insertRemoteAsset({required String checksum, DateTime? deletedAt}) async {
    final now = DateTime(2025, 1, 1);
    await db
        .into(db.remoteAssetEntity)
        .insert(
          RemoteAssetEntityCompanion.insert(
            id: 'remote-$checksum',
            checksum: checksum,
            name: 'remote-$checksum.jpg',
            ownerId: 'user-1',
            type: AssetType.image,
            createdAt: Value(now),
            updatedAt: Value(now),
            visibility: AssetVisibility.timeline,
            deletedAt: Value(deletedAt),
          ),
        );
  }

  Future<void> insertLocalAlbum({
    required String id,
    BackupSelection backupSelection = BackupSelection.selected,
  }) async {
    await db
        .into(db.localAlbumEntity)
        .insert(LocalAlbumEntityCompanion.insert(id: id, name: id, backupSelection: backupSelection));
  }

  Future<void> insertLocalAlbumAsset({required String albumId, required String assetId}) async {
    await db
        .into(db.localAlbumAssetEntity)
        .insert(LocalAlbumAssetEntityCompanion.insert(albumId: albumId, assetId: assetId));
  }

  Future<void> insertLocalAsset({required String id, String? checksum}) async {
    final now = DateTime(2025, 1, 1);
    await db
        .into(db.localAssetEntity)
        .insert(
          LocalAssetEntityCompanion.insert(
            id: id,
            checksum: Value(checksum),
            name: '$id.jpg',
            type: AssetType.image,
            createdAt: Value(now),
            updatedAt: Value(now),
          ),
        );
  }

  // ---------------------------------------------------------------------
  // upsertCandidates
  // ---------------------------------------------------------------------

  group('upsertCandidates', () {
    test('inserts new pending rows', () async {
      await repository.upsertCandidates([
        candidate(localAssetId: 'local-1', checksum: 'sum-1'),
        candidate(localAssetId: 'local-2', checksum: 'sum-2'),
      ]);

      final rows = await db.select(db.trashSyncEntity).get();
      expect(rows.length, 2);
      expect(rows.every((r) => r.decision == TrashStateDecision.pendingReview), isTrue);
    });

    test('does not overwrite existing decisions (insertOrIgnore)', () async {
      // Pre-existing decided row.
      await insertStateRow(localAssetId: 'local-1', checksum: 'sum-1', decision: TrashStateDecision.kept);

      // Repeat remote-delete event for the same asset.
      await repository.upsertCandidates([candidate(localAssetId: 'local-1', checksum: 'sum-1')]);

      final row = (await db.select(db.trashSyncEntity).get()).single;
      // Decision preserved — suppression is the whole point of `kept`.
      expect(row.decision, TrashStateDecision.kept);
    });

    test('no-op on empty input', () async {
      await repository.upsertCandidates(const []);
      final rows = await db.select(db.trashSyncEntity).get();
      expect(rows, isEmpty);
    });
  });

  // ---------------------------------------------------------------------
  // markDecision
  // ---------------------------------------------------------------------

  group('markDecision', () {
    test('transitions pending rows to appTrashed', () async {
      await insertStateRow(localAssetId: 'local-1', checksum: 'sum-1');
      await insertStateRow(localAssetId: 'local-2', checksum: 'sum-2');

      await repository.markDecision(['local-1'], TrashStateDecision.appTrashed);

      final rows = await db.select(db.trashSyncEntity).get();
      final byId = {for (final r in rows) r.localAssetId: r};
      expect(byId['local-1']!.decision, TrashStateDecision.appTrashed);
      expect(byId['local-2']!.decision, TrashStateDecision.pendingReview);
    });

    test('transitions pending rows to kept', () async {
      await insertStateRow(localAssetId: 'local-1', checksum: 'sum-1');
      await repository.markDecision(['local-1'], TrashStateDecision.kept);

      final row = (await db.select(db.trashSyncEntity).get()).single;
      expect(row.decision, TrashStateDecision.kept);
    });
  });

  // ---------------------------------------------------------------------
  // Watch streams
  // ---------------------------------------------------------------------

  group('watch streams', () {
    test('watchPendingReviewCount counts only pending rows in backup-selected albums', () async {
      await insertLocalAlbum(id: 'selected', backupSelection: BackupSelection.selected);
      await insertLocalAlbum(id: 'unselected', backupSelection: BackupSelection.none);

      // Pending, in selected album → counted.
      await insertLocalAsset(id: 'a', checksum: 'sum-a');
      await insertLocalAlbumAsset(albumId: 'selected', assetId: 'a');
      await insertStateRow(localAssetId: 'a', checksum: 'sum-a');

      // Pending, but only in unselected album → not counted.
      await insertLocalAsset(id: 'b', checksum: 'sum-b');
      await insertLocalAlbumAsset(albumId: 'unselected', assetId: 'b');
      await insertStateRow(localAssetId: 'b', checksum: 'sum-b');

      // Kept tombstone in selected album → not counted.
      await insertLocalAsset(id: 'c', checksum: 'sum-c');
      await insertLocalAlbumAsset(albumId: 'selected', assetId: 'c');
      await insertStateRow(localAssetId: 'c', checksum: 'sum-c', decision: TrashStateDecision.kept);

      // appTrashed → not counted (already resolved).
      await insertLocalAsset(id: 'd', checksum: 'sum-d');
      await insertLocalAlbumAsset(albumId: 'selected', assetId: 'd');
      await insertStateRow(localAssetId: 'd', checksum: 'sum-d', decision: TrashStateDecision.appTrashed);

      // Pending row with no matching local_asset → not counted.
      await insertStateRow(localAssetId: 'e', checksum: 'sum-e');

      await expectLater(repository.watchPendingReviewCount(), emits(1));
    });

    test('watchIsAssetPendingById reflects backup-selection and decision state', () async {
      await insertLocalAlbum(id: 'selected');
      await insertLocalAlbum(id: 'unselected', backupSelection: BackupSelection.none);

      await insertLocalAsset(id: 'pending-selected', checksum: 'sum-1');
      await insertLocalAlbumAsset(albumId: 'selected', assetId: 'pending-selected');
      await insertStateRow(localAssetId: 'pending-selected', checksum: 'sum-1');

      await insertLocalAsset(id: 'pending-unselected', checksum: 'sum-2');
      await insertLocalAlbumAsset(albumId: 'unselected', assetId: 'pending-unselected');
      await insertStateRow(localAssetId: 'pending-unselected', checksum: 'sum-2');

      await insertLocalAsset(id: 'kept', checksum: 'sum-3');
      await insertLocalAlbumAsset(albumId: 'selected', assetId: 'kept');
      await insertStateRow(localAssetId: 'kept', checksum: 'sum-3', decision: TrashStateDecision.kept);

      await expectLater(repository.watchIsAssetPendingById('pending-selected'), emits(true));
      await expectLater(repository.watchIsAssetPendingById('pending-unselected'), emits(false));
      await expectLater(repository.watchIsAssetPendingById('kept'), emits(false));
      await expectLater(repository.watchIsAssetPendingById('nonexistent'), emits(false));
    });

    test('watchIsAssetPendingByChecksum works on the indexed checksum column', () async {
      await insertLocalAlbum(id: 'selected');
      await insertLocalAsset(id: 'a', checksum: 'sum-a');
      await insertLocalAlbumAsset(albumId: 'selected', assetId: 'a');
      await insertStateRow(localAssetId: 'a', checksum: 'sum-a');

      await expectLater(repository.watchIsAssetPendingByChecksum('sum-a'), emits(true));
      await expectLater(repository.watchIsAssetPendingByChecksum('sum-nope'), emits(false));
    });
  });

  // ---------------------------------------------------------------------
  // deleteForRestoredRemotes
  // ---------------------------------------------------------------------

  group('deleteForRestoredRemotes', () {
    test('returns affected appTrashed rows and removes only remoteSync triggers', () async {
      await insertStateRow(
        localAssetId: 'a',
        checksum: 'sum-a',
        decision: TrashStateDecision.appTrashed,
        triggerSource: TrashTriggerSource.remoteSync,
      );
      await insertStateRow(
        localAssetId: 'b',
        checksum: 'sum-b',
        decision: TrashStateDecision.appTrashed,
        triggerSource: TrashTriggerSource.localUser, // user-manual: NOT touched
      );
      await insertStateRow(
        localAssetId: 'c',
        checksum: 'sum-a',
        decision: TrashStateDecision.kept,
        triggerSource: TrashTriggerSource.remoteSync,
      );

      final affected = await repository.deleteForRestoredRemotes(['sum-a', 'sum-b']);

      // 'a' and 'c' were removed (both remoteSync, both matched sum-a).
      // 'b' was not removed (localUser trigger).
      expect(affected.map((r) => r.localAssetId).toSet(), {'a', 'c'});

      final remaining = await db.select(db.trashSyncEntity).get();
      expect(remaining.map((r) => r.localAssetId).toSet(), {'b'});
    });

    test('empty input is a no-op', () async {
      await insertStateRow(localAssetId: 'a', checksum: 'sum-a');
      final affected = await repository.deleteForRestoredRemotes(const []);
      expect(affected, isEmpty);
      final remaining = await db.select(db.trashSyncEntity).get();
      expect(remaining.length, 1);
    });
  });

  // ---------------------------------------------------------------------
  // cleanup — single transactional sweep, two rules
  // ---------------------------------------------------------------------

  group('cleanup', () {
    test('rule 1: deletes rows whose remote is alive again', () async {
      await insertRemoteAsset(checksum: 'sum-alive', deletedAt: null);
      await insertRemoteAsset(checksum: 'sum-deleted', deletedAt: DateTime(2025, 1, 1));

      // Insert local_asset rows so rule 2 (orphaned-local cleanup) doesn't
      // fire — we want to verify rule 1 in isolation.
      await insertLocalAsset(id: 'a', checksum: 'sum-alive');
      await insertLocalAsset(id: 'b', checksum: 'sum-deleted');

      await insertStateRow(localAssetId: 'a', checksum: 'sum-alive');
      await insertStateRow(localAssetId: 'b', checksum: 'sum-deleted');

      final deleted = await repository.cleanup();
      expect(deleted, 1);

      final remaining = await db.select(db.trashSyncEntity).get();
      expect(remaining.map((r) => r.localAssetId).toSet(), {'b'});
    });

    test('rule 2: deletes rows whose local_asset is gone and state != appTrashed', () async {
      // local_asset exists for 'a' → not orphan
      await insertLocalAsset(id: 'a', checksum: 'sum-a');
      await insertStateRow(localAssetId: 'a', checksum: 'sum-a');

      // local_asset missing for 'b', pending → deleted
      await insertStateRow(localAssetId: 'b', checksum: 'sum-b');

      // local_asset missing for 'c', kept → deleted
      await insertStateRow(localAssetId: 'c', checksum: 'sum-c', decision: TrashStateDecision.kept);

      // local_asset missing for 'd', appTrashed → KEPT (needed for restore)
      await insertStateRow(localAssetId: 'd', checksum: 'sum-d', decision: TrashStateDecision.appTrashed);

      final deleted = await repository.cleanup();
      expect(deleted, 2);

      final remaining = await db.select(db.trashSyncEntity).get();
      expect(remaining.map((r) => r.localAssetId).toSet(), {'a', 'd'});
    });

    test('both rules apply in one transaction', () async {
      await insertRemoteAsset(checksum: 'sum-alive', deletedAt: null);
      // Will hit rule 1: alive remote.
      await insertStateRow(localAssetId: 'rule1', checksum: 'sum-alive');
      // Will hit rule 2: orphan + not appTrashed.
      await insertStateRow(localAssetId: 'rule2', checksum: 'sum-orphan');
      // Survives both rules.
      await insertLocalAsset(id: 'survivor', checksum: 'sum-keep');
      await insertStateRow(localAssetId: 'survivor', checksum: 'sum-keep');

      final deleted = await repository.cleanup();
      expect(deleted, 2);

      final remaining = await db.select(db.trashSyncEntity).get();
      expect(remaining.map((r) => r.localAssetId).toSet(), {'survivor'});
    });
  });
}
