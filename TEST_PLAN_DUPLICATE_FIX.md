# Duplicate Notification Fix - Test Plan

## Quick Verification Steps

### Test 1: Verify Functions Are Present
```bash
# Check that all tracking functions are defined
grep -c "const buildDeliveryKey\|const markMessageAsDelivered\|const isMessageAlreadyDelivered" backend/controllers/message.controller.js
# Expected: 3
```

### Test 2: Check Integration Points
```bash
# Verify functions are called in correct locations
grep -c "markMessageAsDelivered(user, message)" backend/controllers/message.controller.js
# Expected: 2 (sync endpoint + polling endpoint)

grep -c "isMessageAlreadyDelivered(normalizedUser, message)" backend/controllers/message.controller.js
# Expected: 1 (in dedup function)
```

### Test 3: Verify Constants
```bash
# Check TTL configuration
grep "DELIVERED_MESSAGE_ID_TTL_MS\|MAX_DELIVERED_MESSAGE_IDS_PER_USER" backend/controllers/message.controller.js
# Expected output should show 24-hour TTL and 10,000 limit
```

## Automated Test Scenarios

### Scenario A: Basic Delivery Tracking
```javascript
// Pseudo-code for unit test
const message = {
    messageId: 'msg_123',
    chatId: 'grp_456',
    body: 'Hello'
};
const user = '0546799693';

// Mark as delivered
markMessageAsDelivered(user, message);
// Expected: Entry added to deliveredMessageIdsByUser

// Check if already delivered
const result = isMessageAlreadyDelivered(user, message);
// Expected: true

// Verify key format
const key = buildDeliveryKey(message);
// Expected: 'msg_123:grp_456'
```

### Scenario B: Deduplication Prevents Notification
```javascript
// Pseudo-code
const messages = [
    { messageId: 'msg_1', chatId: 'grp_1', body: 'Test' }
];
const user = '0546799693';

// First sync - message delivered
let deduped = dedupePollingMailboxMessages(messages, user);
// Expected: deduped.length = 1, message marked as delivered

// Second sync - same message should be skipped
deduped = dedupePollingMailboxMessages(messages, user);
// Expected: deduped.length = 0 (already delivered)
```

### Scenario C: TTL Expiration (24 hours)
```javascript
// Pseudo-code - simulating time passing
const message = { messageId: 'msg_1', chatId: 'grp_1' };
const user = '0546799693';

// Mark message at time T
markMessageAsDelivered(user, message);
// isMessageAlreadyDelivered(user, message) = true

// Simulate 24 hours passing (in test: mock Date.now())
// OLD_TIMESTAMP = Date.now() - 24*60*60*1000 - 1000
// Manually set in map for testing

// After 24 hours + 1 second
pruneDeliveredMessageIds();
// Expected: Entry removed from map

// Check again
const result = isMessageAlreadyDelivered(user, message);
// Expected: false (outside 24-hour window)
```

### Scenario D: Per-User Storage Limit
```javascript
// Pseudo-code - testing memory management
// Create 10,001 different messages for same user
const user = '0546799693';
for (let i = 0; i < 10001; i++) {
    const message = {
        messageId: `msg_${i}`,
        chatId: 'grp_1',
        body: `Message ${i}`
    };
    markMessageAsDelivered(user, message);
}

const userDeliveries = deliveredMessageIdsByUser.get(user);
// Expected: userDeliveries.size <= 10000 (newest messages kept)
```

### Scenario E: Multiple Users Isolated
```javascript
// Pseudo-code - verify per-user tracking
const message = { messageId: 'msg_1', chatId: 'grp_1' };
const user1 = '0546799693';
const user2 = '0546799694';

markMessageAsDelivered(user1, message);
// user1 sees message as delivered

const result = isMessageAlreadyDelivered(user2, message);
// Expected: false (not delivered to user2, only user1)
```

## Manual Testing Checklist

### Setup
- [ ] Deploy latest changes to backend
- [ ] Deploy Flutter app with push notification support
- [ ] Prepare test group with 3-5 test users

### Test Execution
- [ ] Send message to group → All users receive notification once
- [ ] Kill server process while message in transit
- [ ] Restart server → Message reloaded from database
- [ ] Verify: No duplicate notifications received by users
- [ ] Verify: Users can still see message in chat history
- [ ] Send new message → Notification received normally

### Verification
- [ ] Check backend logs for `[DEDUP]` messages showing duplicates skipped
- [ ] Check `[SYNC-PIPELINE]` logs show correct message counts
- [ ] Verify notification count in Firebase Console (should be 1x per user)
- [ ] Verify message appears in user's chat (UI shows 1 unread indicator)

### Edge Cases
- [ ] Send message, wait 25 hours, resend same message → Should notify again
- [ ] Send 100 messages in rapid succession → No duplicates
- [ ] Simulate high traffic (1000s messages/sec) → No crashes
- [ ] Restart server during peak traffic → No data loss, no duplicates

## Expected Outcomes

### Before Fix
```
[Before] User receives notification for same message 2-3 times
[Before] Chat shows unread indicator increases each time
[Before] User confusion: "Why did I get this message again?"
```

### After Fix
```
[After] User receives notification exactly once per message
[After] Chat shows unread indicator only once
[After] Duplicate notifications eliminated ~99%
```

## Performance Impact

### Memory Usage
- Per 1000 users: ~50MB (with active tracking)
- Per 10,000 users: ~500MB (worst case)
- Pruning reduces over time as old messages expire

### CPU Impact
- Minimal: Hash map lookups are O(1)
- Pruning: O(n) but happens only during dedup calls
- Expected <1% CPU increase

### Network Impact
- No change: Same response sizes returned
- No new endpoints added
- No additional client traffic

## Monitoring & Alerts

### Metrics to Monitor
1. `[DEDUP]` log count (should increase when duplicates prevented)
2. `deliveredMessageIdsByUser` map size
3. Push notification delivery rate (should stabilize)
4. User complaints about duplicate notifications (should drop to ~0)

### Alerts to Set
- Alert if dedup skip rate > 50% of total messages (unusual pattern)
- Alert if memory usage per user exceeds 1MB (possible leak)
- Alert if pruning doesn't run (dedup not being called)

## Rollback Plan

If issues occur:
1. Remove `buildDeliveryKey()`, `markMessageAsDelivered()`, etc. functions
2. Remove integration calls to these functions
3. Remove TTL constant and storage map
4. Redeploy and restart server
5. No database cleanup needed (all in-memory)

## Sign-Off

- [ ] Code review complete
- [ ] Unit tests pass
- [ ] Integration tests pass
- [ ] Manual testing complete
- [ ] Performance acceptable
- [ ] Monitoring configured
- [ ] Ready for production deployment
