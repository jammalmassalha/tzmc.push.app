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
import '../../features/auth/presentation/auth_state.dart';

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

/// SharedPreferences key for locally deleted chats.
///
/// Stores a JSON object of `{ chatId: deletedAtEpochMs }` so a locally deleted
/// chat stays hidden across app restarts and full syncs until newer messages
/// arrive after the stored delete timestamp.
const String kDeletedChatsKeyPrefix = 'tzmc_deleted_chats_v1';

// ---------------------------------------------------------------------------
// Community group seed data (mirrors Angular's SEED_COMMUNITY_GROUPS)
// ---------------------------------------------------------------------------

/// The creator identity used for all synthesised community groups —
/// mirrors Angular's `DOVRUT_SYSTEM_CREATOR = 'dovrut-system'`.
const String _kDovrutSystemCreator = 'dovrut-system';

/// Seed / fallback community group configs — used when the server returns no
/// configs (e.g. first boot before the DB tables are populated).
/// Mirrors Angular's `SEED_COMMUNITY_GROUPS`.
const List<CommunityGroupConfig> _kSeedCommunityGroups = [
  CommunityGroupConfig(
    id: 'דוברות',
    name: 'דוברות',
    allowedWriters: ['0506501040', '0506267447', '0543108095'],
  ),
  CommunityGroupConfig(
    id: 'בדיקה - דוברות',
    name: 'בדיקה - דוברות',
    staticMembers: ['0546799693', '0550000001', '0547997273', '0505203520'],
    allowedWriters: ['0546799693'],
  ),
  CommunityGroupConfig(
    id: 'אקרדיטציה',
    name: 'אקרדיטציה',
    allowedWriters: ['0502798700'],
  ),
];

// ---------------------------------------------------------------------------
// Chat State
// ---------------------------------------------------------------------------

/// Immutable chat state container
class ChatState {
  final Map<String, Contact> contacts;
  final Map<String, ChatGroup> groups;
  final Map<String, List<ChatMessage>> messagesByChat;
  final Map<String, int> unreadByChat;
  final Map<String, int> deletedChats;
  final String? currentChatId;
  final bool isLoading;
  final bool isInitialized;
  final bool isRestricted;

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
    this.deletedChats = const {},
    this.currentChatId,
    this.isLoading = false,
    this.isInitialized = false,
    this.isRestricted = false,
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
    Map<String, int>? deletedChats,
    String? currentChatId,
    bool? isLoading,
    bool? isInitialized,
    bool? isRestricted,
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
      deletedChats: deletedChats ?? this.deletedChats,
      currentChatId: clearCurrentChat ? null : (currentChatId ?? this.currentChatId),
      isLoading: isLoading ?? this.isLoading,
      isInitialized: isInitialized ?? this.isInitialized,
      isRestricted: isRestricted ?? this.isRestricted,
      isSyncing: isSyncing ?? this.isSyncing,
      syncProgressPercent: syncProgressPercent ?? this.syncProgressPercent,
      syncProgressLabel: syncProgressLabel ?? this.syncProgressLabel,
      typingByChatId: typingByChatId ?? this.typingByChatId,
    );
  }

  /// Get all chat list items sorted by last message timestamp
  List<ChatListItem> get chatListItems {
    final items = <ChatListItem>[];

    if (isRestricted) {
      // Return ALL contacts (the active secretaries returned by getContacts) EVEN if they have no messages!
      for (final contact in contacts.values) {
        final messages = messagesByChat[contact.username] ?? [];
        final lastMessage = messages.isNotEmpty ? messages.first : null;
        items.add(ChatListItem(
          id: contact.username,
          title: contact.displayName,
          info: contact.info,
          phone: contact.phone,
          subtitle: lastMessage != null ? _getMessagePreview(lastMessage) : 'לחץ להתחלת שיחה',
          lastTimestamp: lastMessage != null ? lastMessage.timestamp : 0,
          unread: unreadByChat[contact.username] ?? 0,
          isGroup: false,
          pinned: false,
          avatarUrl: contact.upic,
        ));
      }
      // Sort so that those with messages or active chats are at the top, or just alphabetically
      items.sort((a, b) {
        if (a.lastTimestamp != b.lastTimestamp) {
          return b.lastTimestamp.compareTo(a.lastTimestamp);
        }
        return a.title.toLowerCase().compareTo(b.title.toLowerCase());
      });
      return items;
    }

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
        phone: contact?.phone,
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
        phone: null,
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
  StreamSubscription<bool>? _statusSubscription;

  Timer? _persistTimer;
  int _lastGapAnalysisTime = 0;
  String? _currentUser;

  /// Community group configs loaded from the server; seeded with defaults.
  /// Mirrors Angular's `communityGroupConfigs` field.
  List<CommunityGroupConfig> _communityGroupConfigs = List.unmodifiable(_kSeedCommunityGroups);

  /// Per-chat timers that clear a typing indicator after an idle period.
  final Map<String, Map<String, Timer>> _typingClearTimers = {};

  /// How long after the last typing event to clear the indicator.
  static const Duration _typingClearDelay = Duration(seconds: 5);

  /// Username of the currently authenticated user, normalized to lowercase.
  /// Used to dedupe own-message echoes coming back from the server (which
  /// would otherwise show a duplicate "incoming from me" bubble).
  String? get currentUser => _currentUser;

  String _deletedChatsKeyForUser(String user) => '$kDeletedChatsKeyPrefix:${user.trim().toLowerCase()}';

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
      _statusSubscription?.cancel();
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
    _statusSubscription = _transport.status$.listen(_handleStatusChange);
  }

  void _handleStatusChange(bool isRestricted) {
    ref.read(authStateProvider.notifier).updateUserRestrictedStatus(isRestricted);
    state = state.copyWith(isRestricted: isRestricted);
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

    final isRestricted = ref.read(isUserRestrictedProvider);

    if (state.isInitialized) {
      if (state.isRestricted != isRestricted) {
        state = state.copyWith(isRestricted: isRestricted);
      }
      return;
    }

    state = state.copyWith(isLoading: true, isRestricted: isRestricted);

    try {
      final deletedChats = await _readDeletedChats(normalized);
      state = state.copyWith(deletedChats: deletedChats);

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
          messagesByChat: _filterDeletedChatMessages(
            _groupMessagesByChat(persisted.messages),
            deletedChats,
          ),
          unreadByChat: const {},
          deletedChats: deletedChats,
        );
      } catch (dbError) {
        debugPrint('[ChatStore] DB restore failed, trying web storage fallback: $dbError');
        // Drift DB is unavailable (e.g. web without sqlite3.wasm).
        // Try restoring from the shared_preferences-based localStorage snapshot.
        if (kIsWeb) {
          try {
            final webPersisted = await WebChatStorage.getPersistedState(normalized);
            if (webPersisted != null) {
              state = state.copyWith(
                contacts: Map.fromEntries(webPersisted.contacts.map((c) => MapEntry(c.username, c))),
                groups: Map.fromEntries(webPersisted.groups.map((g) => MapEntry(g.id, g))),
                messagesByChat: _filterDeletedChatMessages(
                  _groupMessagesByChat(webPersisted.messages),
                  deletedChats,
                ),
                unreadByChat: const {},
                deletedChats: deletedChats,
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

      // 2a. Load community group configs from the server and synthesise the
      //     community group entries in state.  This must happen BEFORE
      //     recoverMissedMessages so that _normalizeLogMessageForImport can
      //     resolve group IDs from the sender field for community messages
      //     (e.g. sender = 'אקרדיטציה').
      //     Mirrors Angular's loadCommunityGroupConfigs() + the reactive
      //     dovrutGroupSyncEffect that calls syncHardcodedCommunityGroups().
      await _loadCommunityGroupConfigs();
      _syncCommunityGroups();

      // 3. Pull missed messages (gap analysis).
      int latestTimestampBeforeRecovery;
      try {
        latestTimestampBeforeRecovery = await _db.getLatestMessageTimestamp();
      } catch (_) {
        latestTimestampBeforeRecovery = _latestTimestampFromState();
      }
      final hadLocalHistory = latestTimestampBeforeRecovery > 0;

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
      if (hadLocalHistory && tray.isNotEmpty) {
        final merged = Map<String, int>.from(state.unreadByChat);
        for (final entry in tray.entries) {
          // Skip the currently open chat — the user is already viewing it so
          // the tray count would incorrectly re-show the badge after they exit.
          if (entry.key == state.currentChatId) continue;
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

  Map<String, List<ChatMessage>> _filterDeletedChatMessages(
    Map<String, List<ChatMessage>> messagesByChat,
    Map<String, int> deletedChats,
  ) {
    if (messagesByChat.isEmpty || deletedChats.isEmpty) return messagesByChat;

    final filtered = <String, List<ChatMessage>>{};
    for (final entry in messagesByChat.entries) {
      final deletedAt = deletedChats[entry.key];
      if (deletedAt == null) {
        filtered[entry.key] = entry.value;
        continue;
      }

      final kept = entry.value.where((message) => message.timestamp > deletedAt).toList();
      if (kept.isNotEmpty) {
        kept.sort((a, b) => b.timestamp.compareTo(a.timestamp));
        filtered[entry.key] = kept;
      }
    }
    return filtered;
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
      orElse: () => const MapEntry('', Contact(username: '', displayName: '')),
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

      // Never use the incremental pull path as a full-history download.
      // When latestTimestamp == 0 the DB is empty (fresh install / cleared
      // state) and the server would return ALL historical messages.  Each of
      // those messages would be routed through _handleIncomingTextMessage and
      // marked as unread because state.messagesByChat is also empty.  A full
      // history load must always go through _pullAllMessagesFromLogs (the
      // batch-import path) which never increments unread counts.
      // recoverMissedMessages already handles the since==0 case correctly, so
      // we simply bail out here and let initialization finish first.
      if (latestTimestamp <= 0) return;

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
        // Explicitly clear any unread counts that may have been accumulated
        // from realtime messages (socket/SSE) that arrived concurrently during
        // the batch import.  The batch import itself never increments unreads,
        // but a socket/SSE delivery that fires between two paginated API calls
        // goes through _handleIncomingTextMessage which DOES increment unreads.
        // Clearing here is safe because all those messages are already present
        // in state from the batch import, so the user is not "missing" any
        // unread indicator — they will see the new messages in the chat list.
        state = state.copyWith(unreadByChat: const {});
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
      Future.delayed(Duration(milliseconds: delayMs), pullMessages);
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

      // 4a. Reload community group configs and synthesise community groups so
      //     they appear in state before the logs pull.  Mirrors Angular's
      //     loadCommunityGroupConfigs() + syncHardcodedCommunityGroups().
      await _loadCommunityGroupConfigs();
      _syncCommunityGroups();

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
      // Safety reset: ensure unread counters are always zero when a full sync
      // finishes, whether it succeeded or failed.  During the sync the local
      // state is cleared and repopulated; any realtime deliveries or poll ticks
      // that fire between async steps can increment unreads for messages that
      // already belong to the (now-cleared) history.  Resetting here guarantees
      // the chat list shows a clean slate once the sync completes.
      state = state.copyWith(
        isSyncing: false,
        syncProgressPercent: 0,
        syncProgressLabel: '',
        unreadByChat: const {},
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
    // Text messages are applied in a single batch state update — no unread
    // increment (mirrors Angular's `applyIncomingMessagesBatch` with
    // `incrementUnread: false`).
    // Action messages (reaction, edit-action, delete-action, …) are collected
    // separately and dispatched AFTER the text messages are in state, so that
    // _applyReactionToState / _applyEditToState can find their target messages.
    final textMessages = <ChatMessage>[];
    final actionMessages = <IncomingServerMessage>[];

    for (final msg in normalized) {
      final type = (msg.type ?? '').trim().toLowerCase();
      if (actionTypes.contains(type)) {
        actionMessages.add(msg);
      } else {
        final chatMsg = _buildChatMessageFromServer(msg);
        if (chatMsg != null) textMessages.add(chatMsg);
      }
    }

    // Apply text messages first so the target messages exist in state before
    // reactions (and edits/deletes) are applied.
    _applyMessagesBatch(textMessages);
    for (final msg in actionMessages) {
      _handleServerMessage(msg); // delete / edit / reaction / group-update
    }
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

    // groupSenderName comes exclusively from the server field — never extracted
    // from the message body.  The display name in the bubble is resolved via
    // getDisplayName(groupSenderName) so it reflects the device contact name.
    final String groupSenderName = (msg.groupSenderName ?? '').trim();
    String body = rawBody;

    // If groupSenderName was provided by the backend, strip any matching prefix
    // from the body so the name does not appear twice (in the bubble AND the text).
    if (groupSenderName.isNotEmpty && rawBody.isNotEmpty) {
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
      final deletedAt = state.deletedChats[chatId];
      if (deletedAt != null && message.timestamp <= deletedAt) {
        continue;
      }
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

  // ---------------------------------------------------------------------------
  // Community group config loading + synthesis (mirrors Angular's
  //   loadCommunityGroupConfigs() + syncHardcodedCommunityGroups())
  // ---------------------------------------------------------------------------

  /// Fetch community group configs from the server and update
  /// [_communityGroupConfigs].  Falls back to the seed list on any error.
  ///
  /// Mirrors Angular's `loadCommunityGroupConfigs()`.
  Future<void> _loadCommunityGroupConfigs() async {
    try {
      final configs = await _api.getCommunityGroupConfigs();
      if (configs.isNotEmpty) {
        _communityGroupConfigs = List.unmodifiable(configs);
      }
    } catch (_) {
      // Keep seed defaults on error.
    }
  }

  /// Synthesise / update community group entries in [state.groups] based on
  /// [_communityGroupConfigs].
  ///
  /// Mirrors Angular's `syncHardcodedCommunityGroups`:
  ///   • Groups with no [CommunityGroupConfig.staticMembers] (or an empty list)
  ///     are open to all users — their member list is set to all contacts.
  ///   • Groups with a non-empty [CommunityGroupConfig.staticMembers] are only
  ///     shown to users in that list.
  ///   • Each group is created with `type = community`, `createdBy =
  ///     _kDovrutSystemCreator`, and `admins = allowedWriters`.
  ///
  /// Call this **after** contacts have been pulled so the open-group member
  /// list is accurate, and **before** `recoverMissedMessages` so that
  /// `_normalizeLogMessageForImport` can resolve group IDs from the sender
  /// field for community group messages.
  void _syncCommunityGroups() {
    final user = _currentUser;
    if (user == null || user.isEmpty) return;

    final configs = _communityGroupConfigs;
    if (configs.isEmpty) return;

    // All contact usernames, normalised — used as member list for open groups.
    final allContacts = state.contacts.keys
        .map((k) => k.trim().toLowerCase())
        .where((k) => k.isNotEmpty)
        .toList()
      ..sort();

    final groupsById = Map<String, ChatGroup>.from(state.groups);
    bool changed = false;

    final hardcodedIds =
        configs.map((cfg) => cfg.id.trim().toLowerCase()).toList();

    for (final cfg in configs) {
      final normalizedId = cfg.id.trim().toLowerCase();

      // Determine if this group has an explicit member allow-list.
      final isRestricted =
          cfg.staticMembers != null && cfg.staticMembers!.isNotEmpty;

      // Compute expected member list.
      final List<String> expectedMembers;
      if (isRestricted) {
        expectedMembers = cfg.staticMembers!
            .map((m) => m.trim().toLowerCase())
            .where((m) => m.isNotEmpty)
            .toList()
          ..sort();
      } else {
        // Open group — all contacts are considered members.
        expectedMembers = allContacts;
      }

      // Determine if this user should see the group.
      final shouldInclude =
          !isRestricted || expectedMembers.contains(user);

      if (!shouldInclude) {
        if (groupsById.containsKey(normalizedId)) {
          groupsById.remove(normalizedId);
          changed = true;
        }
        continue;
      }

      final admins = cfg.allowedWriters
          .map((w) => w.trim().toLowerCase())
          .where((w) => w.isNotEmpty)
          .toList();

      final existing = groupsById[normalizedId];

      // Sorted existing member list for comparison.
      final existingMembers = existing != null
          ? (existing.members
                .map((m) => m.trim().toLowerCase())
                .where((m) => m.isNotEmpty)
                .toList()
              ..sort())
          : <String>[];

      final needsUpdate = existing == null ||
          existing.name != cfg.name ||
          existing.type != GroupType.community ||
          existing.createdBy.trim().toLowerCase() != _kDovrutSystemCreator ||
          !_areStringListsEqual(existingMembers, expectedMembers);

      if (!needsUpdate) continue;

      changed = true;
      groupsById[normalizedId] = ChatGroup(
        id: normalizedId,
        name: cfg.name,
        members: expectedMembers,
        admins: admins.isEmpty ? null : admins,
        createdBy: _kDovrutSystemCreator,
        updatedAt: DateTime.now().millisecondsSinceEpoch,
        type: GroupType.community,
      );
    }

    if (!changed) return;

    // Reorder: hardcoded community groups first, then the rest.
    final hardcodedFirst = hardcodedIds
        .map((id) => groupsById[id])
        .whereType<ChatGroup>()
        .toList();
    final remaining =
        groupsById.values.where((g) => !hardcodedIds.contains(g.id)).toList();

    state = state.copyWith(
      groups: Map.fromEntries(
        [...hardcodedFirst, ...remaining].map((g) => MapEntry(g.id, g)),
      ),
    );
    _schedulePersistence();
  }

  /// Returns true when [a] and [b] are equal element-by-element.
  static bool _areStringListsEqual(List<String> a, List<String> b) {
    if (a.length != b.length) return false;
    for (var i = 0; i < a.length; i++) {
      if (a[i] != b[i]) return false;
    }
    return true;
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
              name: existing.name,
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

    String? str(dynamic v) {
      if (v == null) return null;
      final s = v.toString().trim();
      return s.isEmpty ? null : s;
    }

    int? int(dynamic v) {
      if (v == null) return null;
      if (v is int) return v;
      if (v is num) return v.toInt();
      return int.tryParse(v.toString());
    }

    // Helper: FCM coerces all data values to strings on Android; arrays are
    // JSON-encoded strings like '["id1","id2"]'. Decode them back to a list.
    List<String>? strList(dynamic v) {
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

    final type = (str(data['type']) ?? '').toLowerCase();

    // ── Action / housekeeping payloads ────────────────────────────────────
    // These should never create a new ChatMessage or increment the unread
    // counter. Delegate to the same action handlers used by socket/SSE so the
    // UI reflects the action (e.g. marking messages as read, hiding deleted).

    switch (type) {
      case 'read-receipt':
      case 'read':
        {
          final ids = strList(data['messageIds']);
          if (ids == null || ids.isEmpty) return;
          final msg = IncomingServerMessage(
            type: type,
            messageIds: ids,
            readAt: int(data['readAt']),
            sender: str(data['sender']),
          );
          _handleReadReceipt(msg);
          return;
        }

      case 'delete-action':
      case 'delete':
        {
          // The server sends `messageId` (the deleted message's ID).
          // `_handleDelete` expects `targetMessageId`.
          final targetId = str(data['messageId']) ?? str(data['targetMessageId']);
          if (targetId == null) return;
          final msg = IncomingServerMessage(
            type: type,
            targetMessageId: targetId,
            deletedAt: int(data['deletedAt']) ?? int(data['timestamp']),
            sender: str(data['sender']),
          );
          _handleDelete(msg);
          return;
        }

      case 'edit-action':
      case 'edit':
        {
          final targetId = str(data['messageId']) ?? str(data['targetMessageId']);
          if (targetId == null) return;
          final msg = IncomingServerMessage(
            type: type,
            targetMessageId: targetId,
            body: str(data['body']),
            editedAt: int(data['editedAt']) ?? int(data['timestamp']),
            sender: str(data['sender']),
          );
          _handleEdit(msg);
          return;
        }

      case 'group-update':
        {
          final groupId = str(data['groupId']);
          if (groupId == null) return;
          final msg = IncomingServerMessage(
            type: type,
            groupId: groupId,
            groupName: str(data['groupName']),
            groupMembers: strList(data['groupMembers']),
            groupCreatedBy: str(data['groupCreatedBy']),
            groupAdmins: strList(data['groupAdmins']),
            groupUpdatedAt: int(data['groupUpdatedAt']),
            groupType: str(data['groupType']),
            sender: str(data['sender']),
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
          final targetId = str(data['targetMessageId']) ?? str(data['messageId']);
          if (targetId == null) return;
          final msg = IncomingServerMessage(
            type: type,
            targetMessageId: targetId,
            emoji: str(data['emoji']),
            reactor: str(data['reactor']) ?? str(data['sender']),
            reactorName: str(data['reactorName']),
            sender: str(data['sender']),
          );
          _handleReaction(msg);
          return;
        }
    }

    // ── Regular chat message ───────────────────────────────────────────────
    final messageId = str(data['messageId']);
    final sender = str(data['sender']) ?? str(data['fromUser']);
    if (messageId == null || sender == null) return;

    // Self-echo: the server sends a copy to the sender's other devices with
    // skipNotification: true so the outgoing bubble is confirmed delivered.
    // Apply the message but do NOT increment the unread counter.
    final skipNotification = data['skipNotification'] == true ||
        data['skipNotification'] == 'true';

    final groupId = str(data['groupId']);
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
      final toUser = (str(data['toUser']) ?? '').trim().toLowerCase();
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
    final messageText = str(data['messageText']);
    final groupMessageText = str(data['groupMessageText']);
    final rawBody = (messageText != null && groupMessageText != null)
        ? (messageText.length >= groupMessageText.length ? messageText : groupMessageText)
        : (messageText ?? groupMessageText ?? str(data['body']) ?? str(data['message']) ?? '');
    final locationUrl = str(data['locationUrl']) ?? str(data['location']);
    final lat = str(data['latitude']) ?? str(data['lat']);
    final lon = str(data['longitude']) ?? str(data['lng']) ?? str(data['lon']);
    final body = rawBody.isNotEmpty
        ? rawBody
        : ((lat != null && lon != null)
            ? '📍 https://www.google.com/maps?q=$lat,$lon'
            : (locationUrl ?? ''));

    final groupTypeRaw = str(data['groupType']);
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
    final rawGroupSenderName = str(data['groupSenderName']) ?? '';
    final senderDisplayName = rawGroupSenderName.isNotEmpty
        ? getDisplayName(rawGroupSenderName)
        : (senderIsGroupId ? null : getDisplayName(sender));
    final timestamp = int(data['timestamp']) ?? DateTime.now().millisecondsSinceEpoch;

    final message = ChatMessage(
      id: messageId,
      messageId: messageId,
      chatId: chatId,
      sender: sender,
      senderDisplayName: senderDisplayName,
      body: body,
      imageUrl: str(data['image']) ?? str(data['imageUrl']) ?? str(data['imageURL']),
      fileUrl: str(data['fileUrl']) ?? str(data['file']) ?? str(data['attachmentUrl']) ?? str(data['url']),
      direction: (isSelfEcho || skipNotification) ? MessageDirection.outgoing : MessageDirection.incoming,
      timestamp: timestamp,
      deliveryStatus: (isSelfEcho || skipNotification) ? DeliveryStatus.sent : DeliveryStatus.delivered,
      groupId: groupId,
      groupName: str(data['groupName']),
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
    final deletedAt = state.deletedChats[chatId];
    if (deletedAt != null && message.timestamp <= deletedAt) {
      return false;
    }
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
    _schedulePersistence();
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

    // Remove this chat from the FCM "pending tray" so that a stale
    // background-notification count cannot re-show the badge on the next
    // cold start.  The tray is written by firebaseMessagingBackgroundHandler
    // while the app is not running; without this call the badge would
    // re-appear after the user reads the messages and restarts the app.
    unawaited(_clearChatFromPendingTray(chatId));

    try {
      await _api.markMessagesAsRead(chatId, messageIds, _currentUser ?? '');
      await markChatSeen(chatId);
    } catch (e) {
      // Silent failure
    }
  }

  /// Clears all local unread badges and the persisted background tray counts.
  ///
  /// Used by the push-permission onboarding flow so the app starts from a clean
  /// unread state right after notifications are enabled for the first time.
  Future<void> clearAllUnreadBadgesInBackground() async {
    state = state.copyWith(unreadByChat: const {});
    _schedulePersistence();

    try {
      await _db.setAllUnreadCounts(const {});
    } catch (e) {
      debugPrint('[ChatStore] Failed to clear unread counts: $e');
    }

    await _clearPendingTrayUnreadCounts();
  }

  Future<void> markChatSeen(String chatId) async {
    final user = (_currentUser ?? '').trim().toLowerCase();
    final normalizedChatId = chatId.trim().toLowerCase();
    if (user.isEmpty || normalizedChatId.isEmpty) return;
    try {
      await _api.markMessagesSeen(user, normalizedChatId);
    } catch (_) {
      // Best-effort.
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

    // Clear the local unread badge immediately when opening a chat.
    // This must happen here — unconditionally — rather than relying solely on
    // markAsRead(), which has an early-return guard for empty message IDs.
    // On the first visit the messages may not be loaded into memory yet
    // (messagesByChat[chatId] == null), so getMessages() returns [] and
    // markAsRead() exits before resetting the count.  By zeroing the badge
    // here we ensure it resets on the very first open.
    if (chatId != null && (state.unreadByChat[chatId] ?? 0) > 0) {
      final newUnread = Map<String, int>.from(state.unreadByChat);
      newUnread[chatId] = 0;
      state = state.copyWith(unreadByChat: newUnread);

      // Also persist to DB and send the server read-receipt for any messages
      // already in memory.  If messages aren't loaded yet the API call is
      // skipped (markAsRead returns early) but the local count is already 0.
      final messages = getMessages(chatId);
      final messageIds = messages.map((m) => m.messageId).toList();
      if (messageIds.isNotEmpty) {
        markAsRead(chatId, messageIds);
      } else {
        // Persist the cleared count to DB even without message IDs.
        _db.clearUnreadCount(chatId).catchError((_) {});
        // Also clear the FCM pending tray so the badge is not re-shown on
        // the next cold start when messages haven't been loaded yet.
        unawaited(_clearChatFromPendingTray(chatId));
        // Persist SeenTime on the server even when we couldn't build a
        // message-id read receipt (e.g. chat opened before messages loaded),
        // so other connected devices can sync badge clearing.
        unawaited(markChatSeen(chatId));
      }
    }

  }

  /// Remove a chat locally from the dashboard list and persisted store.
  ///
  /// This is a local-delete action (client-side only): it removes the chat's
  /// messages and unread counter from the current device state.
  /// Returns true when the chat existed and was removed; false otherwise.
  Future<bool> deleteChat(String chatId) async {
    final normalized = chatId.trim();
    if (normalized.isEmpty) return false;

    final existingMessages = state.messagesByChat[normalized] ?? const <ChatMessage>[];
    final newMessagesByChat = Map<String, List<ChatMessage>>.from(state.messagesByChat);
    final hadChat = newMessagesByChat.remove(normalized) != null;
    if (!hadChat) return false;

    final newUnread = Map<String, int>.from(state.unreadByChat);
    newUnread.remove(normalized);

    final newGroups = Map<String, ChatGroup>.from(state.groups);
    newGroups.remove(normalized);

    final newDeletedChats = Map<String, int>.from(state.deletedChats);
    int deletedAt = 0;
    for (final message in existingMessages) {
      if (message.timestamp > deletedAt) {
        deletedAt = message.timestamp;
      }
    }
    if (deletedAt == 0) deletedAt = DateTime.now().millisecondsSinceEpoch;
    newDeletedChats[normalized] = deletedAt;

    state = state.copyWith(
      messagesByChat: newMessagesByChat,
      unreadByChat: newUnread,
      groups: newGroups,
      deletedChats: newDeletedChats,
      // Clear the current selection when deleting the chat that is open now.
      clearCurrentChat: state.currentChatId == normalized,
    );

    await _clearChatFromPendingTray(normalized);
    final user = _currentUser;
    if (user != null && user.trim().isNotEmpty) {
      await _writeDeletedChats(user, newDeletedChats);
    }
    _schedulePersistence();
    return true;
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
      final mePhone = me.trim().toLowerCase() ?? '';
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
    // Self-read-clear: server tells our OTHER devices that WE just read a chat.
    // The payload includes chatId to distinguish it from a regular read-receipt
    // (where the other party read OUR messages).
    if (msg.chatId != null && msg.chatId!.isNotEmpty) {
      final chatId = msg.chatId!;
      if ((state.unreadByChat[chatId] ?? 0) > 0) {
        final newUnread = Map<String, int>.from(state.unreadByChat);
        newUnread[chatId] = 0;
        state = state.copyWith(unreadByChat: newUnread);
        _db.clearUnreadCount(chatId).catchError((_) {});
        _schedulePersistence();
      }
      return;
    }

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
      // Do not trigger a gap-analysis pull while a full sync is in progress —
      // the sync itself performs a comprehensive server pull.  Calling
      // recoverMissedMessages here would race with the sync's cleared state
      // and could mark historical messages as unread.
      if (state.isSyncing) return;
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
    // Do not poll before initialization is complete. Polling before initialize()
    // finishes results in pullMessages() reading latestTimestamp=0 from an
    // empty DB, fetching ALL historical messages through the incremental path,
    // and marking every incoming message as unread. The batch-import path in
    // recoverMissedMessages resets unreadByChat to {} at the end of initialize,
    // but intermediate poll ticks during the several-second initialization
    // window can still cause all chats to briefly (or permanently) show unread
    // badges after an app update or reinstall.
    if (!state.isInitialized) return;
    // Do not poll during a full sync — the sync performs its own comprehensive
    // pull and polling with a cleared state would mark historical messages as
    // unread.
    if (state.isSyncing) return;
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

  /// Removes [chatId] from the FCM "pending chat updates" tray in
  /// SharedPreferences.
  ///
  /// Called by [markAsRead] and [setCurrentChat] so that when the user reads
  /// a chat, any background-notification count stored for that chat is cleared
  /// immediately.  Without this call the count would persist to the next cold
  /// start and incorrectly re-set the badge for already-read messages.
  Future<void> _clearChatFromPendingTray(String chatId) async {
    if (kIsWeb) return;
    try {
      final prefs = await SharedPreferences.getInstance();
      final json = prefs.getString(kPendingChatUpdatesKey);
      if (json == null || json.isEmpty) return;
      final decoded = jsonDecode(json);
      if (decoded is! Map<String, dynamic>) return;
      if (!decoded.containsKey(chatId)) return;
      decoded.remove(chatId);
      if (decoded.isEmpty) {
        await prefs.remove(kPendingChatUpdatesKey);
      } else {
        await prefs.setString(kPendingChatUpdatesKey, jsonEncode(decoded));
      }
    } catch (e) {
      debugPrint('[ChatStore] Failed to clear pending tray for $chatId: $e');
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
      final user = _currentUser;
      if (user == null || user.trim().isEmpty) {
        return;
      }
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
          await WebChatStorage.persistState(user, snapshot);
        }
      }
      await _writeDeletedChats(user, state.deletedChats);
    } catch (_) {
      // Persistence failure is non-fatal – data remains available in memory
      // for the current session and will be retried on the next trigger.
    }
  }

  Future<Map<String, int>> _readDeletedChats(String user) async {
    try {
      final prefs = await SharedPreferences.getInstance();
      final json = prefs.getString(_deletedChatsKeyForUser(user));
      if (json == null || json.trim().isEmpty) return const {};
      final decoded = jsonDecode(json);
      if (decoded is! Map) return const {};

      final result = <String, int>{};
      decoded.forEach((key, value) {
        final chatId = key.toString().trim();
        final deletedAt = value is int ? value : int.tryParse(value.toString());
        if (chatId.isNotEmpty && deletedAt != null && deletedAt > 0) {
          result[chatId] = deletedAt;
        }
      });
      return result;
    } catch (_) {
      return const {};
    }
  }

  Future<void> _writeDeletedChats(String user, Map<String, int> deletedChats) async {
    try {
      final prefs = await SharedPreferences.getInstance();
      if (deletedChats.isEmpty) {
        await prefs.remove(_deletedChatsKeyForUser(user));
        return;
      }
      await prefs.setString(_deletedChatsKeyForUser(user), jsonEncode(deletedChats));
    } catch (_) {
      // Best-effort local persistence; in-memory state remains authoritative.
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
    final previousUser = _currentUser;
    _currentUser = null;
    _lastGapAnalysisTime = 0;

    await _db.clearAll();
    if (kIsWeb && previousUser != null && previousUser.trim().isNotEmpty) {
      await WebChatStorage.clear(previousUser);
    }
    if (previousUser != null && previousUser.trim().isNotEmpty) {
      await _writeDeletedChats(previousUser, const {});
    }

    // Clear the FCM background-notification pending tray so that stale unread
    // counts written before a logout, update, or reinstall are never replayed
    // as badge counts on the next login.  Without this, the tray survives app
    // updates (SharedPreferences is preserved across updates on Android/iOS)
    // and would incorrectly re-show badges for messages the user already read.
    await _clearPendingTrayUnreadCounts();

    state = const ChatState();
  }

  Future<void> _clearPendingTrayUnreadCounts() async {
    if (kIsWeb) return;
    try {
      final prefs = await SharedPreferences.getInstance();
      await prefs.remove(kPendingChatUpdatesKey);
    } catch (e) {
      debugPrint('[ChatStore] Failed to clear pending tray unread counts: $e');
    }
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
