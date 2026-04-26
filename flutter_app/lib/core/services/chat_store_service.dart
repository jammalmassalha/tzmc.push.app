/// Chat Store Service - central state management for chat data.
///
/// This is the Flutter equivalent of Angular's ChatStoreService.
/// Manages contacts, groups, messages, and real-time synchronization.
library;

import 'dart:async';
import 'dart:convert';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../api/chat_api_service.dart';
import '../database/chat_database.dart' hide Contact;
import '../models/api_payloads.dart';
import '../models/chat_models.dart';
import '../realtime/realtime_transport_service.dart';

// ---------------------------------------------------------------------------
// Constants (matching Angular constants)
// ---------------------------------------------------------------------------

/// Push recovery pull delays in milliseconds
const List<int> pushRecoveryPullDelaysMs = [1200, 3600];

/// Gap analysis cooldown in milliseconds
const int gapAnalysisCooldownMs = 30000;

/// Max messages to keep per chat
const int maxMessagesPerChat = 500;

// ---------------------------------------------------------------------------
// Chat State
// ---------------------------------------------------------------------------

/// Immutable chat state container
class ChatState {
  final Map<String, Contact> contacts;
  final Map<String, ChatGroup> groups;
  final Map<String, List<ChatMessage>> messagesByChat;
  final Map<String, int> unreadByChat;
  final String? currentChatId;
  final bool isLoading;
  final bool isInitialized;

  /// Full-sync progress fields (mirrors Angular store.syncing /
  /// store.syncProgressPercent / store.syncProgressLabel).
  final bool isSyncing;
  final int syncProgressPercent;
  final String syncProgressLabel;

  const ChatState({
    this.contacts = const {},
    this.groups = const {},
    this.messagesByChat = const {},
    this.unreadByChat = const {},
    this.currentChatId,
    this.isLoading = false,
    this.isInitialized = false,
    this.isSyncing = false,
    this.syncProgressPercent = 0,
    this.syncProgressLabel = '',
  });

  ChatState copyWith({
    Map<String, Contact>? contacts,
    Map<String, ChatGroup>? groups,
    Map<String, List<ChatMessage>>? messagesByChat,
    Map<String, int>? unreadByChat,
    String? currentChatId,
    bool? isLoading,
    bool? isInitialized,
    bool clearCurrentChat = false,
    bool? isSyncing,
    int? syncProgressPercent,
    String? syncProgressLabel,
  }) {
    return ChatState(
      contacts: contacts ?? this.contacts,
      groups: groups ?? this.groups,
      messagesByChat: messagesByChat ?? this.messagesByChat,
      unreadByChat: unreadByChat ?? this.unreadByChat,
      currentChatId: clearCurrentChat ? null : (currentChatId ?? this.currentChatId),
      isLoading: isLoading ?? this.isLoading,
      isInitialized: isInitialized ?? this.isInitialized,
      isSyncing: isSyncing ?? this.isSyncing,
      syncProgressPercent: syncProgressPercent ?? this.syncProgressPercent,
      syncProgressLabel: syncProgressLabel ?? this.syncProgressLabel,
    );
  }

  /// Get all chat list items sorted by last message timestamp
  List<ChatListItem> get chatListItems {
    final items = <ChatListItem>[];

    // Add direct contacts with messages
    for (final entry in messagesByChat.entries) {
      final chatId = entry.key;
      final messages = entry.value;
      if (messages.isEmpty) continue;

      // Check if it's a group chat
      final group = groups[chatId];
      if (group != null) continue; // Handle groups separately

      // Direct chat
      final contact = contacts[chatId];
      final lastMessage = messages.first;

      items.add(ChatListItem(
        id: chatId,
        title: contact?.displayName ?? chatId,
        info: contact?.info,
        subtitle: _getMessagePreview(lastMessage),
        lastTimestamp: lastMessage.timestamp,
        unread: unreadByChat[chatId] ?? 0,
        isGroup: false,
        pinned: false,
        avatarUrl: contact?.upic,
      ));
    }

    // Add groups with messages
    for (final group in groups.values) {
      final messages = messagesByChat[group.id] ?? [];
      if (messages.isEmpty) continue;

      final lastMessage = messages.first;

      items.add(ChatListItem(
        id: group.id,
        title: group.name,
        info: '${group.members.length} חברים',
        subtitle: _getMessagePreview(lastMessage),
        lastTimestamp: lastMessage.timestamp,
        unread: unreadByChat[group.id] ?? 0,
        isGroup: true,
        pinned: false,
      ));
    }

    // Sort by timestamp descending
    items.sort((a, b) => b.lastTimestamp.compareTo(a.lastTimestamp));

    return items;
  }

  String _getMessagePreview(ChatMessage message) {
    if (message.deletedAt != null) return '🗑️ הודעה נמחקה';
    if (message.imageUrl != null) return '📷 תמונה';
    if (message.fileUrl != null) return '📎 קובץ';
    final body = message.body.trim();
    return body.length > 50 ? '${body.substring(0, 50)}...' : body;
  }
}

// ---------------------------------------------------------------------------
// Chat Store Notifier
// ---------------------------------------------------------------------------

class ChatStoreNotifier extends Notifier<ChatState> {
  late final ChatApiService _api;
  late final ChatDatabase _db;
  late final RealtimeTransportService _transport;

  StreamSubscription<IncomingServerMessage>? _messageSubscription;
  StreamSubscription<bool>? _connectionSubscription;
  StreamSubscription<void>? _pollTickSubscription;

  Timer? _persistTimer;
  int _lastGapAnalysisTime = 0;
  String? _currentUser;

  /// Username of the currently authenticated user, normalized to lowercase.
  /// Used to dedupe own-message echoes coming back from the server (which
  /// would otherwise show a duplicate "incoming from me" bubble).
  String? get currentUser => _currentUser;

  @override
  ChatState build() {
    _api = ref.watch(chatApiServiceProvider);
    _db = ref.watch(chatDatabaseProvider);
    _transport = ref.watch(realtimeTransportServiceProvider);
    
    _subscribeToTransport();
    
    // Clean up subscriptions when the notifier is disposed
    ref.onDispose(() {
      _messageSubscription?.cancel();
      _connectionSubscription?.cancel();
      _pollTickSubscription?.cancel();
      _persistTimer?.cancel();
    });
    
    return const ChatState();
  }

  void _subscribeToTransport() {
    _messageSubscription = _transport.message$.listen(_handleServerMessage);
    _connectionSubscription = _transport.connected$.listen(_handleConnectionChange);
    _pollTickSubscription = _transport.pollTick$.listen((_) => _handlePollTick());
  }

  // ---------------------------------------------------------------------------
  // Initialization
  // ---------------------------------------------------------------------------

  /// Initialize chat store - restore from database and pull fresh data
  Future<void> initialize(String currentUser) async {
    // Always remember the current user, even if we've already initialized,
    // so own-message echoes can be tagged as outgoing (avoids the
    // "see my message twice" bug).
    _currentUser = currentUser.trim().toLowerCase();

    if (state.isInitialized) return;

    state = state.copyWith(isLoading: true);

    try {
      // 1. Restore from local database
      final persisted = await _db.getPersistedState();
      state = state.copyWith(
        contacts: Map.fromEntries(persisted.contacts.map((c) => MapEntry(c.username, c))),
        groups: Map.fromEntries(persisted.groups.map((g) => MapEntry(g.id, g))),
        messagesByChat: _groupMessagesByChat(persisted.messages),
        unreadByChat: persisted.unreadByChat,
      );

      // 2. Pull fresh contacts and groups
      await Future.wait([
        _pullContacts(),
        _pullGroups(),
      ]);

      // 3. Pull missed messages (gap analysis)
      await recoverMissedMessages();

      state = state.copyWith(isLoading: false, isInitialized: true);

      // 4. Schedule periodic persistence
      _schedulePersistence();
    } catch (e) {
      state = state.copyWith(isLoading: false);
      rethrow;
    }
  }

  Map<String, List<ChatMessage>> _groupMessagesByChat(List<ChatMessage> messages) {
    final result = <String, List<ChatMessage>>{};
    for (final message in messages) {
      (result[message.chatId] ??= []).add(message);
    }
    // Sort each chat's messages by timestamp descending
    for (final chatId in result.keys) {
      result[chatId]!.sort((a, b) => b.timestamp.compareTo(a.timestamp));
    }
    return result;
  }

  // ---------------------------------------------------------------------------
  // Contacts
  // ---------------------------------------------------------------------------

  Future<void> _pullContacts() async {
    try {
      final contactList = await _api.getContacts();
      final contactMap = Map.fromEntries(contactList.map((c) => MapEntry(c.username, c)));
      state = state.copyWith(contacts: contactMap);
      await _db.upsertContacts(contactList);
    } catch (e) {
      // Use cached data on error
    }
  }

  Contact? getContact(String username) => state.contacts[username];

  String getDisplayName(String username) {
    return state.contacts[username]?.displayName ?? username;
  }

  // ---------------------------------------------------------------------------
  // Groups
  // ---------------------------------------------------------------------------

  Future<void> _pullGroups() async {
    try {
      final groupList = await _api.getGroups();
      final groupMap = Map.fromEntries(groupList.map((g) => MapEntry(g.id, g)));
      state = state.copyWith(groups: groupMap);
      await _db.upsertGroups(groupList);
    } catch (e) {
      // Use cached data on error
    }
  }

  ChatGroup? getGroup(String id) => state.groups[id];

  // ---------------------------------------------------------------------------
  // New chat / group creation (mirrors Angular ChatStoreService.startDirectChat
  // and createGroup so the Flutter "open new chat" / "create group" flows
  // behave identically to the Angular front-end).
  // ---------------------------------------------------------------------------

  /// Ensure a Contact exists for [username] (creating a placeholder if needed)
  /// so it shows up in the chat list right after the user picks it from the
  /// new-chat dialog. Equivalent to Angular `startDirectChat`. Returns the
  /// canonical chat id (case-preserving) the caller should navigate to.
  String startDirectChat(String username) {
    final normalized = username.trim().toLowerCase();
    if (normalized.isEmpty) return '';

    // Case-insensitive lookup — server-side contact keys are not normalized,
    // so we may have e.g. "Username" stored while the picker hands us
    // "username". Don't overwrite a real contact with a placeholder.
    final existing = state.contacts.entries.firstWhere(
      (e) => e.key.trim().toLowerCase() == normalized,
      orElse: () => MapEntry('', const Contact(username: '', displayName: '')),
    );

    String chatId;
    if (existing.key.isEmpty) {
      final placeholder = Contact(
        username: normalized,
        displayName: normalized,
      );
      final newContacts = Map<String, Contact>.from(state.contacts);
      newContacts[normalized] = placeholder;
      state = state.copyWith(contacts: newContacts);
      chatId = normalized;
    } else {
      chatId = existing.key;
    }

    setCurrentChat(chatId);
    return chatId;
  }

  /// Create a new group with the current user as the sole admin and notify
  /// the other members via the existing `/group-update` endpoint. Mirrors
  /// Angular `ChatStoreService.createGroup`.
  ///
  /// Throws if the user is not authenticated, the name is empty, or fewer
  /// than two distinct members were selected (Angular enforces the same).
  Future<ChatGroup> createGroup({
    required String name,
    required List<String> members,
    GroupType type = GroupType.group,
  }) async {
    final user = _currentUser;
    if (user == null || user.isEmpty) {
      throw Exception('יש להתחבר לפני יצירת קבוצה');
    }

    final groupName = name.trim();
    if (groupName.isEmpty) {
      throw Exception('יש להזין שם לקבוצה');
    }

    final normalizedMembers = <String>{
      ...members.map((m) => m.trim().toLowerCase()).where((m) => m.isNotEmpty),
      user,
    }.toList();

    if (normalizedMembers.length < 2) {
      throw Exception('יש לבחור לפחות שני משתתפים');
    }

    final groupId =
        'group:${DateTime.now().millisecondsSinceEpoch}-${DateTime.now().microsecond}';
    final group = ChatGroup(
      id: groupId,
      name: groupName,
      members: normalizedMembers,
      admins: [user],
      createdBy: user,
      updatedAt: DateTime.now().millisecondsSinceEpoch,
      type: type,
    );

    // Optimistically insert into state and persist locally.
    final newGroups = Map<String, ChatGroup>.from(state.groups);
    newGroups[group.id] = group;
    state = state.copyWith(groups: newGroups);
    setCurrentChat(group.id);
    await _db.upsertGroup(group);
    _schedulePersistence();

    final membersToNotify = group.members.where((m) => m != user).toList();
    if (membersToNotify.isEmpty) return group;

    // Notify the server (and other members). Failures are not fatal — the
    // group still exists locally and Angular's chat-store also tolerates a
    // failed `sendGroupUpdate` by queueing it.
    try {
      await _api.sendGroupUpdate(GroupUpdatePayload(
        groupId: group.id,
        groupName: group.name,
        groupMembers: group.members,
        groupCreatedBy: group.createdBy,
        groupAdmins: group.admins,
        actorUser: user,
        groupUpdatedAt: group.updatedAt,
        groupType: group.type,
        membersToNotify: membersToNotify,
      ));
    } catch (e) {
      // Silent — the group is already present locally and will be re-synced
      // on the next /group-update push or recoverMissedMessages cycle.
    }

    return group;
  }

  /// Whether the current user is allowed to send messages to [chatId]. Always
  /// true for direct messages and regular groups; for community groups only
  /// admins (and the group creator) may post — mirroring Angular
  /// `canUserSendToCommunityGroup` / `canSendToActiveChat`.
  bool canSendToChat(String? chatId) {
    if (chatId == null || chatId.isEmpty) return false;
    final group = state.groups[chatId];
    if (group == null) return true; // direct chat
    if (group.type != GroupType.community) return true;

    final me = _currentUser;
    if (me == null || me.isEmpty) return false;

    final admins = (group.admins ?? const <String>[])
        .map((a) => a.trim().toLowerCase())
        .where((a) => a.isNotEmpty)
        .toList();
    if (admins.contains(me)) return true;
    return group.createdBy.trim().toLowerCase() == me;
  }

  // ---------------------------------------------------------------------------
  // Messages
  // ---------------------------------------------------------------------------

  /// Get messages for a chat
  List<ChatMessage> getMessages(String chatId) {
    return state.messagesByChat[chatId] ?? [];
  }

  /// Pull messages since a timestamp
  Future<void> pullMessages({int? since}) async {
    try {
      final latestTimestamp = since ?? await _db.getLatestMessageTimestamp();
      final messages = await _api.getMessagesSince(latestTimestamp);
      
      if (messages.isEmpty) return;

      // Process and store messages
      for (final message in messages) {
        _applyIncomingMessage(message);
      }

      _schedulePersistence();
    } catch (e) {
      // Log error, continue with cached data
    }
  }

  /// Recover missed messages (gap analysis)
  Future<void> recoverMissedMessages({bool force = false}) async {
    final now = DateTime.now().millisecondsSinceEpoch;

    // Cooldown check (unless forced)
    if (!force && (now - _lastGapAnalysisTime) < gapAnalysisCooldownMs) {
      return;
    }

    _lastGapAnalysisTime = now;

    try {
      final latestTimestamp = await _db.getLatestMessageTimestamp();
      await pullMessages(since: latestTimestamp);
    } catch (e) {
      // Silent failure, will retry on next poll
    }
  }

  /// Schedule push recovery pulls (for truncated push payloads)
  void schedulePushRecoveryPulls() {
    for (final delayMs in pushRecoveryPullDelaysMs) {
      Future.delayed(Duration(milliseconds: delayMs), () {
        pullMessages();
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Full sync (mirrors Angular ChatStoreService.forceSyncAllMessagesAndClearCache)
  // ---------------------------------------------------------------------------

  /// Wipe the local cache completely, then pull a fresh copy of all data
  /// from the server. Mirrors Angular's `forceSyncAllMessagesAndClearCache`.
  ///
  /// Progress is exposed via [state.isSyncing], [state.syncProgressPercent],
  /// and [state.syncProgressLabel] so the UI can show a progress overlay.
  ///
  /// Throws on unrecoverable errors (e.g. not authenticated, no network).
  Future<void> forceSyncAllMessagesAndClearCache() async {
    final user = _currentUser;
    if (user == null || user.isEmpty) {
      throw Exception('יש להתחבר לפני סנכרון מלא');
    }

    state = state.copyWith(
      isSyncing: true,
      syncProgressPercent: 0,
      syncProgressLabel: 'מנקה מטמון מקומי...',
    );

    try {
      // 1. Wipe the local Drift database.
      await _db.clearAll();
      state = state.copyWith(
        messagesByChat: const {},
        unreadByChat: const {},
        syncProgressPercent: 20,
        syncProgressLabel: 'טוען אנשי קשר...',
      );

      // 2. Re-pull contacts.
      await _pullContacts();
      state = state.copyWith(
        syncProgressPercent: 40,
        syncProgressLabel: 'טוען קבוצות...',
      );

      // 3. Re-pull groups.
      await _pullGroups();
      state = state.copyWith(
        syncProgressPercent: 60,
        syncProgressLabel: 'מושך הודעות...',
      );

      // 4. Pull messages (full pull — no since filter).
      await pullMessages();
      state = state.copyWith(
        syncProgressPercent: 80,
        syncProgressLabel: 'משחזר הודעות שהוחמצו...',
      );

      // 5. Gap-analysis recovery pull (force = true bypasses cooldown).
      await recoverMissedMessages(force: true);
      state = state.copyWith(
        syncProgressPercent: 95,
        syncProgressLabel: 'מסיים...',
      );

      // 6. Reset unread counters.
      state = state.copyWith(unreadByChat: const {});

      _schedulePersistence();
      state = state.copyWith(
        syncProgressPercent: 100,
        isInitialized: true,
      );
    } finally {
      state = state.copyWith(
        isSyncing: false,
        syncProgressPercent: 0,
        syncProgressLabel: '',
      );
    }
  }

  /// Apply an incoming message from an FCM push payload.
  ///
  /// The [data] map mirrors the `notificationExtraData` / `compactCustomData`
  /// emitted by `backend/src/services/notification.service.ts` and
  /// `server.js` (notificationExtraData around server.js:2136). The payload
  /// may be truncated (groupMessageText is trimmed to 120 chars when the
  /// payload exceeds maxPushPayloadBytes), so this method also schedules
  /// recovery pulls to hydrate the full body shortly after.
  void applyIncomingFromPushPayload(Map<String, dynamic> data) {
    if (data.isEmpty) return;

    String? _str(dynamic v) {
      if (v == null) return null;
      final s = v.toString().trim();
      return s.isEmpty ? null : s;
    }

    int? _int(dynamic v) {
      if (v == null) return null;
      if (v is int) return v;
      if (v is num) return v.toInt();
      return int.tryParse(v.toString());
    }

    // Helper: FCM coerces all data values to strings on Android; arrays are
    // JSON-encoded strings like '["id1","id2"]'. Decode them back to a list.
    List<String>? _strList(dynamic v) {
      if (v == null) return null;
      if (v is List) return v.map((e) => e.toString()).toList();
      final s = v.toString().trim();
      if (s.isEmpty) return null;
      try {
        final decoded = jsonDecode(s);
        if (decoded is List) {
          return decoded.map((e) => e.toString()).toList();
        }
        return [s];
      } catch (_) {
        return [s];
      }
    }

    final type = (_str(data['type']) ?? '').toLowerCase();

    // ── Action / housekeeping payloads ────────────────────────────────────
    // These should never create a new ChatMessage or increment the unread
    // counter. Delegate to the same action handlers used by socket/SSE so the
    // UI reflects the action (e.g. marking messages as read, hiding deleted).

    switch (type) {
      case 'read-receipt':
      case 'read':
        {
          final ids = _strList(data['messageIds']);
          if (ids == null || ids.isEmpty) return;
          final msg = IncomingServerMessage(
            type: type,
            messageIds: ids,
            readAt: _int(data['readAt']),
            sender: _str(data['sender']),
          );
          _handleReadReceipt(msg);
          return;
        }

      case 'delete-action':
      case 'delete':
        {
          // The server sends `messageId` (the deleted message's ID).
          // `_handleDelete` expects `targetMessageId`.
          final targetId = _str(data['messageId']) ?? _str(data['targetMessageId']);
          if (targetId == null) return;
          final msg = IncomingServerMessage(
            type: type,
            targetMessageId: targetId,
            deletedAt: _int(data['deletedAt']) ?? _int(data['timestamp']),
            sender: _str(data['sender']),
          );
          _handleDelete(msg);
          return;
        }

      case 'edit-action':
      case 'edit':
        {
          final targetId = _str(data['messageId']) ?? _str(data['targetMessageId']);
          if (targetId == null) return;
          final msg = IncomingServerMessage(
            type: type,
            targetMessageId: targetId,
            body: _str(data['body']),
            editedAt: _int(data['editedAt']) ?? _int(data['timestamp']),
            sender: _str(data['sender']),
          );
          _handleEdit(msg);
          return;
        }

      case 'group-update':
        {
          final groupId = _str(data['groupId']);
          if (groupId == null) return;
          final msg = IncomingServerMessage(
            type: type,
            groupId: groupId,
            groupName: _str(data['groupName']),
            groupMembers: _strList(data['groupMembers']),
            groupCreatedBy: _str(data['groupCreatedBy']),
            groupAdmins: _strList(data['groupAdmins']),
            groupUpdatedAt: _int(data['groupUpdatedAt']),
            groupType: _str(data['groupType']),
            sender: _str(data['sender']),
          );
          _handleGroupUpdate(msg);
          return;
        }

      case 'typing':
        return; // Typing indicators from push are not actionable.
    }

    // ── Regular chat message ───────────────────────────────────────────────
    final messageId = _str(data['messageId']);
    final sender = _str(data['sender']) ?? _str(data['fromUser']);
    if (messageId == null || sender == null) return;

    // Self-echo: the server sends a copy to the sender's other devices with
    // skipNotification: true so the outgoing bubble is confirmed delivered.
    // Apply the message but do NOT increment the unread counter.
    final skipNotification = data['skipNotification'] == true ||
        data['skipNotification'] == 'true';

    final groupId = _str(data['groupId']);
    final isGroup = groupId != null;
    final chatId = isGroup ? groupId : sender;

    // Backend may include either the full body (messageText) or a truncated
    // groupMessageText. Prefer the longer one — _hydrateExistingMessage will
    // still keep the longer body if a fresher pull replaces it.
    final messageText = _str(data['messageText']);
    final groupMessageText = _str(data['groupMessageText']);
    final body = (messageText != null && groupMessageText != null)
        ? (messageText.length >= groupMessageText.length ? messageText : groupMessageText)
        : (messageText ?? groupMessageText ?? _str(data['body']) ?? '');

    final groupTypeRaw = _str(data['groupType']);
    final groupType = groupTypeRaw == 'community'
        ? GroupType.community
        : (isGroup ? GroupType.group : null);

    final senderDisplayName = _str(data['groupSenderName']) ?? getDisplayName(sender);
    final timestamp = _int(data['timestamp']) ?? DateTime.now().millisecondsSinceEpoch;

    final message = ChatMessage(
      id: messageId,
      messageId: messageId,
      chatId: chatId,
      sender: sender,
      senderDisplayName: senderDisplayName,
      body: body,
      imageUrl: _str(data['image']) ?? _str(data['imageUrl']),
      fileUrl: _str(data['fileUrl']),
      direction: MessageDirection.incoming,
      timestamp: timestamp,
      deliveryStatus: DeliveryStatus.delivered,
      groupId: groupId,
      groupName: _str(data['groupName']),
      groupType: groupType,
    );

    _applyIncomingMessage(message);

    // Update unread count if not the currently open chat.
    // Skip for self-echo messages (sender's own devices) to avoid
    // incrementing the badge for messages the user just sent.
    if (!skipNotification && chatId != state.currentChatId) {
      final newUnread = Map<String, int>.from(state.unreadByChat);
      newUnread[chatId] = (newUnread[chatId] ?? 0) + 1;
      state = state.copyWith(unreadByChat: newUnread);
    }

    _schedulePersistence();

    // Pull full message content shortly after, in case the push body was
    // truncated to fit the FCM payload size limit.
    if (!skipNotification) schedulePushRecoveryPulls();
  }

  /// Apply an incoming message to state
  void _applyIncomingMessage(ChatMessage message) {
    final chatId = message.chatId;
    final newMessagesByChat = Map<String, List<ChatMessage>>.from(state.messagesByChat);
    final chatMessages = List<ChatMessage>.from(newMessagesByChat[chatId] ?? []);

    // Check for existing message (by messageId)
    var existingIndex = chatMessages.indexWhere((m) => m.messageId == message.messageId);

    // Fallback dedup for own-message echoes whose messageId is not preserved
    // by the server. For group messages the backend rewrites
    // `pollingMessage.sender = groupId` (server.js:2138), so the echo arrives
    // with sender == groupId rather than the current user — the
    // `_buildChatMessageFromServer` heuristic then tags it as `incoming` and,
    // if any layer along the way regenerates the messageId, the echo would
    // show up as a second "me" bubble next to the original outgoing one.
    // Match against an optimistic outgoing message with the same body posted
    // within the last 30s and treat the echo as a hydration of it. We scan
    // newest-first (chatMessages is sorted descending by timestamp) and bail
    // out as soon as we leave the window so the cost stays bounded on long
    // chats.
    if (existingIndex < 0 && message.direction == MessageDirection.incoming) {
      final fingerprint = message.body.trim();
      final ts = message.timestamp;
      for (var i = 0; i < chatMessages.length; i++) {
        final m = chatMessages[i];
        if ((m.timestamp - ts).abs() >= 30000) break;
        if (m.direction == MessageDirection.outgoing &&
            m.body.trim() == fingerprint) {
          existingIndex = i;
          break;
        }
      }
    }

    if (existingIndex >= 0) {
      // Hydrate existing message (keep longer body)
      final existing = chatMessages[existingIndex];
      final hydrated = _hydrateExistingMessage(existing, message);
      chatMessages[existingIndex] = hydrated;
    } else {
      // Insert new message
      chatMessages.insert(0, message);
    }

    // Sort by timestamp descending
    chatMessages.sort((a, b) => b.timestamp.compareTo(a.timestamp));

    // Trim to max messages
    if (chatMessages.length > maxMessagesPerChat) {
      chatMessages.removeRange(maxMessagesPerChat, chatMessages.length);
    }

    newMessagesByChat[chatId] = chatMessages;
    state = state.copyWith(messagesByChat: newMessagesByChat);
  }

  /// Hydrate existing message with new data (pick longer body)
  ChatMessage _hydrateExistingMessage(ChatMessage existing, ChatMessage incoming) {
    // Pick longer body (for push truncation recovery)
    final body = (incoming.body.length > existing.body.length) ? incoming.body : existing.body;

    return existing.copyWith(
      body: body,
      senderDisplayName: incoming.senderDisplayName ?? existing.senderDisplayName,
      editedAt: incoming.editedAt ?? existing.editedAt,
      deletedAt: incoming.deletedAt ?? existing.deletedAt,
      reactions: incoming.reactions ?? existing.reactions,
      deliveryStatus: incoming.deliveryStatus,
    );
  }

  // ---------------------------------------------------------------------------
  // Send Messages
  // ---------------------------------------------------------------------------

  /// Deliver a [ReplyPayload] via socket.io when connected, falling back to
  /// HTTP POST otherwise.
  ///
  /// The socket.io connection is already authenticated via its handshake
  /// query (`user=<phone>`), so the server identifies the sender without
  /// inspecting session cookies or the `body.user` field.  When the socket
  /// is unavailable (not connected, or ack times out) we fall back to the
  /// regular HTTP path which uses the session cookie + `body.user`.
  Future<void> _sendReply(ReplyPayload payload) async {
    // Try socket first.
    final socketResult = await _transport.emitWithAck(
      'chat:reply',
      payload.toJson(),
    );
    if (socketResult != null && socketResult['status'] == 'success') {
      return; // Delivered via socket.io.
    }
    // Socket not available, timed out, or returned an error — fall back to HTTP.
    await _api.sendDirectMessage(payload);
  }

  /// Send a direct message
  Future<void> sendDirectMessage({
    required String recipient,
    required String body,
    String? imageUrl,
    String? fileUrl,
    MessageReference? replyTo,
  }) async {
    final messageId = _generateMessageId();
    final timestamp = DateTime.now().millisecondsSinceEpoch;
    final sender = _currentUser ?? '';

    // Create optimistic message
    final message = ChatMessage(
      id: messageId,
      messageId: messageId,
      chatId: recipient,
      sender: sender.isNotEmpty ? sender : 'me',
      body: body,
      imageUrl: imageUrl,
      fileUrl: fileUrl,
      direction: MessageDirection.outgoing,
      timestamp: timestamp,
      deliveryStatus: DeliveryStatus.pending,
      replyTo: replyTo,
    );

    // Add to state optimistically
    _applyIncomingMessage(message);

    try {
      // Build the payload once and reuse it for both socket and HTTP paths.
      // messageId is shared so the server echo dedupes against the optimistic
      // bubble instead of producing a second "incoming from me" copy.
      final payload = ReplyPayload(
        user: sender,
        senderName: getDisplayName(sender),
        reply: body,
        imageUrl: imageUrl,
        fileUrl: fileUrl,
        originalSender: recipient,
        messageId: messageId,
        replyToMessageId: replyTo?.messageId,
      );
      await _sendReply(payload);

      // Update status to sent
      _updateMessageStatus(messageId, DeliveryStatus.sent);
    } catch (e) {
      // Update status to failed
      _updateMessageStatus(messageId, DeliveryStatus.failed);
      rethrow;
    }
  }

  /// Send a group message
  Future<void> sendGroupMessage({
    required String groupId,
    required String body,
    String? imageUrl,
    String? fileUrl,
    MessageReference? replyTo,
  }) async {
    final group = state.groups[groupId];
    if (group == null) throw Exception('Group not found');

    final messageId = _generateMessageId();
    final timestamp = DateTime.now().millisecondsSinceEpoch;
    final sender = _currentUser ?? '';

    // Create optimistic message
    final message = ChatMessage(
      id: messageId,
      messageId: messageId,
      chatId: groupId,
      sender: sender.isNotEmpty ? sender : 'me',
      body: body,
      imageUrl: imageUrl,
      fileUrl: fileUrl,
      direction: MessageDirection.outgoing,
      timestamp: timestamp,
      deliveryStatus: DeliveryStatus.pending,
      groupId: groupId,
      groupName: group.name,
      groupType: group.type,
      replyTo: replyTo,
    );

    // Add to state optimistically
    _applyIncomingMessage(message);

    try {
      // Compute notify list excluding self so the backend doesn't echo a
      // group push back to the sender.
      final me = sender.trim().toLowerCase();
      final notify = group.members
          .where((m) => m.trim().toLowerCase() != me)
          .toList();

      final originalSender = notify.isNotEmpty
          ? notify.first
          : (group.members.isNotEmpty ? group.members.first : groupId);

      final payload = ReplyPayload(
        user: sender,
        senderName: getDisplayName(sender),
        reply: body,
        imageUrl: imageUrl,
        fileUrl: fileUrl,
        originalSender: originalSender,
        messageId: messageId,
        groupId: groupId,
        groupName: group.name,
        groupMembers: group.members,
        groupCreatedBy: group.createdBy,
        groupAdmins: group.admins,
        groupUpdatedAt: group.updatedAt,
        groupType: group.type,
        groupSenderName: getDisplayName(sender),
        membersToNotify: notify,
        replyToMessageId: replyTo?.messageId,
      );
      await _sendReply(payload);

      // Update status to sent
      _updateMessageStatus(messageId, DeliveryStatus.sent);
    } catch (e) {
      // Update status to failed
      _updateMessageStatus(messageId, DeliveryStatus.failed);
      rethrow;
    }
  }

  void _updateMessageStatus(String messageId, DeliveryStatus status) {
    final newMessagesByChat = <String, List<ChatMessage>>{};

    for (final entry in state.messagesByChat.entries) {
      final chatMessages = entry.value.map((m) {
        if (m.messageId == messageId) {
          return m.copyWith(deliveryStatus: status);
        }
        return m;
      }).toList();
      newMessagesByChat[entry.key] = chatMessages;
    }

    state = state.copyWith(messagesByChat: newMessagesByChat);
  }

  String _generateMessageId() {
    return '${DateTime.now().millisecondsSinceEpoch}-${DateTime.now().microsecond}';
  }

  // ---------------------------------------------------------------------------
  // Reactions
  // ---------------------------------------------------------------------------

  Future<void> addReaction(String messageId, String emoji) async {
    await _api.addReaction(messageId, emoji);
    // Real-time update will apply the change
  }

  Future<void> removeReaction(String messageId, String emoji) async {
    await _api.removeReaction(messageId, emoji);
    // Real-time update will apply the change
  }

  // ---------------------------------------------------------------------------
  // Edit/Delete
  // ---------------------------------------------------------------------------

  Future<void> editMessage(String messageId, String newBody) async {
    await _api.editMessage(messageId, newBody);
    // Real-time update will apply the change
  }

  Future<void> deleteMessage(String messageId) async {
    await _api.deleteMessage(messageId);
    // Real-time update will apply the change
  }

  // ---------------------------------------------------------------------------
  // Read Receipts
  // ---------------------------------------------------------------------------

  Future<void> markAsRead(String chatId, List<String> messageIds) async {
    if (messageIds.isEmpty) return;

    // Clear unread count locally
    final newUnread = Map<String, int>.from(state.unreadByChat);
    newUnread[chatId] = 0;
    state = state.copyWith(unreadByChat: newUnread);

    try {
      await _api.markMessagesAsRead(chatId, messageIds);
    } catch (e) {
      // Silent failure
    }
  }

  // ---------------------------------------------------------------------------
  // Chat Navigation
  // ---------------------------------------------------------------------------

  void setCurrentChat(String? chatId) {
    state = state.copyWith(
      currentChatId: chatId,
      clearCurrentChat: chatId == null,
    );

    // Clear unread when opening chat
    if (chatId != null && (state.unreadByChat[chatId] ?? 0) > 0) {
      final messages = getMessages(chatId);
      final messageIds = messages.map((m) => m.messageId).toList();
      markAsRead(chatId, messageIds);
    }
  }

  // ---------------------------------------------------------------------------
  // Real-time Message Handling
  // ---------------------------------------------------------------------------

  void _handleServerMessage(IncomingServerMessage message) {
    // Backend emits regular chat messages over socket.io / SSE without an
    // explicit `type` field (see server `addToQueue` → notifyRealtimeClients).
    // Action payloads use the suffixed names `delete-action`, `edit-action`,
    // `read-receipt`. The Angular client matches the same convention by
    // treating any non-action type as a regular text message
    // (frontend chat-store.service.ts → `isIncomingActionType`).
    // Mirror that behavior here so messages from the Angular frontend are
    // actually applied to the Flutter chat store instead of being silently
    // dropped by an over-strict switch.
    final type = (message.type ?? '').trim().toLowerCase();

    switch (type) {
      case 'typing':
        _handleTypingIndicator(message);
        break;
      case 'read':
      case 'read-receipt':
        _handleReadReceipt(message);
        break;
      case 'reaction':
        _handleReaction(message);
        break;
      case 'edit':
      case 'edit-action':
        _handleEdit(message);
        break;
      case 'delete':
      case 'delete-action':
        _handleDelete(message);
        break;
      case 'group-update':
        _handleGroupUpdate(message);
        break;
      case '':
      case 'message':
      default:
        // Treat anything else (including the common no-type payload from the
        // backend) as a regular incoming text message so 1:1 and group
        // messages from the Angular frontend reach the Flutter user.
        _handleIncomingTextMessage(message);
        break;
    }
  }

  void _handleIncomingTextMessage(IncomingServerMessage msg) {
    final chatMessage = _buildChatMessageFromServer(msg);
    if (chatMessage != null) {
      _applyIncomingMessage(chatMessage);

      // Update unread count if not current chat
      if (chatMessage.chatId != state.currentChatId && 
          chatMessage.direction == MessageDirection.incoming) {
        final newUnread = Map<String, int>.from(state.unreadByChat);
        newUnread[chatMessage.chatId] = (newUnread[chatMessage.chatId] ?? 0) + 1;
        state = state.copyWith(unreadByChat: newUnread);
      }

      _schedulePersistence();
    }
  }

  ChatMessage? _buildChatMessageFromServer(IncomingServerMessage msg) {
    if (msg.messageId == null || msg.sender == null) return null;

    final isGroup = msg.groupId != null;
    final chatId = isGroup ? msg.groupId! : msg.sender!;

    // If the echo is for a message *we* just sent, tag it as outgoing so
    // the chat bubble doesn't render as "incoming from me" (the duplicate
    // bug). The optimistic bubble was inserted with the same messageId, so
    // _applyIncomingMessage will hydrate it in place rather than appending
    // a second row.
    //
    // For 1:1 messages msg.sender == currentUser, so the direct match works.
    // For group messages the backend rewrites pollingMessage.sender to the
    // groupId (server.js:2138), so a sender-based check fails. Fall back to
    // matching against an existing optimistic outgoing message in the same
    // chat by body+timestamp window.
    final me = _currentUser;
    final senderLower = msg.sender!.trim().toLowerCase();
    final body = msg.body ?? '';
    final ts = msg.timestamp ?? DateTime.now().millisecondsSinceEpoch;
    // Scan only recent outgoing messages (chatMessages are sorted newest-first
    // by _applyIncomingMessage), bailing out as soon as we step outside the
    // 30s dedup window so the lookup stays O(k) instead of O(n) on long chats.
    final existing = state.messagesByChat[chatId] ?? const <ChatMessage>[];
    bool hasOptimisticEcho = false;
    final trimmedBody = body.trim();
    for (final m in existing) {
      if ((m.timestamp - ts).abs() >= 30000) break;
      if (m.direction != MessageDirection.outgoing) continue;
      if (m.messageId == msg.messageId || m.body.trim() == trimmedBody) {
        hasOptimisticEcho = true;
        break;
      }
    }
    final isFromMe =
        (me != null && senderLower == me) || hasOptimisticEcho;
    final direction =
        isFromMe ? MessageDirection.outgoing : MessageDirection.incoming;

    return ChatMessage(
      id: msg.messageId!,
      messageId: msg.messageId!,
      chatId: chatId,
      sender: msg.sender!,
      senderDisplayName: msg.groupSenderName ?? getDisplayName(msg.sender!),
      body: body,
      imageUrl: msg.imageUrl,
      fileUrl: msg.fileUrl,
      direction: direction,
      timestamp: ts,
      deliveryStatus:
          isFromMe ? DeliveryStatus.sent : DeliveryStatus.delivered,
      groupId: msg.groupId,
      groupName: msg.groupName,
      groupType: msg.groupType == 'community' ? GroupType.community : GroupType.group,
      replyTo: msg.replyToMessageId != null
          ? MessageReference(
              messageId: msg.replyToMessageId!,
              sender: msg.replyToSender ?? '',
              senderDisplayName: msg.replyToSenderName,
              body: msg.replyToBody,
              imageUrl: msg.replyToImageUrl,
            )
          : null,
      forwarded: msg.forwarded ?? false,
      forwardedFrom: msg.forwardedFrom,
      forwardedFromName: msg.forwardedFromName,
    );
  }

  void _handleTypingIndicator(IncomingServerMessage msg) {
    // TODO: Implement typing indicator handling
  }

  void _handleReadReceipt(IncomingServerMessage msg) {
    if (msg.messageIds == null || msg.messageIds!.isEmpty) return;

    final newMessagesByChat = <String, List<ChatMessage>>{};

    for (final entry in state.messagesByChat.entries) {
      final chatMessages = entry.value.map((m) {
        if (msg.messageIds!.contains(m.messageId)) {
          return m.copyWith(deliveryStatus: DeliveryStatus.read);
        }
        return m;
      }).toList();
      newMessagesByChat[entry.key] = chatMessages;
    }

    state = state.copyWith(messagesByChat: newMessagesByChat);
  }

  void _handleReaction(IncomingServerMessage msg) {
    if (msg.targetMessageId == null) return;

    final targetId = msg.targetMessageId!;
    final emoji = msg.emoji;
    final reactor = msg.reactor ?? '';
    final reactorName = msg.reactorName;

    final newMessagesByChat = <String, List<ChatMessage>>{};

    for (final entry in state.messagesByChat.entries) {
      final chatMessages = entry.value.map((m) {
        if (m.messageId == targetId) {
          final reactions = List<MessageReaction>.from(m.reactions ?? []);

          // Remove existing reaction from same reactor
          reactions.removeWhere((r) => r.reactor == reactor);

          // Add new reaction if emoji is present
          if (emoji != null && emoji.isNotEmpty) {
            reactions.add(MessageReaction(
              emoji: emoji,
              reactor: reactor,
              reactorName: reactorName,
            ));
          }

          return m.copyWith(reactions: reactions);
        }
        return m;
      }).toList();
      newMessagesByChat[entry.key] = chatMessages;
    }

    state = state.copyWith(messagesByChat: newMessagesByChat);
  }

  void _handleEdit(IncomingServerMessage msg) {
    // Server sends `messageId` for the target on both socket/SSE and push.
    // Fall back to msg.messageId when targetMessageId is absent.
    final targetId = msg.targetMessageId ?? msg.messageId;
    if (targetId == null) return;

    final newBody = msg.body;
    final editedAt = msg.editedAt;

    if (newBody == null || editedAt == null) return;

    final newMessagesByChat = <String, List<ChatMessage>>{};

    for (final entry in state.messagesByChat.entries) {
      final chatMessages = entry.value.map((m) {
        if (m.messageId == targetId) {
          return m.copyWith(body: newBody, editedAt: editedAt);
        }
        return m;
      }).toList();
      newMessagesByChat[entry.key] = chatMessages;
    }

    state = state.copyWith(messagesByChat: newMessagesByChat);
  }

  void _handleDelete(IncomingServerMessage msg) {
    // Server sends `messageId` for the target on both socket/SSE and push.
    // Fall back to msg.messageId when targetMessageId is absent.
    final targetId = msg.targetMessageId ?? msg.messageId;
    if (targetId == null) return;

    final deletedAt = msg.deletedAt ?? DateTime.now().millisecondsSinceEpoch;

    final newMessagesByChat = <String, List<ChatMessage>>{};

    for (final entry in state.messagesByChat.entries) {
      final chatMessages = entry.value.map((m) {
        if (m.messageId == targetId) {
          return m.copyWith(deletedAt: deletedAt);
        }
        return m;
      }).toList();
      newMessagesByChat[entry.key] = chatMessages;
    }

    state = state.copyWith(messagesByChat: newMessagesByChat);
  }

  void _handleGroupUpdate(IncomingServerMessage msg) {
    if (msg.groupId == null) return;

    final group = ChatGroup.fromJson({
      'id': msg.groupId,
      'name': msg.groupName,
      'members': msg.groupMembers,
      'admins': msg.groupAdmins,
      'createdBy': msg.groupCreatedBy,
      'updatedAt': msg.groupUpdatedAt,
      'type': msg.groupType,
    });

    final newGroups = Map<String, ChatGroup>.from(state.groups);
    newGroups[group.id] = group;
    state = state.copyWith(groups: newGroups);

    _db.upsertGroup(group);
  }

  void _handleConnectionChange(bool connected) {
    if (connected) {
      // Recover missed messages when reconnecting
      recoverMissedMessages(force: true);
    }
  }

  void _handlePollTick() {
    // Pull messages on poll tick (fallback when socket/SSE unavailable)
    pullMessages();
  }

  // ---------------------------------------------------------------------------
  // Persistence
  // ---------------------------------------------------------------------------

  void _schedulePersistence() {
    _persistTimer?.cancel();
    _persistTimer = Timer(const Duration(seconds: 2), _persistState);
  }

  Future<void> _persistState() async {
    final allMessages = <ChatMessage>[];
    for (final messages in state.messagesByChat.values) {
      allMessages.addAll(messages);
    }

    await _db.persistState(PersistedChatState(
      contacts: state.contacts.values.toList(),
      groups: state.groups.values.toList(),
      unreadByChat: state.unreadByChat,
      messages: allMessages,
    ));
  }

  /// Force immediate persistence
  Future<void> persistNow() async {
    _persistTimer?.cancel();
    await _persistState();
  }

  /// Clear all local data
  Future<void> clearAll() async {
    await _db.clearAll();
    state = const ChatState();
  }
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

final chatStoreProvider = NotifierProvider<ChatStoreNotifier, ChatState>(() {
  return ChatStoreNotifier();
});

// ---------------------------------------------------------------------------
// Convenience Providers
// ---------------------------------------------------------------------------

/// Provider for chat list items
final chatListItemsProvider = Provider<List<ChatListItem>>((ref) {
  return ref.watch(chatStoreProvider).chatListItems;
});

/// Provider for messages in current chat
final currentChatMessagesProvider = Provider<List<ChatMessage>>((ref) {
  final state = ref.watch(chatStoreProvider);
  if (state.currentChatId == null) return [];
  return state.messagesByChat[state.currentChatId!] ?? [];
});

/// Provider for current chat contact/group info
final currentChatInfoProvider = Provider<({String title, String? subtitle, bool isGroup})?>((ref) {
  final state = ref.watch(chatStoreProvider);
  if (state.currentChatId == null) return null;

  final chatId = state.currentChatId!;
  final group = state.groups[chatId];
  
  if (group != null) {
    return (
      title: group.name,
      subtitle: '${group.members.length} חברים',
      isGroup: true,
    );
  }

  final contact = state.contacts[chatId];
  return (
    title: contact?.displayName ?? chatId,
    subtitle: contact?.info,
    isGroup: false,
  );
});
