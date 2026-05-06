/// Chat Store Service - central state management for chat data.
///
/// This is the Flutter equivalent of Angular's ChatStoreService.
/// Manages contacts, groups, messages, and real-time synchronization.
library;

import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../api/chat_api_service.dart';
import '../database/chat_database.dart' hide Contact;
import '../database/web_storage.dart';
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

/// Page size for the paginated full-sync logs pull — mirrors Angular's
/// `pageSize = 500` inside `recoverMissedMessagesFromLogs`.
const int _kFullSyncPageSize = 500;

/// Maximum messages fetched during a full sync — mirrors Angular's
/// `LOGS_RECOVERY_FULL_SYNC_FETCH_LIMIT = 200000`.
const int _kFullSyncMaxMessages = 200000;

/// Maximum number of characters before the colon that are considered a
/// group-sender prefix in the "SenderName: body" pattern stored by the server.
/// Mirrors the 80-character cap in Angular's `normalizeLogsMessagesForImport`.
const int _kGroupSenderPrefixMaxLength = 80;

/// SharedPreferences key for the "pending chat updates" tray.
///
/// Written by [firebaseMessagingBackgroundHandler] (in
/// push_notification_service.dart) each time a notification arrives while
/// the app is not in the foreground. Read and cleared by
/// [ChatStoreNotifier.initialize] on the next app launch so that unread
/// badges are immediately available — even before the network recovery
/// pull completes — and so any messages missed by the pull are still counted.
const String kPendingChatUpdatesKey = 'tzmc_pending_chat_updates_v1';

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

  /// Map of chatId → set of usernames currently typing in that chat.
  final Map<String, Set<String>> typingByChatId;

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
    this.typingByChatId = const <String, Set<String>>{},
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
    Map<String, Set<String>>? typingByChatId,
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
      typingByChatId: typingByChatId ?? this.typingByChatId,
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

  /// Per-chat timers that clear a typing indicator after an idle period.
  final Map<String, Map<String, Timer>> _typingClearTimers = {};

  /// How long after the last typing event to clear the indicator.
  static const Duration _typingClearDelay = Duration(seconds: 5);

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
      for (final timers in _typingClearTimers.values) {
        for (final t in timers.values) {
          t.cancel();
        }
      }
      _typingClearTimers.clear();
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
    final normalized = currentUser.trim().toLowerCase();

    // -----------------------------------------------------------------------
    // USER-CHANGE GUARD
    // If a different user is logging in while the store still holds data from
    // a previous session, wipe everything (in-memory state + persisted DB)
    // before proceeding.  Without this guard the new user would see the old
    // user's contacts and messages until the first server pull completes.
    // -----------------------------------------------------------------------
    if (_currentUser != null && _currentUser!.toLowerCase() != normalized) {
      // Null out _currentUser before clearAll() so any callbacks that fire
      // during the DB wipe don't accidentally act on the stale username.
      _currentUser = null;
      await clearAll(); // resets state (isInitialized → false) and wipes DB
      _lastGapAnalysisTime = 0;
    }

    // Always keep _currentUser up-to-date so own-message echoes are tagged
    // as outgoing (avoids the "see my message twice" bug).
    _currentUser = normalized;

    if (state.isInitialized) return;

    state = state.copyWith(isLoading: true);

    try {
      // 1. Restore from local database (best-effort).
      //
      // On Flutter web the legacy sql.js engine may not initialise correctly
      // (e.g. missing sqlite3.wasm / drift_worker files), causing
      // getPersistedState() to throw.  Catching the error here means the rest
      // of initialise() – most importantly the server-side gap-analysis pull –
      // still runs, so the user sees their chat history without having to
      // manually press "sync".
      //
      // NOTE: unreadByChat is intentionally NOT restored from the persisted
      // snapshot — stale counts from a previous session would mislead the user
      // if they've since read those messages on another device.  The correct
      // unread counts are accumulated fresh by recoverMissedMessages() below
      // and supplemented by the background-notification tray (step 4).
      try {
        final persisted = await _db.getPersistedState();
        state = state.copyWith(
          contacts: Map.fromEntries(persisted.contacts.map((c) => MapEntry(c.username, c))),
          groups: Map.fromEntries(persisted.groups.map((g) => MapEntry(g.id, g))),
          messagesByChat: _groupMessagesByChat(persisted.messages),
          unreadByChat: const {},
        );
      } catch (dbError) {
        debugPrint('[ChatStore] DB restore failed, trying web storage fallback: $dbError');
        // Drift DB is unavailable (e.g. web without sqlite3.wasm).
        // Try restoring from the shared_preferences-based localStorage snapshot.
        if (kIsWeb) {
          try {
            final webPersisted = await WebChatStorage.getPersistedState();
            if (webPersisted != null) {
              state = state.copyWith(
                contacts: Map.fromEntries(webPersisted.contacts.map((c) => MapEntry(c.username, c))),
                groups: Map.fromEntries(webPersisted.groups.map((g) => MapEntry(g.id, g))),
                messagesByChat: _groupMessagesByChat(webPersisted.messages),
                unreadByChat: const {},
              );
              debugPrint('[ChatStore] Restored state from web storage (${webPersisted.messages.length} messages)');
            }
          } catch (webError) {
            debugPrint('[ChatStore] Web storage restore also failed: $webError');
          }
        }
        // State may be empty; the server pull below re-populates it.
      }

      // 2. Pull fresh contacts and groups
      await Future.wait([
        _pullContacts(),
        _pullGroups(),
      ]);

      // 3. Pull missed messages (gap analysis).
      //
      // Use force:true to bypass the 30-second cooldown.  The realtime
      // transport can fire _handleConnectionChange(true) before we reach
      // this point, which advances _lastGapAnalysisTime.  Without force the
      // cooldown would silently skip the initial pull and leave the chat list
      // empty until the next poll tick (≥15 s).
      //
      // This accurately re-counts unread messages by calling
      // _handleIncomingTextMessage for every new incoming message, starting
      // from the empty unreadByChat set above.
      await recoverMissedMessages(force: true);

      // 4. Merge the background-notification pending tray (safety net).
      //
      // When notifications arrive while the app is terminated, the
      // firebaseMessagingBackgroundHandler saves each chat's pending unread
      // count to SharedPreferences.  Read that tray now and use it to fill
      // in any chats that the recovery pull may have missed (e.g. server
      // lag, network error, message not yet persisted when the logs endpoint
      // was queried).  We take the MAX so we never downgrade a count that
      // the pull already computed correctly.
      final tray = await _readAndClearPendingTray();
      if (tray.isNotEmpty) {
        final merged = Map<String, int>.from(state.unreadByChat);
        for (final entry in tray.entries) {
          final existing = merged[entry.key] ?? 0;
          if (entry.value > existing) {
            merged[entry.key] = entry.value;
          }
        }
        state = state.copyWith(unreadByChat: merged);
      }

      // 5. Persist the fully-initialized state immediately so that if the user
      // closes the app right after the first open (before the 2-second deferred
      // timer fires), the recovered messages are already in the DB and the chat
      // list is populated on the very next cold start without needing another
      // server round-trip.
      await persistNow();

      // Mark initialization complete, keeping the freshly-accumulated unread
      // counts (from recoverMissedMessages + tray) intact.
      state = state.copyWith(
        isLoading: false,
        isInitialized: true,
      );

      // 6. Schedule periodic persistence for subsequent state changes
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

  /// Whether the current user is an admin of [groupId].
  bool isGroupAdmin(String groupId) {
    final me = _currentUser;
    if (me == null || me.isEmpty) return false;
    final group = state.groups[groupId];
    if (group == null) return false;
    final admins = (group.admins ?? const <String>[])
        .map((a) => a.trim().toLowerCase())
        .where((a) => a.isNotEmpty)
        .toList();
    return admins.contains(me) || group.createdBy.trim().toLowerCase() == me;
  }

  /// Rename a group. Only admins may rename. Notifies all members.
  Future<void> renameGroup(String groupId, String newName) async {
    final user = _currentUser;
    if (user == null || user.isEmpty) return;
    final group = state.groups[groupId];
    if (group == null) return;
    final trimmedName = newName.trim();
    if (trimmedName.isEmpty || trimmedName == group.name) return;

    final updatedAt = DateTime.now().millisecondsSinceEpoch;
    final updated = ChatGroup(
      id: group.id,
      name: trimmedName,
      members: group.members,
      admins: group.admins,
      createdBy: group.createdBy,
      updatedAt: updatedAt,
      type: group.type,
    );

    final newGroups = Map<String, ChatGroup>.from(state.groups);
    newGroups[groupId] = updated;
    state = state.copyWith(groups: newGroups);
    await _db.upsertGroup(updated);
    _schedulePersistence();

    final membersToNotify = group.members.where((m) => m != user).toList();
    try {
      await _api.sendGroupUpdate(GroupUpdatePayload(
        groupId: updated.id,
        groupName: updated.name,
        groupMembers: updated.members,
        groupCreatedBy: updated.createdBy,
        groupAdmins: updated.admins,
        actorUser: user,
        groupUpdatedAt: updatedAt,
        groupType: updated.type,
        membersToNotify: membersToNotify,
      ));
    } catch (_) {}
  }

  /// Add new members to a group. Only admins may add. Notifies all members.
  Future<void> addGroupMembers(String groupId, List<String> newMembers) async {
    final user = _currentUser;
    if (user == null || user.isEmpty) return;
    final group = state.groups[groupId];
    if (group == null) return;

    final toAdd = newMembers
        .map((m) => m.trim().toLowerCase())
        .where((m) => m.isNotEmpty && !group.members.contains(m))
        .toList();
    if (toAdd.isEmpty) return;

    final updatedAt = DateTime.now().millisecondsSinceEpoch;
    final updatedMembers = [...group.members, ...toAdd];
    final updated = ChatGroup(
      id: group.id,
      name: group.name,
      members: updatedMembers,
      admins: group.admins,
      createdBy: group.createdBy,
      updatedAt: updatedAt,
      type: group.type,
    );

    final newGroups = Map<String, ChatGroup>.from(state.groups);
    newGroups[groupId] = updated;
    state = state.copyWith(groups: newGroups);
    await _db.upsertGroup(updated);
    _schedulePersistence();

    final membersToNotify = updatedMembers.where((m) => m != user).toList();
    try {
      await _api.sendGroupUpdate(GroupUpdatePayload(
        groupId: updated.id,
        groupName: updated.name,
        groupMembers: updated.members,
        groupCreatedBy: updated.createdBy,
        groupAdmins: updated.admins,
        actorUser: user,
        groupUpdatedAt: updatedAt,
        groupType: updated.type,
        membersToNotify: membersToNotify,
      ));
    } catch (_) {}
  }

  /// Remove a member from a group. Only admins may remove others.
  /// Members may remove themselves (leave).
  Future<void> removeGroupMember(String groupId, String member) async {
    final user = _currentUser;
    if (user == null || user.isEmpty) return;
    final group = state.groups[groupId];
    if (group == null) return;

    final normalizedMember = member.trim().toLowerCase();
    if (!group.members.contains(normalizedMember)) return;

    final updatedAt = DateTime.now().millisecondsSinceEpoch;
    final updatedMembers =
        group.members.where((m) => m != normalizedMember).toList();
    final updatedAdmins =
        group.admins?.where((a) => a != normalizedMember).toList();

    final updated = ChatGroup(
      id: group.id,
      name: group.name,
      members: updatedMembers,
      admins: updatedAdmins,
      createdBy: group.createdBy,
      updatedAt: updatedAt,
      type: group.type,
    );

    final newGroups = Map<String, ChatGroup>.from(state.groups);
    newGroups[groupId] = updated;
    state = state.copyWith(groups: newGroups);
    await _db.upsertGroup(updated);
    _schedulePersistence();

    // Notify remaining members and also the removed member so their client
    // can drop the group from their list.
    final membersToNotify = [
      ...updatedMembers,
      normalizedMember,
    ].where((m) => m != user).toList();
    try {
      await _api.sendGroupUpdate(GroupUpdatePayload(
        groupId: updated.id,
        groupName: updated.name,
        groupMembers: updated.members,
        groupCreatedBy: updated.createdBy,
        groupAdmins: updated.admins,
        actorUser: user,
        groupUpdatedAt: updatedAt,
        groupType: updated.type,
        membersToNotify: membersToNotify,
      ));
    } catch (_) {}
  }

  /// Leave a group (current user removes themselves and drops the group locally).
  Future<void> leaveGroup(String groupId) async {
    final user = _currentUser;
    if (user == null || user.isEmpty) return;
    await removeGroupMember(groupId, user);
    // After removeGroupMember the group still exists in state (without this
    // user). Fully remove it so it no longer appears in the user's list.
    final newGroups = Map<String, ChatGroup>.from(state.groups);
    newGroups.remove(groupId);
    state = state.copyWith(groups: newGroups);
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
    final user = _currentUser;
    if (user == null || user.isEmpty) return;

    try {
      int latestTimestamp;
      if (since != null) {
        latestTimestamp = since;
      } else {
        try {
          latestTimestamp = await _db.getLatestMessageTimestamp();
        } catch (_) {
          // DB unavailable on web; use in-memory state.
          latestTimestamp = _latestTimestampFromState();
        }
      }
      final messages = await _api.getMessagesFromLogs(
        user: user,
        since: latestTimestamp,
      );

      if (messages.isEmpty) return;

      // Route each message through the same handler used by realtime transport
      // so that action payloads (read-receipt, delete-action, etc.) are handled
      // correctly and regular messages are applied to the chat store.
      for (final message in messages) {
        _handleServerMessage(message);
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
      int latestTimestamp;
      try {
        latestTimestamp = await _db.getLatestMessageTimestamp();
      } catch (_) {
        // DB unavailable (web without WASM files); derive the latest known
        // timestamp from the in-memory state so we still pull missed messages.
        latestTimestamp = _latestTimestampFromState();
      }

      if (latestTimestamp == 0) {
        // No local history (first install or DB cleared): use the batch-import
        // path so that all historical messages are loaded without incrementing
        // unread counters. Treating the entire history as "unread" on first open
        // would produce thousands of spurious badge counts that confuse users.
        // On the next open the DB will have messages and the incremental path
        // below is used — only genuinely new messages are counted as unread.
        final user = _currentUser;
        if (user != null && user.isNotEmpty) {
          await _pullAllMessagesFromLogs(user: user, since: latestTimestamp);
        }
      } else {
        // Incremental update: use the normal per-message handler so that new
        // messages increment unread counts for the user.
        await pullMessages(since: latestTimestamp);
      }
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
      // 1. Wipe the local Drift database (best-effort; may fail on Flutter web
      //    where the Drift SQLite WASM runtime requires sqlite3.wasm / drift_worker.js
      //    in the web/ folder. If missing, the batch-delete throws a non-Exception
      //    Dart Error. We catch it and continue – the in-memory state is cleared
      //    below and the server pull re-populates everything fresh.)
      try {
        await _db.clearAll();
      } catch (_) {
        // DB clear failed (e.g. sqlite3.wasm not available on web).
        // The in-memory state is still cleared in the copyWith below.
      }
      state = state.copyWith(
        messagesByChat: const {},
        unreadByChat: const {},
        groups: const {},
        syncProgressPercent: 10,
        syncProgressLabel: 'טוען אנשי קשר...',
      );

      // 2. Re-pull contacts.
      await _pullContacts();
      state = state.copyWith(
        syncProgressPercent: 20,
        syncProgressLabel: 'טוען קבוצות...',
      );

      // 3. Re-pull groups (community/runtime list).
      await _pullGroups();
      state = state.copyWith(
        syncProgressPercent: 30,
        syncProgressLabel: 'טוען נתוני קבוצות מהשרת...',
      );

      // 4. Load groups persisted in the server DB and merge them — mirrors
      //    Angular's `loadUserChatGroupsFromDb()` which prefers the server
      //    record when its `updatedAt` is newer than the local one.
      await _mergeUserChatGroups();
      state = state.copyWith(
        syncProgressPercent: 40,
        syncProgressLabel: 'מרענן נתונים...',
      );

      // 5. Drain the /messages poll queue — mirrors Angular's `pullMessages(user)`
      //    call inside forceSyncAllMessagesAndClearCache (which uses `pollMessages()`
      //    on the /messages endpoint rather than the logs endpoint).
      try {
        final polled = await _api.pollMessages();
        for (final msg in polled) {
          _handleServerMessage(msg);
        }
      } catch (_) {
        // Polling failures are non-fatal; the logs pull below covers any gaps.
      }
      state = state.copyWith(
        syncProgressPercent: 55,
        syncProgressLabel: 'מושך הודעות...',
      );

      // 6. Paginated logs pull — mirrors Angular's `recoverMissedMessagesFromLogs`
      //    with `limit: LOGS_RECOVERY_FULL_SYNC_FETCH_LIMIT (200000)` and page
      //    size 500.  Using since:0 so the full history is fetched after the
      //    cache clear (the old DB high-water timestamp is gone).
      await _pullAllMessagesFromLogs(user: user, since: 0);
      state = state.copyWith(
        syncProgressPercent: 85,
        syncProgressLabel: 'מסיים...',
      );

      // 7. Reset unread counters — mirrors Angular's `this.unreadByChat.set({})`.
      state = state.copyWith(unreadByChat: const {});

      // 8. Persist to disk immediately (do not defer via _schedulePersistence so
      //    that data survives an app close that happens right after the sync).
      await persistNow();
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

  /// Paginated logs pull used during full sync — mirrors Angular's
  /// `recoverMissedMessagesFromLogs` with `limit: LOGS_RECOVERY_FULL_SYNC_FETCH_LIMIT`.
  ///
  /// Pages through the `/messages/logs` endpoint in batches of
  /// [_kFullSyncPageSize] (500) until there are no more results or
  /// [_kFullSyncMaxMessages] (200 000) have been fetched.
  ///
  /// All pages are collected first, then:
  ///   1. System/sentinel messages are filtered out.
  ///   2. Group messages are normalised (sender-prefix stripped from body).
  ///   3. Missing groups are synthesised from the message metadata.
  ///   4. Action messages (delete, edit, reaction, …) are applied one-by-one
  ///      through the normal handler.
  ///   5. Regular text messages are applied in a single batch without
  ///      incrementing unread counters.
  ///
  /// This avoids O(n) state rebuilds for large histories (up to 200 000 msgs).
  Future<void> _pullAllMessagesFromLogs({
    required String user,
    int since = 0,
  }) async {
    // ── 1. Fetch all pages ──────────────────────────────────────────────────
    int offset = 0;
    int totalFetched = 0;
    final allRaw = <IncomingServerMessage>[];

    while (totalFetched < _kFullSyncMaxMessages) {
      final remaining = _kFullSyncMaxMessages - totalFetched;
      if (remaining <= 0) break;
      final limit = remaining.clamp(1, _kFullSyncPageSize);

      List<IncomingServerMessage> page;
      try {
        page = await _api.getMessagesFromLogs(
          user: user,
          limit: limit,
          offset: offset,
          since: since,
        );
      } catch (_) {
        break; // Network error — stop paging; keep what we already have.
      }

      if (page.isEmpty) break;

      allRaw.addAll(page);
      offset += page.length;
      totalFetched += page.length;

      // Server returned fewer items than the page size → end of results.
      if (page.length < limit) break;
    }

    if (allRaw.isEmpty) return;

    // ── 2. Filter system/sentinel messages ──────────────────────────────────
    // Mirrors Angular's `shouldSkipLogsMessage`:
    //   • keep action types (delete-action, edit-action, reaction, read-receipt,
    //     group-update) so deletions and edits are reflected in the history.
    //   • drop messages with no sender or sender == "system".
    //   • drop sentinel bodies "new notification" / "new reaction".
    const actionTypes = {
      'read',
      'read-receipt',
      'delete',
      'delete-action',
      'edit',
      'edit-action',
      'reaction',
      'group-update',
    };
    final filtered = allRaw.where((msg) {
      final type = (msg.type ?? '').trim().toLowerCase();
      if (actionTypes.contains(type)) return true; // always keep actions
      final sender = (msg.sender ?? '').trim().toLowerCase();
      if (sender.isEmpty || sender == 'system') return false;
      final body = (msg.body ?? '').trim().toLowerCase();
      if (body == 'new notification' || body == 'new reaction') return false;
      return true;
    }).toList();

    if (filtered.isEmpty) return;

    // ── 3. Normalise group messages ─────────────────────────────────────────
    // Mirrors Angular's `normalizeLogsMessagesForImport`:
    //   • resolve groupId when sender holds a known group ID.
    //   • strip the "SenderName: body" prefix that the server writes to the
    //     body column for group messages, and promote the prefix to
    //     groupSenderName.
    final normalized = filtered.map(_normalizeLogMessageForImport).toList();

    // ── 4. Synthesise missing groups ────────────────────────────────────────
    // Mirrors Angular's `ensureGroupsFromImportedLogs`.
    _ensureGroupsFromImportedLogs(normalized);

    // ── 5. Apply messages ───────────────────────────────────────────────────
    // Action messages are dispatched through the regular handler (small count).
    // Text messages are applied in a single batch state update — no unread
    // increment (mirrors Angular's `applyIncomingMessagesBatch` with
    // `incrementUnread: false`).
    final textMessages = <ChatMessage>[];

    for (final msg in normalized) {
      final type = (msg.type ?? '').trim().toLowerCase();
      if (actionTypes.contains(type)) {
        _handleServerMessage(msg); // delete / edit / reaction / group-update
      } else {
        final chatMsg = _buildChatMessageFromServer(msg);
        if (chatMsg != null) textMessages.add(chatMsg);
      }
    }

    _applyMessagesBatch(textMessages);
  }

  // ---------------------------------------------------------------------------
  // Full-sync helpers (mirrors Angular normalizeLogsMessagesForImport,
  //   ensureGroupsFromImportedLogs, applyRegularIncomingMessagesBulk)
  // ---------------------------------------------------------------------------

  /// Normalise a single logs message for batch import.
  ///
  /// • Resolves [IncomingServerMessage.groupId] from the sender field when
  ///   the sender ID matches a known group (mirrors Angular's group:// check).
  /// • Strips the "SenderName: body" prefix embedded in group message bodies
  ///   by the server and promotes it to [IncomingServerMessage.groupSenderName].
  /// • Preserves the resolved group name from local state when the server
  ///   record only stores the group ID as its name.
  IncomingServerMessage _normalizeLogMessageForImport(IncomingServerMessage msg) {
    final rawGroupId = (msg.groupId ?? '').trim();
    final rawSender  = (msg.sender  ?? '').trim();

    // Resolve groupId from sender when sender looks like a group.
    String resolvedGroupId = rawGroupId.toLowerCase();
    if (resolvedGroupId.isEmpty && rawSender.isNotEmpty) {
      final senderNorm = rawSender.toLowerCase();
      if (senderNorm.startsWith('group:') ||
          state.groups.containsKey(senderNorm)) {
        resolvedGroupId = senderNorm;
      }
    }

    if (resolvedGroupId.isEmpty) {
      // Not a group message — still strip an explicit sender-prefix if present.
      final gsn = (msg.groupSenderName ?? '').trim();
      if (gsn.isNotEmpty && msg.body != null) {
        final strippedBody = _stripGroupSenderPrefixFromBody(msg.body!, gsn);
        if (strippedBody != msg.body) {
          return _copyMsgWith(msg, body: strippedBody);
        }
      }
      return msg;
    }

    final existingGroup  = state.groups[resolvedGroupId];
    final rawGroupName   = (msg.groupName ?? '').trim();
    final rawBody        = (msg.body      ?? '').trim();

    // Determine the best group name.
    final String resolvedGroupName;
    if (rawGroupName.isNotEmpty &&
        rawGroupName.toLowerCase() != resolvedGroupId) {
      // The record carries a real human-readable name.
      resolvedGroupName = rawGroupName;
    } else if (existingGroup != null && existingGroup.name.isNotEmpty) {
      // Fall back to the locally-cached name.
      resolvedGroupName = existingGroup.name;
    } else {
      // Last resort: use the raw group-name field if present, else the ID.
      resolvedGroupName = rawGroupName.isNotEmpty ? rawGroupName : resolvedGroupId;
    }

    // Extract "SenderName: message" prefix from body when groupSenderName is absent.
    String groupSenderName = (msg.groupSenderName ?? '').trim();
    String body = rawBody;

    if (groupSenderName.isEmpty && rawBody.isNotEmpty) {
      // Guard against bodies that are URLs (e.g. "https://example.com"):
      // the colon in the scheme would be incorrectly extracted as a sender.
      final isUrl = rawBody.startsWith('http://') ||
          rawBody.startsWith('https://');
      if (!isUrl) {
        final colonIdx = rawBody.indexOf(':');
        if (colonIdx > 0 && colonIdx <= _kGroupSenderPrefixMaxLength) {
          final potentialSender = rawBody.substring(0, colonIdx).trim();
          final potentialBody   = rawBody.substring(colonIdx + 1).trim();
          if (potentialSender.length <= _kGroupSenderPrefixMaxLength &&
              !potentialSender.contains('\n') &&
              potentialBody.isNotEmpty) {
            groupSenderName = potentialSender;
            body = potentialBody;
          }
        }
      }
    } else if (groupSenderName.isNotEmpty && rawBody.isNotEmpty) {
      body = _stripGroupSenderPrefixFromBody(rawBody, groupSenderName);
    }

    return _copyMsgWith(
      msg,
      groupId:        resolvedGroupId,
      groupName:      resolvedGroupName,
      groupSenderName: groupSenderName.isNotEmpty ? groupSenderName : msg.groupSenderName,
      body:           body.isNotEmpty ? body : rawBody,
      groupType:      msg.groupType ?? existingGroup?.type.name,
    );
  }

  /// Return a shallow copy of [msg] with optional field overrides.
  IncomingServerMessage _copyMsgWith(
    IncomingServerMessage msg, {
    String? groupId,
    String? groupName,
    String? groupSenderName,
    String? body,
    String? groupType,
  }) {
    return IncomingServerMessage(
      messageId:        msg.messageId,
      sender:           msg.sender,
      toUser:           msg.toUser,
      recipient:        msg.recipient,
      type:             msg.type,
      chatId:           msg.chatId,
      isTyping:         msg.isTyping,
      editedAt:         msg.editedAt,
      deletedAt:        msg.deletedAt,
      messageIds:       msg.messageIds,
      readAt:           msg.readAt,
      targetMessageId:  msg.targetMessageId,
      emoji:            msg.emoji,
      reactor:          msg.reactor,
      reactorName:      msg.reactorName,
      body:             body          ?? msg.body,
      timestamp:        msg.timestamp,
      imageUrl:         msg.imageUrl,
      fileUrl:          msg.fileUrl,
      groupId:          groupId       ?? msg.groupId,
      groupName:        groupName     ?? msg.groupName,
      groupMembers:     msg.groupMembers,
      groupCreatedBy:   msg.groupCreatedBy,
      groupAdmins:      msg.groupAdmins,
      groupUpdatedAt:   msg.groupUpdatedAt,
      groupType:        groupType     ?? msg.groupType,
      groupSenderName:  groupSenderName ?? msg.groupSenderName,
      replyToMessageId: msg.replyToMessageId,
      replyToSender:    msg.replyToSender,
      replyToSenderName: msg.replyToSenderName,
      replyToBody:      msg.replyToBody,
      replyToImageUrl:  msg.replyToImageUrl,
      forwarded:        msg.forwarded,
      forwardedFrom:    msg.forwardedFrom,
      forwardedFromName: msg.forwardedFromName,
      userReceivedTime: msg.userReceivedTime,
    );
  }

  /// Remove the leading "SenderName: " prefix from a group message body.
  String _stripGroupSenderPrefixFromBody(String body, String senderName) {
    if (senderName.isEmpty) return body;
    final prefix = '$senderName:';
    if (body.startsWith(prefix)) {
      return body.substring(prefix.length).trimLeft();
    }
    return body;
  }

  /// Synthesise [ChatGroup] entries for any group referenced in the import
  /// batch that is not already present in [state.groups].
  ///
  /// Mirrors Angular's `ensureGroupsFromImportedLogs`:
  ///   • Only creates a group when its name is a real human-readable string
  ///     (not just the group ID). This prevents "ghost" groups for unknown IDs.
  ///   • Does NOT overwrite an existing group entry.
  void _ensureGroupsFromImportedLogs(List<IncomingServerMessage> messages) {
    final groupsById = Map<String, ChatGroup>.from(state.groups);
    final me = _currentUser ?? '';
    bool changed = false;

    for (final msg in messages) {
      final groupId = (msg.groupId ?? '').trim().toLowerCase();
      if (groupId.isEmpty) continue;
      if (groupsById.containsKey(groupId)) continue;

      final groupName = (msg.groupName ?? '').trim();
      // Skip if the name is absent or identical to the ID (ghost group guard).
      if (groupName.isEmpty || groupName.toLowerCase() == groupId) continue;

      groupsById[groupId] = ChatGroup(
        id: groupId,
        name: groupName,
        members: me.isNotEmpty ? [me] : const [],
        createdBy: me.isNotEmpty ? me : 'system',
        updatedAt: DateTime.now().millisecondsSinceEpoch,
        type: msg.groupType == 'community' ? GroupType.community : GroupType.group,
      );
      changed = true;
    }

    if (changed) {
      state = state.copyWith(groups: groupsById);
    }
  }

  /// Apply a list of already-built [ChatMessage]s to the store in a single
  /// state update, without incrementing unread counters.
  ///
  /// Used by the full-sync batch import to avoid O(n) Riverpod state rebuilds.
  void _applyMessagesBatch(List<ChatMessage> messages) {
    if (messages.isEmpty) return;

    final newMessagesByChat =
        Map<String, List<ChatMessage>>.from(state.messagesByChat);

    for (final message in messages) {
      final chatId = message.chatId;
      final chatMessages =
          List<ChatMessage>.from(newMessagesByChat[chatId] ?? const <ChatMessage>[]);

      final existingIndex =
          chatMessages.indexWhere((m) => m.messageId == message.messageId);

      if (existingIndex >= 0) {
        chatMessages[existingIndex] =
            _hydrateExistingMessage(chatMessages[existingIndex], message);
      } else {
        chatMessages.add(message);
      }

      newMessagesByChat[chatId] = chatMessages;
    }

    // Sort each chat descending by timestamp and trim to the per-chat cap.
    for (final entry in newMessagesByChat.entries) {
      final msgs = entry.value;
      msgs.sort((a, b) => b.timestamp.compareTo(a.timestamp));
      if (msgs.length > maxMessagesPerChat) {
        newMessagesByChat[entry.key] = msgs.sublist(0, maxMessagesPerChat);
      }
    }

    state = state.copyWith(messagesByChat: newMessagesByChat);
  }

  /// Loads the groups that are persisted in the server DB and merges them into
  /// the local state — mirrors Angular's `loadUserChatGroupsFromDb()`.
  ///
  /// The server record wins when its `updatedAt` is ≥ the local copy's, but a
  /// real human-readable name is never replaced by a bare group-ID string
  /// (matching Angular's `isGroupNameLikeId` guard).
  Future<void> _mergeUserChatGroups() async {
    try {
      final dbGroups = await _api.getUserChatGroups();
      if (dbGroups.isEmpty) return;

      final groupsById = Map<String, ChatGroup>.from(state.groups);
      bool changed = false;

      for (final dbGroup in dbGroups) {
        final existing = groupsById[dbGroup.id];
        final dbUpdatedAt = dbGroup.updatedAt;
        final localUpdatedAt = existing?.updatedAt ?? 0;

        if (existing == null || dbUpdatedAt >= localUpdatedAt) {
          // Preserve a real cached name when the DB record only stores the
          // group ID as its name — mirrors Angular's `isGroupNameLikeId` guard.
          final dbNameLooksLikeId =
              dbGroup.name.trim().toLowerCase() == dbGroup.id.trim().toLowerCase();
          final localHasRealName = existing != null &&
              existing.name.trim().toLowerCase() != existing.id.trim().toLowerCase() &&
              existing.name.trim().isNotEmpty;

          if (localHasRealName && dbNameLooksLikeId) {
            groupsById[dbGroup.id] = ChatGroup(
              id: dbGroup.id,
              name: existing!.name,
              members: dbGroup.members,
              admins: dbGroup.admins,
              createdBy: dbGroup.createdBy,
              updatedAt: dbGroup.updatedAt,
              type: dbGroup.type,
            );
          } else {
            groupsById[dbGroup.id] = dbGroup;
          }
          changed = true;
        }
      }

      if (changed) {
        state = state.copyWith(groups: groupsById);
      }
    } catch (_) {
      // Non-fatal: groups will be reconstructed from messages.
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

      case 'reaction':
        {
          // Reaction pushes must update the emoji on the target message, not
          // create a new chat bubble. Route through the same handler used by
          // socket/SSE so the UI reflects the change silently.
          final targetId = _str(data['targetMessageId']) ?? _str(data['messageId']);
          if (targetId == null) return;
          final msg = IncomingServerMessage(
            type: type,
            targetMessageId: targetId,
            emoji: _str(data['emoji']),
            reactor: _str(data['reactor']) ?? _str(data['sender']),
            reactorName: _str(data['reactorName']),
            sender: _str(data['sender']),
          );
          _handleReaction(msg);
          return;
        }
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

    // For self-echo push notifications (skipNotification: true), the server
    // sends sender=currentUser and toUser=the other party. Using sender as
    // chatId would create a spurious "self-chat".
    //
    // Two scenarios handled:
    //  1. Normal: _currentUser is set → isSelfEcho detects sender==me, routes
    //     by toUser.
    //  2. Race condition on cold-start: _currentUser may be null when the push
    //     fires.  We can't confirm "isSelfEcho" via phone comparison, but the
    //     skipNotification flag alone tells us this is a self-echo → use toUser.
    //
    // In both cases we must NOT fall back to data['recipient'] — on some paths
    // that field equals me's phone and would produce a self-chat chatId.
    final meNorm = _currentUser?.trim().toLowerCase() ?? '';
    final senderNorm = sender.trim().toLowerCase();
    final isSelfEcho = meNorm.isNotEmpty && senderNorm == meNorm;
    String chatId;
    if (isGroup) {
      chatId = groupId;
    } else if (isSelfEcho || skipNotification) {
      // Use only toUser — never fall back to recipient for self-echo messages.
      final toUser = (_str(data['toUser']) ?? '').trim().toLowerCase();
      // Discard if there is no deterministic chat partner: this can happen with
      // old self-echo DB log entries where ToUser == sender (self-chat artifact).
      if (toUser.isEmpty || toUser == meNorm || toUser == senderNorm) return;
      chatId = toUser;
    } else {
      chatId = senderNorm;
    }

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

    // When the server rewrites sender to the groupId (server.js:2138) and no
    // groupSenderName was provided, getDisplayName would return the raw group
    // ID string (e.g. "group:grp_F...") because there is no contact for it.
    // Guard against that by only calling getDisplayName when sender is an
    // actual user identifier, not the group ID itself.
    final senderIsGroupId = isGroup &&
        sender.trim().toLowerCase() == (groupId ?? '').trim().toLowerCase();
    // groupSenderName from the server may be a raw phone number (e.g. when
    // sourced from MessageActivities.Sender).  Always run it through
    // getDisplayName so the bubble shows the contact name when available;
    // getDisplayName returns the input unchanged when no match is found.
    final rawGroupSenderName = _str(data['groupSenderName']) ?? '';
    final senderDisplayName = rawGroupSenderName.isNotEmpty
        ? getDisplayName(rawGroupSenderName)
        : (senderIsGroupId ? null : getDisplayName(sender));
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
      direction: (isSelfEcho || skipNotification) ? MessageDirection.outgoing : MessageDirection.incoming,
      timestamp: timestamp,
      deliveryStatus: (isSelfEcho || skipNotification) ? DeliveryStatus.sent : DeliveryStatus.delivered,
      groupId: groupId,
      groupName: _str(data['groupName']),
      groupType: groupType,
    );

    final isNew = _applyIncomingMessage(message);

    // Update unread count if not the currently open chat.
    // Skip for self-echo messages (sender's own devices) to avoid
    // incrementing the badge for messages the user just sent.
    // Also skip when the message was already known locally (isNew == false) to
    // prevent re-incrementing a badge the user has already cleared by reading.
    if (isNew && !skipNotification && chatId != state.currentChatId) {
      final newUnread = Map<String, int>.from(state.unreadByChat);
      newUnread[chatId] = (newUnread[chatId] ?? 0) + 1;
      state = state.copyWith(unreadByChat: newUnread);
    }

    _schedulePersistence();

    // Pull full message content shortly after, in case the push body was
    // truncated to fit the FCM payload size limit.
    if (!skipNotification) schedulePushRecoveryPulls();
  }

  /// Apply an incoming message to state.
  ///
  /// Returns `true` when the message was genuinely new (inserted for the first
  /// time), or `false` when it was a hydration of an already-known entry.
  ///
  /// Callers that increment the unread badge should only do so when this
  /// method returns `true` — returning `false` means the message was already
  /// present in the local state (e.g. a server-side duplicate returned by the
  /// logs endpoint near the `since` boundary) and the user may have already
  /// read it, so re-incrementing the badge would be incorrect.
  bool _applyIncomingMessage(ChatMessage message) {
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

    final isNew = existingIndex < 0;

    if (!isNew) {
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

    return isNew;
  }

  /// Hydrate existing message with new data (pick longer body)
  ChatMessage _hydrateExistingMessage(ChatMessage existing, ChatMessage incoming) {
    // Pick the more up-to-date body.
    // - If the existing message was already edited (editedAt != null), always
    //   keep the edited body. The poll returns the original text which is
    //   outdated — applying the longer-body heuristic here would revert an
    //   edit that made the text shorter (e.g. "Hello World" → "Hi").
    // - Otherwise fall back to the longer-body heuristic which guards against
    //   push truncation where the cached body is shorter than the full text.
    final String body;
    if (existing.editedAt != null) {
      body = existing.body;
    } else if (incoming.body.length > existing.body.length) {
      body = incoming.body;
    } else {
      body = existing.body;
    }

    return existing.copyWith(
      body: body,
      senderDisplayName: incoming.senderDisplayName ?? existing.senderDisplayName,
      editedAt: incoming.editedAt ?? existing.editedAt,
      deletedAt: incoming.deletedAt ?? existing.deletedAt,
      reactions: incoming.reactions ?? existing.reactions,
      // Never downgrade the delivery status: once a message is `read` or
      // `delivered`, a stale server echo (which always carries `sent`) must
      // not revert it back.
      deliveryStatus: _maxDeliveryStatus(existing.deliveryStatus, incoming.deliveryStatus),
      // Hydrate the reply reference from the incoming message when the
      // existing optimistic bubble was created without it (e.g. the optimistic
      // message is created locally with replyTo from state, but the server
      // echo carries the canonically stored reference fields).
      replyTo: existing.replyTo ?? incoming.replyTo,
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
    bool forwarded = false,
    String? forwardedFrom,
    String? forwardedFromName,
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
      forwarded: forwarded,
      forwardedFrom: forwardedFrom,
      forwardedFromName: forwardedFromName,
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
        replyToSender: replyTo?.sender,
        replyToSenderName: replyTo?.senderDisplayName,
        replyToBody: replyTo?.body,
        replyToImageUrl: replyTo?.imageUrl,
        forwarded: forwarded,
        forwardedFrom: forwardedFrom,
        forwardedFromName: forwardedFromName,
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
        replyToSender: replyTo?.sender,
        replyToSenderName: replyTo?.senderDisplayName,
        replyToBody: replyTo?.body,
        replyToImageUrl: replyTo?.imageUrl,
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

  /// Returns the higher-ranked of two [DeliveryStatus] values so that status
  /// transitions only ever advance (pending → sent → delivered → read) and
  /// never regress.
  static DeliveryStatus _maxDeliveryStatus(DeliveryStatus a, DeliveryStatus b) {
    const rank = {
      DeliveryStatus.pending: 0,
      DeliveryStatus.queued: 1,
      DeliveryStatus.sent: 2,
      DeliveryStatus.delivered: 3,
      DeliveryStatus.read: 4,
      DeliveryStatus.failed: -1,
    };
    // Keep `failed` unless the incoming status is a positive advancement.
    if (a == DeliveryStatus.failed) return b == DeliveryStatus.failed ? a : b;
    if (b == DeliveryStatus.failed) return a;
    return (rank[a] ?? 0) >= (rank[b] ?? 0) ? a : b;
  }

  String _generateMessageId() {
    return '${DateTime.now().millisecondsSinceEpoch}-${DateTime.now().microsecond}';
  }

  /// Find a message in the in-memory store by its [messageId] field.
  ChatMessage? _findMessageByMessageId(String messageId) {
    for (final msgs in state.messagesByChat.values) {
      for (final m in msgs) {
        if (m.messageId == messageId) return m;
      }
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // Reactions
  // ---------------------------------------------------------------------------

  Future<void> addReaction(String messageId, String emoji) async {
    final user = _currentUser ?? '';
    final msg = _findMessageByMessageId(messageId);
    final group = msg?.groupId != null ? state.groups[msg!.groupId] : null;
    // Apply optimistically so the sender sees the reaction immediately.
    _applyReactionToState(messageId, emoji, user, getDisplayName(user));
    await _api.addReaction(
      messageId,
      emoji,
      user,
      targetUser: group == null ? msg?.chatId : null,
      groupId: group?.id,
      groupName: group?.name,
      groupMembers: group?.members,
      groupCreatedBy: group?.createdBy,
      groupAdmins: group?.admins,
      groupUpdatedAt: group?.updatedAt,
      groupType: group?.type,
    );
  }

  Future<void> removeReaction(String messageId, String emoji) async {
    final user = _currentUser ?? '';
    final msg = _findMessageByMessageId(messageId);
    final group = msg?.groupId != null ? state.groups[msg!.groupId] : null;
    // Apply optimistically so the sender sees the removal immediately.
    _applyReactionToState(messageId, '', user, getDisplayName(user));
    await _api.removeReaction(
      messageId,
      emoji,
      user,
      targetUser: group == null ? msg?.chatId : null,
      groupId: group?.id,
      groupName: group?.name,
      groupMembers: group?.members,
      groupCreatedBy: group?.createdBy,
      groupAdmins: group?.admins,
      groupUpdatedAt: group?.updatedAt,
      groupType: group?.type,
    );
  }

  /// Updates the reactions on a single message in local state.
  /// Passing an empty [emoji] removes the reactor's existing reaction.
  /// This is called both optimistically (on the sender's device) and when
  /// the server broadcasts the reaction event to the other participant.
  void _applyReactionToState(
    String targetMessageId,
    String? emoji,
    String reactor,
    String? reactorName,
  ) {
    final newMessagesByChat = <String, List<ChatMessage>>{};
    for (final entry in state.messagesByChat.entries) {
      final chatMessages = entry.value.map((m) {
        if (m.messageId == targetMessageId) {
          final reactions = List<MessageReaction>.from(m.reactions ?? []);
          reactions.removeWhere((r) => r.reactor == reactor);
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

  // ---------------------------------------------------------------------------
  // Edit/Delete
  // ---------------------------------------------------------------------------

  Future<void> editMessage(String messageId, String newBody) async {
    final user = _currentUser ?? '';
    final msg = _findMessageByMessageId(messageId);
    final group = msg?.groupId != null ? state.groups[msg!.groupId] : null;
    final editedAt = DateTime.now().millisecondsSinceEpoch;
    // Apply optimistically so the sender sees the edit immediately.
    _applyEditToState(messageId, newBody, editedAt);
    await _api.editMessage(
      messageId,
      newBody,
      user,
      recipient: group == null ? msg?.chatId : null,
      groupId: group?.id,
      groupName: group?.name,
      groupMembers: group?.members,
      groupCreatedBy: group?.createdBy,
      groupAdmins: group?.admins,
      groupUpdatedAt: group?.updatedAt,
      groupType: group?.type,
    );
  }

  Future<void> deleteMessage(String messageId) async {
    final user = _currentUser ?? '';
    final msg = _findMessageByMessageId(messageId);
    final group = msg?.groupId != null ? state.groups[msg!.groupId] : null;
    final deletedAt = DateTime.now().millisecondsSinceEpoch;
    // Apply optimistically so the sender sees the deletion immediately.
    _applyDeleteToState(messageId, deletedAt);
    await _api.deleteMessage(
      messageId,
      user,
      recipient: group == null ? msg?.chatId : null,
      groupId: group?.id,
      groupName: group?.name,
      groupMembers: group?.members,
      groupCreatedBy: group?.createdBy,
      groupAdmins: group?.admins,
      groupUpdatedAt: group?.updatedAt,
      groupType: group?.type,
    );
  }

  void _applyEditToState(String targetMessageId, String newBody, int editedAt) {
    final newMessagesByChat = <String, List<ChatMessage>>{};
    for (final entry in state.messagesByChat.entries) {
      final chatMessages = entry.value.map((m) {
        if (m.messageId == targetMessageId) {
          return m.copyWith(body: newBody, editedAt: editedAt);
        }
        return m;
      }).toList();
      newMessagesByChat[entry.key] = chatMessages;
    }
    state = state.copyWith(messagesByChat: newMessagesByChat);
  }

  void _applyDeleteToState(String targetMessageId, int deletedAt) {
    final newMessagesByChat = <String, List<ChatMessage>>{};
    for (final entry in state.messagesByChat.entries) {
      final chatMessages = entry.value.map((m) {
        if (m.messageId == targetMessageId) {
          return m.copyWith(deletedAt: deletedAt);
        }
        return m;
      }).toList();
      newMessagesByChat[entry.key] = chatMessages;
    }
    state = state.copyWith(messagesByChat: newMessagesByChat);
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

    // Persist the cleared count immediately so it survives app restart /
    // full sync without requiring the full state snapshot.
    try {
      await _db.clearUnreadCount(chatId);
    } catch (_) {
      // Non-fatal – the in-memory count is already correct.
    }

    try {
      await _api.markMessagesAsRead(chatId, messageIds, _currentUser ?? '');
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
      final isNew = _applyIncomingMessage(chatMessage);

      // Only increment the unread badge when:
      //  • the message is for a chat the user is NOT currently viewing, AND
      //  • the message is incoming (not our own echo), AND
      //  • the message is genuinely new — not an already-known entry returned
      //    by the logs endpoint near the `since` boundary (the server
      //    intentionally returns 1-2 such duplicates to avoid missing rows;
      //    _applyIncomingMessage returns false for those so we never re-count
      //    a message the user has already read).
      if (isNew &&
          chatMessage.chatId != state.currentChatId &&
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
    final me = _currentUser;
    final senderNorm = msg.sender!.trim().toLowerCase();
    final isFromMe = me != null && senderNorm == me.trim().toLowerCase();

    // For 1:1 outgoing messages the server returns sender=currentUser and
    // toUser=the other party. Using sender as chatId would create a spurious
    // "self-chat". Mirror Angular's logic: when isFromMe, use toUser as chatId.
    //
    // IMPORTANT: do NOT fall back to msg.recipient here.  The logs endpoint
    // always sets recipient = requestedUser (= me), so using it as a fallback
    // when toUser is absent produces chatId = me = self-chat.
    String chatId;
    if (isGroup) {
      chatId = msg.groupId!;
    } else if (isFromMe) {
      final toUser = (msg.toUser ?? '').trim().toLowerCase();
      final mePhone = me?.trim().toLowerCase() ?? '';
      // If toUser is absent or equals the sender (a self-chat DB artifact from
      // old self-echo log entries where ToUser = sender), skip this message.
      if (toUser.isEmpty || (mePhone.isNotEmpty && toUser == mePhone)) return null;
      chatId = toUser;
    } else {
      chatId = senderNorm;
    }

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

    // Fallback for group messages fetched from the notification logs: the DB's
    // `From` column stores the group ID instead of the actual sender's phone
    // number (the server writes `senderForPush = isGroup ? groupId : user`).
    // When sender == groupId we can't use a direct phone comparison, so we
    // look at `groupSenderName` (extracted from the "SenderName: body" prefix
    // by the logs endpoint) and match it against _currentUser's phone or their
    // display name.
    bool isFromMeFallback = false;
    if (!isFromMe && isGroup) {
      final groupIdNorm = msg.groupId!.trim().toLowerCase();
      if (senderNorm == groupIdNorm) {
        final gsn = (msg.groupSenderName ?? '').trim().toLowerCase();
        final meNorm = (me ?? '').trim().toLowerCase();
        if (meNorm.isNotEmpty && gsn.isNotEmpty) {
          final myDisplayName = getDisplayName(meNorm).trim().toLowerCase();
          isFromMeFallback = gsn == meNorm || gsn == myDisplayName;
        }
      }
    }

    final isOutgoing = isFromMe || isFromMeFallback || hasOptimisticEcho;
    final direction =
        isOutgoing ? MessageDirection.outgoing : MessageDirection.incoming;

    return ChatMessage(
      id: msg.messageId!,
      messageId: msg.messageId!,
      chatId: chatId,
      sender: msg.sender!,
      // When the server stores the group ID as sender (server.js:2138) and
      // groupSenderName is absent, avoid showing the raw group ID string.
      // groupSenderName may be a raw phone (sourced from MessageActivities),
      // so always resolve it through getDisplayName for a proper contact name.
      senderDisplayName: (msg.groupSenderName != null && msg.groupSenderName!.isNotEmpty)
          ? getDisplayName(msg.groupSenderName!)
          : (isGroup &&
                  msg.sender!.trim().toLowerCase() ==
                      (msg.groupId ?? '').trim().toLowerCase()
              ? null
              : getDisplayName(msg.sender!)),
      body: body,
      imageUrl: msg.imageUrl,
      fileUrl: msg.fileUrl,
      direction: direction,
      timestamp: ts,
      deliveryStatus:
          isOutgoing ? DeliveryStatus.sent : DeliveryStatus.delivered,
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
    final sender = msg.sender?.trim();
    if (sender == null || sender.isEmpty) return;

    // Ignore own typing echoes.
    final me = _currentUser?.trim().toLowerCase();
    if (sender.trim().toLowerCase() == me) return;

    // Determine which chat the typing is for.
    // Mirrors Angular: groupId takes precedence over chatId, then falls back
    // to sender (for direct messages the server sets toUser/targetUser but
    // sender is the easiest canonical key to use on the recipient side).
    final chatId = msg.groupId ?? msg.chatId ?? sender;

    final isTyping = msg.isTyping ?? true;

    final newTyping = Map<String, Set<String>>.from(
      state.typingByChatId.map((k, v) => MapEntry(k, Set<String>.from(v))),
    );

    if (isTyping) {
      newTyping[chatId] = {...(newTyping[chatId] ?? {}), sender};

      // Start/reset the auto-clear timer for this sender in this chat.
      _typingClearTimers[chatId] ??= {};
      _typingClearTimers[chatId]![sender]?.cancel();
      _typingClearTimers[chatId]![sender] = Timer(_typingClearDelay, () {
        _clearTypingForSender(chatId, sender);
      });
    } else {
      newTyping[chatId]?.remove(sender);
      if (newTyping[chatId]?.isEmpty ?? false) newTyping.remove(chatId);
      _typingClearTimers[chatId]?[sender]?.cancel();
      _typingClearTimers[chatId]?.remove(sender);
    }

    state = state.copyWith(typingByChatId: newTyping);
  }

  void _clearTypingForSender(String chatId, String sender) {
    final newTyping = Map<String, Set<String>>.from(
      state.typingByChatId.map((k, v) => MapEntry(k, Set<String>.from(v))),
    );
    newTyping[chatId]?.remove(sender);
    if (newTyping[chatId]?.isEmpty ?? false) newTyping.remove(chatId);
    state = state.copyWith(typingByChatId: newTyping);
    _typingClearTimers[chatId]?.remove(sender);
  }

  /// Notify the server (and thereby the other user) that the current user is
  /// typing (or has stopped typing) in [chatId].
  ///
  /// [isGroup] controls whether group metadata is included in the payload.
  Future<void> sendTypingIndicator({
    required String chatId,
    required bool isTyping,
    bool isGroup = false,
  }) async {
    final user = _currentUser;
    if (user == null || user.isEmpty) return;

    final group = isGroup ? state.groups[chatId] : null;

    final payload = TypingPayload(
      user: user,
      isTyping: isTyping,
      targetUser: isGroup ? null : chatId,
      chatId: chatId,
      groupId: isGroup ? chatId : null,
      groupName: group?.name,
      groupMembers: group?.members,
    );

    try {
      await _api.sendTypingState(payload);
    } catch (_) {
      // Typing indicators are best-effort; failures are silently ignored.
    }
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
    _applyReactionToState(
      msg.targetMessageId!,
      msg.emoji,
      msg.reactor ?? '',
      msg.reactorName,
    );
  }

  void _handleEdit(IncomingServerMessage msg) {
    // Server sends `messageId` for the target on both socket/SSE and push.
    // Fall back to msg.messageId when targetMessageId is absent.
    final targetId = msg.targetMessageId ?? msg.messageId;
    if (targetId == null) return;

    final newBody = msg.body;
    final editedAt = msg.editedAt;

    if (newBody == null || editedAt == null) return;

    _applyEditToState(targetId, newBody, editedAt);
  }

  void _handleDelete(IncomingServerMessage msg) {
    // Server sends `messageId` for the target on both socket/SSE and push.
    // Fall back to msg.messageId when targetMessageId is absent.
    final targetId = msg.targetMessageId ?? msg.messageId;
    if (targetId == null) return;

    final deletedAt = msg.deletedAt ?? DateTime.now().millisecondsSinceEpoch;

    _applyDeleteToState(targetId, deletedAt);
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
    // Only pull messages via HTTP when the real-time transport (socket/SSE) is
    // not available. When socket or SSE is active, messages are delivered in
    // real time; polling would just duplicate network calls.
    if (_transport.transportMode != RealtimeTransportMode.polling) {
      debugPrint('[ChatStore] Poll tick skipped — transport is ${_transport.transportMode.name}');
      return;
    }
    pullMessages();
  }

  // ---------------------------------------------------------------------------
  // Background Notification Tray
  // ---------------------------------------------------------------------------

  /// Read the SharedPreferences "pending chat updates" tray that was written
  /// by [firebaseMessagingBackgroundHandler] while the app was not in the
  /// foreground, then clear it so the same counts are never applied twice.
  ///
  /// Returns a map of chatId → accumulated unread count.  Returns an empty
  /// map on web (where the FCM background handler is not used) and on any
  /// error (failures are non-fatal; the recovery pull already handles the
  /// common case).
  Future<Map<String, int>> _readAndClearPendingTray() async {
    if (kIsWeb) return {};
    try {
      final prefs = await SharedPreferences.getInstance();
      final json = prefs.getString(kPendingChatUpdatesKey);
      if (json == null || json.isEmpty) return {};
      // Clear immediately so a crash/re-entry can't double-apply.
      await prefs.remove(kPendingChatUpdatesKey);
      final raw = jsonDecode(json) as Map<String, dynamic>;
      final result = <String, int>{};
      for (final entry in raw.entries) {
        final val = entry.value;
        int count = 0;
        if (val is int) {
          count = val;
        } else if (val is Map) {
          count = (val['unreadCount'] as int?) ?? 0;
        }
        if (count > 0) result[entry.key] = count;
      }
      return result;
    } catch (e) {
      debugPrint('[ChatStore] Failed to read pending tray: $e');
      return {};
    }
  }

  // ---------------------------------------------------------------------------
  // Persistence
  // ---------------------------------------------------------------------------

  void _schedulePersistence() {
    _persistTimer?.cancel();
    _persistTimer = Timer(const Duration(seconds: 2), _persistState);
  }

  Future<void> _persistState() async {
    try {
      final allMessages = <ChatMessage>[];
      for (final messages in state.messagesByChat.values) {
        allMessages.addAll(messages);
      }

      final snapshot = PersistedChatState(
        contacts: state.contacts.values.toList(),
        groups: state.groups.values.toList(),
        unreadByChat: state.unreadByChat,
        messages: allMessages,
      );

      try {
        await _db.persistState(snapshot);
      } catch (_) {
        // Drift DB unavailable (e.g. web without sqlite3.wasm).
        // Fall back to shared_preferences-based localStorage snapshot.
        if (kIsWeb) {
          await WebChatStorage.persistState(snapshot);
        }
      }
    } catch (_) {
      // Persistence failure is non-fatal – data remains available in memory
      // for the current session and will be retried on the next trigger.
    }
  }

  /// Force immediate persistence
  Future<void> persistNow() async {
    _persistTimer?.cancel();
    await _persistState();
  }

  /// Returns the latest message timestamp from in-memory state.
  ///
  /// Used as a fallback when the Drift DB is unavailable (e.g. Flutter web
  /// without sqlite3.wasm) so that gap-analysis pulls still work correctly.
  int _latestTimestampFromState() {
    var latest = 0;
    for (final msgs in state.messagesByChat.values) {
      for (final msg in msgs) {
        if (msg.timestamp > latest) latest = msg.timestamp;
      }
    }
    return latest;
  }

  /// Clear all local data and reset to a clean state.
  ///
  /// Called during explicit logout and when a different user logs in on the
  /// same device so the previous user's data is never exposed to the new user.
  Future<void> clearAll() async {
    // Cancel any pending deferred write to prevent stale data being persisted
    // after the wipe.
    _persistTimer?.cancel();
    _persistTimer = null;

    // Reset per-session tracking fields.
    _currentUser = null;
    _lastGapAnalysisTime = 0;

    await _db.clearAll();
    if (kIsWeb) {
      await WebChatStorage.clear();
    }
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
