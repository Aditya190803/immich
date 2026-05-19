import 'package:drift/drift.dart' as drift;
import 'package:drift/native.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:immich_mobile/domain/models/store.model.dart';
import 'package:immich_mobile/domain/services/store.service.dart';
import 'package:immich_mobile/entities/store.entity.dart';
import 'package:immich_mobile/infrastructure/repositories/db.repository.dart';
import 'package:immich_mobile/infrastructure/repositories/store.repository.dart';
import 'package:immich_mobile/repositories/download.repository.dart';
import 'package:immich_mobile/services/action.service.dart';
import 'package:mocktail/mocktail.dart';

import '../fixtures/asset.stub.dart';
import '../infrastructure/repository.mock.dart';
import '../repository.mocks.dart';

class MockDownloadRepository extends Mock implements DownloadRepository {}

void main() {
  late ActionService sut;

  late MockAssetApiRepository assetApiRepository;
  late MockRemoteAssetRepository remoteAssetRepository;
  late MockDriftLocalAssetRepository localAssetRepository;
  late MockDriftAlbumApiRepository albumApiRepository;
  late MockRemoteAlbumRepository remoteAlbumRepository;
  late MockDriftTrashSyncRepository trashSyncRepository;
  late MockAssetMediaRepository assetMediaRepository;
  late MockDownloadRepository downloadRepository;
  late MockTagService tagService;

  late Drift db;

  setUpAll(() async {
    registerFallbackValue(LocalAssetStub.image1);
    TestWidgetsFlutterBinding.ensureInitialized();
    debugDefaultTargetPlatformOverride = TargetPlatform.android;

    db = Drift(drift.DatabaseConnection(NativeDatabase.memory(), closeStreamsSynchronously: true));
    await StoreService.init(storeRepository: DriftStoreRepository(db));
  });

  tearDownAll(() async {
    debugDefaultTargetPlatformOverride = null;
    await Store.clear();
    await db.close();
  });

  setUp(() {
    assetApiRepository = MockAssetApiRepository();
    remoteAssetRepository = MockRemoteAssetRepository();
    localAssetRepository = MockDriftLocalAssetRepository();
    albumApiRepository = MockDriftAlbumApiRepository();
    remoteAlbumRepository = MockRemoteAlbumRepository();
    trashSyncRepository = MockDriftTrashSyncRepository();
    assetMediaRepository = MockAssetMediaRepository();
    downloadRepository = MockDownloadRepository();
    tagService = MockTagService();

    sut = ActionService(
      assetApiRepository,
      remoteAssetRepository,
      localAssetRepository,
      albumApiRepository,
      remoteAlbumRepository,
      trashSyncRepository,
      assetMediaRepository,
      downloadRepository,
      tagService,
    );

    when(() => trashSyncRepository.recordUserManualTrash(any())).thenAnswer((_) async {});
    when(() => localAssetRepository.delete(any())).thenAnswer((_) async {});
  });

  tearDown(() async {
    await Store.clear();
  });

  group('ActionService.deleteLocal', () {
    test('records user manual trash and deletes local asset row when Android trash handling is enabled', () async {
      await Store.put(StoreKey.manageLocalMediaAndroid, true);
      const ids = ['a', 'b'];

      when(() => assetMediaRepository.deleteAll(ids)).thenAnswer((_) async => ids);

      final result = await sut.deleteLocal(ids);

      expect(result, ids.length);
      verify(() => assetMediaRepository.deleteAll(ids)).called(1);
      verify(() => trashSyncRepository.recordUserManualTrash(ids)).called(1);
      verify(() => localAssetRepository.delete(ids)).called(1);
    });

    test('only deletes locally when Android trash handling is disabled', () async {
      await Store.put(StoreKey.manageLocalMediaAndroid, false);
      const ids = ['c'];

      when(() => assetMediaRepository.deleteAll(ids)).thenAnswer((_) async => ids);

      final result = await sut.deleteLocal(ids);

      expect(result, ids.length);
      verify(() => assetMediaRepository.deleteAll(ids)).called(1);
      verify(() => localAssetRepository.delete(ids)).called(1);
      verifyNever(() => trashSyncRepository.recordUserManualTrash(any()));
    });

    test('short-circuits when nothing was deleted', () async {
      await Store.put(StoreKey.manageLocalMediaAndroid, true);
      const ids = ['x'];

      when(() => assetMediaRepository.deleteAll(ids)).thenAnswer((_) async => <String>[]);

      final result = await sut.deleteLocal(ids);

      expect(result, 0);
      verify(() => assetMediaRepository.deleteAll(ids)).called(1);
      verifyNever(() => trashSyncRepository.recordUserManualTrash(any()));
      verifyNever(() => localAssetRepository.delete(any()));
    });
  });

  // The detailed approve/reject/partial-success behaviour is owned by
  // DriftTrashSyncRepository (see trash_sync_repository_test.dart
  // for the state-machine tests). Here we only verify that
  // ActionService delegates correctly — the HIGH atomicity bug from the
  // original PR can't recur because the state-machine surface is a
  // single transactional method.
  group('ActionService.resolveRemoteTrash', () {
    test('delegates "keep" decisions to DriftTrashSyncRepository.applyReviewDecision', () async {
      when(
        () => trashSyncRepository.applyReviewDecision(any(), keep: any(named: 'keep')),
      ).thenAnswer((_) async => (displayCount: 2, success: true));

      final result = await sut.resolveRemoteTrash(['local-1', 'local-2'], keep: true);

      expect(result, (displayCount: 2, success: true));
      verify(() => trashSyncRepository.applyReviewDecision(['local-1', 'local-2'], keep: true)).called(1);
    });

    test('delegates "trash" decisions to DriftTrashSyncRepository.applyReviewDecision', () async {
      when(
        () => trashSyncRepository.applyReviewDecision(any(), keep: any(named: 'keep')),
      ).thenAnswer((_) async => (displayCount: 1, success: true));

      final result = await sut.resolveRemoteTrash(['local-1'], keep: false);

      expect(result, (displayCount: 1, success: true));
      verify(() => trashSyncRepository.applyReviewDecision(['local-1'], keep: false)).called(1);
    });

    test('propagates partial-success results from DriftTrashSyncRepository unchanged', () async {
      when(
        () => trashSyncRepository.applyReviewDecision(any(), keep: any(named: 'keep')),
      ).thenAnswer((_) async => (displayCount: 1, success: false));

      final result = await sut.resolveRemoteTrash(['local-1', 'local-2'], keep: false);

      expect(result, (displayCount: 1, success: false));
    });
  });
}
