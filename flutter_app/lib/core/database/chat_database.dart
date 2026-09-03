/// Local database service using Drift (SQLite).
///
/// This replaces the IndexedDB persistence from the Angular frontend (Dexie.js).
/// Stores contacts, groups, messages, and unread counts locally.
/// Supports both native (mobile/desktop) and web platforms via conditional imports.
library;

import 'dart:convert';

import 'package:drift/drift.dart';
import 'package:flutter/foundation.dart' show visibleForTesting;
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../models/chat_models.dart';

// Conditional imports for platform-specific database connection
import 'connection/unsupported.dart'
    if (dart.library.ffi) 'connection/native.dart'
    if (dart.library.js_interop) 'connection/web.dart';

part 'chat_database.g.dart';

// ---------------------------------------------------------------------------
// Table Definitions
// ---------------------------------------------------------------------------

/// Maximum length of a sender-name prefix that can be extracted from a legacy
/// group-message body ("SenderName: message text" format).
/// Must match _kGroupSenderPrefixMaxLength in chat_store_service.dart.
const int _kMaxGroupSenderPrefixLength = 80;

/// Maximum number of messages loaded back into memory when restoring the
/// persisted state.  The on-disk history is unbounded (persistence never
/// deletes messages), so the restore is capped to keep cold start predictable.
const int restoreMessageLimit = 20000;

/// Extracts a sender name from a legacy group-message body of the form
/// "SenderName: message text".  Returns null when the body does not match
/// (including URL bodies) or when the candidate is suspicious.
({String senderName, String strippedBody})? _extractGroupSenderFromBodyPrefix(String body) {
  final trimmed = body.trim();
  if (trimmed.isEmpty) return null;
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) return null;
  final colonIdx = trimmed.indexOf(':');
  if (colonIdx <= 0 || colonIdx > _kMaxGroupSenderPrefixLength) return null;
  final senderName = trimmed.substring(0, colonIdx).trim();
  final strippedBody = trimmed.substring(colonIdx + 1).trim();
  if (senderName.isEmpty || strippedBody.isEmpty) return null;
  if (senderName.contains('\n')) return null;
  if (senderName.length > _kMaxGroupSenderPrefixLength) return null;
  return (senderName: senderName, strippedBody: strippedBody);
}

/// Contacts table
@DataClassName('ContactsData')
class Contacts extends Table {
  TextColumn get username => text()();
  TextColumn get displayName => text()();
  TextColumn get info => text().nullable()();
  TextColumn get phone => text().nullable()();
  TextColumn get upic => text().nullable()();
  IntColumn get status => integer().nullable()();
  IntColumn get updatedAt => integer()();

  @override
  Set<Column> get primaryKey => {username};
}

/// Groups table
@DataClassName('GroupsData')
class Groups extends Table {
  TextColumn get id => text()();
  TextColumn get name => text()();
  TextColumn get members => text()(); // JSON array
  TextColumn get admins => text().nullable()(); // JSON array
  TextColumn get createdBy => text()();
  IntColumn get updatedAt => integer()();
  TextColumn get type => text()(); // 'group' or 'community'

  @override
  Set<Column> get primaryKey => {id};
}

/// Messages table
@DataClassName('MessagesData')
class Messages extends Table {
  TextColumn get id => text()();
  TextColumn get messageId => text()();
  TextColumn get chatId => text()();
  TextColumn get sender => text()();
  TextColumn get senderDisplayName => text().nullable()();
  TextColumn get recordType => text().nullable()();
  TextColumn get body => text()();
  TextColumn get imageUrl => text().nullable()();
  TextColumn get thumbnailUrl => text().nullable()();
  TextColumn get fileUrl => text().nullable()();
  TextColumn get direction => text()(); // 'incoming' or 'outgoing'
  IntColumn get timestamp => integer()();
  TextColumn get deliveryStatus => text()();
  TextColumn get groupId => text().nullable()();
  TextColumn get groupName => text().nullable()();
  TextColumn get groupType => text().nullable()();
  TextColumn get reactions => text().nullable()(); // JSON array
  IntColumn get editedAt => integer().nullable()();
  IntColumn get deletedAt => integer().nullable()();
  TextColumn get replyTo => text().nullable()(); // JSON object
  BoolColumn get forwarded => boolean().withDefault(const Constant(false))();
  TextColumn get forwardedFrom => text().nullable()();
  TextColumn get forwardedFromName => text().nullable()();
  IntColumn get userReceivedTime => integer().nullable()();

  @override
  Set<Column> get primaryKey => {id};
}

/// Unread counts table
@DataClassName('UnreadCountsData')
class UnreadCounts extends Table {
  TextColumn get chatId => text()();
  IntColumn get count => integer()();

  @override
  Set<Column> get primaryKey => {chatId};
}

/// Outbox items table (pending messages to send)
@DataClassName('OutboxItemsData')
class OutboxItems extends Table {
  TextColumn get id => text()();
  TextColumn get kind => text()(); // 'direct', 'group', 'group-update'
  TextColumn get payload => text()(); // JSON
  TextColumn get recipients => text().nullable()(); // JSON array for group messages
  TextColumn get messageId => text().nullable()();
  IntColumn get attempts => integer().withDefault(const Constant(0))();
  IntColumn get createdAt => integer()();

  @override
  Set<Column> get primaryKey => {id};
}

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------

@DriftDatabase(tables: [Contacts, Groups, Messages, UnreadCounts, OutboxItems])
class ChatDatabase extends _$ChatDatabase {
  ChatDatabase() : super(openConnection());

  /// Test-only constructor that runs against an explicit executor (e.g.
  /// `NativeDatabase.memory()`), bypassing the platform connection.
  @visibleForTesting
  ChatDatabase.forTesting(QueryExecutor executor) : super(executor);

  @override
  int get schemaVersion => 1;

  @override
  MigrationStrategy get migration {
    return MigrationStrategy(
      onCreate: (Migrator m) async {
        await m.createAll();
      },
      onUpgrade: (Migrator m, int from, int to) async {
        // Handle future migrations here
      },
    );
  }

  // ---------------------------------------------------------------------------
  // Contacts
  // ---------------------------------------------------------------------------

  Future<List<Contact>> getAllContacts() async {
    final rows = await select(contacts).get();
    return rows.map(_contactFromRow).toList();
  }

  Future<Contact?> getContact(String username) async {
    final row = await (select(contacts)..where((t) => t.username.equals(username))).getSingleOrNull();
    return row != null ? _contactFromRow(row) : null;
  }

  Future<void> upsertContact(Contact contact) async {
    await into(contacts).insertOnConflictUpdate(
      ContactsCompanion.insert(
        username: contact.username,
        displayName: contact.displayName,
        info: Value(contact.info),
        phone: Value(contact.phone),
        upic: Value(contact.upic),
        status: Value(contact.status),
        updatedAt: DateTime.now().millisecondsSinceEpoch,
      ),
    );
  }

  Future<void> upsertContacts(List<Contact> contactList) async {
    await batch((batch) {
      for (final contact in contactList) {
        batch.insert(
          contacts,
          ContactsCompanion.insert(
            username: contact.username,
            displayName: contact.displayName,
            info: Value(contact.info),
            phone: Value(contact.phone),
            upic: Value(contact.upic),
            status: Value(contact.status),
            updatedAt: DateTime.now().millisecondsSinceEpoch,
          ),
          mode: InsertMode.insertOrReplace,
        );
      }
    });
  }

  Contact _contactFromRow(ContactsData row) {
    return Contact(
      username: row.username,
      displayName: row.displayName,
      info: row.info,
      phone: row.phone,
      upic: row.upic,
      status: row.status,
    );
  }

  // ---------------------------------------------------------------------------
  // Groups
  // ---------------------------------------------------------------------------

  Future<List<ChatGroup>> getAllGroups() async {
    final rows = await select(groups).get();
    return rows.map(_groupFromRow).toList();
  }

  Future<ChatGroup?> getGroup(String id) async {
    final row = await (select(groups)..where((t) => t.id.equals(id))).getSingleOrNull();
    return row != null ? _groupFromRow(row) : null;
  }

  Future<void> upsertGroup(ChatGroup group) async {
    await into(groups).insertOnConflictUpdate(
      GroupsCompanion.insert(
        id: group.id,
        name: group.name,
        members: jsonEncode(group.members),
        admins: Value(group.admins != null ? jsonEncode(group.admins) : null),
        createdBy: group.createdBy,
        updatedAt: group.updatedAt,
        type: group.type == GroupType.community ? 'community' : 'group',
      ),
    );
  }

  Future<void> upsertGroups(List<ChatGroup> groupList) async {
    await batch((batch) {
      for (final group in groupList) {
        batch.insert(
          groups,
          GroupsCompanion.insert(
            id: group.id,
            name: group.name,
            members: jsonEncode(group.members),
            admins: Value(group.admins != null ? jsonEncode(group.admins) : null),
            createdBy: group.createdBy,
            updatedAt: group.updatedAt,
            type: group.type == GroupType.community ? 'community' : 'group',
          ),
          mode: InsertMode.insertOrReplace,
        );
      }
    });
  }

  ChatGroup _groupFromRow(GroupsData row) {
    return ChatGroup(
      id: row.id,
      name: row.name,
      members: (jsonDecode(row.members) as List).cast<String>(),
      admins: row.admins != null ? (jsonDecode(row.admins!) as List).cast<String>() : null,
      createdBy: row.createdBy,
      updatedAt: row.updatedAt,
      type: row.type == 'community' ? GroupType.community : GroupType.group,
    );
  }

  // ---------------------------------------------------------------------------
  // Messages
  // ---------------------------------------------------------------------------

  Future<List<ChatMessage>> getAllMessages() async {
    final rows = await select(messages).get();
    return rows.map(_messageFromRow).toList();
  }

  /// Newest [limit] messages across all chats, most recent first.
  ///
  /// Persistence is non-destructive, so the table keeps history beyond the
  /// per-chat in-memory cap.  Restoring uses this bounded query to keep cold
  /// start cost predictable while the full history stays available on disk.
  Future<List<ChatMessage>> getRecentMessages({int limit = restoreMessageLimit}) async {
    final query = select(messages)
      ..orderBy([(t) => OrderingTerm.desc(t.timestamp)])
      ..limit(limit);
    final rows = await query.get();
    return rows.map(_messageFromRow).toList();
  }

  Future<List<ChatMessage>> getMessagesByChatId(String chatId, {int limit = 100}) async {
    final query = select(messages)
      ..where((t) => t.chatId.equals(chatId))
      ..orderBy([(t) => OrderingTerm.desc(t.timestamp)])
      ..limit(limit);
    final rows = await query.get();
    return rows.map(_messageFromRow).toList();
  }

  Future<ChatMessage?> getMessage(String id) async {
    final row = await (select(messages)..where((t) => t.id.equals(id))).getSingleOrNull();
    return row != null ? _messageFromRow(row) : null;
  }

  Future<int> getLatestMessageTimestamp() async {
    final query = selectOnly(messages)..addColumns([messages.timestamp.max()]);
    final result = await query.getSingleOrNull();
    return result?.read(messages.timestamp.max()) ?? 0;
  }

  Future<void> upsertMessage(ChatMessage message) async {
    await into(messages).insertOnConflictUpdate(_messageToCompanion(message));
  }

  Future<void> upsertMessages(List<ChatMessage> messageList) async {
    await batch((batch) {
      for (final message in messageList) {
        batch.insert(messages, _messageToCompanion(message), mode: InsertMode.insertOrReplace);
      }
    });
  }

  Future<void> deleteMessage(String id) async {
    await (delete(messages)..where((t) => t.id.equals(id))).go();
  }

  MessagesCompanion _messageToCompanion(ChatMessage message) {
    return MessagesCompanion.insert(
      id: message.id,
      messageId: message.messageId,
      chatId: message.chatId,
      sender: message.sender,
      senderDisplayName: Value(message.senderDisplayName),
      recordType: Value(message.recordType),
      body: message.body,
      imageUrl: Value(message.imageUrl),
      thumbnailUrl: Value(message.thumbnailUrl),
      fileUrl: Value(message.fileUrl),
      direction: message.direction == MessageDirection.incoming ? 'incoming' : 'outgoing',
      timestamp: message.timestamp,
      deliveryStatus: message.deliveryStatus.name,
      groupId: Value(message.groupId),
      groupName: Value(message.groupName),
      groupType: Value(message.groupType?.name),
      reactions: Value(message.reactions != null ? jsonEncode(message.reactions!.map((r) => r.toJson()).toList()) : null),
      editedAt: Value(message.editedAt),
      deletedAt: Value(message.deletedAt),
      replyTo: Value(message.replyTo != null ? jsonEncode(message.replyTo!.toJson()) : null),
      forwarded: Value(message.forwarded),
      forwardedFrom: Value(message.forwardedFrom),
      forwardedFromName: Value(message.forwardedFromName),
      userReceivedTime: Value(message.userReceivedTime),
    );
  }

  ChatMessage _messageFromRow(MessagesData row) {
    // For older group-message rows that pre-date the GroupSenderName column,
    // the server wrote the sender as a prefix in the body ("SenderName: text").
    // Extract it in-memory so the UI shows the sender label correctly without
    // requiring a DB schema migration.  The transformation is idempotent: if
    // `senderDisplayName` is already set we skip it.
    String? senderDisplayName = row.senderDisplayName;
    String body = row.body;
    if (senderDisplayName == null && row.groupId != null && body.isNotEmpty) {
      final extracted = _extractGroupSenderFromBodyPrefix(body);
      if (extracted != null) {
        senderDisplayName = extracted.senderName;
        body = extracted.strippedBody;
      }
    }

    return ChatMessage(
      id: row.id,
      messageId: row.messageId,
      chatId: row.chatId,
      sender: row.sender,
      senderDisplayName: senderDisplayName,
      recordType: row.recordType,
      body: body,
      imageUrl: row.imageUrl,
      thumbnailUrl: row.thumbnailUrl,
      fileUrl: row.fileUrl,
      direction: row.direction == 'incoming' ? MessageDirection.incoming : MessageDirection.outgoing,
      timestamp: row.timestamp,
      deliveryStatus: DeliveryStatus.values.firstWhere(
        (e) => e.name == row.deliveryStatus,
        orElse: () => DeliveryStatus.pending,
      ),
      groupId: row.groupId,
      groupName: row.groupName,
      groupType: row.groupType != null
          ? GroupType.values.firstWhere((e) => e.name == row.groupType, orElse: () => GroupType.group)
          : null,
      reactions: row.reactions != null
          ? (jsonDecode(row.reactions!) as List).map((r) => MessageReaction.fromJson(r as Map<String, dynamic>)).toList()
          : null,
      editedAt: row.editedAt,
      deletedAt: row.deletedAt,
      replyTo: row.replyTo != null ? MessageReference.fromJson(jsonDecode(row.replyTo!) as Map<String, dynamic>) : null,
      forwarded: row.forwarded,
      forwardedFrom: row.forwardedFrom,
      forwardedFromName: row.forwardedFromName,
      userReceivedTime: row.userReceivedTime,
    );
  }

  // ---------------------------------------------------------------------------
  // Unread Counts
  // ---------------------------------------------------------------------------

  Future<Map<String, int>> getAllUnreadCounts() async {
    final rows = await select(unreadCounts).get();
    return Map.fromEntries(rows.map((r) => MapEntry(r.chatId, r.count)));
  }

  Future<int> getUnreadCount(String chatId) async {
    final row = await (select(unreadCounts)..where((t) => t.chatId.equals(chatId))).getSingleOrNull();
    return row?.count ?? 0;
  }

  Future<void> setUnreadCount(String chatId, int count) async {
    await into(unreadCounts).insertOnConflictUpdate(
      UnreadCountsCompanion.insert(chatId: chatId, count: count),
    );
  }

  Future<void> clearUnreadCount(String chatId) async {
    await (delete(unreadCounts)..where((t) => t.chatId.equals(chatId))).go();
  }

  Future<void> setAllUnreadCounts(Map<String, int> counts) async {
    await batch((batch) {
      batch.deleteAll(unreadCounts);
      for (final entry in counts.entries) {
        batch.insert(
          unreadCounts,
          UnreadCountsCompanion.insert(chatId: entry.key, count: entry.value),
        );
      }
    });
  }

  // ---------------------------------------------------------------------------
  // State Persistence (matches Angular persistState/restoreState)
  // ---------------------------------------------------------------------------

  Future<PersistedChatState> getPersistedState() async {
    final contactList = await getAllContacts();
    final groupList = await getAllGroups();
    final unread = await getAllUnreadCounts();
    final messageList = await getRecentMessages();

    return PersistedChatState(
      contacts: contactList,
      groups: groupList,
      unreadByChat: unread,
      messages: messageList,
    );
  }

  /// Write an in-memory snapshot to disk.
  ///
  /// The snapshot is applied **idempotently**: every row is upserted
  /// (`InsertMode.insertOrReplace`) and only rows that are genuinely absent
  /// from the snapshot are deleted.  A previous implementation cleared each
  /// table before re-inserting, which had two damaging consequences:
  ///
  ///  * The in-memory store keeps at most `maxMessagesPerChat` messages per
  ///    chat, so every persist permanently dropped the older history that had
  ///    been trimmed out of memory.
  ///  * An interrupted write (browser tab closed on Web, process killed on
  ///    mobile) could leave the tables empty, which in turn reset the
  ///    incremental-sync cursor and forced a full re-pull.
  ///
  /// Messages are never deleted here: the snapshot is a trimmed view of the
  /// history, not the authoritative set.  Rows are removed explicitly through
  /// [deleteMessage] / [clearAll] instead.
  ///
  /// The whole snapshot is applied inside a single [batch] so it is atomic.
  Future<void> persistState(PersistedChatState state) async {
    await batch((batch) {
      // Contacts
      final contactKeys = state.contacts.map((c) => c.username).toList();
      if (contactKeys.isNotEmpty) {
        batch.deleteWhere(contacts, (t) => t.username.isNotIn(contactKeys));
      }
      for (final contact in state.contacts) {
        batch.insert(
          contacts,
          ContactsCompanion.insert(
            username: contact.username,
            displayName: contact.displayName,
            info: Value(contact.info),
            phone: Value(contact.phone),
            upic: Value(contact.upic),
            status: Value(contact.status),
            updatedAt: DateTime.now().millisecondsSinceEpoch,
          ),
          mode: InsertMode.insertOrReplace,
        );
      }

      // Groups
      final groupKeys = state.groups.map((g) => g.id).toList();
      if (groupKeys.isNotEmpty) {
        batch.deleteWhere(groups, (t) => t.id.isNotIn(groupKeys));
      }
      for (final group in state.groups) {
        batch.insert(
          groups,
          GroupsCompanion.insert(
            id: group.id,
            name: group.name,
            members: jsonEncode(group.members),
            admins: Value(group.admins != null ? jsonEncode(group.admins) : null),
            createdBy: group.createdBy,
            updatedAt: group.updatedAt,
            type: group.type == GroupType.community ? 'community' : 'group',
          ),
          mode: InsertMode.insertOrReplace,
        );
      }

      // Unread counts — chats missing from the snapshot have no unread
      // messages, so their rows are dropped.
      final unreadKeys = state.unreadByChat.keys.toList();
      if (unreadKeys.isEmpty) {
        batch.deleteAll(unreadCounts);
      } else {
        batch.deleteWhere(unreadCounts, (t) => t.chatId.isNotIn(unreadKeys));
      }
      for (final entry in state.unreadByChat.entries) {
        batch.insert(
          unreadCounts,
          UnreadCountsCompanion.insert(chatId: entry.key, count: entry.value),
          mode: InsertMode.insertOrReplace,
        );
      }

      // Messages — upsert only, never delete (see doc comment above).
      for (final message in state.messages) {
        batch.insert(
          messages,
          _messageToCompanion(message),
          mode: InsertMode.insertOrReplace,
        );
      }
    });
  }

  /// Clear all data
  Future<void> clearAll() async {
    await batch((batch) {
      batch.deleteAll(contacts);
      batch.deleteAll(groups);
      batch.deleteAll(messages);
      batch.deleteAll(unreadCounts);
      batch.deleteAll(outboxItems);
    });
  }
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

final chatDatabaseProvider = Provider<ChatDatabase>((ref) {
  return ChatDatabase();
});
