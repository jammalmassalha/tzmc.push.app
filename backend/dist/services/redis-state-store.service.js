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
    client = null;
    connected = false;
    constructor(config = {}) {
        this.redisUrl = toTrimmedString(config.url || process.env.REDIS_URL || '');
        this.keyPrefix = toTrimmedString(config.keyPrefix || process.env.REDIS_KEY_PREFIX || 'tzmc:notify');
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
        const encodedPayloads = messages.map((entry) => JSON.stringify(entry ?? {}));
        const queueKey = this.queueKeyForUser(normalizedUser);
        const tx = this.client.multi();
        tx.rPush(queueKey, encodedPayloads);
        tx.sAdd(this.queueUsersKey(), normalizedUser);
        await tx.exec();
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
        const tx = this.client.multi();
        tx.lRange(queueKey, 0, -1);
        tx.del(queueKey);
        tx.sRem(this.queueUsersKey(), normalizedUser);
        const result = await tx.exec();
        const listResult = Array.isArray(result) ? result[0] : null;
        const rawEntries = Array.isArray(listResult) ? listResult : [];
        return rawEntries.map((entry) => safeJsonParse(entry, null)).filter((entry) => entry !== null);
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
            const rawEntries = await this.client.lRange(queueKey, 0, -1);
            snapshot[user] = rawEntries.map((entry) => safeJsonParse(entry, null)).filter((entry) => entry !== null);
        }
        return snapshot;
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
