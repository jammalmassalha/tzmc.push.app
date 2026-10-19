/// Tests for chat ID normalization used to prevent duplicate message threads.
library;

import 'package:flutter_test/flutter_test.dart';
import 'package:tzmc_push/core/models/chat_models.dart';

void main() {
  group('chat id normalization', () {
    test('normalizeChatId lowercases and trims ids', () {
      expect(normalizeChatId('  Group:123_ABC  '), 'group:123_abc');
    });

    test('resolveChatRoomId normalizes group ids', () {
      expect(
        resolveChatRoomId(
          groupId: 'Group:123_ABC',
          senderId: 'alice',
          recipientId: 'bob',
          currentUserId: 'alice',
        ),
        'group:123_abc',
      );
    });

    test('ChatMessage.fromJson canonicalizes chatId and groupId', () {
      final message = ChatMessage.fromJson({
        'id': 'm1',
        'messageId': 'm1',
        'chatId': 'Group:123_ABC',
        'sender': 'alice',
        'direction': 'incoming',
        'timestamp': 1,
        'deliveryStatus': 'delivered',
        'groupId': 'Group:123_ABC',
      });

      expect(message.chatId, 'group:123_abc');
      expect(message.groupId, 'group:123_abc');
    });
  });
}
