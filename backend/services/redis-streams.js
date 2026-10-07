/**
 * Redis Streams Utilities
 * 
 * Provides a robust event streaming system using Redis Streams with features:
 * - Append-only message log (XADD)
 * - Consumer groups for distributed processing (XGROUP)
 * - Automatic acknowledgment tracking
 * - Message replay capability on server restart
 * - Guaranteed delivery with consumer acknowledgments
 */

const { EventEmitter } = require('events');

/**
 * Redis Streams Manager
 * Handles all Redis Streams operations for message broadcasting
 */
class RedisStreamsManager extends EventEmitter {
    constructor(redisClient) {
        super();
        this.redis = redisClient;
        this.streamName = 'message-events';
        this.consumerGroupName = 'websocket-group';
        this.streamStats = {
            totalAdded: 0,
            totalRead: 0,
            totalAcked: 0
        };
    }

    /**
     * Initialize consumer group for the stream
     * Creates group if it doesn't exist (uses $ to start from new messages)
     * @param {string} streamName - Name of the stream
     * @returns {Promise<void>}
     */
    async initializeConsumerGroup(streamName = this.streamName) {
        try {
            // XGROUP CREATE stream group id [MKSTREAM]
            // Using MKSTREAM to create stream if it doesn't exist
            // Using $ to start consuming from new messages (not old ones)
            const result = await this.redis.xgroup(
                'CREATE',
                streamName,
                this.consumerGroupName,
                '$',
                'MKSTREAM'
            ).catch(err => {
                // BUSYGROUP error means the group already exists - that's fine
                if (err && err.message && err.message.includes('BUSYGROUP')) {
                    console.log(`[Streams] Consumer group '${this.consumerGroupName}' already exists`);
                    return null;
                }
                throw err;
            });

            if (result) {
                console.log(`[Streams] Initialized consumer group '${this.consumerGroupName}' on stream '${streamName}'`);
            }
        } catch (error) {
            console.error(`[Streams] Failed to initialize consumer group:`, error.message);
            throw error;
        }
    }

    /**
     * Append a new message to the stream
     * Messages are stored with auto-generated IDs and can be replayed on restart
     * @param {Object} message - Message to append
     * @param {string} message.type - Event type (e.g., 'fcm-notification', 'websocket-broadcast')
     * @param {string} message.groupId - Target group ID
     * @param {Array<string>} message.recipients - List of recipient user IDs
     * @param {Object} message.payload - Message payload to deliver
     * @param {number} message.timestamp - Message timestamp
     * @returns {Promise<string>} Generated stream message ID (e.g., '1234567890-0')
     */
    async appendMessage(message) {
        if (!message || typeof message !== 'object') {
            throw new Error('Message must be an object');
        }

        const streamMessage = {
            type: message.type || 'event',
            groupId: message.groupId || '',
            recipients: JSON.stringify(message.recipients || []),
            payload: JSON.stringify(message.payload || {}),
            timestamp: message.timestamp || Date.now(),
            clientMsgId: message.clientMsgId || null,
            priority: message.priority || 'normal'
        };

        try {
            // XADD stream ID field value [field value ...]
            // Using * for auto-generated ID
            const messageId = await this.redis.xadd(
                this.streamName,
                '*',
                ...Object.entries(streamMessage).flatMap(([k, v]) => [k, v])
            );

            this.streamStats.totalAdded++;
            console.log(`[Streams] Message added to stream: ${messageId}`);
            return messageId;
        } catch (error) {
            console.error(`[Streams] Failed to append message:`, error.message);
            throw error;
        }
    }

    /**
     * Read pending messages from consumer group
     * Used by worker processes to consume messages in distributed fashion
     * @param {string} consumerId - Unique consumer identifier in the group
     * @param {number} count - Max number of messages to read (default: 10)
     * @param {number} blockMs - Block for this many ms if no messages (default: 1000)
     * @returns {Promise<Array>} Array of [streamId, message] pairs
     */
    async readMessagesForConsumer(consumerId, count = 10, blockMs = 1000) {
        try {
            // XREADGROUP GROUP group consumer [COUNT count] [BLOCK milliseconds] STREAMS stream id
            // Using > to only read messages not yet delivered to this consumer
            const result = await this.redis.xreadgroup(
                'GROUP',
                this.consumerGroupName,
                consumerId,
                'COUNT',
                count,
                'BLOCK',
                blockMs,
                'STREAMS',
                this.streamName,
                '>'
            );

            if (!result || result.length === 0) {
                return [];
            }

            // Result format: [[streamName, [[messageId, [field, value, ...]], ...]]]
            const messages = [];
            for (const [streamName, messageList] of result) {
                for (const [messageId, fields] of messageList) {
                    const message = {};
                    for (let i = 0; i < fields.length; i += 2) {
                        const fieldName = fields[i];
                        const fieldValue = fields[i + 1];
                        // Try to parse JSON fields, fall back to string
                        try {
                            message[fieldName] = JSON.parse(fieldValue);
                        } catch {
                            message[fieldName] = fieldValue;
                        }
                    }
                    messages.push({ id: messageId, message });
                    this.streamStats.totalRead++;
                }
            }

            return messages;
        } catch (error) {
            console.error(`[Streams] Failed to read messages:`, error.message);
            throw error;
        }
    }

    /**
     * Acknowledge a message as processed by consumer
     * Removes message from pending entries list (PEL)
     * @param {string} messageId - Stream message ID to acknowledge
     * @returns {Promise<number>} Number of acknowledged messages
     */
    async acknowledgeMessage(messageId) {
        try {
            const result = await this.redis.xack(
                this.streamName,
                this.consumerGroupName,
                messageId
            );

            this.streamStats.totalAcked++;
            return result;
        } catch (error) {
            console.error(`[Streams] Failed to acknowledge message ${messageId}:`, error.message);
            throw error;
        }
    }

    /**
     * Acknowledge multiple messages in batch
     * More efficient than calling acknowledgeMessage multiple times
     * @param {Array<string>} messageIds - Array of stream message IDs
     * @returns {Promise<number>} Total number of acknowledged messages
     */
    async acknowledgeMessageBatch(messageIds) {
        if (!Array.isArray(messageIds) || messageIds.length === 0) {
            return 0;
        }

        try {
            const result = await this.redis.xack(
                this.streamName,
                this.consumerGroupName,
                ...messageIds
            );

            this.streamStats.totalAcked += messageIds.length;
            return result;
        } catch (error) {
            console.error(`[Streams] Failed to acknowledge batch:`, error.message);
            throw error;
        }
    }

    /**
     * Get consumer group information
     * Shows pending messages, consumers, and their status
     * @returns {Promise<Object>} Consumer group info
     */
    async getConsumerGroupInfo() {
        try {
            const info = await this.redis.xinfo('GROUP', this.streamName, this.consumerGroupName);
            return {
                name: this.consumerGroupName,
                consumers: info[1],
                pending: info[3],
                lastDeliveredId: info[5],
                lag: info[7]
            };
        } catch (error) {
            console.error(`[Streams] Failed to get consumer group info:`, error.message);
            return { error: error.message };
        }
    }

    /**
     * Get pending messages for a specific consumer
     * Useful for monitoring and debugging message processing
     * @param {string} consumerId - Consumer ID to check
     * @returns {Promise<Array>} Array of pending messages
     */
    async getPendingMessages(consumerId) {
        try {
            const pending = await this.redis.xpending(
                this.streamName,
                this.consumerGroupName,
                '-',
                '+',
                100
            );
            return pending.filter(item => item[1] === consumerId);
        } catch (error) {
            console.error(`[Streams] Failed to get pending messages:`, error.message);
            return [];
        }
    }

    /**
     * Trim stream to a maximum length to prevent memory bloat
     * Keeps only the most recent messages
     * @param {number} maxLength - Maximum number of entries to keep (default: 100000)
     * @returns {Promise<number>} Number of messages removed
     */
    async trimStream(maxLength = 100000) {
        try {
            const removed = await this.redis.xtrim(
                this.streamName,
                'MAXLEN',
                '~',
                maxLength
            );
            console.log(`[Streams] Trimmed stream, removed ${removed} old messages`);
            return removed;
        } catch (error) {
            console.error(`[Streams] Failed to trim stream:`, error.message);
            return 0;
        }
    }

    /**
     * Get stream statistics
     * Shows total messages added, read, and acknowledged
     * @returns {Object} Stream statistics
     */
    getStreamStats() {
        return {
            ...this.streamStats,
            streamName: this.streamName,
            consumerGroup: this.consumerGroupName
        };
    }

    /**
     * Reset stream statistics
     */
    resetStreamStats() {
        this.streamStats = {
            totalAdded: 0,
            totalRead: 0,
            totalAcked: 0
        };
    }
}

/**
 * Create a Redis Streams manager instance
 * @param {Object} redisClient - Redis client instance
 * @returns {RedisStreamsManager} Manager instance
 */
function createRedisStreamsManager(redisClient) {
    return new RedisStreamsManager(redisClient);
}

module.exports = {
    RedisStreamsManager,
    createRedisStreamsManager
};
