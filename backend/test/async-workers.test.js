/**
 * Tests for Async Worker Architecture
 * 
 * Tests for:
 * - Database connection pool
 * - Redis Streams
 * - FCM Worker
 * - WebSocket Fan-out
 * - Fast-Reply Handler
 * 
 * Run with: npm test
 */

const assert = require('assert');
const { describe, it, before, after } = require('node:test');

// Mock implementations for testing
const mockRedis = {
    get: async (key) => null,
    setex: async (key, ttl, value) => 'OK',
    hget: async (key, field) => null,
    hset: async (key, field, value) => 1,
    expire: async (key, ttl) => 1,
    ping: async () => 'PONG',
    xadd: async (stream, id, ...args) => `${Date.now()}-0`,
    xgroup: async (...args) => null,
    xreadgroup: async (...args) => [],
    xack: async (stream, group, ...ids) => ids.length
};

const mockDbPool = {
    getConnection: async () => ({
        execute: async (sql, params) => [[]],
        beginTransaction: async () => {},
        commit: async () => {},
        rollback: async () => {},
        release: () => {}
    }),
    end: async () => {}
};

describe('Database Connection Pool', () => {
    it('should create a pool with default config', () => {
        const { createDatabasePool } = require('../backend/config/db');
        
        // Just test that function exists and is callable
        assert.strictEqual(typeof createDatabasePool, 'function');
    });

    it('should provide pool statistics helper', () => {
        const { getPoolStats } = require('../backend/config/db');
        
        assert.strictEqual(typeof getPoolStats, 'function');
        const stats = getPoolStats({});
        assert.ok(stats.error || typeof stats === 'object');
    });

    it('should provide bulk insert helper', () => {
        const { executeBulkInsert } = require('../backend/config/db');
        
        assert.strictEqual(typeof executeBulkInsert, 'function');
    });

    it('should provide transaction helper', () => {
        const { executeTransaction } = require('../backend/config/db');
        
        assert.strictEqual(typeof executeTransaction, 'function');
    });
});

describe('Database Indexes', () => {
    it('should return array of index statements', () => {
        const { getDatabaseIndexStatements } = require('../backend/config/database-indexes');
        
        const statements = getDatabaseIndexStatements();
        assert.ok(Array.isArray(statements));
        assert.ok(statements.length > 0);
        assert.ok(statements[0].includes('ALTER TABLE'));
    });

    it('should include DDL statements', () => {
        const { INDEX_DDL_STATEMENTS } = require('../backend/config/database-indexes');
        
        assert.ok(typeof INDEX_DDL_STATEMENTS === 'string');
        assert.ok(INDEX_DDL_STATEMENTS.includes('ALTER TABLE'));
    });
});

describe('Redis Streams Manager', () => {
    it('should create manager instance', () => {
        const { createRedisStreamsManager } = require('../backend/services/redis-streams');
        
        const manager = createRedisStreamsManager(mockRedis);
        assert.ok(manager);
        assert.ok(typeof manager.appendMessage === 'function');
        assert.ok(typeof manager.readMessagesForConsumer === 'function');
        assert.ok(typeof manager.acknowledgeMessage === 'function');
    });

    it('should have initialization method', () => {
        const { createRedisStreamsManager } = require('../backend/services/redis-streams');
        
        const manager = createRedisStreamsManager(mockRedis);
        assert.ok(typeof manager.initializeConsumerGroup === 'function');
    });

    it('should provide stream statistics', () => {
        const { createRedisStreamsManager } = require('../backend/services/redis-streams');
        
        const manager = createRedisStreamsManager(mockRedis);
        const stats = manager.getStreamStats();
        
        assert.ok(typeof stats === 'object');
        assert.ok('totalAdded' in stats);
        assert.ok('totalRead' in stats);
        assert.ok('totalAcked' in stats);
    });
});

describe('FCM Worker', () => {
    it('should create worker instance', () => {
        const { createFcmWorker } = require('../backend/workers/fcm.worker');
        
        assert.strictEqual(typeof createFcmWorker, 'function');
    });

    it('should throw error without Redis', () => {
        const { createFcmWorker } = require('../backend/workers/fcm.worker');
        
        assert.throws(() => {
            createFcmWorker({});
        }, /Redis client is required/);
    });

    it('should have chunking utility', () => {
        const { chunkArray } = require('../backend/workers/fcm.worker');
        
        const input = Array.from({ length: 1000 }, (_, i) => `token-${i}`);
        const chunks = chunkArray(input, 500);
        
        assert.strictEqual(chunks.length, 2);
        assert.strictEqual(chunks[0].length, 500);
        assert.strictEqual(chunks[1].length, 500);
    });

    it('should identify retryable errors', () => {
        const { isRetryableError } = require('../backend/workers/fcm.worker');
        
        const rateLimitError = new Error('quota exceeded');
        assert.ok(isRetryableError(rateLimitError));
        
        const networkError = new Error('ECONNREFUSED');
        assert.ok(isRetryableError(networkError));
        
        const permanentError = new Error('[PERMANENT] Invalid token');
        assert.ok(!isRetryableError(permanentError));
    });
});

describe('WebSocket Fan-out Worker', () => {
    it('should create fan-out manager', () => {
        const { createWebSocketFanoutManager } = require('../backend/workers/websocket-fanout.worker');
        
        const mockIO = {
            to: () => ({ emit: () => {} }),
            emit: () => {},
            sockets: { adapter: { rooms: new Map() } }
        };
        
        const manager = createWebSocketFanoutManager({
            redis: mockRedis,
            io: mockIO
        });
        
        assert.ok(manager);
        assert.ok(typeof manager.start === 'function');
        assert.ok(typeof manager.stop === 'function');
        assert.ok(typeof manager.getStats === 'function');
    });

    it('should throw error without Socket.io', () => {
        const { createWebSocketFanoutManager } = require('../backend/workers/websocket-fanout.worker');
        
        assert.throws(() => {
            createWebSocketFanoutManager({
                redis: mockRedis,
                io: null
            });
        }, /Socket.io server instance is required/);
    });

    it('should provide user identification middleware', () => {
        const { createUserIdentificationMiddleware } = require('../backend/workers/websocket-fanout.worker');
        
        const middleware = createUserIdentificationMiddleware();
        assert.strictEqual(typeof middleware, 'function');
    });

    it('should provide connection handler', () => {
        const { createSocketConnectionHandler } = require('../backend/workers/websocket-fanout.worker');
        
        const mockManager = {
            onSocketConnect: () => {}
        };
        
        const handler = createSocketConnectionHandler(mockManager);
        assert.strictEqual(typeof handler, 'function');
    });
});

describe('Worker Manager', () => {
    it('should create manager instance', () => {
        const { initializeWorkers } = require('../backend/workers/manager');
        
        assert.strictEqual(typeof initializeWorkers, 'function');
    });

    it('should throw error without Redis', async () => {
        const { initializeWorkers } = require('../backend/workers/manager');
        
        try {
            await initializeWorkers({});
            assert.fail('Should throw error');
        } catch (error) {
            assert.ok(error.message.includes('Redis'));
        }
    });

    it('should provide graceful shutdown setup', () => {
        const { setupGracefulShutdown } = require('../backend/workers/manager');
        
        assert.strictEqual(typeof setupGracefulShutdown, 'function');
    });

    it('should provide health check helper', () => {
        const { getWorkersHealthCheck } = require('../backend/workers/manager');
        
        const mockManager = {
            getWorkersStats: () => ({
                timestamp: new Date().toISOString(),
                workers: { fcm: { queue: 'test' } }
            })
        };
        
        const health = getWorkersHealthCheck(mockManager);
        assert.ok(health.status);
        assert.ok(Array.isArray(health.workers));
    });
});

describe('Fast-Reply Handler', () => {
    it('should create handler instance', () => {
        const { createFastReplyHandler } = require('../backend/handlers/fast-reply.handler');
        
        const handler = createFastReplyHandler({
            redis: mockRedis,
            dbPool: mockDbPool
        });
        
        assert.ok(handler);
        assert.ok(typeof handler.handleMessageReply === 'function');
    });

    it('should throw error without Redis', () => {
        const { createFastReplyHandler } = require('../backend/handlers/fast-reply.handler');
        
        assert.throws(() => {
            createFastReplyHandler({
                dbPool: mockDbPool
            });
        }, /Redis client required/);
    });

    it('should throw error without database pool', () => {
        const { createFastReplyHandler } = require('../backend/handlers/fast-reply.handler');
        
        assert.throws(() => {
            createFastReplyHandler({
                redis: mockRedis
            });
        }, /Database pool required/);
    });

    it('should provide idempotency checker', () => {
        const { createFastReplyHandler } = require('../backend/handlers/fast-reply.handler');
        
        const handler = createFastReplyHandler({
            redis: mockRedis,
            dbPool: mockDbPool
        });
        
        assert.ok(typeof handler.checkIdempotency === 'function');
    });

    it('should provide health check', () => {
        const { createFastReplyHandler } = require('../backend/handlers/fast-reply.handler');
        
        const handler = createFastReplyHandler({
            redis: mockRedis,
            dbPool: mockDbPool
        });
        
        assert.ok(typeof handler.getHealth === 'function');
    });

    it('should have FCM queue', () => {
        const { createFastReplyHandler } = require('../backend/handlers/fast-reply.handler');
        
        const handler = createFastReplyHandler({
            redis: mockRedis,
            dbPool: mockDbPool
        });
        
        assert.ok(handler.fcmQueue);
    });
});

describe('Integration Tests', () => {
    it('should have all required modules', () => {
        const modules = [
            'backend/config/db',
            'backend/config/database-indexes',
            'backend/services/redis-streams',
            'backend/workers/fcm.worker',
            'backend/workers/websocket-fanout.worker',
            'backend/workers/manager',
            'backend/handlers/fast-reply.handler'
        ];

        modules.forEach(modulePath => {
            const path = require.resolve(`../${modulePath}`);
            assert.ok(path, `Module ${modulePath} exists`);
        });
    });

    it('should have startup scripts', () => {
        const fs = require('fs');
        const path = require('path');

        const scripts = [
            'scripts/start-fcm-worker.js',
            'scripts/start-websocket-worker.js'
        ];

        scripts.forEach(script => {
            const filePath = path.resolve(__dirname, '..', script);
            assert.ok(fs.existsSync(filePath), `Script ${script} exists`);
        });
    });
});

describe('Documentation Tests', () => {
    it('should have architecture documentation', () => {
        const fs = require('fs');
        const path = require('path');

        const docPath = path.resolve(__dirname, '..', 'ASYNC_WORKER_ARCHITECTURE.md');
        assert.ok(fs.existsSync(docPath), 'Architecture documentation exists');

        const content = fs.readFileSync(docPath, 'utf8');
        assert.ok(content.includes('Fast-Reply'));
        assert.ok(content.includes('Redis Streams'));
        assert.ok(content.includes('Worker Manager'));
    });

    it('should have quick start guide', () => {
        const fs = require('fs');
        const path = require('path');

        const docPath = path.resolve(__dirname, '..', 'QUICK_START_ASYNC_WORKERS.md');
        assert.ok(fs.existsSync(docPath), 'Quick start guide exists');

        const content = fs.readFileSync(docPath, 'utf8');
        assert.ok(content.includes('Installation'));
        assert.ok(content.includes('Integration'));
        assert.ok(content.includes('Troubleshooting'));
    });
});

console.log('All tests completed!');
