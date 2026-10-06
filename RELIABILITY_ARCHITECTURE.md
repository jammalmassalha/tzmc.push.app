# Zero-Duplicate, Zero-Missing Message Architecture

## Overview
This document describes the comprehensive reliability architecture implemented to guarantee zero duplicate messages and zero missing messages in the TZMC messaging system. The solution uses persistent state, Redis caching, MySQL transactions, and client-side outbox patterns to eliminate all race conditions and data loss scenarios.

---

## Problem Statement

### Original Issues
1. **Duplicate Messages**: Old messages appearing as new notifications multiple times despite being read
2. **Missing Messages**: Messages lost due to in-memory queue crashes or server restarts
3. **Race Conditions**: Cold-start and background app states missing push notifications
4. **Non-Atomic Operations**: MessageActivities and Logs inserts could become inconsistent if server crashed between them

### Root Causes
1. **In-Memory Deduplication Cache**: 60-second TTL; too short for server restarts or offline scenarios
2. **In-Memory Message Queues**: Lost on server restart or crash
3. **Fire-and-Forget Inserts**: No transaction wrapping; inconsistent state on partial failure
4. **No Sequence Numbers**: Clients couldn't order messages reliably after sync

---

## Architecture: 7 Phases

### Phase 1: Database Schema Updates ✅

**Goal**: Add persistent idempotency tracking and sequence numbering to database

**Changes**:
- **MessageActivities Table**: Added UNIQUE constraint on `ClientMsgId` column (allows NULL for non-message activities)
- **Logs Table**: Added `pts` (sequence) column for persistent ordering
- **Indexes**: 
  - `uk_client_msg_id_idempotency` on `MessageActivities.ClientMsgId` (UNIQUE, allows NULL)
  - `idx_logs_pts` on `Logs.pts` for sync queries

**Why it works**:
- UNIQUE constraint prevents duplicate inserts at database level
- NULL values in UNIQUE index allow non-message activities (reactions, edits) without violating constraint
- Sequence numbers survive server restarts and client reconnects

**Fallback**: If migration fails, MySQL constraint will still catch duplicates

---

### Phase 2: Redis Integration for Idempotency ✅

**Goal**: Cache processed messages across server restarts with 24-48 hour TTL

**Implementation**:
```javascript
// checkAndMarkMessageProcessed(clientMsgId, redisStore, ttlSeconds)
// Returns: true if already processed, false if first time
const alreadyProcessed = await checkAndMarkMessageProcessed(clientMsgId, redisStore, 86400);
if (alreadyProcessed) {
  return { status: 'success', details: { deduped: true } };
}

// generateSequenceNumber(groupId, redisStore)
// Returns: monotonic sequence number (pts) for message ordering
const pts = await generateSequenceNumber(groupId, redisStore);
```

**Flow**:
1. Client sends message with `clientMsgId`
2. Server checks Redis for `msg_processed:{clientMsgId}`
3. If found → return success (already processed)
4. If not found → mark in Redis with SETEX (24-hour TTL)
5. Generate sequence number via `INCR pts:{groupId}`

**Fallback Chain**:
- Redis available → use Redis cache (survives restart) ✅ **Best**
- Redis down → use in-memory cache (lost on restart)
- Both down → MySQL UNIQUE constraint (catches duplicates on retry)

**Why it works**:
- Survives server restarts (persisted in Redis)
- Survives client offline/reconnect scenarios
- Redis failure doesn't break system (MySQL fallback)
- Sequence numbers globally monotonic and ordered

---

### Phase 3: Database-Backed Message Persistence ✅

**Goal**: Replace in-memory queues with database queries

**Previous Problem**:
```javascript
// VULNERABLE: Lost on server crash/restart
let messageQueue = {};
async function addToQueue(targetUser, messageObj) {
  messageQueue[user].push(messageObj);
}
```

**New Solution**:
- Messages written to Logs table with `pts` column
- `/messages/sync` endpoint queries: `SELECT * FROM Logs WHERE pts > client_last_pts`
- No dependency on in-memory state

**Benefits**:
- Messages survive server crashes
- Clients recover missed messages via sync
- Sequence numbers ensure strict ordering

---

### Phase 4: Atomic Transactions ✅

**Goal**: Guarantee all-or-nothing message persistence

**Previous Problem**:
```javascript
// BROKEN: Could crash between these two operations
void mysqlLogsService.insertMessageActivity(...);  // Async, not awaited
await logNotificationStatus(...);                  // Separate call
// If server crashes here, data is inconsistent!
```

**New Solution**:
```typescript
// New method: insertMessageActivityAndLog()
async insertMessageActivityAndLog(activity, logPayload): Promise<{success, isDuplicate}> {
  const connection = await this.pool.getConnection();
  try {
    await connection.beginTransaction();
    
    // Both inserts happen atomically
    await connection.execute(INSERT_MESSAGE_ACTIVITIES);
    await connection.execute(INSERT_LOGS);
    
    await connection.commit();
    return { success: true, isDuplicate: false };
  } catch (error) {
    await connection.rollback();
    
    // Check if duplicate (MySQL UNIQUE constraint)
    if (error.code === 'ER_DUP_ENTRY' && error.message.includes('uk_client_msg_id_idempotency')) {
      return { success: true, isDuplicate: true };
    }
    throw error;
  }
}
```

**Flow in processReplyPayload**:
1. Check Redis for duplicate (24-hour cache)
2. Generate sequence number (pts) from Redis
3. Call `insertMessageActivityAndLog()` with transaction
4. Catch UNIQUE constraint → return idempotent success
5. Only queue message and send FCM if transaction succeeded

**Why it works**:
- All-or-nothing semantics
- UNIQUE constraint provides idempotency on client retry
- Sequence numbers are atomic part of transaction
- Handles server crashes between steps

---

### Phase 5: Multi-Trigger Sync on Client (Flutter) ⏳

**Goal**: Sync messages on multiple events (not just FCM)

**Current Problem**:
- Only syncs when FCM notification arrives
- iOS/Android OS can throttle, delay, or drop background notifications
- Messages can be invisible to app for minutes

**New Solution**:
Trigger `/notify/messages/sync` on three distinct events:

1. **FCM Notification Received** (existing, but enhanced)
   - `onMessage` handler (app foreground)
   - `onBackgroundMessage` handler (app background)
   - `onMessageOpenedApp` handler (app reopened)

2. **App Lifecycle Change**
   - `WidgetsBindingObserver.didChangeAppLifecycleState()`
   - When state changes to `resumed` (app brought to foreground)
   - Ensures messages appear immediately when user opens app

3. **WebSocket Reconnection**
   - After successful WebSocket connection/reconnection
   - Catches messages that arrived while offline

**Implementation Example** (to be added to Flutter):
```dart
@override
void didChangeAppLifecycleState(AppLifecycleState state) {
  if (state == AppLifecycleState.resumed) {
    // User brought app to foreground
    _syncMessagesInBackground();
  }
}

@override
void onWebSocketConnected() {
  // Connection established (or reconnected)
  _syncMessagesInBackground();
}

Future<void> _syncMessagesInBackground() async {
  // Sends POST /notify/messages/sync with last_pts
  await chatStore.fullSync();
}
```

**Why it works**:
- Multiple independent sync triggers ensure messages arrive
- Even if FCM is delayed/dropped, app will sync when opened
- WebSocket sync catches messages during reconnect
- No reliance on any single mechanism

---

### Phase 6: Local Outbox Pattern (Flutter) ⏳

**Goal**: Guarantee sent messages survive app crashes

**Current Problem**:
- Optimistic UI updates are great, but if app closes while "pending", message might be lost
- No persistent storage of unsent messages

**New Solution**:
Create SQLite Outbox table on client:

```dart
class MessageOutbox {
  final String id;
  final String chatId;
  final String clientMsgId;
  final String body;
  final String imageUrl;
  final String fileUrl;
  final int timestamp;
  final String status; // 'pending', 'sent', 'failed'
  final int retryCount;
  final int lastRetryAt;
}
```

**Flow**:

1. **Send Request**:
   - Write message to Outbox table (status: 'pending')
   - Show optimistic update in UI
   - POST /reply (with clientMsgId)

2. **On Success (200 OK)**:
   - Delete from Outbox table
   - Keep message in chat history

3. **On Failure or No Response**:
   - Leave in Outbox (status: 'pending')
   - Background worker retries with exponential backoff

4. **On App Restart**:
   - Read pending messages from Outbox
   - Retry sending automatically
   - Use same clientMsgId (ensures idempotency)

**Background Worker**:
```dart
Future<void> _retryOutboxMessages() async {
  final pending = await messageOutboxService.getPendingMessages();
  
  for (final message in pending) {
    if (DateTime.now().millisecondsSinceEpoch - message.lastRetryAt < backoffMs(message.retryCount)) {
      continue; // Not ready to retry yet
    }
    
    try {
      await chatApi.sendDirectMessage({
        clientMessageId: message.clientMsgId,
        reply: message.body,
        ...
      });
      
      // Only delete on successful response
      await messageOutboxService.delete(message.id);
    } catch {
      // Increment retry count, update lastRetryAt
      await messageOutboxService.incrementRetry(message.id);
    }
  }
}

// Runs:
// - Every 30 seconds (timer)
// - On app startup
// - On network connectivity change
// - On WebSocket reconnection
```

**Why it works**:
- Messages survive app crashes (persisted in SQLite)
- Same clientMsgId ensures Redis/MySQL dedup catches it
- Exponential backoff prevents overwhelming server
- Automatic retry on app restart
- No manual user action needed

---

### Phase 7: Testing & Validation ⏳

**Scenarios to Test**:

1. **Duplicate Prevention**
   - Send message, simulate retry (same clientMsgId)
   - Verify: Only 1 row in Logs, deduped response returned
   - Test Redis cache hit and miss
   - Test MySQL UNIQUE constraint fallback

2. **Offline Recovery**
   - App sends message while offline
   - Message stored in Outbox (SQLite)
   - Reconnect to network
   - Verify: Message sent with same clientMsgId
   - Check: Redis/MySQL dedup doesn't duplicate

3. **Server Restart Resilience**
   - Send message (stored in Redis + MySQL)
   - Restart server
   - Client retries with same clientMsgId
   - Verify: Returns deduped success (MySQL UNIQUE constraint)

4. **Atomic Transaction**
   - Send message
   - Verify: Both MessageActivities AND Logs rows present
   - Inject failure between two inserts
   - Verify: Transaction rolls back, neither row created

5. **Sequence Number Ordering**
   - Send 10 messages rapidly
   - Verify: Each has unique pts (monotonically increasing)
   - Client syncs: `SELECT * FROM Logs WHERE pts > 5`
   - Verify: Results sorted by pts, no gaps

6. **Redis Fallback**
   - Disable Redis connection
   - Send message
   - Verify: Still deduped via in-memory + MySQL UNIQUE
   - Re-enable Redis
   - Verify: New messages use Redis

---

## Data Flow Diagram

### Send Message Flow (with all protections)

```
┌─────────────────────────────────────────┐
│ CLIENT (Flutter)                         │
│                                         │
│ User sends message                      │
│  - Persist to Outbox (SQLite)           │
│  - Show optimistic UI update            │
│  - POST /reply {clientMsgId, ...}       │
└────────────┬────────────────────────────┘
             │
             ↓
┌─────────────────────────────────────────┐
│ SERVER.JS                                │
│                                         │
│ 1. Check Redis                          │
│    msg_processed:{clientMsgId}?         │
│    → If found: return deduped success   │
│                                         │
│ 2. Generate pts                         │
│    INCR pts:{groupId}                   │
│    → Monotonic sequence number          │
│                                         │
│ 3. Atomic Transaction (MySQL)           │
│    BEGIN                                │
│      INSERT MessageActivities ✓         │
│      INSERT Logs ✓                      │
│    COMMIT                               │
│    ← If ER_DUP_ENTRY: return success    │
│                                         │
│ 4. Mark in Redis (24h TTL)              │
│    SETEX msg_processed:{clientMsgId}    │
│                                         │
│ 5. Queue to recipients                  │
│    addToQueue(recipients, message)      │
│                                         │
│ 6. Send FCM push notification           │
│    sendPushNotificationToUser(...)      │
│                                         │
└─────────────────────────────────────────┘
             │
             ↓
┌─────────────────────────────────────────┐
│ RECIPIENT DEVICES                       │
│                                         │
│ 1. FCM notification received            │
│ 2. Trigger sync: POST /messages/sync    │
│    {since_pts: 1045}                    │
│    ← Returns messages with pts > 1045   │
│ 3. Or: App resumed → trigger sync       │
│ 4. Or: WebSocket reconnected → sync     │
│                                         │
│ App displays message                    │
│                                         │
└─────────────────────────────────────────┘
             │
             ↓
┌─────────────────────────────────────────┐
│ SENDER DEVICE                           │
│                                         │
│ Receive 200 OK response                 │
│ → Delete from Outbox (SQLite)           │
│ → Mark as "sent" in chat history        │
│                                         │
└─────────────────────────────────────────┘
```

---

## Database Schema Changes

### MessageActivities Table
```sql
ALTER TABLE `MessageActivities` 
ADD UNIQUE INDEX `uk_client_msg_id_idempotency` (`ClientMsgId`);
-- Allows NULL for non-message activities (reactions, edits)
-- Prevents duplicate insertions on retry
```

### Logs Table
```sql
ALTER TABLE `Logs` 
ADD COLUMN `pts` BIGINT DEFAULT NULL;

CREATE INDEX `idx_logs_pts` ON `Logs` (`pts`, `From`, `ToUser`);
-- Used by /messages/sync endpoint: SELECT * WHERE pts > client_last_pts
-- Ensures strict chronological ordering
```

---

## Redis Keys & TTLs

| Key | TTL | Purpose |
|-----|-----|---------|
| `msg_processed:{clientMsgId}` | 86400s (24h) | Idempotency cache for messages |
| `pts:{groupId}` | ∞ (persistent) | Monotonic sequence counter |

---

## Server Configuration

Environment variables to add/verify:

```bash
# Redis connection (existing)
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_PASSWORD=...

# Message dedup TTL (existing)
RECENT_REPLY_MESSAGE_TTL_MS=600000  # 10 minutes (in-memory fallback)

# Message pts TTL (new)
# No config needed — Redis INCR is persistent
```

---

## Compatibility

- **Backward Compatible**: Old clients without clientMsgId still work (no dedup, but not broken)
- **Graceful Degradation**: Each phase has fallbacks
- **Database Migrations**: All applied automatically on server startup
- **No Breaking Changes**: Existing endpoints unchanged

---

## Performance Impact

| Operation | Before | After | Improvement |
|-----------|--------|-------|-------------|
| Check duplicate | O(1) memory | O(1) Redis + O(1) MySQL | ✅ Survives restart |
| Insert message | 1 async call (lost on crash) | 1 atomic transaction | ✅ Guaranteed delivery |
| Sync messages | O(n) in-memory queue | O(log n) by pts index | ✅ Index-backed query |
| Sequence generation | In-app timestamp | Redis INCR atomic | ✅ Globally monotonic |

---

## Known Limitations & Future Work

1. **Redis Dependency**: If Redis and MySQL both down, cannot generate sequence numbers
   - Fallback: Use app-local timestamps (orders by time, not guaranteed monotonic)
   
2. **Outbox Size**: Large outbox (100+ pending) could slow SQLite
   - Mitigation: Aggressive retry strategy, trim old entries
   
3. **Multi-Server Deployment**: Redis pts counter shared across servers
   - Current: Works correctly with Redis
   - Future: Shard by groupId if needed

4. **Message Ordering Race**: If client sends 2 messages very quickly, pts might not reflect send order
   - Reason: Network jitter
   - Mitigation: Client timestamps + client-side sorting

---

## Verification Checklist

Before deploying:

- [ ] Database migrations run successfully
- [ ] Redis connection working
- [ ] Transaction support tested with injection failures
- [ ] UNIQUE constraint prevents duplicates
- [ ] pts counter increments correctly
- [ ] Flutter Outbox table created and functional
- [ ] Multi-trigger sync working (FCM, lifecycle, websocket)
- [ ] Fallback chains tested (Redis down, MySQL constraint)
- [ ] Load test with 1000+ messages/sec
- [ ] Offline scenario tested (app closed, messages sent)

---

## Rollback Plan

If critical issues found:

1. **Stop server** (graceful shutdown to complete in-flight transactions)
2. **Remove UNIQUE constraint**: `ALTER TABLE MessageActivities DROP INDEX uk_client_msg_id_idempotency;`
3. **Disable Redis caching**: Set `RECENT_REPLY_MESSAGE_TTL_MS` to 10min (in-memory fallback)
4. **Revert to old transaction**: Remove `insertMessageActivityAndLog()` call, use separate inserts
5. **Restart with old code**

---

## Support & Monitoring

**Key Metrics to Monitor**:
- `msg_processed:*` cache hit rate (should be >95% after warmup)
- Message dedup rate (should be 0.01% in normal operation, 50%+ during retries)
- Transaction rollback count (should be 0)
- /messages/sync latency (should be <100ms for 1000 messages)
- Outbox size by user (should be <5 pending messages)

**Logging**:
- `[IDEMPOTENCY]` — Redis dedup events
- `[TRANSACTION]` — MySQL transaction events
- `[PTS-GENERATION]` — Sequence number generation
- `[REPLY]` — Message processing flow

---

## References

- **Pull Request**: #125 (Reliability Architecture)
- **Issue**: Duplicate notifications, missing messages
- **Architecture Revision**: v2.0 (Zero-Duplicate, Zero-Missing)

