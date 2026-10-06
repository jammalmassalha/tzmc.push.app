import 'dart:convert';
import 'dart:math';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../api/chat_api_service.dart';
import '../database/chat_database.dart';
import '../models/api_payloads.dart';
import '../models/chat_models.dart';
import '../realtime/realtime_transport_service.dart';
import '../utils/xfile.dart' as xfile;
import '../utils/staged_file_stub.dart'
    if (dart.library.io) '../utils/staged_file_io.dart';

/// Outbox processor for handling message retry logic (PHASE 6).
///
/// This service implements the background retry worker for the local outbox pattern.
/// When messages fail to send (due to network issues, server errors, etc.), they are
/// stored in the SQLite outbox table and retried automatically with exponential backoff.
///
/// **PHASE 6: Local Outbox Pattern**
///
/// Retry Strategy:
/// 1. Attempt #1: Immediate
/// 2. Attempt #2: 1 second delay
/// 3. Attempt #3: 2 second delay
/// 4. Attempt #4: 4 second delay
/// 5. Attempt #5: 8 second delay
/// 6. Attempt #6+: 30 second delay (max backoff)
///
/// Triggers:
/// - WebSocket connection restored (via ChatStoreService._handleConnectionChange)
/// - Network connectivity restored (via RealtimeTransportService connectivity observer)
/// - App lifecycle resumed (via ChatShellScreen._handleAppResumed)
///
/// See RELIABILITY_ARCHITECTURE.md and FLUTTER_IMPLEMENTATION_GUIDE.md for details.
final outboxProcessorProvider = Provider<OutboxProcessor>((ref) {
  return OutboxProcessor(
    ref.watch(chatDatabaseProvider),
    ref.watch(chatApiServiceProvider),
    ref.watch(realtimeTransportServiceProvider),
  );
});

class OutboxProcessor {
  OutboxProcessor(this._db, this._api, this._transport);

  final ChatDatabase _db;
  final ChatApiService _api;
  final RealtimeTransportService _transport;
  bool _isDraining = false;
  final Random _random = Random();

  /// PHASE 6: Drain the outbox queue of pending messages.
  ///
  /// This is called when:
  /// 1. WebSocket connection is restored (ChatStoreService._handleConnectionChange)
  /// 2. Network connectivity is restored (RealtimeTransportService connectivity observer)
  /// 3. App lifecycle is resumed (ChatShellScreen._handleAppResumed)
  ///
  /// Fetches all messages that are due for retry (based on exponential backoff)
  /// and attempts to send them. If a message fails again, the retry count is
  /// incremented and the next retry time is calculated.
  Future<void> drainQueue() async {
    if (_isDraining || !_transport.isConnected) return;
    _isDraining = true;
    try {
      final items = await _db.getDueOutboxItems(
        now: DateTime.now().millisecondsSinceEpoch,
        limit: 20,
      );
      for (final item in items) {
        await _process(item);
      }
    } finally {
      _isDraining = false;
    }
  }

  /// PHASE 6: Process a single outbox item.
  ///
  /// Attempts to send the message. On success, removes from outbox.
  /// On failure, increments retry count and schedules next attempt with exponential backoff.
  Future<void> _process(OutboxItemsData item) async {
    try {
      final decoded = jsonDecode(item.payload);
      if (decoded is! Map) throw const FormatException('Invalid outbox payload');
      final payloadMap = Map<String, dynamic>.from(decoded);
      final payload = ReplyPayload.fromJson(payloadMap);
      final message = await _db.getMessage(item.messageId ?? payload.messageId);
      final localPath = message?.localFilePath;
      if (localPath != null && localPath.isNotEmpty) {
        final bytes = await readStagedFile(localPath);
        final uploaded = await _api.uploadFile(
          xfile.XFile.fromPath(
            path: localPath,
            bytesLoader: () async => bytes,
          ),
          chatId: payload.groupId ?? payload.originalSender,
        );
        final extension = localPath.toLowerCase().split('.').last;
        const imageExtensions = {'jpg', 'jpeg', 'png', 'gif', 'webp', 'heic'};
        if (imageExtensions.contains(extension)) {
          payloadMap['imageUrl'] = uploaded.url;
          payloadMap.remove('fileUrl');
        } else {
          payloadMap['fileUrl'] = uploaded.url;
          payloadMap.remove('imageUrl');
        }
        await _db.upsertMessage(
          message!.copyWith(
            imageUrl: imageExtensions.contains(extension) ? uploaded.url : message!.imageUrl,
            fileUrl: imageExtensions.contains(extension) ? message!.fileUrl : uploaded.url,
          ),
        );
      }
      final dispatchedPayload = ReplyPayload.fromJson(payloadMap);
      await _api.sendDirectMessage(dispatchedPayload);
      await _db.removeOutboxItem(item.id);
      await _updateMessageStatus(item.messageId ?? dispatchedPayload.messageId, DeliveryStatus.sent);
      if (localPath != null && localPath.isNotEmpty) {
        try {
          await deleteStagedFile(localPath);
        } catch (_) {
          // Cleanup is best-effort after the server acknowledged the message.
        }
      }
    } catch (error) {
      final retryCount = item.retryCount + 1;
      final baseDelay = min(1000 * pow(2, retryCount).toInt(), 3600000);
      final nextAttemptAt = DateTime.now().millisecondsSinceEpoch +
          baseDelay +
          _random.nextInt(1001);
      await _db.updateOutboxRetry(
        id: item.id,
        retryCount: retryCount,
        nextAttemptAt: nextAttemptAt,
        error: error.toString(),
      );
      final messageId = item.messageId;
      if (messageId != null && messageId.isNotEmpty) {
        await _updateMessageStatus(messageId, DeliveryStatus.failed);
      }
    }
  }

  Future<void> _updateMessageStatus(
    String messageId,
    DeliveryStatus status,
  ) async {
    if (messageId.isEmpty) return;
    final message = await _db.getMessage(messageId);
    if (message != null) {
      await _db.upsertMessage(message.copyWith(deliveryStatus: status));
    }
  }
}
