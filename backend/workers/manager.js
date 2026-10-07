/**
 * Worker Manager
 * 
 * Centralized manager for all background workers.
 * Handles initialization, startup, shutdown, and monitoring of:
 * - FCM notifications worker
 * - WebSocket fan-out worker
 * - Future worker types
 */

const { createFcmWorker } = require('./fcm.worker');
const { createWebSocketFanoutManager, createSocketConnectionHandler, createUserIdentificationMiddleware } = require('./websocket-fanout.worker');
const { createRedisStreamsManager } = require('../services/redis-streams');

/**
 * Initialize all background workers
 * @param {Object} config - Configuration object
 * @param {Object} config.redis - Redis client
 * @param {Object} config.io - Socket.io server instance
 * @param {Object} config.dbPool - Database connection pool
 * @param {Object} config.firebaseApp - Firebase Admin app
 * @returns {Promise<Object>} Workers manager instance
 */
async function initializeWorkers(config = {}) {
    const {
        redis,
        io,
        dbPool,
        firebaseApp
    } = config;

    if (!redis) {
        throw new Error('Redis client required for worker initialization');
    }

    const workers = {
        fcm: null,
        websocketFanout: null,
        redisStreams: null
    };

    const eventListeners = [];

    /**
     * Start all workers
     */
    const startAllWorkers = async () => {
        console.log('[Workers] Starting all background workers...');

        try {
            // Initialize Redis Streams manager
            if (redis) {
                workers.redisStreams = createRedisStreamsManager(redis);
                await workers.redisStreams.initializeConsumerGroup();
                console.log('[Workers] Redis Streams manager initialized');
            }

            // Start FCM worker
            if (firebaseApp && redis && dbPool) {
                workers.fcm = createFcmWorker({
                    redis,
                    redisStreams: workers.redisStreams,
                    dbPool,
                    firebaseApp,
                    concurrency: parseInt(process.env.FCM_WORKER_CONCURRENCY || '5')
                });
                console.log('[Workers] FCM worker started');
            } else {
                console.warn('[Workers] Skipping FCM worker - missing dependencies');
            }

            // Start WebSocket fan-out manager
            if (io && redis) {
                workers.websocketFanout = createWebSocketFanoutManager({
                    redis,
                    io,
                    dbPool,
                    batchSize: parseInt(process.env.WS_FANOUT_BATCH_SIZE || '10'),
                    blockMs: parseInt(process.env.WS_FANOUT_BLOCK_MS || '1000')
                });

                // Set up Socket.io middleware and connection handler
                if (io.use && typeof io.use === 'function') {
                    io.use(createUserIdentificationMiddleware());
                }

                io.on('connection', createSocketConnectionHandler(workers.websocketFanout));

                // Start fan-out processing loop
                await workers.websocketFanout.start();
                console.log('[Workers] WebSocket fan-out manager started');
            } else {
                console.warn('[Workers] Skipping WebSocket fan-out - missing dependencies');
            }

            console.log('[Workers] All workers started successfully');
            return workers;

        } catch (error) {
            console.error('[Workers] Failed to start workers:', error.message);
            // Attempt cleanup on failure
            await stopAllWorkers();
            throw error;
        }
    };

    /**
     * Stop all workers gracefully
     */
    const stopAllWorkers = async () => {
        console.log('[Workers] Stopping all workers...');

        try {
            // Stop FCM worker
            if (workers.fcm && typeof workers.fcm.close === 'function') {
                await workers.fcm.close();
                console.log('[Workers] FCM worker stopped');
            }

            // Stop WebSocket fan-out
            if (workers.websocketFanout && typeof workers.websocketFanout.stop === 'function') {
                await workers.websocketFanout.stop();
                console.log('[Workers] WebSocket fan-out stopped');
            }

            console.log('[Workers] All workers stopped');

        } catch (error) {
            console.error('[Workers] Error stopping workers:', error.message);
            // Continue trying to stop other workers despite errors
        }
    };

    /**
     * Get statistics from all workers
     */
    const getWorkersStats = () => {
        const stats = {
            timestamp: new Date().toISOString(),
            workers: {}
        };

        if (workers.fcm) {
            stats.workers.fcm = {
                type: 'BullMQ Queue Consumer',
                queueName: 'fcm-notifications'
                // Additional stats can be fetched from queue
            };
        }

        if (workers.websocketFanout) {
            stats.workers.websocketFanout = workers.websocketFanout.getStats();
        }

        if (workers.redisStreams) {
            stats.workers.redisStreams = workers.redisStreams.getStreamStats();
        }

        return stats;
    };

    /**
     * Queue a message for FCM delivery
     * Used by message controller to queue notifications
     */
    const queueFcmJob = async (jobData) => {
        if (!workers.fcm) {
            console.warn('[Workers] FCM worker not initialized');
            return null;
        }

        const queue = workers.fcm.queue || null;
        if (!queue) {
            throw new Error('FCM worker queue not available');
        }

        // Add job to queue with default options
        const job = await queue.add(jobData, {
            attempts: 6,
            backoff: {
                type: 'exponential',
                delay: 1000
            },
            removeOnComplete: {
                age: 3600 // Remove after 1 hour
            },
            removeOnFail: {
                age: 86400 // Keep for 24 hours
            }
        });

        console.log(`[Workers] Queued FCM job: ${job.id}`);
        return job.id;
    };

    /**
     * Send message via WebSocket fan-out (immediate, not queued)
     * Used for real-time notifications to connected clients
     */
    const sendWebSocketMessage = (userId, payload) => {
        if (!workers.websocketFanout) {
            console.warn('[Workers] WebSocket fan-out not initialized');
            return false;
        }

        workers.websocketFanout.sendToUser(userId, payload);
        return true;
    };

    /**
     * Broadcast message to all connected clients
     */
    const broadcastMessage = (payload) => {
        if (!workers.websocketFanout) {
            console.warn('[Workers] WebSocket fan-out not initialized');
            return false;
        }

        workers.websocketFanout.broadcast(payload);
        return true;
    };

    /**
     * Add stream event (for monitoring and fan-out via Redis Streams)
     */
    const addStreamEvent = async (eventData) => {
        if (!workers.redisStreams) {
            console.warn('[Workers] Redis Streams not initialized');
            return null;
        }

        try {
            const messageId = await workers.redisStreams.appendMessage(eventData);
            return messageId;
        } catch (error) {
            console.error('[Workers] Failed to add stream event:', error.message);
            return null;
        }
    };

    return {
        startAllWorkers,
        stopAllWorkers,
        getWorkersStats,
        queueFcmJob,
        sendWebSocketMessage,
        broadcastMessage,
        addStreamEvent,
        workers
    };
}

/**
 * Setup graceful shutdown handler
 * Ensures workers are stopped cleanly on process termination
 */
function setupGracefulShutdown(workersManager) {
    const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'];

    signals.forEach(signal => {
        process.on(signal, async () => {
            console.log(`\n[Process] Received ${signal}, shutting down workers...`);
            
            try {
                if (workersManager && typeof workersManager.stopAllWorkers === 'function') {
                    await workersManager.stopAllWorkers();
                }
                console.log('[Process] Graceful shutdown complete');
                process.exit(0);
            } catch (error) {
                console.error('[Process] Error during shutdown:', error.message);
                process.exit(1);
            }
        });
    });

    // Handle uncaught exceptions
    process.on('uncaughtException', (error) => {
        console.error('[Process] Uncaught exception:', error);
        workersManager.stopAllWorkers().then(() => process.exit(1));
    });

    // Handle unhandled promise rejections
    process.on('unhandledRejection', (reason, promise) => {
        console.error('[Process] Unhandled rejection:', reason);
    });
}

/**
 * Health check endpoint data for monitoring
 */
function getWorkersHealthCheck(workersManager) {
    const stats = workersManager.getWorkersStats();
    
    return {
        status: 'ok',
        timestamp: stats.timestamp,
        workers: Object.keys(stats.workers).map(name => ({
            name,
            initialized: !!stats.workers[name],
            stats: stats.workers[name]
        }))
    };
}

module.exports = {
    initializeWorkers,
    setupGracefulShutdown,
    getWorkersHealthCheck
};
