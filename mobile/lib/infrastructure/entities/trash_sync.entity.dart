import 'package:drift/drift.dart';
import 'package:immich_mobile/domain/models/asset/base_asset.model.dart';
import 'package:immich_mobile/infrastructure/entities/trash_sync.entity.drift.dart';
import 'package:immich_mobile/infrastructure/utils/asset.mixin.dart';
import 'package:immich_mobile/infrastructure/utils/drift_default.mixin.dart';

/// What the user (or auto-mode) decided about this candidate.
enum TrashStateDecision {
  // do not change this order!
  pendingReview,
  kept,
  appTrashed,
}

/// Why this row was created. Drives restore behaviour.
enum TrashTriggerSource {
  // do not change this order!
  remoteSync,
  localUser,
}

/// Single source of truth for "what did we decide to do with this local asset?".
///
/// Replaces `trash_sync_entity` and the operational-journal aspect of
/// `trashed_local_asset_entity`. The OS-trash *mirror* role of
/// `trashed_local_asset_entity` (Android `source = localSync` rows)
/// stays separate.
@TableIndex.sql('CREATE INDEX IF NOT EXISTS idx_trash_sync_decision ON trash_sync_entity (decision)')
@TableIndex.sql('CREATE INDEX IF NOT EXISTS idx_trash_sync_checksum ON trash_sync_entity (checksum)')
class TrashSyncEntity extends Table with DriftDefaultsMixin, AssetEntityMixin {
  const TrashSyncEntity();

  TextColumn get localAssetId => text()();

  TextColumn get checksum => text().nullable()();

  IntColumn get decision => intEnum<TrashStateDecision>()();

  IntColumn get triggerSource => intEnum<TrashTriggerSource>()();

  TextColumn get albumId => text().nullable()();

  DateTimeColumn get remoteDeletedAt => dateTime().nullable()();

  DateTimeColumn get decidedAt => dateTime().withDefault(currentDateAndTime)();

  BoolColumn get isFavorite => boolean().withDefault(const Constant(false))();

  IntColumn get orientation => integer().withDefault(const Constant(0))();

  IntColumn get playbackStyle => intEnum<AssetPlaybackStyle>().withDefault(const Constant(0))();

  @override
  Set<Column> get primaryKey => {localAssetId};
}

extension TrashSyncEntityDataDomainExtension on TrashSyncEntityData {
  LocalAsset toLocalAsset() => LocalAsset(
    id: localAssetId,
    name: name,
    checksum: checksum,
    type: type,
    createdAt: createdAt,
    updatedAt: updatedAt,
    durationMs: durationMs,
    isFavorite: isFavorite,
    height: height,
    width: width,
    orientation: orientation,
    playbackStyle: playbackStyle,
    isEdited: false,
  );
}
