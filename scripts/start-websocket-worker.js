#!/usr/bin/env node

/**
 * WebSocket Fan-out Worker Startup Script
 * 
 * Runs the WebSocket message fan-out worker in a separate process.
 * This worker reads messages from Redis Streams and distributes them
 * to connected Socket.io clients.
 * 
 * Note: This is typically integrated into the main server, but can run
 * independently for load distribution.
 * 
 * Usage:
 *   node scripts/start-websocket-worker.js
 * 
 * Environment Variables:
 *   - MYSQL_HOST, MYSQL_PORT, MYSQL_USER, MYSQL_PASSWORD, MYSQL_DATABASE
 *   - REDIS_HOST, REDIS_PORT, REDIS_PASSWORD
 *   - WS_PORT (default: 3001)
 *   - WS_FANOUT_BATCH_SIZE (default: 10)
 *   - WS_FANOUT_BLOCK_MS (default: 1000)
 */

require('dotenv').config();

const redis = require('redis');
const http = require('http');
const { Server: SocketIOServer } = require('socket.io');
const { createDatabasePool } = require('../backend/config/db');
const { createWebSocketFanoutManager, createUserIdentificationMiddleware, createSocketConnectionHandler } = require('../backend/workers/websocket-fanout.worker');
const { createRedisStreamsManager } = require('../backend/services/redis-streams');

/**
 * Initialize Redis client
 */
function initializeRedis() {
    const redisHost = process.env.REDIS_HOST || 'localhost';
    const redisPort = parseInt(process.env.REDIS_PORT || '6379');
    const redisPassword = process.env.REDIS_PASSWORD;

    const client = redis.createClient({
        host: redisHost,
        port: redisPort,
        password: redisPassword,
        retryStrategy: (times) => {
            const delay = Math.min(times * 50, 2000);
            return delay;
        }
    });

    client.on('error', (err) => {
        console.error('[WebSocket Worker] Redis error:', err.message);
    });

    client.on('connect', () => {
        console.log('[WebSocket Worker] Redis connected');
    });

    return client;
}

/**
 * Start the WebSocket fan-out worker
 */
async function startWorker() {
    console.log('[WebSocket Worker] Starting...');
    console.log('[WebSocket Worker] PID:', process.pid);
    console.log('[WebSocket Worker] Environment:');
    console.log('  - REDIS_HOST:', process.env.REDIS_HOST || 'localhost');
    console.log('  - MYSQL_HOST:', process.env.MYSQL_HOST || 'localhost');
    console.log('  - WS_PORT:', process.env.WS_PORT || '3001');

    try {
        // Initialize connections
        const redisClient = initializeRedis();
        const dbPool = createDatabasePool();
        const redisStreams = createRedisStreamsManager(redisClient);

        // Wait for Redis connection
        await new Promise((resolve, reject) => {
            redisClient.on('ready', resolve);
            redisClient.on('error', reject);
            setTimeout(() => reject(new Error('Redis connection timeout')), 10000);
        });

        // Create HTTP server for Socket.io
        const httpServer = http.createServer((req, res) => {
            // Simple health check endpoint
            if (req.url === '/health') {
                res.writeHead(200);
                res.end(JSON.stringify({ status: 'ok', worker: 'websocket-fanout' }));
            } else {
                res.writeHead(404);
                res.end('Not found');
            }
        });

        // Initialize Socket.io with CORS
        const io = new SocketIOServer(httpServer, {
            cors: {
                origin: '*',
                methods: ['GET', 'POST']
            },
            transports: ['websocket', 'polling']
        });

        // Set up Socket.io middleware for user identification
        io.use(createUserIdentificationMiddleware());

        // Create fan-out manager
        const fanoutManager = createWebSocketFanoutManager({
            redis: redisClient,
            io,
            dbPool,
            batchSize: parseInt(process.env.WS_FANOUT_BATCH_SIZE || '10'),
            blockMs: parseInt(process.env.WS_FANOUT_BLOCK_MS || '1000')
        });

        // Handle Socket.io connections
        io.on('connection', createSocketConnectionHandler(fanoutManager));

        // Initialize Redis Streams
        await redisStreams.initializeConsumerGroup();

        // Start fan-out processing
        await fanoutManager.start();

        // Start HTTP server
        const port = parseInt(process.env.WS_PORT || '3001');
        httpServer.listen(port, () => {
            console.log(`[WebSocket Worker] ✓ Listening on port ${port}`);
            console.log('[WebSocket Worker] ✓ Ready to distribute messages');
        });

        // Handle graceful shutdown
        process.on('SIGINT', async () => {
            console.log('[WebSocket Worker] Received SIGINT, shutting down...');
            try {
                await fanoutManager.stop();
                httpServer.close();
                await redisClient.quit();
                await dbPool.end();
                console.log('[WebSocket Worker] Shutdown complete');
                process.exit(0);
            } catch (error) {
                console.error('[WebSocket Worker] Shutdown error:', error.message);
                process.exit(1);
            }
        });

        process.on('SIGTERM', async () => {
            console.log('[WebSocket Worker] Received SIGTERM, shutting down...');
            try {
                await fanoutManager.stop();
                httpServer.close();
                await redisClient.quit();
                await dbPool.end();
                console.log('[WebSocket Worker] Shutdown complete');
                process.exit(0);
            } catch (error) {
                console.error('[WebSocket Worker] Shutdown error:', error.message);
                process.exit(1);
            }
        });

        // Log periodic stats
        setInterval(() => {
            const stats = fanoutManager.getStats();
            console.log('[WebSocket Worker] Stats:', {
                messagesRead: stats.messagesRead,
                messagesDelivered: stats.messagesDelivered,
                activeConnections: stats.connectionsActive,
                uptime: `${Math.floor(process.uptime())}s`
            });
        }, 60000); // Every minute

    } catch (error) {
        console.error('[WebSocket Worker] Startup failed:', error.message);
        process.exit(1);
    }
}

// Start worker
startWorker().catch((error) => {
    console.error('[WebSocket Worker] Fatal error:', error.message);
    process.exit(1);
});
