/// Chat Store Service - central state management for chat data.
///
/// This is the Flutter equivalent of Angular's ChatStoreService.
/// Manages contacts, groups, messages, and real-time synchronization.
library;

import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../api/chat_api_service.dart';
import '../database/chat_database.dart' hide Contact;
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

  const ChatState({
    this.contacts = const {},
    this.groups = const {},
    this.messagesByChat = const {},
    this.unreadByChat = const {},
    this.currentChatId,
    this.isLoading = false,
    this.isInitialized = false,
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
  }) {
    return ChatState(
      contacts: contacts ?? this.contacts,
      groups: groups ?? this.groups,
      messagesByChat: messagesByChat ?? this.messagesByChat,
      unreadByChat: unreadByChat ?? this.unreadByChat,
      currentChatId: clearCurrentChat ? null : (currentChatId ?? this.currentChatId),
      isLoading: isLoading ?? this.isLoading,
      isInitialized: isInitialized ?? this.isInitialized,
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

  /// Apply an incoming message to state
  void _applyIncomingMessage(ChatMessage message) {
    final chatId = message.chatId;
    final newMessagesByChat = Map<String, List<ChatMessage>>.from(state.messagesByChat);
    final chatMessages = List<ChatMessage>.from(newMessagesByChat[chatId] ?? []);

    // Check for existing message (by messageId)
    final existingIndex = chatMessages.indexWhere((m) => m.messageId == message.messageId);

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

    // Create optimistic message
    final message = ChatMessage(
      id: messageId,
      messageId: messageId,
      chatId: recipient,
      sender: 'me', // Will be replaced with actual user
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
      // Send via API
      await _api.sendDirectMessageWithParams(
        recipient: recipient,
        body: body,
        imageUrl: imageUrl,
        fileUrl: fileUrl,
        replyToMessageId: replyTo?.messageId,
      );

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

    // Create optimistic message
    final message = ChatMessage(
      id: messageId,
      messageId: messageId,
      chatId: groupId,
      sender: 'me',
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
      // Send via API
      await _api.sendGroupMessage(
        groupId: groupId,
        recipients: group.members,
        body: body,
        imageUrl: imageUrl,
        fileUrl: fileUrl,
        replyToMessageId: replyTo?.messageId,
      );

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
    final type = message.type;

    switch (type) {
      case 'message':
        _handleIncomingTextMessage(message);
        break;
      case 'typing':
        _handleTypingIndicator(message);
        break;
      case 'read':
        _handleReadReceipt(message);
        break;
      case 'reaction':
        _handleReaction(message);
        break;
      case 'edit':
        _handleEdit(message);
        break;
      case 'delete':
        _handleDelete(message);
        break;
      case 'group-update':
        _handleGroupUpdate(message);
        break;
      default:
        // Unknown message type
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

    return ChatMessage(
      id: msg.messageId!,
      messageId: msg.messageId!,
      chatId: chatId,
      sender: msg.sender!,
      senderDisplayName: msg.groupSenderName ?? getDisplayName(msg.sender!),
      body: msg.body ?? '',
      imageUrl: msg.imageUrl,
      fileUrl: msg.fileUrl,
      direction: MessageDirection.incoming,
      timestamp: msg.timestamp ?? DateTime.now().millisecondsSinceEpoch,
      deliveryStatus: DeliveryStatus.delivered,
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
    if (msg.targetMessageId == null) return;

    final targetId = msg.targetMessageId!;
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
    if (msg.targetMessageId == null) return;

    final targetId = msg.targetMessageId!;
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
