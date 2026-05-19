import 'dart:async';

import 'package:drift/drift.dart' as drift;
import 'package:drift/native.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:immich_mobile/domain/models/store.model.dart';
import 'package:immich_mobile/domain/models/sync_event.model.dart';
import 'package:immich_mobile/domain/services/store.service.dart';
import 'package:immich_mobile/domain/services/sync_stream.service.dart';
import 'package:immich_mobile/infrastructure/repositories/trash_sync.repository.dart';
import 'package:immich_mobile/entities/store.entity.dart';
import 'package:immich_mobile/infrastructure/repositories/db.repository.dart';
import 'package:immich_mobile/infrastructure/repositories/store.repository.dart';
import 'package:immich_mobile/infrastructure/repositories/sync_api.repository.dart';
import 'package:immich_mobile/infrastructure/repositories/sync_stream.repository.dart';
import 'package:immich_mobile/utils/semver.dart';
import 'package:mocktail/mocktail.dart';
import 'package:openapi/api.dart';

import '../../api.mocks.dart';
import '../../fixtures/asset.stub.dart';
import '../../fixtures/sync_stream.stub.dart';
import '../../infrastructure/repository.mock.dart';
import '../../service.mocks.dart';

class _AbortCallbackWrapper {
  const _AbortCallbackWrapper();

  bool call() => false;
}

class _MockAbortCallbackWrapper extends Mock implements _AbortCallbackWrapper {}

class _CancellationWrapper {
  const _CancellationWrapper();

  bool call() => false;
}

class _MockCancellationWrapper extends Mock implements _CancellationWrapper {}

void main() {
  late SyncStreamService sut;
  late SyncStreamRepository mockSyncStreamRepo;
  late SyncApiRepository mockSyncApiRepo;
  late DriftTrashSyncRepository mockDriftTrashSyncRepository;
  late MockApiService mockApi;
  late MockServerApi mockServerApi;
  late MockSyncMigrationRepository mockSyncMigrationRepo;
  late Future<void> Function(List<SyncEvent>, Function(), Function()) handleEventsCallback;
  late _MockAbortCallbackWrapper mockAbortCallbackWrapper;
  late _MockAbortCallbackWrapper mockResetCallbackWrapper;
  late Drift db;

  setUpAll(() async {
    TestWidgetsFlutterBinding.ensureInitialized();
    debugDefaultTargetPlatformOverride = TargetPlatform.android;
    registerFallbackValue(LocalAssetStub.image1);
    registerFallbackValue(const SemVer(major: 2, minor: 5, patch: 0));

    db = Drift(drift.DatabaseConnection(NativeDatabase.memory(), closeStreamsSynchronously: true));
    await StoreService.init(storeRepository: DriftStoreRepository(db), listenUpdates: false);
  });

  tearDownAll(() async {
    debugDefaultTargetPlatformOverride = null;
    await Store.clear();
    await db.close();
  });

  successHandler(Invocation _) async => true;

  setUp(() async {
    mockSyncStreamRepo = MockSyncStreamRepository();
    mockSyncApiRepo = MockSyncApiRepository();
    mockDriftTrashSyncRepository = MockDriftTrashSyncRepository();
    mockAbortCallbackWrapper = _MockAbortCallbackWrapper();
    mockResetCallbackWrapper = _MockAbortCallbackWrapper();
    mockApi = MockApiService();
    mockServerApi = MockServerApi();
    mockSyncMigrationRepo = MockSyncMigrationRepository();

    when(() => mockAbortCallbackWrapper()).thenReturn(false);

    when(() => mockSyncApiRepo.streamChanges(any(), serverVersion: any(named: 'serverVersion'))).thenAnswer((
      invocation,
    ) async {
      handleEventsCallback = invocation.positionalArguments.first;
    });

    when(
      () => mockSyncApiRepo.streamChanges(
        any(),
        onReset: any(named: 'onReset'),
        serverVersion: any(named: 'serverVersion'),
      ),
    ).thenAnswer((invocation) async {
      handleEventsCallback = invocation.positionalArguments.first;
    });

    when(() => mockSyncApiRepo.ack(any())).thenAnswer((_) async => {});
    when(() => mockSyncApiRepo.deleteSyncAck(any())).thenAnswer((_) async => {});

    when(() => mockApi.serverInfoApi).thenReturn(mockServerApi);
    when(
      () => mockServerApi.getServerVersion(),
    ).thenAnswer((_) async => ServerVersionResponseDto(major: 1, minor: 132, patch_: 0));

    when(() => mockSyncStreamRepo.updateUsersV1(any())).thenAnswer(successHandler);
    when(() => mockSyncStreamRepo.deleteUsersV1(any())).thenAnswer(successHandler);
    when(() => mockSyncStreamRepo.updatePartnerV1(any())).thenAnswer(successHandler);
    when(() => mockSyncStreamRepo.deletePartnerV1(any())).thenAnswer(successHandler);
    when(() => mockSyncStreamRepo.updateAssetsV1(any())).thenAnswer(successHandler);
    when(
      () => mockSyncStreamRepo.updateAssetsV1(any(), debugLabel: any(named: 'debugLabel')),
    ).thenAnswer(successHandler);
    when(() => mockSyncStreamRepo.deleteAssetsV1(any())).thenAnswer(successHandler);
    when(
      () => mockSyncStreamRepo.deleteAssetsV1(any(), debugLabel: any(named: 'debugLabel')),
    ).thenAnswer(successHandler);
    when(() => mockSyncStreamRepo.updateAssetsExifV1(any())).thenAnswer(successHandler);
    when(
      () => mockSyncStreamRepo.updateAssetsExifV1(any(), debugLabel: any(named: 'debugLabel')),
    ).thenAnswer(successHandler);
    when(() => mockSyncStreamRepo.updateMemoriesV1(any())).thenAnswer(successHandler);
    when(() => mockSyncStreamRepo.deleteMemoriesV1(any())).thenAnswer(successHandler);
    when(() => mockSyncStreamRepo.updateMemoryAssetsV1(any())).thenAnswer(successHandler);
    when(() => mockSyncStreamRepo.deleteMemoryAssetsV1(any())).thenAnswer(successHandler);
    when(
      () => mockSyncStreamRepo.updateStacksV1(any(), debugLabel: any(named: 'debugLabel')),
    ).thenAnswer(successHandler);
    when(
      () => mockSyncStreamRepo.deleteStacksV1(any(), debugLabel: any(named: 'debugLabel')),
    ).thenAnswer(successHandler);
    when(() => mockSyncStreamRepo.updateUserMetadatasV1(any())).thenAnswer(successHandler);
    when(() => mockSyncStreamRepo.deleteUserMetadatasV1(any())).thenAnswer(successHandler);
    when(() => mockSyncStreamRepo.updatePeopleV1(any())).thenAnswer(successHandler);
    when(() => mockSyncStreamRepo.deletePeopleV1(any())).thenAnswer(successHandler);
    when(() => mockSyncStreamRepo.updateAssetFacesV1(any())).thenAnswer(successHandler);
    when(() => mockSyncStreamRepo.deleteAssetFacesV1(any())).thenAnswer(successHandler);
    when(() => mockSyncMigrationRepo.v20260128CopyExifWidthHeightToAsset()).thenAnswer(successHandler);

    sut = SyncStreamService(
      syncApiRepository: mockSyncApiRepo,
      syncStreamRepository: mockSyncStreamRepo,
      trashSyncRepository: mockDriftTrashSyncRepository,
      api: mockApi,
      syncMigrationRepository: mockSyncMigrationRepo,
    );

    when(() => mockDriftTrashSyncRepository.recordRemoteTrash(any())).thenAnswer((_) async {});
    when(() => mockDriftTrashSyncRepository.recordRemoteRestore(any())).thenAnswer((_) async {});
    await Store.put(StoreKey.manageLocalMediaAndroid, false);
    await Store.put(StoreKey.reviewOutOfSyncChangesAndroid, false);
  });

  Future<void> simulateEvents(List<SyncEvent> events) async {
    await sut.sync();
    await handleEventsCallback(events, mockAbortCallbackWrapper.call, mockResetCallbackWrapper.call);
  }

  group("SyncStreamService - _handleEvents", () {
    test("processes events and acks successfully when handlers succeed", () async {
      final events = [
        SyncStreamStub.userDeleteV1,
        SyncStreamStub.userV1Admin,
        SyncStreamStub.userV1User,
        SyncStreamStub.partnerDeleteV1,
        SyncStreamStub.partnerV1,
      ];

      await simulateEvents(events);

      verifyInOrder([
        () => mockSyncStreamRepo.deleteUsersV1(any()),
        () => mockSyncApiRepo.ack(["2"]),
        () => mockSyncStreamRepo.updateUsersV1(any()),
        () => mockSyncApiRepo.ack(["5"]),
        () => mockSyncStreamRepo.deletePartnerV1(any()),
        () => mockSyncApiRepo.ack(["4"]),
        () => mockSyncStreamRepo.updatePartnerV1(any()),
        () => mockSyncApiRepo.ack(["3"]),
      ]);
      verifyNever(() => mockAbortCallbackWrapper());
    });

    test("processes final batch correctly", () async {
      final events = [SyncStreamStub.userDeleteV1, SyncStreamStub.userV1Admin];

      await simulateEvents(events);

      verifyInOrder([
        () => mockSyncStreamRepo.deleteUsersV1(any()),
        () => mockSyncApiRepo.ack(["2"]),
        () => mockSyncStreamRepo.updateUsersV1(any()),
        () => mockSyncApiRepo.ack(["1"]),
      ]);
      verifyNever(() => mockAbortCallbackWrapper());
    });

    test("does not process or ack when event list is empty", () async {
      await simulateEvents([]);

      verifyNever(() => mockSyncStreamRepo.updateUsersV1(any()));
      verifyNever(() => mockSyncStreamRepo.deleteUsersV1(any()));
      verifyNever(() => mockSyncStreamRepo.updatePartnerV1(any()));
      verifyNever(() => mockSyncStreamRepo.deletePartnerV1(any()));
      verifyNever(() => mockAbortCallbackWrapper());
      verifyNever(() => mockSyncApiRepo.ack(any()));
    });

    test("aborts and stops processing if cancelled during iteration", () async {
      final cancellationChecker = _MockCancellationWrapper();
      when(() => cancellationChecker()).thenReturn(false);

      sut = SyncStreamService(
        syncApiRepository: mockSyncApiRepo,
        syncStreamRepository: mockSyncStreamRepo,
        trashSyncRepository: mockDriftTrashSyncRepository,
        cancelChecker: cancellationChecker.call,
        api: mockApi,
        syncMigrationRepository: mockSyncMigrationRepo,
      );
      await sut.sync();

      final events = [SyncStreamStub.userDeleteV1, SyncStreamStub.userV1Admin, SyncStreamStub.partnerDeleteV1];

      when(() => mockSyncStreamRepo.deleteUsersV1(any())).thenAnswer((_) async {
        when(() => cancellationChecker()).thenReturn(true);
      });

      await handleEventsCallback(events, mockAbortCallbackWrapper.call, mockResetCallbackWrapper.call);

      verify(() => mockSyncStreamRepo.deleteUsersV1(any())).called(1);
      verifyNever(() => mockSyncStreamRepo.updateUsersV1(any()));
      verifyNever(() => mockSyncStreamRepo.deletePartnerV1(any()));

      verify(() => mockAbortCallbackWrapper()).called(1);

      verify(() => mockSyncApiRepo.ack(["2"])).called(1);
    });

    test("aborts and stops processing if cancelled before processing batch", () async {
      final cancellationChecker = _MockCancellationWrapper();
      when(() => cancellationChecker()).thenReturn(false);

      final processingCompleter = Completer<void>();
      bool handler1Started = false;
      when(() => mockSyncStreamRepo.deleteUsersV1(any())).thenAnswer((_) async {
        handler1Started = true;
        return processingCompleter.future;
      });

      sut = SyncStreamService(
        syncApiRepository: mockSyncApiRepo,
        syncStreamRepository: mockSyncStreamRepo,
        trashSyncRepository: mockDriftTrashSyncRepository,
        cancelChecker: cancellationChecker.call,
        api: mockApi,
        syncMigrationRepository: mockSyncMigrationRepo,
      );

      await sut.sync();

      final events = [SyncStreamStub.userDeleteV1, SyncStreamStub.userV1Admin, SyncStreamStub.partnerDeleteV1];

      final processingFuture = handleEventsCallback(
        events,
        mockAbortCallbackWrapper.call,
        mockResetCallbackWrapper.call,
      );
      await pumpEventQueue();

      expect(handler1Started, isTrue);

      // Signal cancellation while handler 1 is waiting
      when(() => cancellationChecker()).thenReturn(true);
      await pumpEventQueue();

      processingCompleter.complete();
      await processingFuture;

      verifyNever(() => mockSyncStreamRepo.updateUsersV1(any()));

      verify(() => mockSyncApiRepo.ack(["2"])).called(1);
    });

    test("processes memory sync events successfully", () async {
      final events = [
        SyncStreamStub.memoryV1,
        SyncStreamStub.memoryDeleteV1,
        SyncStreamStub.memoryToAssetV1,
        SyncStreamStub.memoryToAssetDeleteV1,
      ];

      await simulateEvents(events);

      verifyInOrder([
        () => mockSyncStreamRepo.updateMemoriesV1(any()),
        () => mockSyncApiRepo.ack(["5"]),
        () => mockSyncStreamRepo.deleteMemoriesV1(any()),
        () => mockSyncApiRepo.ack(["6"]),
        () => mockSyncStreamRepo.updateMemoryAssetsV1(any()),
        () => mockSyncApiRepo.ack(["7"]),
        () => mockSyncStreamRepo.deleteMemoryAssetsV1(any()),
        () => mockSyncApiRepo.ack(["8"]),
      ]);
      verifyNever(() => mockAbortCallbackWrapper());
    });

    test("processes mixed memory and user events in correct order", () async {
      final events = [
        SyncStreamStub.memoryDeleteV1,
        SyncStreamStub.userV1Admin,
        SyncStreamStub.memoryToAssetV1,
        SyncStreamStub.memoryV1,
      ];

      await simulateEvents(events);

      verifyInOrder([
        () => mockSyncStreamRepo.deleteMemoriesV1(any()),
        () => mockSyncApiRepo.ack(["6"]),
        () => mockSyncStreamRepo.updateUsersV1(any()),
        () => mockSyncApiRepo.ack(["1"]),
        () => mockSyncStreamRepo.updateMemoryAssetsV1(any()),
        () => mockSyncApiRepo.ack(["7"]),
        () => mockSyncStreamRepo.updateMemoriesV1(any()),
        () => mockSyncApiRepo.ack(["5"]),
      ]);
      verifyNever(() => mockAbortCallbackWrapper());
    });

    test("handles memory sync failure gracefully", () async {
      when(() => mockSyncStreamRepo.updateMemoriesV1(any())).thenThrow(Exception("Memory sync failed"));

      final events = [SyncStreamStub.memoryV1, SyncStreamStub.userV1Admin];

      expect(() async => await simulateEvents(events), throwsA(isA<Exception>()));
    });

    test("processes memory asset events with correct data types", () async {
      final events = [SyncStreamStub.memoryToAssetV1];

      await simulateEvents(events);

      verify(() => mockSyncStreamRepo.updateMemoryAssetsV1(any())).called(1);
      verify(() => mockSyncApiRepo.ack(["7"])).called(1);
    });

    test("processes memory delete events with correct data types", () async {
      final events = [SyncStreamStub.memoryDeleteV1];

      await simulateEvents(events);

      verify(() => mockSyncStreamRepo.deleteMemoriesV1(any())).called(1);
      verify(() => mockSyncApiRepo.ack(["6"])).called(1);
    });

    test("processes memory create/update events with correct data types", () async {
      final events = [SyncStreamStub.memoryV1];

      await simulateEvents(events);

      verify(() => mockSyncStreamRepo.updateMemoriesV1(any())).called(1);
      verify(() => mockSyncApiRepo.ack(["5"])).called(1);
    });
  });

  // After the refactor, SyncStreamService's only job for trash events
  // is to extract (id, deletedAt, checksum) tuples and delegate to
  // DriftTrashSyncRepository. The detailed behaviour (auto-trash, review-mode
  // queueing, OS permission gating, restore branching) lives in
  // DriftTrashSyncRepository and is tested at that layer.
  group("SyncStreamService - delegates trash events to DriftTrashSyncRepository", () {
    test("assetV1 with deletedAt routes trash intents through recordRemoteTrash", () async {
      final trashedAt = DateTime(2025, 5, 1);
      final events = [
        SyncStreamStub.assetTrashed(
          id: 'remote-1',
          checksum: 'checksum-1',
          ack: 'asset-trashed-1',
          trashedAt: trashedAt,
        ),
      ];

      await simulateEvents(events);

      final captured =
          verify(() => mockDriftTrashSyncRepository.recordRemoteTrash(captureAny())).captured.single
              as Map<String, DateTime>;
      expect(captured, {'remote-1': trashedAt});
    });

    test("assetV1 with null deletedAt routes alive checksums through recordRemoteRestore", () async {
      final events = [SyncStreamStub.assetModified(id: 'remote-1', checksum: 'checksum-1', ack: 'asset-restored-1')];

      await simulateEvents(events);

      final captured =
          verify(() => mockDriftTrashSyncRepository.recordRemoteRestore(captureAny())).captured.single
              as Iterable<String>;
      expect(captured.toList(), ['checksum-1']);
    });

    test("assetDeleteV1 events route through recordRemoteTrash (permanent delete)", () async {
      final events = [SyncStreamStub.assetDeleteV1];

      await simulateEvents(events);

      verify(() => mockDriftTrashSyncRepository.recordRemoteTrash(any())).called(1);
    });

    test("mixed batch routes trash and restore in one call each", () async {
      final trashedAt = DateTime(2025, 5, 1);
      final events = [
        SyncStreamStub.assetTrashed(
          id: 'remote-trashed',
          checksum: 'checksum-trashed',
          ack: 'asset-trashed',
          trashedAt: trashedAt,
        ),
        SyncStreamStub.assetModified(id: 'remote-alive', checksum: 'checksum-alive', ack: 'asset-alive'),
      ];

      await simulateEvents(events);

      final trashCaptured =
          verify(() => mockDriftTrashSyncRepository.recordRemoteTrash(captureAny())).captured.single
              as Map<String, DateTime>;
      expect(trashCaptured, {'remote-trashed': trashedAt});

      final restoreCaptured =
          verify(() => mockDriftTrashSyncRepository.recordRemoteRestore(captureAny())).captured.single
              as Iterable<String>;
      expect(restoreCaptured.toList(), ['checksum-alive']);
    });
  });

  group('SyncStreamService - Sync Migration', () {
    test('ensure that <2.5.0 migrations run', () async {
      await Store.put(StoreKey.syncMigrationStatus, "[]");
      when(
        () => mockServerApi.getServerVersion(),
      ).thenAnswer((_) async => ServerVersionResponseDto(major: 2, minor: 4, patch_: 1));

      await sut.sync();

      verifyInOrder([
        () => mockSyncApiRepo.deleteSyncAck([
          SyncEntityType.assetExifV1,
          SyncEntityType.partnerAssetExifV1,
          SyncEntityType.albumAssetExifCreateV1,
          SyncEntityType.albumAssetExifUpdateV1,
        ]),
        () => mockSyncMigrationRepo.v20260128CopyExifWidthHeightToAsset(),
      ]);

      // should only run on server >2.5.0
      verifyNever(
        () => mockSyncApiRepo.deleteSyncAck([
          SyncEntityType.assetV1,
          SyncEntityType.partnerAssetV1,
          SyncEntityType.albumAssetCreateV1,
          SyncEntityType.albumAssetUpdateV1,
        ]),
      );
    });
    test('ensure that >=2.5.0 migrations run', () async {
      await Store.put(StoreKey.syncMigrationStatus, "[]");
      when(
        () => mockServerApi.getServerVersion(),
      ).thenAnswer((_) async => ServerVersionResponseDto(major: 2, minor: 5, patch_: 0));
      await sut.sync();

      verifyInOrder([
        () => mockSyncApiRepo.deleteSyncAck([
          SyncEntityType.assetExifV1,
          SyncEntityType.partnerAssetExifV1,
          SyncEntityType.albumAssetExifCreateV1,
          SyncEntityType.albumAssetExifUpdateV1,
        ]),
        () => mockSyncApiRepo.deleteSyncAck([
          SyncEntityType.assetV1,
          SyncEntityType.partnerAssetV1,
          SyncEntityType.albumAssetCreateV1,
          SyncEntityType.albumAssetUpdateV1,
        ]),
      ]);

      // v20260128_ResetAssetV1 writes that v20260128_CopyExifWidthHeightToAsset has been completed
      verifyNever(() => mockSyncMigrationRepo.v20260128CopyExifWidthHeightToAsset());
    });

    test('ensure that migrations do not re-run', () async {
      await Store.put(
        StoreKey.syncMigrationStatus,
        '["${SyncMigrationTask.v20260128_CopyExifWidthHeightToAsset.name}"]',
      );

      when(
        () => mockServerApi.getServerVersion(),
      ).thenAnswer((_) async => ServerVersionResponseDto(major: 2, minor: 4, patch_: 1));

      await sut.sync();

      verifyNever(() => mockSyncMigrationRepo.v20260128CopyExifWidthHeightToAsset());
    });
  });
}
