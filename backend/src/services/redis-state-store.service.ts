import { createClient, type RedisClientType } from 'redis';

export interface PersistedServerState {
  unreadCounts: Record<string, unknown>;
  messageQueue: Record<string, unknown[]>;
  groups: Record<string, unknown>;
  deviceSubscriptionsByUser: Record<string, unknown>;
  shuttleReminderSentAtByKey: Record<string, unknown>;
}

interface RedisStateStoreConfig {
  url?: string;
  keyPrefix?: string;
}

interface RedisQueueEventPayload {
  user: string;
  message: unknown;
  sourceId: string;
}

type QueueEventHandler = (event: RedisQueueEventPayload) => void;

function toTrimmedString(value: unknown): string {
  return String(value ?? '').trim();
}

function safeJsonParse<T>(payload: unknown, fallback: T): T {
  if (typeof payload !== 'string' || !payload.trim()) {
    return fallback;
  }
  try {
    return JSON.parse(payload) as T;
  } catch {
    return fallback;
  }
}

export class RedisStateStore {
  private readonly redisUrl: string;
  private readonly keyPrefix: string;
  private readonly queueStreamMaxLen: number;
  private readonly publisherId: string;
  private client: RedisClientType | null = null;
  private subscriber: RedisClientType | null = null;
  private connected = false;

  constructor(config: RedisStateStoreConfig = {}) {
    this.redisUrl = toTrimmedString(config.url || process.env.REDIS_URL || '');
    this.keyPrefix = toTrimmedString(config.keyPrefix || process.env.REDIS_KEY_PREFIX || 'tzmc:notify');
    this.queueStreamMaxLen = Math.max(
      100,
      Number(process.env.REDIS_QUEUE_STREAM_MAXLEN || 5000) || 5000
    );
    this.publisherId = toTrimmedString(process.env.REDIS_QUEUE_PUBLISHER_ID || '') || `srv-${process.pid}`;
  }

  get isEnabled(): boolean {
    return Boolean(this.redisUrl);
  }

  private stateKey(): string {
    return `${this.keyPrefix}:state:v1`;
  }

  private queueUsersKey(): string {
    return `${this.keyPrefix}:queue:users`;
  }

  private queueKeyForUser(user: string): string {
    return `${this.keyPrefix}:queue:${user}`;
  }

  private sequenceKeyForUser(user: string): string {
    return `${this.keyPrefix}:sequence:${user}`;
  }

  private chatPtsKey(chatId: string): string {
    return `${this.keyPrefix}:chat:${chatId}:pts`;
  }

  private queueEventsChannel(): string {
    return `${this.keyPrefix}:queue:events`;
  }

  private activeConnectionsKey(user: string): string {
    return `${this.keyPrefix}:connections:${user}`;
  }

  async registerActiveConnection(user: string, connectionId: string): Promise<void> {
    if (!this.connected || !this.client) return;
    const normalizedUser = toTrimmedString(user).toLowerCase();
    const normalizedConnection = toTrimmedString(connectionId);
    if (!normalizedUser || !normalizedConnection) return;
    await this.client.sAdd(this.activeConnectionsKey(normalizedUser), normalizedConnection);
    await this.client.expire(this.activeConnectionsKey(normalizedUser), 86400);
  }

  async unregisterActiveConnection(user: string, connectionId: string): Promise<void> {
    if (!this.connected || !this.client) return;
    const normalizedUser = toTrimmedString(user).toLowerCase();
    const normalizedConnection = toTrimmedString(connectionId);
    if (!normalizedUser || !normalizedConnection) return;
    const key = this.activeConnectionsKey(normalizedUser);
    await this.client.sRem(key, normalizedConnection);
    if ((await this.client.sCard(key)) === 0) await this.client.del(key);
  }

  async getActiveConnectionCount(user: string): Promise<number> {
    if (!this.connected || !this.client) return 0;
    const normalizedUser = toTrimmedString(user).toLowerCase();
    return normalizedUser ? Number(await this.client.sCard(this.activeConnectionsKey(normalizedUser))) || 0 : 0;
  }

  get queuePublisherId(): string {
    return this.publisherId;
  }

  async connect(): Promise<boolean> {
    if (!this.isEnabled) {
      return false;
    }
    if (this.connected && this.client) {
      return true;
    }
    try {
      this.client = createClient({ url: this.redisUrl });
      this.client.on('error', (error) => {
        // Keep runtime resilient; server.js handles fallback flow.
        console.warn('[REDIS] Client error:', error instanceof Error ? error.message : String(error));
      });
      await this.client.connect();
      this.connected = true;
      return true;
    } catch (error) {
      this.connected = false;
      this.client = null;
      console.warn('[REDIS] Failed to connect:', error instanceof Error ? error.message : String(error));
      return false;
    }
  }

  async loadState(): Promise<PersistedServerState | null> {
    if (!this.connected || !this.client) {
      return null;
    }
    const raw = await this.client.get(this.stateKey());
    const state = safeJsonParse<PersistedServerState | null>(raw, null);
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

  async persistState(state: PersistedServerState): Promise<void> {
    if (!this.connected || !this.client) {
      return;
    }
    const payload: PersistedServerState = {
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

  async enqueueMessages(user: string, messages: unknown[]): Promise<void> {
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
      await this.client.publish(
        this.queueEventsChannel(),
        JSON.stringify({
          user: normalizedUser,
          message: entry ?? {},
          sourceId: this.publisherId
        } satisfies RedisQueueEventPayload)
      );
    }
  }

  /** Atomically allocate the next mailbox sequence for a user. */
  async nextMailboxSequence(user: string): Promise<number> {
    if (!this.connected || !this.client) return 0;
    const normalizedUser = toTrimmedString(user).toLowerCase();
    if (!normalizedUser) return 0;
    const value = await this.client.incr(this.sequenceKeyForUser(normalizedUser));
    return Number(value) || 0;
  }

  async nextChatPts(chatId: string): Promise<number> {
    if (!this.connected || !this.client) return 0;
    const normalizedChatId = toTrimmedString(chatId);
    if (!normalizedChatId) return 0;
    const value = await this.client.incr(this.chatPtsKey(normalizedChatId));
    return Number(value) || 0;
  }

  /** Read retained mailbox events without consuming them. */
  async readQueueSince(user: string, lastSequence = 0): Promise<unknown[]> {
    if (!this.connected || !this.client) return [];
    const normalizedUser = toTrimmedString(user).toLowerCase();
    if (!normalizedUser) return [];
    const rawEntries = await this.client.sendCommand([
      'XRANGE', this.queueKeyForUser(normalizedUser), '-', '+'
    ]);
    return this.decodeStreamEntries(rawEntries).filter((entry) => {
      const value = entry && typeof entry === 'object'
        ? (entry as { seq_id?: unknown }).seq_id
        : undefined;
      return Number(value) > Number(lastSequence);
    });
  }

  async drainQueue(user: string): Promise<unknown[]> {
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

  async getQueueUsers(): Promise<string[]> {
    if (!this.connected || !this.client) {
      return [];
    }
    const values = await this.client.sMembers(this.queueUsersKey());
    return values.map((value) => toTrimmedString(value).toLowerCase()).filter(Boolean);
  }

  async loadQueueSnapshot(): Promise<Record<string, unknown[]>> {
    if (!this.connected || !this.client) {
      return {};
    }
    const users = await this.getQueueUsers();
    const snapshot: Record<string, unknown[]> = {};
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

  async subscribeToQueueEvents(handler: QueueEventHandler): Promise<boolean> {
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
        const payload = safeJsonParse<RedisQueueEventPayload | null>(rawPayload, null);
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
    } catch (error) {
      console.warn('[REDIS] Queue subscribe failed:', error instanceof Error ? error.message : String(error));
      return false;
    }
  }

  private decodeStreamEntries(rawEntries: unknown): unknown[] {
    if (!Array.isArray(rawEntries)) {
      return [];
    }
    const decoded: unknown[] = [];
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

  private extractPayloadField(rawFields: unknown): string {
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
      const candidate = (rawFields as { payload?: unknown }).payload;
      return typeof candidate === 'string' ? candidate : '';
    }
    return '';
  }
}

export async function createRedisStateStoreFromEnv(env: NodeJS.ProcessEnv = process.env): Promise<RedisStateStore> {
  const store = new RedisStateStore({
    url: env.REDIS_URL,
    keyPrefix: env.REDIS_KEY_PREFIX
  });
  await store.connect();
  return store;
}
