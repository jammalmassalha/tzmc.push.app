/**
 * WebSocket Fan-out Worker
 * 
 * Handles real-time message distribution to connected WebSocket clients.
 * Consumes messages from Redis Streams and distributes them to connected users.
 * 
 * Features:
 * - Redis Streams consumer for reliable event delivery
 * - Maintains user connections via Socket.io
 * - Fan-out to multiple clients per user
 * - Connection state management
 * - Automatic reconnection handling
 */

const { createRedisStreamsManager } = require('./redis-streams');

/**
 * Create a WebSocket fan-out consumer
 * Reads from Redis Streams and distributes to connected clients
 * @param {Object} config - Configuration object
 * @param {Object} config.redis - Redis client
 * @param {Object} config.io - Socket.io server instance
 * @param {Object} config.dbPool - Database connection pool (optional)
 * @param {number} config.batchSize - Messages to read per iteration (default: 10)
 * @param {number} config.blockMs - Block time for stream reads (default: 1000)
 * @returns {Object} Fan-out manager with start/stop controls
 */
function createWebSocketFanoutManager(config = {}) {
    const {
        redis,
        io,
        dbPool,
        batchSize = 10,
        blockMs = 1000,
        consumerId = `websocket-fanout-${Date.now()}`
    } = config;

    if (!redis) {
        throw new Error('Redis client is required for WebSocket fan-out');
    }
    if (!io || typeof io.to !== 'function') {
        throw new Error('Socket.io server instance is required');
    }

    const streamsManager = createRedisStreamsManager(redis);
    let isRunning = false;
    let processingLoop = null;
    const stats = {
        messagesRead: 0,
        messagesDelivered: 0,
        messagesFailed: 0,
        connectionsActive: 0,
        bytesTransferred: 0
    };

    /**
     * Process and deliver a single message to connected clients
     */
    const processMessage = async (messageId, message) => {
        try {
            // Parse message fields
            const type = message.type || 'message';
            const groupId = message.groupId || '';
            const recipients = Array.isArray(message.recipients) 
                ? message.recipients 
                : (typeof message.recipients === 'string' ? JSON.parse(message.recipients) : []);
            const payload = typeof message.payload === 'string' 
                ? JSON.parse(message.payload) 
                : message.payload;

            if (!groupId || !recipients.length) {
                console.warn(`[WebSocket Fanout] Invalid message format: ${messageId}`);
                return false;
            }

            // Deliver to each recipient via Socket.io
            let deliveredCount = 0;
            for (const userId of recipients) {
                try {
                    // Use Socket.io's 'to' method to target specific user
                    // This broadcasts to all sockets connected by that user
                    io.to(`user-${userId}`).emit('message', {
                        type,
                        groupId,
                        payload,
                        receivedAt: Date.now(),
                        serverMessageId: messageId
                    });

                    deliveredCount++;
                    stats.bytesTransferred += JSON.stringify(payload).length;
                } catch (error) {
                    console.error(`[WebSocket Fanout] Failed to deliver to user ${userId}:`, error.message);
                    stats.messagesFailed++;
                }
            }

            // Acknowledge message as processed
            await streamsManager.acknowledgeMessage(messageId);
            stats.messagesDelivered += deliveredCount;

            console.log(`[WebSocket Fanout] Delivered message ${messageId} to ${deliveredCount}/${recipients.length} users`);
            return true;

        } catch (error) {
            console.error(`[WebSocket Fanout] Error processing message ${messageId}:`, error.message);
            stats.messagesFailed++;
            return false;
        }
    };

    /**
     * Main message processing loop
     * Continuously reads from Redis Streams and delivers messages
     */
    const runProcessingLoop = async () => {
        while (isRunning) {
            try {
                // Initialize consumer group on first run
                if (stats.messagesRead === 0) {
                    await streamsManager.initializeConsumerGroup();
                }

                // Read pending messages from stream
                const messages = await streamsManager.readMessagesForConsumer(
                    consumerId,
                    batchSize,
                    blockMs
                );

                // Process each message
                for (const { id, message } of messages) {
                    stats.messagesRead++;
                    await processMessage(id, message);
                }

                // Periodic stats logging
                if (stats.messagesRead % 100 === 0) {
                    console.log(`[WebSocket Fanout] Stats:`, {
                        read: stats.messagesRead,
                        delivered: stats.messagesDelivered,
                        failed: stats.messagesFailed,
                        active: stats.connectionsActive
                    });
                }

            } catch (error) {
                console.error('[WebSocket Fanout] Loop error:', error.message);
                // Continue despite errors
                await sleep(1000);
            }
        }
    };

    /**
     * Get active Socket.io connections per user
     */
    const getActiveConnections = () => {
        const rooms = io.sockets.adapter.rooms;
        const connectionsByUser = {};

        for (const [roomName, sockets] of rooms.entries()) {
            if (roomName.startsWith('user-')) {
                const userId = roomName.slice(5); // Remove 'user-' prefix
                connectionsByUser[userId] = sockets.size;
            }
        }

        return connectionsByUser;
    };

    /**
     * Start the fan-out manager
     */
    const start = async () => {
        if (isRunning) {
            console.warn('[WebSocket Fanout] Already running');
            return;
        }

        isRunning = true;
        console.log(`[WebSocket Fanout] Started with consumerId=${consumerId}`);

        // Start processing loop in background
        processingLoop = runProcessingLoop().catch(error => {
            console.error('[WebSocket Fanout] Fatal error in processing loop:', error.message);
            isRunning = false;
        });
    };

    /**
     * Stop the fan-out manager
     */
    const stop = async () => {
        isRunning = false;
        if (processingLoop) {
            await processingLoop;
        }
        console.log('[WebSocket Fanout] Stopped');
    };

    /**
     * Get current statistics
     */
    const getStats = () => {
        return {
            ...stats,
            isRunning,
            consumerId,
            activeConnections: getActiveConnections()
        };
    };

    /**
     * Handle new Socket.io connection
     * Called when client connects via WebSocket
     */
    const onSocketConnect = (socket) => {
        const userId = socket.data.userId || socket.handshake.auth.userId;
        
        if (userId) {
            // Join user-specific room for targeted delivery
            socket.join(`user-${userId}`);
            stats.connectionsActive = (stats.connectionsActive || 0) + 1;
            
            console.log(`[WebSocket Fanout] Socket ${socket.id} joined user-${userId}`);

            // Handle disconnect
            socket.on('disconnect', () => {
                stats.connectionsActive = Math.max(0, (stats.connectionsActive || 1) - 1);
                console.log(`[WebSocket Fanout] Socket ${socket.id} disconnected`);
            });
        }
    };

    /**
     * Manually send a message to a user (for testing or special cases)
     */
    const sendToUser = (userId, payload) => {
        io.to(`user-${userId}`).emit('message', payload);
    };

    /**
     * Broadcast to all connected clients
     */
    const broadcast = (payload) => {
        io.emit('message', payload);
    };

    return {
        start,
        stop,
        getStats,
        onSocketConnect,
        sendToUser,
        broadcast,
        getStreamsManager: () => streamsManager
    };
}

/**
 * Create a Socket.io middleware to handle user identification
 * Attach this to io.use() to validate and set user data on each socket
 */
function createUserIdentificationMiddleware(config = {}) {
    return async (socket, next) => {
        try {
            // Get user ID from auth or query params
            const userId = socket.handshake.auth?.userId || socket.handshake.query?.userId;
            
            if (!userId) {
                return next(new Error('Authentication: User ID required'));
            }

            socket.data.userId = userId;
            socket.join(`user-${userId}`);

            console.log(`[WebSocket Auth] User ${userId} authenticated`);
            next();

        } catch (error) {
            next(new Error(`Authentication failed: ${error.message}`));
        }
    };
}

/**
 * Create a Socket.io connection handler
 * Registers event listeners for the fan-out manager
 */
function createSocketConnectionHandler(fanoutManager) {
    return (socket) => {
        console.log(`[Socket.io] Client ${socket.id} connected`);

        // Notify fan-out manager of new connection
        fanoutManager.onSocketConnect(socket);

        // Handle custom events if needed
        socket.on('ping', () => {
            socket.emit('pong');
        });

        socket.on('disconnect', () => {
            console.log(`[Socket.io] Client ${socket.id} disconnected`);
        });

        socket.on('error', (error) => {
            console.error(`[Socket.io] Client ${socket.id} error:`, error);
        });
    };
}

/**
 * Sleep for specified milliseconds
 * @param {number} ms - Milliseconds
 * @returns {Promise<void>}
 */
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = {
    createWebSocketFanoutManager,
    createUserIdentificationMiddleware,
    createSocketConnectionHandler
};
