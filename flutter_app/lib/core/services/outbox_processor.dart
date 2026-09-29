import 'dart:convert';
import 'dart:math';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../api/chat_api_service.dart';
import '../database/chat_database.dart';
import '../models/api_payloads.dart';
import '../models/chat_models.dart';
import '../realtime/realtime_transport_service.dart';

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

  Future<void> _process(OutboxItemsData item) async {
    try {
      final decoded = jsonDecode(item.payload);
      if (decoded is! Map) throw const FormatException('Invalid outbox payload');
      final payload = ReplyPayload.fromJson(Map<String, dynamic>.from(decoded));
      await _api.sendDirectMessage(payload);
      await _db.removeOutboxItem(item.id);
      await _updateMessageStatus(item.messageId ?? payload.messageId, DeliveryStatus.sent);
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
