/**
 * Fast-Reply Message Handler
 * 
 * Implements the Fast-Reply pattern for message delivery:
 * 1. Idempotency Check (Redis cache of clientMsgId)
 * 2. Database Transaction (Insert to Logs and MessageActivities)
 * 3. Queue the Job (Push to BullMQ for background processing)
 * 4. Return Response (200 OK immediately)
 * 
 * This pattern ensures the HTTP response completes in < 30ms,
 * while background workers handle FCM and WebSocket delivery.
 */

const { Queue } = require('bullmq');

/**
 * Create Fast-Reply message handler
 * @param {Object} config - Configuration object
 * @param {Object} config.redis - Redis client
 * @param {Object} config.dbPool - Database connection pool
 * @param {Object} config.workersManager - Workers manager instance
 * @returns {Object} Message handler functions
 */
function createFastReplyHandler(config = {}) {
    const {
        redis,
        dbPool,
        workersManager
    } = config;

    if (!redis) {
        throw new Error('Redis client required for Fast-Reply handler');
    }
    if (!dbPool) {
        throw new Error('Database pool required for Fast-Reply handler');
    }

    // Create or get FCM notifications queue
    const fcmQueue = new Queue('fcm-notifications', { connection: redis });

    const IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60; // 24 hours
    const IDEMPOTENCY_KEY_PREFIX = 'idempotency:message:';

    /**
     * Check idempotency using clientMsgId
     * Returns true if message was already processed, false if it's new
     * @param {string} clientMsgId - Client message ID
     * @returns {Promise<boolean>} True if duplicate, false if unique
     */
    async function checkIdempotency(clientMsgId) {
        if (!clientMsgId) {
            return false;
        }

        const key = IDEMPOTENCY_KEY_PREFIX + clientMsgId;
        try {
            // Check if key exists in Redis
            const existing = await redis.get(key);
            return !!existing;
        } catch (error) {
            console.error('[FastReply] Idempotency check failed:', error.message);
            // Fail open (allow message) on Redis failure
            return false;
        }
    }

    /**
     * Mark message as processed in idempotency cache
     * @param {string} clientMsgId - Client message ID
     * @param {Object} messageData - Message data to cache
     * @returns {Promise<void>}
     */
    async function markAsProcessed(clientMsgId, messageData) {
        if (!clientMsgId) {
            return;
        }

        const key = IDEMPOTENCY_KEY_PREFIX + clientMsgId;
        try {
            // Set with expiration using EX option
            await redis.setex(
                key,
                IDEMPOTENCY_TTL_SECONDS,
                JSON.stringify({
                    timestamp: Date.now(),
                    data: messageData
                })
            );
        } catch (error) {
            console.warn('[FastReply] Failed to cache message:', error.message);
            // Continue despite cache failure
        }
    }

    /**
     * Store message in database with transaction
     * Inserts to both Logs and MessageActivities tables atomically
     * @param {Object} message - Message object
     * @param {string} message.clientMsgId - Client message ID
     * @param {string} message.groupId - Group ID
     * @param {string} message.userId - Sender user ID
     * @param {string} message.content - Message text content
     * @param {Object} message.payload - Full message payload
     * @param {Array<string>} message.recipients - List of recipient IDs
     * @returns {Promise<Object>} Result with serverMessageId
     */
    async function storeMessageInDatabase(message) {
        const {
            clientMsgId,
            groupId,
            userId,
            content,
            payload,
            recipients = []
        } = message;

        if (!groupId || !userId) {
            throw new Error('Missing required fields: groupId, userId');
        }

        const connection = await dbPool.getConnection();
        try {
            await connection.beginTransaction();

            // Get next sequence number for this group
            const [[{ nextPts }]] = await connection.execute(
                `SELECT IFNULL(MAX(pts), 0) + 1 as nextPts FROM Logs WHERE groupId = ?`,
                [groupId]
            );

            // Insert to Logs table
            const timestamp = new Date();
            const [logResult] = await connection.execute(
                `INSERT INTO Logs (clientMsgId, groupId, userId, content, pts, timestamp) 
                 VALUES (?, ?, ?, ?, ?, ?)`,
                [clientMsgId, groupId, userId, content || '', nextPts, timestamp]
            );

            const serverMessageId = logResult.insertId;

            // Insert message activities for each recipient
            if (recipients && recipients.length > 0) {
                const activityInserts = recipients.map(recipientId => [
                    serverMessageId,
                    recipientId,
                    groupId,
                    0, // delivered: false
                    null, // deliveredAt
                    timestamp
                ]);

                // Bulk insert with batching
                const batchSize = 100;
                for (let i = 0; i < activityInserts.length; i += batchSize) {
                    const batch = activityInserts.slice(i, i + batchSize);
                    const placeholders = batch.map(() => '(?, ?, ?, ?, ?, ?)').join(',');
                    const flatValues = batch.flat();

                    await connection.execute(
                        `INSERT INTO MessageActivities (messageId, userId, groupId, delivered, deliveredAt, createdAt) 
                         VALUES ${placeholders}`,
                        flatValues
                    );
                }
            }

            await connection.commit();

            return {
                serverMessageId,
                pts: nextPts,
                timestamp: timestamp.toISOString()
            };

        } catch (error) {
            await connection.rollback();
            throw error;
        } finally {
            connection.release();
        }
    }

    /**
     * Queue message for delivery
     * Creates async jobs for FCM and WebSocket fan-out
     * @param {Object} message - Message object
     * @param {string} message.serverMessageId - Server message ID from database
     * @param {string} message.groupId - Group ID
     * @param {Array<string>} message.recipients - List of recipient IDs
     * @param {Object} message.payload - Message payload
     * @param {string} message.priority - Message priority (high, normal)
     * @returns {Promise<Object>} Job IDs
     */
    async function queueMessageDelivery(message) {
        const {
            serverMessageId,
            groupId,
            recipients,
            payload,
            priority = 'normal'
        } = message;

        if (!serverMessageId || !groupId || !recipients || !recipients.length) {
            throw new Error('Invalid message for queueing');
        }

        const jobIds = {};

        try {
            // Queue FCM job for notification delivery
            const fcmJob = await fcmQueue.add(
                {
                    type: 'notification',
                    serverMessageId,
                    groupId,
                    recipients,
                    payload,
                    priority,
                    timestamp: Date.now()
                },
                {
                    priority: priority === 'high' ? 10 : 5,
                    attempts: 6,
                    backoff: {
                        type: 'exponential',
                        delay: 1000
                    },
                    removeOnComplete: {
                        age: 3600
                    }
                }
            );

            jobIds.fcm = fcmJob.id;
            console.log(`[FastReply] Queued FCM job: ${fcmJob.id} for message ${serverMessageId}`);

            // Add stream event for WebSocket fan-out
            if (workersManager && typeof workersManager.addStreamEvent === 'function') {
                const streamId = await workersManager.addStreamEvent({
                    type: 'message-delivered',
                    groupId,
                    recipients,
                    payload: {
                        serverMessageId,
                        content: payload.content,
                        senderName: payload.senderName
                    },
                    timestamp: Date.now()
                });

                jobIds.stream = streamId;
                console.log(`[FastReply] Added stream event: ${streamId}`);
            }

        } catch (error) {
            console.error('[FastReply] Failed to queue delivery:', error.message);
            throw error;
        }

        return jobIds;
    }

    /**
     * Fast-Reply message handler (Express middleware)
     * Handles a complete message delivery flow in < 30ms
     * @param {Object} req - Express request
     * @param {Object} res - Express response
     */
    const handleMessageReply = async (req, res) => {
        const startTime = Date.now();
        const body = req.body || {};

        try {
            // 1. VALIDATE REQUEST
            const {
                clientMsgId,
                groupId,
                content,
                payload,
                recipients,
                priority,
                userId
            } = body;

            if (!clientMsgId || !groupId) {
                return res.status(400).json({
                    error: 'Missing required fields: clientMsgId, groupId',
                    timestamp: new Date().toISOString()
                });
            }

            // Get user from middleware
            const sender = req.resolvedUser || userId;
            if (!sender) {
                return res.status(401).json({ error: 'Unauthorized' });
            }

            // 2. IDEMPOTENCY CHECK (< 5ms)
            const isDuplicate = await checkIdempotency(clientMsgId);
            if (isDuplicate) {
                console.log(`[FastReply] Duplicate message detected: ${clientMsgId}`);
                return res.status(202).json({
                    status: 'duplicate',
                    message: 'Message already processed',
                    timestamp: new Date().toISOString()
                });
            }

            // 3. DATABASE TRANSACTION (< 10ms)
            const dbResult = await storeMessageInDatabase({
                clientMsgId,
                groupId,
                userId: sender,
                content: content || '',
                payload: payload || {},
                recipients: recipients || []
            });

            // 4. MARK AS PROCESSED
            await markAsProcessed(clientMsgId, dbResult);

            // 5. QUEUE DELIVERY JOBS (< 5ms)
            let jobIds = {};
            try {
                if (recipients && recipients.length > 0) {
                    jobIds = await queueMessageDelivery({
                        serverMessageId: dbResult.serverMessageId,
                        groupId,
                        recipients,
                        payload: payload || {},
                        priority: priority || 'normal'
                    });
                }
            } catch (queueError) {
                // Log queue error but still return 200 - message is in database
                console.error('[FastReply] Queue error (continuing):', queueError.message);
                jobIds = { error: queueError.message };
            }

            // 6. RETURN IMMEDIATE RESPONSE (< 30ms total)
            const duration = Date.now() - startTime;
            return res.status(200).json({
                status: 'accepted',
                message: 'Message queued for delivery',
                serverMessageId: dbResult.serverMessageId,
                pts: dbResult.pts,
                timestamp: dbResult.timestamp,
                jobs: jobIds,
                responseTimeMs: duration
            });

        } catch (error) {
            const duration = Date.now() - startTime;
            console.error('[FastReply] Handler error:', error.message, `Duration: ${duration}ms`);

            // Return error response
            return res.status(500).json({
                error: 'Message processing failed',
                message: error.message,
                timestamp: new Date().toISOString(),
                responseTimeMs: duration
            });
        }
    };

    /**
     * Health check for Fast-Reply handler
     */
    const getHealth = async () => {
        const checks = {
            redis: false,
            database: false,
            queue: false
        };

        try {
            await redis.ping();
            checks.redis = true;
        } catch (error) {
            console.error('[FastReply Health] Redis check failed:', error.message);
        }

        try {
            const connection = await dbPool.getConnection();
            connection.release();
            checks.database = true;
        } catch (error) {
            console.error('[FastReply Health] Database check failed:', error.message);
        }

        try {
            const jobCounts = await fcmQueue.getJobCounts();
            checks.queue = jobCounts !== undefined;
        } catch (error) {
            console.error('[FastReply Health] Queue check failed:', error.message);
        }

        return {
            healthy: Object.values(checks).every(v => v),
            checks
        };
    };

    return {
        handleMessageReply,
        checkIdempotency,
        markAsProcessed,
        storeMessageInDatabase,
        queueMessageDelivery,
        getHealth,
        fcmQueue
    };
}

module.exports = {
    createFastReplyHandler
};
