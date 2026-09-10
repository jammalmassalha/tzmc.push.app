/// Tests for strict chronological message ordering by `sentDateTime`.
///
/// Reproduces the notification-tap bug: when a user taps an *older*
/// notification from the tray, the message used to be stamped with
/// `DateTime.now()` and appended to the tail of the chat. With the lifecycle
/// timestamp support, messages must always slot into their correct
/// chronological position ordered by sentDateTime ASC regardless of the order
/// in which they are ingested.
library;

import 'package:flutter_test/flutter_test.dart';
import 'package:tzmc_push/core/models/chat_models.dart';

ChatMessage buildMessage({
  required String messageId,
  required int timestamp,
  DateTime? sentDateTime,
  DateTime? receiveDateTime,
  DateTime? readDateTime,
}) {
  return ChatMessage(
    id: 'id-$messageId',
    messageId: messageId,
    chatId: 'chat_001',
    sender: 'alice',
    body: 'message $messageId',
    direction: MessageDirection.incoming,
    timestamp: timestamp,
    deliveryStatus: DeliveryStatus.delivered,
    sentDateTime: sentDateTime,
    receiveDateTime: receiveDateTime,
    readDateTime: readDateTime,
  );
}

/// Mimics ChatStoreService upsert semantics: match by id, else append,
/// then always re-sort strictly by sentDateTime.
void insertOrUpdateMessage(
  List<ChatMessage> messages,
  ChatMessage newMessage, {
  bool descending = false,
}) {
  final index = messages.indexWhere((m) => m.messageId == newMessage.messageId);
  if (index != -1) {
    messages[index] = newMessage;
  } else {
    messages.add(newMessage);
  }
  messages.sort(
    descending ? compareMessagesBySentTimeDesc : compareMessagesBySentTimeAsc,
  );
}

void main() {
  final base = DateTime.utc(2026, 9, 10, 7, 0);
  DateTime sentAt(int minute) => base.add(Duration(minutes: minute));

  group('parseFlexibleDateTime', () {
    test('parses ISO 8601 strings', () {
      expect(
        ChatMessage.parseFlexibleDateTime('2026-09-10T07:15:00.000Z'),
        DateTime.utc(2026, 9, 10, 7, 15),
      );
    });

    test('parses epoch milliseconds as int and numeric string', () {
      final expected = DateTime.utc(2026, 9, 10, 7, 15);
      final ms = expected.millisecondsSinceEpoch;
      expect(ChatMessage.parseFlexibleDateTime(ms), expected);
      expect(ChatMessage.parseFlexibleDateTime('$ms'), expected);
    });

    test('returns null for missing or invalid values', () {
      expect(ChatMessage.parseFlexibleDateTime(null), isNull);
      expect(ChatMessage.parseFlexibleDateTime(''), isNull);
      expect(ChatMessage.parseFlexibleDateTime('not-a-date'), isNull);
      expect(ChatMessage.parseFlexibleDateTime(0), isNull);
      expect(ChatMessage.parseFlexibleDateTime(-5), isNull);
    });
  });

  group('effectiveSentTime', () {
    test('prefers sentDateTime over legacy timestamp', () {
      final sent = sentAt(2);
      final message = buildMessage(
        messageId: 'M2',
        // Legacy timestamp stamped much later (e.g. notification tap time).
        timestamp: sentAt(30).millisecondsSinceEpoch,
        sentDateTime: sent,
      );
      expect(message.effectiveSentTime, sent.millisecondsSinceEpoch);
    });

    test('falls back to timestamp when sentDateTime is missing', () {
      final ts = sentAt(1).millisecondsSinceEpoch;
      expect(buildMessage(messageId: 'M1', timestamp: ts).effectiveSentTime, ts);
    });
  });

  group('out-of-order ingestion is sorted by sentDateTime ASC', () {
    test('tapping an older notification slots the message chronologically',
        () {
      // M1..M5 sent 1 minute apart. The app receives M1, M3, M4, M5 first
      // and only ingests M2 later, when its notification is tapped — with a
      // "now"-ish legacy timestamp but the true sentDateTime in the payload.
      final messages = <ChatMessage>[];
      for (final minute in [1, 3, 4, 5]) {
        insertOrUpdateMessage(
          messages,
          buildMessage(
            messageId: 'M$minute',
            timestamp: sentAt(minute).millisecondsSinceEpoch,
            sentDateTime: sentAt(minute),
          ),
        );
      }

      // M2 arrives last, ingested long after it was sent.
      insertOrUpdateMessage(
        messages,
        buildMessage(
          messageId: 'M2',
          timestamp: sentAt(45).millisecondsSinceEpoch,
          sentDateTime: sentAt(2),
          receiveDateTime: sentAt(45),
        ),
      );

      expect(
        messages.map((m) => m.messageId).toList(),
        ['M1', 'M2', 'M3', 'M4', 'M5'],
      );
      // M2 must NOT be at the bottom.
      expect(messages.last.messageId, isNot('M2'));
    });

    test('descending comparator keeps newest-first order for the store', () {
      final messages = <ChatMessage>[];
      for (final minute in [3, 1, 5, 2, 4]) {
        insertOrUpdateMessage(
          messages,
          buildMessage(
            messageId: 'M$minute',
            timestamp: sentAt(minute).millisecondsSinceEpoch,
            sentDateTime: sentAt(minute),
          ),
          descending: true,
        );
      }
      expect(
        messages.map((m) => m.messageId).toList(),
        ['M5', 'M4', 'M3', 'M2', 'M1'],
      );
    });

    test('upsert by id replaces the message instead of duplicating it', () {
      final messages = <ChatMessage>[];
      insertOrUpdateMessage(
        messages,
        buildMessage(
          messageId: 'M1',
          timestamp: sentAt(1).millisecondsSinceEpoch,
          sentDateTime: sentAt(1),
        ),
      );
      insertOrUpdateMessage(
        messages,
        buildMessage(
          messageId: 'M1',
          timestamp: sentAt(1).millisecondsSinceEpoch,
          sentDateTime: sentAt(1),
          readDateTime: sentAt(10),
        ),
      );
      expect(messages, hasLength(1));
      expect(messages.single.readDateTime, sentAt(10));
    });

    test('messages without sentDateTime fall back to timestamp ordering', () {
      final messages = <ChatMessage>[
        buildMessage(
          messageId: 'legacy-late',
          timestamp: sentAt(9).millisecondsSinceEpoch,
        ),
        buildMessage(
          messageId: 'M2',
          timestamp: sentAt(50).millisecondsSinceEpoch,
          sentDateTime: sentAt(2),
        ),
        buildMessage(
          messageId: 'legacy-early',
          timestamp: sentAt(0).millisecondsSinceEpoch,
        ),
      ]..sort(compareMessagesBySentTimeAsc);

      expect(
        messages.map((m) => m.messageId).toList(),
        ['legacy-early', 'M2', 'legacy-late'],
      );
    });
  });
}
