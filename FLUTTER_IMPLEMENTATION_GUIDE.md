# Flutter Implementation Guide: Phases 5-6 (Multi-Trigger Sync & Local Outbox)

This guide provides step-by-step instructions for implementing Phases 5 and 6 of the Zero-Duplicate, Zero-Missing Message Architecture on the Flutter side.

---

## Phase 5: Multi-Trigger Sync on Client (Flutter)

### Objective
Trigger `/notify/messages/sync` on three distinct events:
1. FCM notification received
2. App lifecycle change (resumed)
3. WebSocket reconnection

This ensures messages are never missed even if FCM is delayed/dropped.

### Implementation

#### 5.1: Enhance Push Notification Service

**File**: `flutter_app/lib/core/services/push_notification_service.dart`

Add sync triggers to existing notification handlers:

```dart
// In _setupForegroundMessageHandler()
FirebaseMessaging.onMessage.listen((RemoteMessage message) {
  debugPrint('[PUSH] Foreground message received: ${message.messageId}');
  
  // PHASE 5: Trigger sync on foreground message
  void _triggerSync() async {
    final store = sl<ChatStoreService>();
    await store.fullSync();
  }
  _triggerSync();
  
  // Existing code continues...
});

// In _setupBackgroundMessageHandler()
FirebaseMessaging.onBackgroundMessage((RemoteMessage message) async {
  debugPrint('[PUSH] Background message received: ${message.messageId}');
  
  // PHASE 5: Trigger sync on background message
  try {
    final store = sl<ChatStoreService>();
    await store.fullSync();
  } catch (e) {
    debugPrint('[PUSH] Background sync failed: $e');
  }
});

// In _setupOpenedAppMessageHandler()
FirebaseMessaging.onMessageOpenedApp.listen((RemoteMessage message) {
  debugPrint('[PUSH] App opened from notification: ${message.messageId}');
  
  // PHASE 5: Trigger sync when app opened
  WidgetsBinding.instance.addPostFrameCallback((_) {
    sl<ChatStoreService>().fullSync();
  });
  
  // Existing navigation code continues...
});
```

#### 5.2: Add App Lifecycle Sync

**File**: `flutter_app/lib/features/chat/presentation/chat_shell_screen.dart`

Add lifecycle observer to sync on app resume:

```dart
import 'package:flutter/material.dart';

class ChatShellScreen extends StatefulWidget {
  @override
  _ChatShellScreenState createState() => _ChatShellScreenState();
}

class _ChatShellScreenState extends State<ChatShellScreen>
    with WidgetsBindingObserver {
  
  @override
  void initState() {
    super.initState();
    
    // PHASE 5: Register lifecycle observer
    WidgetsBinding.instance.addObserver(this);
  }
  
  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }
  
  // PHASE 5: Sync when app is brought to foreground
  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    debugPrint('[LIFECYCLE] App state: $state');
    
    if (state == AppLifecycleState.resumed) {
      debugPrint('[LIFECYCLE] App resumed — triggering sync');
      
      // Sync messages when user opens app
      WidgetsBinding.instance.addPostFrameCallback((_) async {
        try {
          final store = sl<ChatStoreService>();
          if (store.isInitialized) {
            await store.fullSync();
          }
        } catch (e) {
          debugPrint('[LIFECYCLE] Sync failed: $e');
        }
      });
    } else if (state == AppLifecycleState.paused) {
      debugPrint('[LIFECYCLE] App paused — pausing syncs');
    }
  }
  
  @override
  Widget build(BuildContext context) {
    // Existing widget tree
    return Scaffold(/* ... */);
  }
}
```

#### 5.3: Add WebSocket Reconnection Sync

**File**: `flutter_app/lib/core/services/websocket_transport_service.dart`

Add sync trigger after successful reconnection:

```dart
class WebSocketTransportService {
  
  Future<void> connect() async {
    try {
      // Existing connection logic...
      await _socket.connect();
      
      // PHASE 5: Trigger sync after successful connection
      _onConnected();
    } catch (e) {
      debugPrint('[WS] Connection failed: $e');
      _scheduleReconnect();
    }
  }
  
  void _onConnected() {
    debugPrint('[WS] Connected — triggering sync');
    
    // Sync messages immediately after reconnection
    Future.microtask(() async {
      try {
        final store = sl<ChatStoreService>();
        if (store.isInitialized) {
          await store.fullSync();
        }
      } catch (e) {
        debugPrint('[WS] Post-connect sync failed: $e');
      }
    });
    
    // Emit connection event
    _connectionSubject.add(true);
  }
  
  // Existing code continues...
}
```

#### 5.4: Verify fullSync() Implementation

**File**: `flutter_app/lib/core/services/chat_store_service.dart`

Ensure `fullSync()` exists and uses database queries:

```dart
class ChatStoreService {
  
  // PHASE 5: Public full sync endpoint (may already exist)
  Future<void> fullSync() async {
    debugPrint('[CHAT-STORE] Full sync initiated');
    
    try {
      // This calls /notify/messages/sync which now uses pts
      await _performFullSync();
      
      debugPrint('[CHAT-STORE] Full sync completed');
    } catch (e) {
      debugPrint('[CHAT-STORE] Full sync failed: $e');
      rethrow;
    }
  }
  
  Future<void> _performFullSync() async {
    final activeChatId = this.activeChatId();
    final lastPts = await _getLastSyncPts(activeChatId);
    
    // POST /notify/messages/sync
    // Server will return messages with pts > lastPts
    final syncResponse = await this.api.fetchSyncMessages({
      'since_pts': lastPts,
      'limit': 1000,
    });
    
    // Process and apply messages...
    await _applyMessagesBatch(syncResponse.messages);
    
    // Update last sync pts
    await _saveLastSyncPts(activeChatId, syncResponse.next_sync_pts);
  }
}
```

---

## Phase 6: Local Outbox Pattern (SQLite)

### Objective
Store unsent messages in local SQLite database, retry automatically, survive app crashes.

### Implementation

#### 6.1: Create Outbox Schema

**File**: `flutter_app/lib/core/local_storage/message_outbox_dao.dart` (NEW)

```dart
import 'package:floor/floor.dart';
import 'package:hive/hive.dart';

// Define Outbox entity
@Entity(tableName: 'message_outbox')
class MessageOutboxEntry {
  @PrimaryKey(autoGenerate: true)
  final int? id;
  
  final String outboxId;          // UUID for tracking
  final String chatId;             // Group or direct message recipient
  final String clientMsgId;        // Unique client ID (for dedup)
  final String senderPhone;        // Sender's phone number
  final String body;               // Message text
  final String? imageUrl;          // Optional image URL
  final String? fileUrl;           // Optional file URL
  final DateTime timestamp;        // When message was created
  final String status;             // 'pending', 'sent', 'failed', 'retrying'
  final int retryCount;            // Number of retry attempts
  final DateTime? lastRetryAt;     // Last retry attempt time
  final DateTime createdAt;        // When added to outbox
  
  MessageOutboxEntry({
    this.id,
    required this.outboxId,
    required this.chatId,
    required this.clientMsgId,
    required this.senderPhone,
    required this.body,
    this.imageUrl,
    this.fileUrl,
    required this.timestamp,
    this.status = 'pending',
    this.retryCount = 0,
    this.lastRetryAt,
    required this.createdAt,
  });
}

@dao
abstract class MessageOutboxDao {
  
  @Insert()
  Future<int> insert(MessageOutboxEntry entry);
  
  @Update()
  Future<void> update(MessageOutboxEntry entry);
  
  @delete
  Future<void> delete(MessageOutboxEntry entry);
  
  @Query('SELECT * FROM message_outbox WHERE status = "pending" ORDER BY timestamp ASC')
  Future<List<MessageOutboxEntry>> getPendingMessages();
  
  @Query('SELECT * FROM message_outbox WHERE chatId = :chatId AND status != "sent" ORDER BY timestamp ASC')
  Future<List<MessageOutboxEntry>> getUnsentForChat(String chatId);
  
  @Query('DELETE FROM message_outbox WHERE status = "sent" AND createdAt < datetime("now", "-7 days")')
  Future<void> cleanupOldSentMessages();
  
  @Query('SELECT COUNT(*) FROM message_outbox WHERE status = "pending"')
  Future<int> getPendingCount();
}
```

#### 6.2: Create Outbox Service

**File**: `flutter_app/lib/core/services/message_outbox_service.dart` (NEW)

```dart
import 'package:uuid/uuid.dart';
import 'package:path/path.dart' as p;

class MessageOutboxService {
  final MessageOutboxDao _dao;
  final ChatApiService _api;
  final ChatStoreService _chatStore;
  
  // Background retry timer
  Timer? _retryTimer;
  
  MessageOutboxService({
    required MessageOutboxDao dao,
    required ChatApiService api,
    required ChatStoreService chatStore,
  })  : _dao = dao,
        _api = api,
        _chatStore = chatStore;
  
  // PHASE 6: Initialize outbox service
  Future<void> initialize() async {
    debugPrint('[OUTBOX] Initializing message outbox service');
    
    // Clean up old sent messages (>7 days)
    await _dao.cleanupOldSentMessages();
    
    // Start retry timer
    _startRetryWorker();
    
    // Retry any pending messages immediately
    await retryPendingMessages();
  }
  
  // PHASE 6: Add message to outbox before sending
  Future<String> addToOutbox({
    required String chatId,
    required String senderPhone,
    required String body,
    String? imageUrl,
    String? fileUrl,
  }) async {
    final clientMsgId = _generateClientMsgId();
    final outboxId = const Uuid().v4();
    
    final entry = MessageOutboxEntry(
      outboxId: outboxId,
      chatId: chatId,
      clientMsgId: clientMsgId,
      senderPhone: senderPhone,
      body: body,
      imageUrl: imageUrl,
      fileUrl: fileUrl,
      timestamp: DateTime.now(),
      status: 'pending',
      retryCount: 0,
      createdAt: DateTime.now(),
    );
    
    await _dao.insert(entry);
    
    debugPrint('[OUTBOX] Added message to outbox: $clientMsgId (chatId=$chatId)');
    
    return clientMsgId;
  }
  
  // PHASE 6: Mark as sent (delete from outbox)
  Future<void> markAsSent(String clientMsgId) async {
    debugPrint('[OUTBOX] Marking as sent: $clientMsgId');
    
    final pending = await _dao.getPendingMessages();
    final entry = pending.firstWhere(
      (e) => e.clientMsgId == clientMsgId,
      orElse: () => null,
    );
    
    if (entry != null) {
      await _dao.delete(entry);
      debugPrint('[OUTBOX] Deleted from outbox: $clientMsgId');
    }
  }
  
  // PHASE 6: Mark as failed (increment retry)
  Future<void> markAsFailed(String clientMsgId) async {
    debugPrint('[OUTBOX] Marking as failed: $clientMsgId');
    
    final pending = await _dao.getPendingMessages();
    final entry = pending.firstWhere(
      (e) => e.clientMsgId == clientMsgId,
      orElse: () => null,
    );
    
    if (entry != null) {
      await _dao.update(entry.copyWith(
        retryCount: entry.retryCount + 1,
        lastRetryAt: DateTime.now(),
        status: 'retrying',
      ));
      debugPrint('[OUTBOX] Incremented retry count: $clientMsgId (count=${entry.retryCount + 1})');
    }
  }
  
  // PHASE 6: Retry pending messages
  Future<void> retryPendingMessages() async {
    final pending = await _dao.getPendingMessages();
    
    if (pending.isEmpty) {
      debugPrint('[OUTBOX] No pending messages to retry');
      return;
    }
    
    debugPrint('[OUTBOX] Retrying ${pending.length} pending messages');
    
    for (final entry in pending) {
      // Check if enough time has passed since last retry (exponential backoff)
      final backoffMs = _calculateBackoff(entry.retryCount);
      final lastRetry = entry.lastRetryAt?.millisecondsSinceEpoch ?? 0;
      final now = DateTime.now().millisecondsSinceEpoch;
      
      if (now - lastRetry < backoffMs) {
        debugPrint('[OUTBOX] Skipping (backoff): ${entry.clientMsgId} (wait ${backoffMs}ms)');
        continue;
      }
      
      try {
        debugPrint('[OUTBOX] Retrying: ${entry.clientMsgId} (attempt=${entry.retryCount + 1})');
        
        // Send message with same clientMsgId (ensures Redis/MySQL dedup)
        await _api.sendDirectMessage({
          'messageId': entry.clientMsgId,
          'reply': entry.body,
          'imageUrl': entry.imageUrl,
          'fileUrl': entry.fileUrl,
          'originalSender': entry.chatId,
          // ... other fields
        });
        
        // On success, delete from outbox
        await markAsSent(entry.clientMsgId);
        debugPrint('[OUTBOX] Successfully sent and deleted: ${entry.clientMsgId}');
        
      } catch (e) {
        // On failure, increment retry and update lastRetryAt
        await markAsFailed(entry.clientMsgId);
        debugPrint('[OUTBOX] Send failed (will retry): ${entry.clientMsgId} — $e');
      }
    }
  }
  
  // PHASE 6: Background retry worker
  void _startRetryWorker() {
    _retryTimer = Timer.periodic(Duration(seconds: 30), (timer) async {
      debugPrint('[OUTBOX-WORKER] Periodic retry check');
      
      try {
        await retryPendingMessages();
      } catch (e) {
        debugPrint('[OUTBOX-WORKER] Error during retry: $e');
      }
    });
    
    debugPrint('[OUTBOX-WORKER] Started (30s interval)');
  }
  
  void _stopRetryWorker() {
    _retryTimer?.cancel();
    _retryTimer = null;
    debugPrint('[OUTBOX-WORKER] Stopped');
  }
  
  // Exponential backoff: 1s, 2s, 4s, 8s, 30s, 30s...
  int _calculateBackoff(int retryCount) {
    if (retryCount == 0) return 0;      // First attempt, no backoff
    if (retryCount == 1) return 1000;   // 1 second
    if (retryCount == 2) return 2000;   // 2 seconds
    if (retryCount == 3) return 4000;   // 4 seconds
    if (retryCount == 4) return 8000;   // 8 seconds
    return 30000;                        // 30 seconds for retries > 5
  }
  
  String _generateClientMsgId() {
    return 'msg_${DateTime.now().millisecondsSinceEpoch}_${Random().nextInt(10000)}';
  }
  
  Future<void> dispose() async {
    _stopRetryWorker();
  }
}
```

#### 6.3: Integrate Outbox into Chat Store

**File**: `flutter_app/lib/core/services/chat_store_service.dart`

Update message sending to use outbox:

```dart
class ChatStoreService {
  late MessageOutboxService _outboxService;
  
  Future<void> initialize() async {
    // ... existing init code ...
    
    // PHASE 6: Initialize outbox service
    _outboxService = MessageOutboxService(
      dao: sl<MessageOutboxDao>(),
      api: this.api,
      chatStore: this,
    );
    await _outboxService.initialize();
  }
  
  // Update sendGroupMessage to use outbox
  Future<void> sendGroupMessage(
    ChatGroup group,
    String messageId,
    String body,
    String? imageUrl,
    SendMessageOptions options = {},
    String? fileUrl,
  ) async {
    final user = this.currentUser();
    if (!user) return;
    
    try {
      // PHASE 6: Add to outbox BEFORE attempting to send
      final clientMsgId = await _outboxService.addToOutbox(
        chatId: group.id,
        senderPhone: user,
        body: body,
        imageUrl: imageUrl,
        fileUrl: fileUrl,
      );
      
      // Attempt to send
      await this.sendReplyTransport({
        messageId: clientMsgId,  // Use outbox-generated clientMsgId
        user,
        senderName: this.getDisplayName(user),
        reply: body,
        imageUrl,
        fileUrl: fileUrl,
        groupId: group.id,
        groupName: group.name,
        groupMembers: group.members,
        groupCreatedBy: group.createdBy,
        groupAdmins: group.admins,
        groupType: group.type,
      });
      
      // On success, server returns 200 — outbox worker will mark as sent
      // (when checkSendStatus returns success)
      
    } catch (e) {
      // Network error — message stays in outbox for retry
      debugPrint('[CHAT-STORE] Send failed (outbox will retry): $e');
      rethrow;
    }
  }
  
  // Listen for successful sends (from API response)
  Future<void> sendReplyTransport(payload) async {
    try {
      final response = await this.api.sendDirectMessage(payload);
      
      // PHASE 6: On 200 OK, mark as sent in outbox
      if (response.ok) {
        final clientMsgId = payload['messageId'];
        await _outboxService.markAsSent(clientMsgId);
        debugPrint('[CHAT-STORE] Message sent and removed from outbox: $clientMsgId');
      }
      
      return response;
    } catch (e) {
      // Leave in outbox for automatic retry
      debugPrint('[CHAT-STORE] API error (outbox will retry): $e');
      rethrow;
    }
  }
  
  @override
  Future<void> dispose() async {
    await _outboxService.dispose();
    super.dispose();
  }
}
```

#### 6.4: Trigger Outbox Retry on Network Change

**File**: `flutter_app/lib/core/services/connectivity_service.dart` (or equivalent)

```dart
class ConnectivityService {
  
  Future<void> monitorConnectivity() async {
    Connectivity().onConnectivityChanged.listen((result) async {
      if (result == ConnectivityResult.none) {
        debugPrint('[CONNECTIVITY] Offline');
      } else {
        debugPrint('[CONNECTIVITY] Online (${result.toString()})');
        
        // PHASE 6: Retry outbox messages when network is restored
        WidgetsBinding.instance.addPostFrameCallback((_) async {
          try {
            await sl<MessageOutboxService>().retryPendingMessages();
          } catch (e) {
            debugPrint('[CONNECTIVITY] Outbox retry failed: $e');
          }
        });
      }
    });
  }
}
```

---

## Testing Checklist

### Phase 5: Multi-Trigger Sync
- [ ] Send message from another device, receive FCM → message appears
- [ ] FCM is delayed → open app → message appears (lifecycle sync)
- [ ] App backgrounded → send message from other device → app opens → message appears
- [ ] Disable FCM → send message → WebSocket sync delivers it
- [ ] Verify `/messages/sync` uses `since_pts` parameter

### Phase 6: Local Outbox
- [ ] Send message → check SQLite Outbox (entry with 'pending' status)
- [ ] Server returns 200 OK → check Outbox (entry deleted)
- [ ] Go offline → send message → stay in Outbox → go online → message sent
- [ ] App crashes while sending → restart app → message retried and sent
- [ ] Multiple retry attempts → verify exponential backoff
- [ ] Network connectivity restored → Outbox worker retries
- [ ] Same clientMsgId on retry → verify Redis/MySQL dedup works

---

## Summary

**Phase 5** ensures messages are never missed by syncing on three triggers:
1. FCM notification
2. App lifecycle (resumed)
3. WebSocket reconnection

**Phase 6** ensures sent messages survive crashes by:
1. Persisting to SQLite Outbox before sending
2. Automatic retry with exponential backoff
3. Using same `clientMsgId` for idempotency

Together, Phases 5-6 complete the zero-duplicate, zero-missing message architecture.

