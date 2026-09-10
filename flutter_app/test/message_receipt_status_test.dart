/// Tests for message receipt status ticks (sent ✓ / delivered ✓✓ / read ✓✓).
///
/// The receipt state of an outgoing message must be derived from its
/// lifecycle timestamps so that ticks are correct both for live updates
/// (delivery-receipt / read-receipt events) and after a history reload,
/// and must never downgrade once a higher state is known.
library;

import 'package:flutter_test/flutter_test.dart';
import 'package:tzmc_push/core/models/chat_models.dart';

ChatMessage buildMessage({
  DeliveryStatus deliveryStatus = DeliveryStatus.pending,
  DateTime? sentDateTime,
  DateTime? receiveDateTime,
  DateTime? readDateTime,
}) {
  return ChatMessage(
    id: 'm1',
    messageId: 'm1',
    chatId: 'chat_001',
    sender: 'me',
    body: 'hello',
    direction: MessageDirection.outgoing,
    timestamp: 1000,
    deliveryStatus: deliveryStatus,
    sentDateTime: sentDateTime,
    receiveDateTime: receiveDateTime,
    readDateTime: readDateTime,
  );
}

void main() {
  final sent = DateTime.utc(2026, 9, 10, 7, 15);
  final delivered = DateTime.utc(2026, 9, 10, 7, 16);
  final read = DateTime.utc(2026, 9, 10, 7, 20);

  group('ChatMessage.receiptStatus derivation', () {
    test('no timestamps and pending status → sending', () {
      expect(buildMessage().receiptStatus, MessageReceiptStatus.sending);
    });

    test('sentDateTime only → sent (single grey tick)', () {
      expect(
        buildMessage(deliveryStatus: DeliveryStatus.sent, sentDateTime: sent)
            .receiptStatus,
        MessageReceiptStatus.sent,
      );
    });

    test('receiveDateTime set → delivered (double grey tick)', () {
      expect(
        buildMessage(
          deliveryStatus: DeliveryStatus.sent,
          sentDateTime: sent,
          receiveDateTime: delivered,
        ).receiptStatus,
        MessageReceiptStatus.delivered,
      );
    });

    test('readDateTime set → read (double blue tick)', () {
      expect(
        buildMessage(
          deliveryStatus: DeliveryStatus.sent,
          sentDateTime: sent,
          receiveDateTime: delivered,
          readDateTime: read,
        ).receiptStatus,
        MessageReceiptStatus.read,
      );
    });

    test('readDateTime wins even when receiveDateTime is missing', () {
      expect(
        buildMessage(
          deliveryStatus: DeliveryStatus.sent,
          sentDateTime: sent,
          readDateTime: read,
        ).receiptStatus,
        MessageReceiptStatus.read,
      );
    });

    test('transport status upgrades are honored without timestamps', () {
      expect(
        buildMessage(deliveryStatus: DeliveryStatus.delivered).receiptStatus,
        MessageReceiptStatus.delivered,
      );
      expect(
        buildMessage(deliveryStatus: DeliveryStatus.read).receiptStatus,
        MessageReceiptStatus.read,
      );
    });

    test('pending/queued/failed never report as sent from sentDateTime alone',
        () {
      expect(
        buildMessage(
          deliveryStatus: DeliveryStatus.pending,
          sentDateTime: sent,
        ).receiptStatus,
        MessageReceiptStatus.sending,
      );
      expect(
        buildMessage(
          deliveryStatus: DeliveryStatus.failed,
          sentDateTime: sent,
        ).receiptStatus,
        MessageReceiptStatus.sending,
      );
    });
  });

  group('receipt upgrades never downgrade', () {
    test('copyWith preserving readDateTime keeps read status', () {
      final message = buildMessage(
        deliveryStatus: DeliveryStatus.sent,
        sentDateTime: sent,
        readDateTime: read,
      );
      // A stale delivery-receipt applied after the read receipt must not
      // downgrade the tick: readDateTime remains set.
      final upgraded = message.copyWith(
        receiveDateTime: message.receiveDateTime ?? delivered,
      );
      expect(upgraded.receiptStatus, MessageReceiptStatus.read);
      expect(upgraded.readDateTime, read);
      expect(upgraded.receiveDateTime, delivered);
    });

    test('delivery-receipt upgrade sets receiveDateTime once', () {
      final message = buildMessage(
        deliveryStatus: DeliveryStatus.sent,
        sentDateTime: sent,
      );
      final first = message.copyWith(
        deliveryStatus: DeliveryStatus.delivered,
        receiveDateTime: message.receiveDateTime ?? delivered,
      );
      final later = DateTime.utc(2026, 9, 10, 7, 30);
      final second = first.copyWith(
        receiveDateTime: first.receiveDateTime ?? later,
      );
      expect(second.receiveDateTime, delivered);
      expect(second.receiptStatus, MessageReceiptStatus.delivered);
    });
  });

  group('serialization round-trips', () {
    test('fromJson parses ISO 8601 lifecycle timestamps', () {
      final message = ChatMessage.fromJson({
        'id': '12345',
        'messageId': '12345',
        'chatId': 'chat_001',
        'sender': 'me',
        'body': 'hi',
        'direction': 'outgoing',
        'timestamp': 1000,
        'deliveryStatus': 'sent',
        'sentDateTime': '2026-09-10T07:15:00.000Z',
        'receiveDateTime': '2026-09-10T07:16:00.000Z',
        'readDateTime': '2026-09-10T07:20:00.000Z',
      });
      expect(message.sentDateTime, sent);
      expect(message.receiveDateTime, delivered);
      expect(message.readDateTime, read);
      expect(message.receiptStatus, MessageReceiptStatus.read);
    });

    test('toJson/fromJson keeps receipt status stable (epoch ms)', () {
      final original = buildMessage(
        deliveryStatus: DeliveryStatus.delivered,
        sentDateTime: sent,
        receiveDateTime: delivered,
      );
      final restored = ChatMessage.fromJson(original.toJson());
      expect(restored.receiptStatus, MessageReceiptStatus.delivered);
      expect(restored.sentDateTime, sent);
      expect(restored.receiveDateTime, delivered);
    });
  });
}
