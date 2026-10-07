# Quick Start Guide - Event-Driven Worker Architecture

## 1. Installation

### Step 1: Install Dependencies

The main dependency (BullMQ) is already installed. Verify with:

```bash
npm list bullmq
```

### Step 2: Update Environment Variables

Add to your `.env` file:

```bash
# Database Connection Pool
DB_POOL_SIZE=20
DB_MAX_IDLE_MS=60000
DB_QUEUE_LIMIT=0

# Workers
FCM_WORKER_CONCURRENCY=5
WS_FANOUT_BATCH_SIZE=10
WS_FANOUT_BLOCK_MS=1000

# Firebase (if not already set)
FIREBASE_SERVICE_ACCOUNT_JSON='{"type":"service_account","project_id":"..."}'

# Redis (if not using default localhost:6379)
REDIS_HOST=redis
REDIS_PORT=6379
```

### Step 3: Create Database Indexes

Run this once on your production database:

```bash
node -e "
const { createDatabasePool } = require('./backend/config/db');
const { createOptimizationIndexes } = require('./backend/config/database-indexes');

(async () => {
    const pool = createDatabasePool();
    await createOptimizationIndexes(pool);
    await pool.end();
    console.log('Indexes created successfully');
})();
"
```

## 2. Integration into Existing Server

### Option A: Minimal Integration (Add to existing server.js)

Add these imports at the top:

```javascript
const { initializeWorkers, setupGracefulShutdown } = require('./backend/workers/manager');
const { createFastReplyHandler } = require('./backend/handlers/fast-reply.handler');
const { createDatabasePool } = require('./backend/config/db');
const redis = require('redis');
```

After creating `app` and `httpServer`:

```javascript
// Initialize database pool
const dbPool = createDatabasePool();

// Initialize Redis client
const redisClient = redis.createClient({
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379')
});

// Initialize workers
let workersManager;
httpServer.listen(3000, async () => {
    try {
        workersManager = await initializeWorkers({
            redis: redisClient,
            io: socketIOServer, // If using Socket.io
            dbPool,
            firebaseApp // If configured
        });

        await workersManager.startAllWorkers();
        console.log('Workers started successfully');

        setupGracefulShutdown(workersManager);
    } catch (error) {
        console.error('Worker initialization failed:', error.message);
        process.exit(1);
    }
});
```

### Option B: Run Workers as Separate Processes

In production, workers should run in separate containers for better resource isolation:

```bash
# Terminal 1: Main API Server
node server.js

# Terminal 2: FCM Worker
node scripts/start-fcm-worker.js

# Terminal 3: WebSocket Worker
node scripts/start-websocket-worker.js
```

Or with Docker Compose (see ASYNC_WORKER_ARCHITECTURE.md).

## 3. Using the Fast-Reply Pattern

### Option 1: As Express Route Handler

```javascript
const { createFastReplyHandler } = require('./backend/handlers/fast-reply.handler');

const fastReplyHandler = createFastReplyHandler({
    redis: redisClient,
    dbPool,
    workersManager
});

app.post('/api/v1/messages/reply',
    requireAuthorizedUser,
    fastReplyHandler.handleMessageReply
);

// Health check endpoint
app.get('/health/workers', async (req, res) => {
    const health = await fastReplyHandler.getHealth();
    res.status(health.healthy ? 200 : 503).json(health);
});
```

### Option 2: Manual Integration in Existing Controller

```javascript
const { createFastReplyHandler } = require('./backend/handlers/fast-reply.handler');

function registerMessageController(app, deps = {}) {
    const fastReplyHandler = createFastReplyHandler({
        redis: deps.redis,
        dbPool: deps.dbPool,
        workersManager: deps.workersManager
    });

    app.post('/api/messages/reply', fastReplyHandler.handleMessageReply);
}
```

## 4. Client API

The client sends messages to the new endpoint:

```javascript
// Client-side (Flutter/Web)
const response = await fetch('/api/v1/messages/reply', {
    method: 'POST',
    headers: {
        'Content-Type': 'application/json',
        'Authorization': `******
    },
    body: JSON.stringify({
        clientMsgId: `msg-${Date.now()}-${Math.random()}`, // Unique per client
        groupId: 'group-123',
        content: 'Hello World',
        payload: {
            content: 'Hello World',
            senderName: 'John Doe',
            type: 'text'
        },
        recipients: ['user1', 'user2', 'user3'], // List of recipient IDs
        priority: 'normal' // or 'high'
    })
});

const result = await response.json();
console.log('Response time:', result.responseTimeMs, 'ms');
console.log('FCM Job ID:', result.jobs.fcm);
console.log('Stream Event ID:', result.jobs.stream);
```

Expected response (< 30ms):

```json
{
    "status": "accepted",
    "message": "Message queued for delivery",
    "serverMessageId": 12345,
    "pts": 1,
    "timestamp": "2024-01-01T12:00:00.000Z",
    "jobs": {
        "fcm": "550e8400-e29b-41d4-a716-446655440000",
        "stream": "1704110400000-0"
    },
    "responseTimeMs": 24
}
```

## 5. Monitoring

### Check Worker Health

```bash
# API Health
curl http://localhost:3000/health

# Response should show:
{
    "healthy": true,
    "checks": {
        "redis": true,
        "database": true,
        "queue": true
    }
}
```

### View Worker Statistics

```javascript
const stats = workersManager.getWorkersStats();
console.log(JSON.stringify(stats, null, 2));
```

Output:
```json
{
    "timestamp": "2024-01-01T12:00:00.000Z",
    "workers": {
        "fcm": {
            "type": "BullMQ Queue Consumer",
            "queueName": "fcm-notifications"
        },
        "websocketFanout": {
            "messagesRead": 250,
            "messagesDelivered": 245,
            "messagesFailed": 5,
            "connectionsActive": 32,
            "bytesTransferred": 125000,
            "activeConnections": {
                "user1": 2,
                "user2": 1,
                "user3": 3
            }
        },
        "redisStreams": {
            "totalAdded": 250,
            "totalRead": 250,
            "totalAcked": 245,
            "streamName": "message-events",
            "consumerGroup": "websocket-group"
        }
    }
}
```

## 6. Performance Testing

### Load Test the API

```bash
# Using wrk (install from https://github.com/wg/wrk)
wrk -t12 -c400 -d30s --latency \
    -s load_test.lua \
    http://localhost:3000/api/v1/messages/reply
```

Create `load_test.lua`:
```lua
request = function()
    wrk.method = "POST"
    wrk.headers["Content-Type"] = "application/json"
    wrk.headers["Authorization"] = "******"
    wrk.body = string.format('{
        "clientMsgId": "msg-%d",
        "groupId": "group-123",
        "content": "Test message",
        "recipients": ["user1", "user2"]
    }', math.random(1000000))
    return wrk.format(nil)
end
```

### Expected Results

With 12 threads and 400 concurrent connections:

- **Latency**: 15-30ms (p50), 30-50ms (p95)
- **Throughput**: 100-300 requests/sec per instance
- **CPU**: 10-20% per core
- **Memory**: ~200-400MB

## 7. Troubleshooting

### Workers Not Starting

```bash
# Check logs
docker logs <worker-container>

# Verify Redis connectivity
redis-cli -h $REDIS_HOST -p $REDIS_PORT ping

# Check database connection
mysql -h $MYSQL_HOST -u $MYSQL_USER -p $MYSQL_PASSWORD -e "SELECT 1"
```

### High Response Times

```javascript
// Check pool stats
const { getPoolStats } = require('./backend/config/db');
console.log(getPoolStats(dbPool));

// If activeConnections is high, increase pool size
// Set DB_POOL_SIZE=50 and restart
```

### Messages Not Delivering

```javascript
// Check FCM queue
const queue = fastReplyHandler.fcmQueue;
const failed = await queue.getFailed(0, 10);
failed.forEach(job => {
    console.log(`Job ${job.id}: ${job.failedReason}`);
});

// Check streams
const groupInfo = await workersManager.workers.redisStreams.getConsumerGroupInfo();
console.log('Pending:', groupInfo.pending);
```

## 8. Next Steps

1. **Test in staging**: Deploy to a staging environment first
2. **Monitor metrics**: Set up alerts for response times and error rates
3. **Optimize pool sizes**: Adjust `DB_POOL_SIZE` and `FCM_WORKER_CONCURRENCY` based on load
4. **Scale horizontally**: Add more worker instances as traffic grows
5. **Implement circuit breaker**: Add fallback logic if Firebase is unavailable

## References

- Full Documentation: [ASYNC_WORKER_ARCHITECTURE.md](./ASYNC_WORKER_ARCHITECTURE.md)
- BullMQ: https://docs.bullmq.io/
- Redis Streams: https://redis.io/docs/data-types/streams/
- Socket.io: https://socket.io/docs/
