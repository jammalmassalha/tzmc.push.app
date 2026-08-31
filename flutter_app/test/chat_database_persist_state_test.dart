/// Tests for the non-destructive [ChatDatabase.persistState] behaviour.
///
/// The in-memory chat store keeps only the most recent `maxMessagesPerChat`
/// messages per chat, so persisting a trimmed snapshot must never delete the
/// older history that already lives on disk.  These tests pin that contract
/// (persist → trim → persist keeps everything) together with the idempotency
/// of repeated persists of the same message.
library;

import 'package:drift/native.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tzmc_push/core/database/chat_database.dart' hide Contact;
import 'package:tzmc_push/core/models/chat_models.dart';

ChatMessage buildMessage({
  required String id,
  required String chatId,
  required int timestamp,
  String body = 'hello',
  MessageDirection direction = MessageDirection.incoming,
  DeliveryStatus deliveryStatus = DeliveryStatus.delivered,
  String sender = '0500000001',
}) {
  return ChatMessage(
    id: id,
    messageId: id,
    chatId: chatId,
    sender: sender,
    body: body,
    direction: direction,
    timestamp: timestamp,
    deliveryStatus: deliveryStatus,
  );
}

void main() {
  late ChatDatabase db;

  setUp(() {
    db = ChatDatabase.forTesting(NativeDatabase.memory());
  });

  tearDown(() async {
    await db.close();
  });

  test('persisting a trimmed snapshot keeps the older history on disk',
      () async {
    final older = buildMessage(id: 'm1', chatId: 'chat-a', timestamp: 1000);
    final newer = buildMessage(id: 'm2', chatId: 'chat-a', timestamp: 2000);

    await db.persistState(PersistedChatState(messages: [older, newer]));
    expect((await db.getAllMessages()).length, 2);

    // Second persist with a trimmed snapshot (only the newest message is still
    // in memory).  The older row must survive.
    await db.persistState(PersistedChatState(messages: [newer]));

    final stored = await db.getAllMessages();
    expect(stored.map((m) => m.id).toSet(), {'m1', 'm2'});
  });

  test('persisting the same message twice produces a single row', () async {
    final message = buildMessage(id: 'm1', chatId: 'chat-a', timestamp: 1000);

    await db.persistState(PersistedChatState(messages: [message]));
    await db.persistState(PersistedChatState(messages: [message]));

    final stored = await db.getAllMessages();
    expect(stored.length, 1);
    expect(stored.single.id, 'm1');
  });

  test('upserting the same message twice produces a single row', () async {
    final message = buildMessage(id: 'm1', chatId: 'chat-a', timestamp: 1000);

    await db.upsertMessage(message);
    await db.upsertMessage(message);

    expect((await db.getAllMessages()).length, 1);
  });

  test('persisting an updated message replaces the stored row', () async {
    final original = buildMessage(
      id: 'm1',
      chatId: 'chat-a',
      timestamp: 1000,
      body: 'first',
      direction: MessageDirection.outgoing,
      deliveryStatus: DeliveryStatus.pending,
    );

    await db.persistState(PersistedChatState(messages: [original]));
    await db.upsertMessage(
      original.copyWith(body: 'edited', deliveryStatus: DeliveryStatus.sent),
    );

    final stored = await db.getAllMessages();
    expect(stored.length, 1);
    expect(stored.single.body, 'edited');
    expect(stored.single.deliveryStatus, DeliveryStatus.sent);
  });

  test('getLatestMessageTimestamp survives a trimmed persist', () async {
    await db.persistState(PersistedChatState(messages: [
      buildMessage(id: 'm1', chatId: 'chat-a', timestamp: 1000),
      buildMessage(id: 'm2', chatId: 'chat-a', timestamp: 5000),
    ]));

    await db.persistState(PersistedChatState(messages: [
      buildMessage(id: 'm2', chatId: 'chat-a', timestamp: 5000),
    ]));

    expect(await db.getLatestMessageTimestamp(), 5000);
  });

  test('getRecentMessages returns the newest messages first', () async {
    await db.persistState(PersistedChatState(messages: [
      buildMessage(id: 'm1', chatId: 'chat-a', timestamp: 1000),
      buildMessage(id: 'm2', chatId: 'chat-a', timestamp: 3000),
      buildMessage(id: 'm3', chatId: 'chat-b', timestamp: 2000),
    ]));

    final recent = await db.getRecentMessages(limit: 2);
    expect(recent.map((m) => m.id).toList(), ['m2', 'm3']);
    // The oldest message is trimmed by the limit but stays on disk.
    expect(recent.map((m) => m.id), isNot(contains('m1')));
    expect((await db.getAllMessages()).length, 3);
  });

  test('contacts and groups absent from the snapshot are pruned', () async {
    const alice = Contact(username: '0500000001', displayName: 'Alice');
    const bob = Contact(username: '0500000002', displayName: 'Bob');
    const group = ChatGroup(
      id: 'group:1',
      name: 'Team',
      members: ['0500000001'],
      createdBy: '0500000001',
      updatedAt: 1000,
      type: GroupType.group,
    );

    await db.persistState(const PersistedChatState(
      contacts: [alice, bob],
      groups: [group],
      unreadByChat: {'chat-a': 3},
    ));
    expect((await db.getAllContacts()).length, 2);

    await db.persistState(const PersistedChatState(
      contacts: [alice],
      groups: [group],
      unreadByChat: {'chat-a': 1},
    ));

    expect((await db.getAllContacts()).map((c) => c.username).toList(),
        ['0500000001']);
    expect((await db.getAllGroups()).length, 1);
    expect(await db.getAllUnreadCounts(), {'chat-a': 1});
  });

  test('an empty contact list does not wipe the stored contacts', () async {
    const alice = Contact(username: '0500000001', displayName: 'Alice');

    await db.persistState(const PersistedChatState(contacts: [alice]));
    // A snapshot taken before the contact pull completed must not delete the
    // previously stored contacts.
    await db.persistState(const PersistedChatState());

    expect((await db.getAllContacts()).length, 1);
  });
}
