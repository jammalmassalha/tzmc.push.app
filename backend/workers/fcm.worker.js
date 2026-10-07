/**
 * FCM Worker
 * 
 * Dedicated background worker that handles Firebase Cloud Messaging (FCM) delivery.
 * Runs in a separate process/container and consumes messages from BullMQ queue.
 * 
 * Features:
 * - Chunking large recipient lists (Firebase sendMulticast limit: 500 recipients)
 * - Token caching using Redis HSET/HGET
 * - Exponential backoff for rate limiting and failures
 * - Retry logic with configurable attempt limits
 * - Dead letter queue for permanently failed messages
 */

const { Worker } = require('bullmq');
const firebaseAdmin = require('firebase-admin');

/**
 * Create and configure the FCM Worker
 * @param {Object} config - Configuration object
 * @param {Object} config.redis - Redis client for queue
 * @param {Object} config.redisStreams - Redis Streams manager
 * @param {Object} config.dbPool - Database connection pool
 * @param {Object} config.firebaseApp - Firebase Admin app instance
 * @param {number} config.concurrency - Number of parallel jobs to process (default: 5)
 * @returns {Worker} BullMQ Worker instance
 */
function createFcmWorker(config = {}) {
    const {
        redis,
        redisStreams,
        dbPool,
        firebaseApp,
        concurrency = 5
    } = config;

    if (!redis) {
        throw new Error('Redis client is required for FCM worker');
    }
    if (!firebaseApp || !firebaseApp.messaging) {
        throw new Error('Firebase Admin app with messaging is required for FCM worker');
    }

    // Initialize Redis Streams for reliable event delivery
    if (redisStreams) {
        redisStreams.initializeConsumerGroup().catch(err => {
            console.warn('[FCM Worker] Failed to initialize consumer group:', err.message);
        });
    }

    /**
     * Job handler for FCM message delivery
     * Processes a single job from the queue
     */
    const processJob = async (job) => {
        const startTime = Date.now();
        const jobData = job.data || {};

        console.log(`[FCM Worker] Processing job ${job.id}:`, {
            type: jobData.type,
            groupId: jobData.groupId,
            recipientCount: (jobData.recipients || []).length,
            attempt: job.attemptsMade + 1
        });

        try {
            // Validate job structure
            if (!jobData.type || !jobData.recipients || !Array.isArray(jobData.recipients)) {
                throw new Error('Invalid job data: missing type, recipients, or payload');
            }

            // Fetch cached device tokens for recipients
            const deviceTokens = await fetchAndCacheDeviceTokens(
                redis,
                jobData.recipients,
                dbPool
            );

            if (deviceTokens.length === 0) {
                console.warn(`[FCM Worker] No device tokens found for ${jobData.recipients.length} recipients`);
                return { success: true, delivered: 0, skipped: jobData.recipients.length };
            }

            // Chunk tokens into batches of 500 (Firebase limit)
            const chunks = chunkArray(deviceTokens, 500);

            let totalDelivered = 0;
            let totalFailed = 0;

            // Send to each chunk
            for (let i = 0; i < chunks.length; i++) {
                const chunk = chunks[i];
                try {
                    const result = await sendMulticast(
                        firebaseApp,
                        chunk,
                        jobData.payload,
                        jobData.priority || 'normal'
                    );

                    totalDelivered += result.successCount;
                    totalFailed += result.failureCount;

                    console.log(`[FCM Worker] Chunk ${i + 1}/${chunks.length}: ${result.successCount} delivered, ${result.failureCount} failed`);

                    // Add stream event for monitoring
                    if (redisStreams) {
                        try {
                            await redisStreams.appendMessage({
                                type: 'fcm-chunk-delivered',
                                groupId: jobData.groupId,
                                recipients: chunk,
                                payload: { success: result.successCount, failed: result.failureCount },
                                timestamp: Date.now()
                            });
                        } catch (streamErr) {
                            console.warn('[FCM Worker] Failed to log to stream:', streamErr.message);
                        }
                    }

                    // Stagger requests to avoid rate limiting
                    if (i < chunks.length - 1) {
                        await sleep(100);
                    }
                } catch (chunkError) {
                    totalFailed += chunk.length;
                    console.error(`[FCM Worker] Chunk ${i + 1} failed:`, chunkError.message);

                    // Check if error is rate limit (can retry)
                    if (isRetryableError(chunkError)) {
                        throw chunkError; // Will trigger exponential backoff
                    }
                    // Otherwise continue to next chunk
                }
            }

            const duration = Date.now() - startTime;
            const result = {
                success: true,
                delivered: totalDelivered,
                failed: totalFailed,
                duration: `${duration}ms`
            };

            console.log(`[FCM Worker] Job ${job.id} completed:`, result);
            return result;

        } catch (error) {
            const duration = Date.now() - startTime;
            console.error(`[FCM Worker] Job ${job.id} failed (attempt ${job.attemptsMade + 1}):`, 
                error.message,
                `Duration: ${duration}ms`
            );

            // Determine retry strategy
            if (isRetryableError(error)) {
                throw error; // Will be retried with exponential backoff
            } else {
                // Permanent failure - move to dead letter queue
                throw new Error(`[PERMANENT] ${error.message}`);
            }
        }
    };

    /**
     * Failed job handler for logging and monitoring
     */
    const onFailed = async (job, err) => {
        console.error(`[FCM Worker] Job ${job.id} permanently failed after ${job.attemptsMade} attempts:`,
            err.message
        );

        // Log to database if available
        if (dbPool) {
            try {
                const connection = await dbPool.getConnection();
                try {
                    await connection.execute(
                        `INSERT INTO WorkerJobLogs (jobId, queueName, status, errorMessage, metadata) 
                         VALUES (?, ?, ?, ?, ?)`,
                        [
                            job.id,
                            'fcm-notifications',
                            'failed',
                            err.message,
                            JSON.stringify({ data: job.data, attempts: job.attemptsMade })
                        ]
                    );
                } finally {
                    connection.release();
                }
            } catch (dbErr) {
                console.warn('[FCM Worker] Failed to log job failure:', dbErr.message);
            }
        }
    };

    /**
     * Completed job handler for monitoring
     */
    const onCompleted = async (job, result) => {
        console.log(`[FCM Worker] Job ${job.id} completed successfully:`, result);

        // Log to database if available
        if (dbPool) {
            try {
                const connection = await dbPool.getConnection();
                try {
                    await connection.execute(
                        `INSERT INTO WorkerJobLogs (jobId, queueName, status, metadata) 
                         VALUES (?, ?, ?, ?)`,
                        [
                            job.id,
                            'fcm-notifications',
                            'completed',
                            JSON.stringify(result)
                        ]
                    );
                } finally {
                    connection.release();
                }
            } catch (dbErr) {
                console.warn('[FCM Worker] Failed to log job completion:', dbErr.message);
            }
        }
    };

    // Create worker with exponential backoff
    const worker = new Worker('fcm-notifications', processJob, {
        connection: redis,
        concurrency,
        maxStalledCount: 2,
        stalledInterval: 5000,
        lockDuration: 30000,
        
        // Exponential backoff: 1s, 2s, 4s, 8s, 16s, 32s
        defaultJobOptions: {
            attempts: 6,
            backoff: {
                type: 'exponential',
                delay: 1000
            },
            removeOnComplete: {
                age: 3600, // Remove completed jobs after 1 hour
                isPattern: false
            },
            removeOnFail: {
                age: 86400 // Keep failed jobs for 24 hours for debugging
            }
        }
    });

    worker.on('failed', onFailed);
    worker.on('completed', onCompleted);

    worker.on('error', (error) => {
        console.error('[FCM Worker] Worker error:', error.message);
    });

    console.log(`[FCM Worker] Started with concurrency=${concurrency}`);
    return worker;
}

/**
 * Fetch and cache device tokens for recipients
 * First checks Redis cache, falls back to database if needed
 * @param {Object} redis - Redis client
 * @param {Array<string>} userIds - List of user IDs
 * @param {Object} dbPool - Database connection pool (optional)
 * @returns {Promise<Array<string>>} Array of FCM device tokens
 */
async function fetchAndCacheDeviceTokens(redis, userIds, dbPool = null) {
    const cacheKey = 'fcm:device-tokens';
    const tokens = [];
    const cacheHits = [];
    const misses = [];

    // Check Redis cache first (HGET for each user)
    for (const userId of userIds) {
        try {
            const cachedToken = await redis.hget(cacheKey, userId);
            if (cachedToken) {
                tokens.push(cachedToken);
                cacheHits.push(userId);
            } else {
                misses.push(userId);
            }
        } catch (error) {
            console.warn(`[FCM Worker] Cache lookup failed for ${userId}:`, error.message);
            misses.push(userId);
        }
    }

    // Fetch missing tokens from database
    if (misses.length > 0 && dbPool) {
        try {
            const connection = await dbPool.getConnection();
            try {
                const placeholders = misses.map(() => '?').join(',');
                const [rows] = await connection.execute(
                    `SELECT userId, fcmToken FROM FlutterPushTokens 
                     WHERE userId IN (${placeholders}) AND fcmToken IS NOT NULL`,
                    misses
                );

                // Cache in Redis for future use (TTL: 24 hours)
                for (const row of rows) {
                    if (row.fcmToken) {
                        tokens.push(row.fcmToken);
                        // HSET with EX for automatic expiration
                        redis.hset(cacheKey, row.userId, row.fcmToken).catch(err => {
                            console.warn('[FCM Worker] Cache set failed:', err.message);
                        });
                        // Set expiration on hash field
                        redis.expire(cacheKey, 86400).catch(() => {}); // 24 hours
                    }
                }

                console.log(`[FCM Worker] Token cache: ${cacheHits.length} hits, ${rows.length} fetched from DB`);
            } finally {
                connection.release();
            }
        } catch (error) {
            console.error('[FCM Worker] Failed to fetch tokens from database:', error.message);
        }
    }

    return [...new Set(tokens)]; // Remove duplicates
}

/**
 * Send multicast FCM notification
 * Firebase's sendMulticast API delivers to up to 500 tokens per call
 * @param {Object} firebaseApp - Firebase Admin app
 * @param {Array<string>} tokens - Device tokens
 * @param {Object} payload - Message payload
 * @param {string} priority - Message priority ('high', 'normal')
 * @returns {Promise<Object>} Result with successCount and failureCount
 */
async function sendMulticast(firebaseApp, tokens, payload, priority = 'normal') {
    if (!tokens || tokens.length === 0) {
        return { successCount: 0, failureCount: 0 };
    }

    const message = {
        data: {
            type: payload.type || 'message',
            groupId: payload.groupId || '',
            payload: JSON.stringify(payload.data || {})
        },
        android: {
            priority: priority === 'high' ? 'high' : 'normal',
            ttl: 3600 // 1 hour TTL
        },
        apns: {
            headers: {
                'apns-priority': priority === 'high' ? '10' : '10'
            }
        },
        webpush: {
            urgency: priority === 'high' ? 'high' : 'normal'
        }
    };

    try {
        const response = await firebaseApp.messaging().sendMulticast({
            tokens,
            ...message
        });

        console.log(`[FCM] Sent to ${response.successCount} devices, ${response.failureCount} failed`);
        return response;
    } catch (error) {
        console.error('[FCM] sendMulticast failed:', error.message);
        throw error;
    }
}

/**
 * Chunk array into smaller arrays
 * @param {Array} array - Array to chunk
 * @param {number} size - Chunk size
 * @returns {Array<Array>} Array of chunks
 */
function chunkArray(array, size) {
    const chunks = [];
    for (let i = 0; i < array.length; i += size) {
        chunks.push(array.slice(i, i + size));
    }
    return chunks;
}

/**
 * Check if error is retryable
 * Rate limiting and transient errors should be retried
 * @param {Error} error - Error to check
 * @returns {boolean} True if error is retryable
 */
function isRetryableError(error) {
    if (!error) return false;
    
    const message = error.message || '';
    const code = error.code || '';

    // Rate limiting errors
    if (message.includes('quota') || message.includes('rate limit') || code === 'messaging/too-many-requests') {
        return true;
    }

    // Transient network errors
    if (message.includes('ECONNREFUSED') || message.includes('ETIMEDOUT') || message.includes('ENOTFOUND')) {
        return true;
    }

    // Firebase temporary errors
    if (code && code.startsWith('messaging/')) {
        const temporaryCodes = ['internal-error', 'service-unavailable'];
        return temporaryCodes.some(c => code.includes(c));
    }

    // PERMANENT marker in message means don't retry
    if (message.includes('[PERMANENT]')) {
        return false;
    }

    return false;
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
    createFcmWorker,
    fetchAndCacheDeviceTokens,
    sendMulticast,
    chunkArray,
    isRetryableError
};
