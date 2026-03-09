"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RedisStateStore = void 0;
exports.createRedisStateStoreFromEnv = createRedisStateStoreFromEnv;
const redis_1 = require("redis");
function toTrimmedString(value) {
    return String(value ?? '').trim();
}
function safeJsonParse(payload, fallback) {
    if (typeof payload !== 'string' || !payload.trim()) {
        return fallback;
    }
    try {
        return JSON.parse(payload);
    }
    catch {
        return fallback;
    }
}
class RedisStateStore {
    redisUrl;
    keyPrefix;
    queueStreamMaxLen;
    publisherId;
    client = null;
    subscriber = null;
    connected = false;
    constructor(config = {}) {
        this.redisUrl = toTrimmedString(config.url || process.env.REDIS_URL || '');
        this.keyPrefix = toTrimmedString(config.keyPrefix || process.env.REDIS_KEY_PREFIX || 'tzmc:notify');
        this.queueStreamMaxLen = Math.max(100, Number(process.env.REDIS_QUEUE_STREAM_MAXLEN || 5000) || 5000);
        this.publisherId = toTrimmedString(process.env.REDIS_QUEUE_PUBLISHER_ID || '') || `srv-${process.pid}`;
    }
    get isEnabled() {
        return Boolean(this.redisUrl);
    }
    stateKey() {
        return `${this.keyPrefix}:state:v1`;
    }
    queueUsersKey() {
        return `${this.keyPrefix}:queue:users`;
    }
    queueKeyForUser(user) {
        return `${this.keyPrefix}:queue:${user}`;
    }
    queueEventsChannel() {
        return `${this.keyPrefix}:queue:events`;
    }
    get queuePublisherId() {
        return this.publisherId;
    }
    async connect() {
        if (!this.isEnabled) {
            return false;
        }
        if (this.connected && this.client) {
            return true;
        }
        try {
            this.client = (0, redis_1.createClient)({ url: this.redisUrl });
            this.client.on('error', (error) => {
                // Keep runtime resilient; server.js handles fallback flow.
                console.warn('[REDIS] Client error:', error instanceof Error ? error.message : String(error));
            });
            await this.client.connect();
            this.connected = true;
            return true;
        }
        catch (error) {
            this.connected = false;
            this.client = null;
            console.warn('[REDIS] Failed to connect:', error instanceof Error ? error.message : String(error));
            return false;
        }
    }
    async loadState() {
        if (!this.connected || !this.client) {
            return null;
        }
        const raw = await this.client.get(this.stateKey());
        const state = safeJsonParse(raw, null);
        if (!state || typeof state !== 'object') {
            return null;
        }
        return {
            unreadCounts: state.unreadCounts && typeof state.unreadCounts === 'object' ? state.unreadCounts : {},
            messageQueue: {},
            groups: state.groups && typeof state.groups === 'object' ? state.groups : {},
            deviceSubscriptionsByUser: state.deviceSubscriptionsByUser && typeof state.deviceSubscriptionsByUser === 'object'
                ? state.deviceSubscriptionsByUser
                : {},
            shuttleReminderSentAtByKey: state.shuttleReminderSentAtByKey && typeof state.shuttleReminderSentAtByKey === 'object'
                ? state.shuttleReminderSentAtByKey
                : {}
        };
    }
    async persistState(state) {
        if (!this.connected || !this.client) {
            return;
        }
        const payload = {
            unreadCounts: state.unreadCounts && typeof state.unreadCounts === 'object' ? state.unreadCounts : {},
            // Queue is persisted through Redis lists; keep snapshot lightweight.
            messageQueue: {},
            groups: state.groups && typeof state.groups === 'object' ? state.groups : {},
            deviceSubscriptionsByUser: state.deviceSubscriptionsByUser && typeof state.deviceSubscriptionsByUser === 'object'
                ? state.deviceSubscriptionsByUser
                : {},
            shuttleReminderSentAtByKey: state.shuttleReminderSentAtByKey && typeof state.shuttleReminderSentAtByKey === 'object'
                ? state.shuttleReminderSentAtByKey
                : {}
        };
        await this.client.set(this.stateKey(), JSON.stringify(payload));
    }
    async enqueueMessages(user, messages) {
        if (!this.connected || !this.client) {
            return;
        }
        const normalizedUser = toTrimmedString(user).toLowerCase();
        if (!normalizedUser || !Array.isArray(messages) || messages.length === 0) {
            return;
        }
        const queueKey = this.queueKeyForUser(normalizedUser);
        await this.client.sAdd(this.queueUsersKey(), normalizedUser);
        for (const entry of messages) {
            const payload = JSON.stringify(entry ?? {});
            await this.client.sendCommand([
                'XADD',
                queueKey,
                'MAXLEN',
                '~',
                String(this.queueStreamMaxLen),
                '*',
                'payload',
                payload
            ]);
            await this.client.publish(this.queueEventsChannel(), JSON.stringify({
                user: normalizedUser,
                message: entry ?? {},
                sourceId: this.publisherId
            }));
        }
    }
    async drainQueue(user) {
        if (!this.connected || !this.client) {
            return [];
        }
        const normalizedUser = toTrimmedString(user).toLowerCase();
        if (!normalizedUser) {
            return [];
        }
        const queueKey = this.queueKeyForUser(normalizedUser);
        const lua = `
      local entries = redis.call('XRANGE', KEYS[1], '-', '+')
      redis.call('DEL', KEYS[1])
      redis.call('SREM', KEYS[2], ARGV[1])
      return entries
    `;
        const rawEntries = await this.client.sendCommand([
            'EVAL',
            lua,
            '2',
            queueKey,
            this.queueUsersKey(),
            normalizedUser
        ]);
        return this.decodeStreamEntries(rawEntries);
    }
    async getQueueUsers() {
        if (!this.connected || !this.client) {
            return [];
        }
        const values = await this.client.sMembers(this.queueUsersKey());
        return values.map((value) => toTrimmedString(value).toLowerCase()).filter(Boolean);
    }
    async loadQueueSnapshot() {
        if (!this.connected || !this.client) {
            return {};
        }
        const users = await this.getQueueUsers();
        const snapshot = {};
        for (const user of users) {
            const queueKey = this.queueKeyForUser(user);
            const rawEntries = await this.client.sendCommand(['XRANGE', queueKey, '-', '+']);
            const decoded = this.decodeStreamEntries(rawEntries);
            if (decoded.length > 0) {
                snapshot[user] = decoded;
            }
        }
        return snapshot;
    }
    async subscribeToQueueEvents(handler) {
        if (!this.connected || !this.client) {
            return false;
        }
        try {
            if (!this.subscriber) {
                this.subscriber = this.client.duplicate();
                this.subscriber.on('error', (error) => {
                    console.warn('[REDIS] Queue subscriber error:', error instanceof Error ? error.message : String(error));
                });
                await this.subscriber.connect();
            }
            await this.subscriber.subscribe(this.queueEventsChannel(), (rawPayload) => {
                const payload = safeJsonParse(rawPayload, null);
                if (!payload || typeof payload !== 'object') {
                    return;
                }
                const user = toTrimmedString(payload.user).toLowerCase();
                if (!user) {
                    return;
                }
                handler({
                    user,
                    message: payload.message,
                    sourceId: toTrimmedString(payload.sourceId)
                });
            });
            return true;
        }
        catch (error) {
            console.warn('[REDIS] Queue subscribe failed:', error instanceof Error ? error.message : String(error));
            return false;
        }
    }
    decodeStreamEntries(rawEntries) {
        if (!Array.isArray(rawEntries)) {
            return [];
        }
        const decoded = [];
        for (const rawEntry of rawEntries) {
            if (!Array.isArray(rawEntry) || rawEntry.length < 2) {
                continue;
            }
            const fields = rawEntry[1];
            const payloadRaw = this.extractPayloadField(fields);
            if (!payloadRaw) {
                continue;
            }
            const parsed = safeJsonParse(payloadRaw, null);
            if (parsed !== null) {
                decoded.push(parsed);
            }
        }
        return decoded;
    }
    extractPayloadField(rawFields) {
        if (Array.isArray(rawFields)) {
            for (let index = 0; index < rawFields.length - 1; index += 2) {
                const key = toTrimmedString(rawFields[index]);
                if (key === 'payload') {
                    return String(rawFields[index + 1] ?? '');
                }
            }
            return '';
        }
        if (rawFields && typeof rawFields === 'object') {
            const candidate = rawFields.payload;
            return typeof candidate === 'string' ? candidate : '';
        }
        return '';
    }
}
exports.RedisStateStore = RedisStateStore;
async function createRedisStateStoreFromEnv(env = process.env) {
    const store = new RedisStateStore({
        url: env.REDIS_URL,
        keyPrefix: env.REDIS_KEY_PREFIX
    });
    await store.connect();
    return store;
}
