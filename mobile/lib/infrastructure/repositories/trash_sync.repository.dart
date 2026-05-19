import 'dart:async';

import 'package:collection/collection.dart';
import 'package:drift/drift.dart';
import 'package:immich_mobile/constants/constants.dart';
import 'package:immich_mobile/domain/models/album/local_album.model.dart';
import 'package:immich_mobile/domain/models/asset/base_asset.model.dart';
import 'package:immich_mobile/domain/models/asset/remote_deleted_local_asset.model.dart';
import 'package:immich_mobile/domain/models/store.model.dart';
import 'package:immich_mobile/entities/store.entity.dart';
import 'package:immich_mobile/extensions/platform_extensions.dart';
import 'package:immich_mobile/infrastructure/entities/trash_sync.entity.dart';
import 'package:immich_mobile/infrastructure/entities/trash_sync.entity.drift.dart';
import 'package:immich_mobile/infrastructure/repositories/db.repository.dart';
import 'package:immich_mobile/infrastructure/repositories/local_asset.repository.dart';
import 'package:immich_mobile/repositories/asset_media.repository.dart';
import 'package:logging/logging.dart';

/// Mode for handling remote-delete events on this platform.
enum TrashSyncMode { off, autoSync, review }

/// Result of a user-driven trash decision (Keep / Move to trash).
typedef RemoteTrashResolveResult = ({int displayCount, bool success});

/// Outcome emitted on the repository's `restoreOutcomes` stream when a
/// remote-restore is processed. The UI layer subscribes and surfaces
/// notifications — particularly important on iOS, where the user must
/// manually recover assets from Recently Deleted.
class RestoreOutcome {
  final List<String> restoredAssetIds;
  final List<String> needsManualRestoreOnIos;

  const RestoreOutcome({required this.restoredAssetIds, required this.needsManualRestoreOnIos});
}

class TrashSyncCandidate {
  final String localAssetId;
  final String? checksum;
  final String? albumId;
  final DateTime? remoteDeletedAt;
  final TrashTriggerSource triggerSource;
  final String name;
  final AssetType type;
  final DateTime createdAt;
  final DateTime updatedAt;
  final int? width;
  final int? height;
  final int? durationMs;
  final bool isFavorite;
  final int orientation;
  final AssetPlaybackStyle playbackStyle;

  const TrashSyncCandidate({
    required this.localAssetId,
    required this.checksum,
    required this.albumId,
    required this.remoteDeletedAt,
    required this.triggerSource,
    required this.name,
    required this.type,
    required this.createdAt,
    required this.updatedAt,
    required this.width,
    required this.height,
    required this.durationMs,
    required this.isFavorite,
    required this.orientation,
    required this.playbackStyle,
  });
}

/// Owner of the trash-sync state machine.
///
/// Follows the codebase convention of rich repositories (see
/// `local_album.repository.dart`): owns transactional table writes plus
/// the OS-side trash/restore calls needed to keep the local file system
/// in sync with decisions recorded in `trash_sync_entity`.
///
/// **Every public method that mutates state is one transaction** —
/// the cross-repo atomicity gap from the original PR cannot recur.
class DriftTrashSyncRepository extends DriftDatabaseRepository {
  final Logger _logger = Logger('DriftTrashSyncRepository');

  final Drift _db;
  final DriftLocalAssetRepository _localAssetRepository;
  final AssetMediaRepository _assetMediaRepository;
  final StreamController<RestoreOutcome> _restoreOutcomes = StreamController.broadcast();

  DriftTrashSyncRepository(this._db, this._localAssetRepository, this._assetMediaRepository) : super(_db);

  /// Subscribe to restore-outcome events. iOS callers should surface
  /// `needsManualRestoreOnIos` lists as user-facing notifications
  /// ("recover from Recently Deleted in Photos").
  Stream<RestoreOutcome> get restoreOutcomes => _restoreOutcomes.stream;

  void dispose() {
    _restoreOutcomes.close();
  }

  TrashSyncMode get mode {
    if (Store.get(StoreKey.reviewOutOfSyncChangesAndroid, false)) {
      return TrashSyncMode.review;
    }
    if (Store.get(StoreKey.manageLocalMediaAndroid, false)) {
      return TrashSyncMode.autoSync;
    }
    return TrashSyncMode.off;
  }

  // ===================================================================
  // State machine: remote events
  // ===================================================================

  /// A remote asset was marked as deleted/trashed. Find matching local
  /// assets in backup-selected albums and either auto-trash them (auto
  /// mode + permission) or queue them for review.
  Future<void> recordRemoteTrash(Map<String, DateTime> remoteDeletedAtByRemoteId) async {
    if (remoteDeletedAtByRemoteId.isEmpty) {
      return;
    }
    final currentMode = mode;
    if (currentMode == TrashSyncMode.off) {
      return;
    }

    final candidatesByAlbum = await _localAssetRepository.getRemoteTrashCandidatesByAlbum(remoteDeletedAtByRemoteId);
    if (candidatesByAlbum.isEmpty) {
      _logger.fine('No local assets matched remote-delete batch of ${remoteDeletedAtByRemoteId.length}');
      return;
    }

    // Dedupe by local asset id — one state row per asset, regardless of
    // how many backup-selected albums it appears in.
    final uniqueById = <String, ({String albumId, RemoteDeletedLocalAsset candidate})>{};
    for (final entry in candidatesByAlbum.entries) {
      for (final candidate in entry.value) {
        uniqueById.putIfAbsent(candidate.asset.id, () => (albumId: entry.key, candidate: candidate));
      }
    }

    if (currentMode == TrashSyncMode.autoSync && await _canMoveLocalMediaToTrash()) {
      final ids = uniqueById.keys.toList();
      _logger.info('Auto-trashing ${ids.length} local assets');
      final movedIds = (await _assetMediaRepository.deleteAll(ids)).toSet();

      final newCandidates = uniqueById.values.map((item) => _candidateFrom(item.albumId, item.candidate)).toList();
      await upsertCandidates(newCandidates);
      if (movedIds.isNotEmpty) {
        await markDecision(movedIds, TrashStateDecision.appTrashed);
      }
      return;
    }

    final newCandidates = uniqueById.values.map((item) => _candidateFrom(item.albumId, item.candidate)).toList();
    await upsertCandidates(newCandidates);
  }

  /// A remote asset is alive again. Drop pending/kept rows for the same
  /// checksum; on Android, restore `appTrashed` rows via the OS. On iOS
  /// emit a notification for the user to do it manually.
  Future<void> recordRemoteRestore(Iterable<String> aliveRemoteChecksums) async {
    // Check permission BEFORE deleting state rows so a denied permission
    // doesn't silently drop in-flight restore intents.
    if (CurrentPlatform.isAndroid && !await _hasManageMediaPermission('restore from trash')) {
      return;
    }

    final affected = await deleteForRestoredRemotes(aliveRemoteChecksums);
    if (affected.isEmpty) {
      return;
    }

    final wereAppTrashed = affected.where((r) => r.decision == TrashStateDecision.appTrashed).toList();
    if (wereAppTrashed.isEmpty) {
      return;
    }

    if (CurrentPlatform.isAndroid) {
      final localAssets = wereAppTrashed.map((r) => r.toLocalAsset()).toList();
      final restoredIds = await _assetMediaRepository.restoreAssetsFromTrash(localAssets);
      _restoreOutcomes.add(RestoreOutcome(restoredAssetIds: restoredIds, needsManualRestoreOnIos: const []));
    } else if (CurrentPlatform.isIOS) {
      _restoreOutcomes.add(
        RestoreOutcome(
          restoredAssetIds: const [],
          needsManualRestoreOnIos: wereAppTrashed.map((r) => r.localAssetId).toList(),
        ),
      );
    }
  }

  /// Periodic catch-up: restore app-trashed assets whose remote came
  /// alive but for which we never received (or never acted on) the
  /// matching sync event. Complements [recordRemoteRestore], which is
  /// event-driven.
  ///
  /// **Android-only.** iOS can't programmatically restore, so a periodic
  /// catch-up would either spam the same notification every sync or
  /// require extra "already notified" state.
  Future<void> syncRestoresForRevivedAssets() async {
    if (!CurrentPlatform.isAndroid) {
      return;
    }
    if (!await _hasManageMediaPermission('restore from trash')) {
      return;
    }

    final rows = await getAppTrashedRemotelyRestored();
    if (rows.isEmpty) {
      return;
    }

    final localAssets = rows.map((r) => r.toLocalAsset()).toList();
    final restoredIds = await _assetMediaRepository.restoreAssetsFromTrash(localAssets);
    if (restoredIds.isEmpty) {
      return;
    }

    // Drop rows we successfully restored. Anything we couldn't restore
    // stays for next sync, or gets swept by `cleanup()` rule 1.
    await deleteByAssetIds(restoredIds);
    _restoreOutcomes.add(RestoreOutcome(restoredAssetIds: restoredIds, needsManualRestoreOnIos: const []));
  }

  // ===================================================================
  // State machine: user actions
  // ===================================================================

  /// Apply a user review decision. The HIGH atomicity bug from the
  /// original PR is structurally impossible because both writes are
  /// single-row column updates on the same table.
  Future<RemoteTrashResolveResult> applyReviewDecision(Iterable<String> localAssetIds, {required bool keep}) async {
    final ids = localAssetIds.toSet();
    if (ids.isEmpty) {
      return (displayCount: 0, success: true);
    }

    if (keep) {
      await markDecision(ids, TrashStateDecision.kept);
      return (displayCount: ids.length, success: true);
    }

    final movedIds = (await _assetMediaRepository.deleteAll(ids.toList())).toSet();
    if (movedIds.isEmpty) {
      return (displayCount: 0, success: false);
    }
    await markDecision(movedIds, TrashStateDecision.appTrashed);
    return (displayCount: movedIds.length, success: movedIds.length == ids.length);
  }

  /// Record an asset the user manually trashed inside the app. Replaces
  /// the old `applyTrashedAssets` journal write on `trashed_local_asset`.
  Future<void> recordUserManualTrash(Iterable<String> localAssetIds) async {
    final ids = localAssetIds.toSet();
    if (ids.isEmpty) {
      return;
    }
    final snapshots = await _localAssetRepository.getByIds(ids);
    if (snapshots.isEmpty) {
      return;
    }
    final manualCandidates = snapshots
        .map(
          (a) => TrashSyncCandidate(
            localAssetId: a.id,
            checksum: a.checksum,
            albumId: null,
            remoteDeletedAt: null,
            triggerSource: TrashTriggerSource.localUser,
            name: a.name,
            type: a.type,
            createdAt: a.createdAt,
            updatedAt: a.updatedAt,
            width: a.width,
            height: a.height,
            durationMs: a.durationMs,
            isFavorite: a.isFavorite,
            orientation: a.orientation,
            playbackStyle: a.playbackStyle,
          ),
        )
        .toList();
    await upsertCandidates(manualCandidates);
    await markDecision(ids, TrashStateDecision.appTrashed);
  }

  // ===================================================================
  // Helpers (private)
  // ===================================================================

  TrashSyncCandidate _candidateFrom(String albumId, RemoteDeletedLocalAsset candidate) {
    final asset = candidate.asset;
    return TrashSyncCandidate(
      localAssetId: asset.id,
      checksum: asset.checksum,
      albumId: albumId,
      remoteDeletedAt: candidate.remoteDeletedAt,
      triggerSource: TrashTriggerSource.remoteSync,
      name: asset.name,
      type: asset.type,
      createdAt: asset.createdAt,
      updatedAt: asset.updatedAt,
      width: asset.width,
      height: asset.height,
      durationMs: asset.durationMs,
      isFavorite: asset.isFavorite,
      orientation: asset.orientation,
      playbackStyle: asset.playbackStyle,
    );
  }

  Future<bool> _canMoveLocalMediaToTrash() async {
    if (CurrentPlatform.isAndroid) {
      return await _hasManageMediaPermission('move to trash');
    }
    return true;
  }

  Future<bool> _hasManageMediaPermission(String logContext) async {
    if (!CurrentPlatform.isAndroid) {
      return true;
    }
    final hasPermission = await _assetMediaRepository.hasManageMediaPermission();
    if (!hasPermission) {
      _logger.warning('$logContext blocked: MANAGE_MEDIA permission missing');
    }
    return hasPermission;
  }

  // ===================================================================
  // Low-level table writes (used by the state machine above and by
  // direct callers/tests).
  // ===================================================================

  Future<void> upsertCandidates(Iterable<TrashSyncCandidate> candidates) async {
    if (candidates.isEmpty) {
      return;
    }

    return _db.batch((batch) {
      for (final c in candidates) {
        batch.insert(
          _db.trashSyncEntity,
          TrashSyncEntityCompanion.insert(
            localAssetId: c.localAssetId,
            checksum: Value(c.checksum),
            decision: TrashStateDecision.pendingReview,
            triggerSource: c.triggerSource,
            albumId: Value(c.albumId),
            remoteDeletedAt: Value(c.remoteDeletedAt),
            name: c.name,
            type: c.type,
            createdAt: Value(c.createdAt),
            updatedAt: Value(c.updatedAt),
            width: Value(c.width),
            height: Value(c.height),
            durationMs: Value(c.durationMs),
            isFavorite: Value(c.isFavorite),
            orientation: Value(c.orientation),
            playbackStyle: Value(c.playbackStyle),
          ),
          // Existing rows already have a decision (pending or terminal).
          // Don't overwrite — the prior decision still applies.
          mode: InsertMode.insertOrIgnore,
        );
      }
    });
  }

  Future<void> markDecision(Iterable<String> localAssetIds, TrashStateDecision decision) {
    assert(decision != TrashStateDecision.pendingReview, 'Use upsertCandidates for pending rows');
    final ids = localAssetIds.toSet();
    if (ids.isEmpty) {
      return Future.value();
    }

    return _db.batch((batch) {
      for (final slice in ids.slices(kDriftMaxChunk)) {
        batch.update(
          _db.trashSyncEntity,
          TrashSyncEntityCompanion(decision: Value(decision), decidedAt: Value(DateTime.now())),
          where: (tbl) => tbl.localAssetId.isIn(slice),
        );
      }
    });
  }

  /// Atomically read-then-delete rows for restored remotes. Caller
  /// decides whether to trigger an OS restore (Android) or surface a
  /// notification (iOS).
  Future<List<TrashSyncEntityData>> deleteForRestoredRemotes(Iterable<String> remoteAliveChecksums) {
    final checksums = remoteAliveChecksums.toSet();
    if (checksums.isEmpty) {
      return Future.value(const []);
    }

    return _db.transaction(() async {
      final affected = <TrashSyncEntityData>[];
      for (final slice in checksums.slices(kDriftMaxChunk)) {
        final rows = await (_db.select(
          _db.trashSyncEntity,
        )..where((t) => t.checksum.isIn(slice) & t.triggerSource.equalsValue(TrashTriggerSource.remoteSync))).get();
        affected.addAll(rows);
      }
      for (final slice in checksums.slices(kDriftMaxChunk)) {
        await (_db.delete(
          _db.trashSyncEntity,
        )..where((t) => t.checksum.isIn(slice) & t.triggerSource.equalsValue(TrashTriggerSource.remoteSync))).go();
      }
      return affected;
    });
  }

  Future<void> deleteByAssetIds(Iterable<String> localAssetIds) {
    final ids = localAssetIds.toSet();
    if (ids.isEmpty) {
      return Future.value();
    }

    return _db.batch((batch) {
      for (final slice in ids.slices(kDriftMaxChunk)) {
        batch.deleteWhere(_db.trashSyncEntity, (t) => t.localAssetId.isIn(slice));
      }
    });
  }

  Future<List<TrashSyncEntityData>> getAppTrashedRemotelyRestored() async {
    final selectedAlbumIds = _db.selectOnly(_db.localAlbumEntity)
      ..addColumns([_db.localAlbumEntity.id])
      ..where(_db.localAlbumEntity.backupSelection.equalsValue(BackupSelection.selected));

    final rows =
        await (_db.select(_db.trashSyncEntity).join([
              innerJoin(_db.remoteAssetEntity, _db.remoteAssetEntity.checksum.equalsExp(_db.trashSyncEntity.checksum)),
            ])..where(
              _db.trashSyncEntity.decision.equalsValue(TrashStateDecision.appTrashed) &
                  _db.trashSyncEntity.triggerSource.equalsValue(TrashTriggerSource.remoteSync) &
                  _db.remoteAssetEntity.deletedAt.isNull() &
                  (_db.trashSyncEntity.albumId.isInQuery(selectedAlbumIds) | _db.trashSyncEntity.albumId.isNull()),
            ))
            .get();

    return rows.map((r) => r.readTable(_db.trashSyncEntity)).toList();
  }

  Future<Set<String>> getAppTrashedAssetIds() async {
    final rows =
        await (_db.selectOnly(_db.trashSyncEntity)
              ..addColumns([_db.trashSyncEntity.localAssetId])
              ..where(_db.trashSyncEntity.decision.equalsValue(TrashStateDecision.appTrashed)))
            .get();
    return rows.map((r) => r.read(_db.trashSyncEntity.localAssetId)!).toSet();
  }

  Stream<int> watchPendingReviewCount() {
    final countExpr = _db.trashSyncEntity.localAssetId.count();

    final q = _db.selectOnly(_db.trashSyncEntity)
      ..addColumns([countExpr])
      ..where(
        _db.trashSyncEntity.decision.equalsValue(TrashStateDecision.pendingReview) &
            _isLocalAssetInBackupSelectedAlbum(),
      );

    return q.watchSingle().map((row) => row.read(countExpr) ?? 0).distinct();
  }

  Stream<bool> watchIsAssetPendingById(String localAssetId) {
    final q = _db.selectOnly(_db.trashSyncEntity)
      ..addColumns([_db.trashSyncEntity.localAssetId])
      ..where(
        _db.trashSyncEntity.localAssetId.equals(localAssetId) &
            _db.trashSyncEntity.decision.equalsValue(TrashStateDecision.pendingReview) &
            _isLocalAssetInBackupSelectedAlbum(),
      )
      ..limit(1);
    return q.watchSingleOrNull().map((row) => row != null).distinct();
  }

  Stream<bool> watchIsAssetPendingByChecksum(String checksum) {
    final q = _db.selectOnly(_db.trashSyncEntity)
      ..addColumns([_db.trashSyncEntity.localAssetId])
      ..where(
        _db.trashSyncEntity.checksum.equals(checksum) &
            _db.trashSyncEntity.decision.equalsValue(TrashStateDecision.pendingReview) &
            _isLocalAssetInBackupSelectedAlbum(),
      )
      ..limit(1);
    return q.watchSingleOrNull().map((row) => row != null).distinct();
  }

  Expression<bool> _isLocalAssetInBackupSelectedAlbum() {
    final selectedAlbumQ =
        _db.localAlbumAssetEntity.selectOnly().join([
            innerJoin(
              _db.localAlbumEntity,
              _db.localAlbumAssetEntity.albumId.equalsExp(_db.localAlbumEntity.id),
              useColumns: false,
            ),
          ])
          ..addColumns([_db.localAlbumAssetEntity.assetId])
          ..where(
            _db.localAlbumAssetEntity.assetId.equalsExp(_db.trashSyncEntity.localAssetId) &
                _db.localAlbumEntity.backupSelection.equalsValue(BackupSelection.selected),
          );
    return existsQuery(selectedAlbumQ);
  }

  /// Two-rule cleanup, one transaction.
  ///
  /// Rule 1: the remote came back alive (any decision state).
  /// Rule 2: the `local_asset` row is gone *and* state != appTrashed.
  ///         (appTrashed rows are kept because they're needed for restore.)
  Future<int> cleanup() async {
    return _db.transaction(() async {
      final aliveChecksums = _db.selectOnly(_db.remoteAssetEntity)
        ..addColumns([_db.remoteAssetEntity.checksum])
        ..where(_db.remoteAssetEntity.deletedAt.isNull());
      final rule1 = await (_db.delete(_db.trashSyncEntity)..where((t) => t.checksum.isInQuery(aliveChecksums))).go();

      final liveLocalIds = _db.selectOnly(_db.localAssetEntity)..addColumns([_db.localAssetEntity.id]);
      final rule2 =
          await (_db.delete(_db.trashSyncEntity)..where(
                (t) =>
                    t.localAssetId.isNotInQuery(liveLocalIds) &
                    t.decision.equalsValue(TrashStateDecision.appTrashed).not(),
              ))
              .go();

      return rule1 + rule2;
    });
  }
}
