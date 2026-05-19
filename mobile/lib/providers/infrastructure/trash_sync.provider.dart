import 'package:async/async.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/infrastructure/repositories/trash_sync.repository.dart';
import 'package:immich_mobile/providers/app_settings.provider.dart';
import 'package:immich_mobile/providers/infrastructure/asset.provider.dart';
import 'package:immich_mobile/providers/infrastructure/db.provider.dart';
import 'package:immich_mobile/repositories/asset_media.repository.dart';
import 'package:immich_mobile/services/app_settings.service.dart';

typedef TrashedAssetsCount = ({int total, int hashed});

final trashSyncRepositoryProvider = Provider<DriftTrashSyncRepository>((ref) {
  final repo = DriftTrashSyncRepository(
    ref.watch(driftProvider),
    ref.watch(localAssetRepository),
    ref.watch(assetMediaRepositoryProvider),
  );
  ref.onDispose(repo.dispose);
  return repo;
});

final trashedAssetsCountProvider = StreamProvider<TrashedAssetsCount>((ref) {
  final repo = ref.watch(trashedLocalAssetRepository);
  final total$ = repo.watchCount();
  final hashed$ = repo.watchHashedCount();
  return StreamZip<int>([total$, hashed$]).map((values) => (total: values[0], hashed: values[1]));
});

final outOfSyncAssetsCountProvider = StreamProvider<int>((ref) {
  final enabledReviewMode = ref.watch(appSettingStreamProvider(AppSettingsEnum.reviewOutOfSyncChangesAndroid));
  final repo = ref.watch(trashSyncRepositoryProvider);
  return enabledReviewMode.when(
    data: (enabled) => enabled ? repo.watchPendingReviewCount() : Stream<int>.value(0),
    loading: () => Stream<int>.value(0),
    error: (_, __) => Stream<int>.value(0),
  );
});

final isWaitingForTrashApprovalProvider = StreamProvider.family<bool, String?>((ref, checksum) {
  final enabledReviewMode = ref.watch(appSettingStreamProvider(AppSettingsEnum.reviewOutOfSyncChangesAndroid));
  final repo = ref.watch(trashSyncRepositoryProvider);
  return enabledReviewMode.when(
    data: (enabled) => enabled && checksum != null ? repo.watchIsAssetPendingByChecksum(checksum) : Stream.value(false),
    loading: () => Stream.value(false),
    error: (_, __) => Stream.value(false),
  );
});
