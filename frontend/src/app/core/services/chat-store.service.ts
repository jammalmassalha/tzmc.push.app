import { Injectable, computed, effect, signal } from '@angular/core';
import { SYSTEM_CHAT_IDS } from '../config/runtime-config';
import {
  ChatGroup,
  ChatListItem,
  ChatMessage,
  DeleteMessagePayload,
  Contact,
  DeliveryStatus,
  EditMessagePayload,
  GroupUpdatePayload,
  GroupType,
  IncomingServerMessage,
  MessageReference,
  MessageReaction,
  OutboxDirectItem,
  OutboxGroupItem,
  OutboxGroupUpdateItem,
  OutboxItem,
  PersistedChatState,
  ReplyPayload
} from '../models/chat.models';
import { ChatApiService, HrActionOption, HrStepOption } from './chat-api.service';

const CONTACTS_TTL_MS = 5 * 60 * 1000;
const CONTACTS_ACCESS_SYNC_INTERVAL_MS = 60 * 1000;
const GROUPS_TTL_MS = 2 * 60 * 1000;
const POLL_INTERVAL_MS = 15000;
const STREAM_RETRY_MS = 5000;
const MAX_PERSISTED_MESSAGES = 2500;
const PUSH_REGISTER_MIN_INTERVAL_MS = 30000;
const PUSH_REGISTER_REFRESH_MS = 6 * 60 * 60 * 1000;
const FOREGROUND_SYNC_MIN_INTERVAL_MS = 4000;
const BADGE_RESET_MIN_INTERVAL_MS = 30000;
const PUSH_RECOVERY_PULL_DELAYS_MS = [1200, 3600];
const DELIVERY_TELEMETRY_FLUSH_INTERVAL_MS = 60 * 1000;
const DELIVERY_TELEMETRY_FLUSH_MIN_EVENTS = 4;
const DELIVERY_TELEMETRY_DEVICE_ID_KEY = 'modern-chat-delivery-device-id';
const HR_CHAT_NAME = 'ציפי';
const SHUTTLE_CHAT_NAME = 'הזמנת הסעה';
const HR_WELCOME_KEY_PREFIX = 'hr_welcome_sent_';
const HR_STATE_KEY_PREFIX = 'hr_state_';
const HR_UPLOAD_BASE_URL = '/notify/uploads/';
const HR_STEPS_CACHE_TTL_MS = 5 * 60 * 1000;
const HR_ACTIONS_CACHE_TTL_MS = 5 * 60 * 1000;
const SHUTTLE_WELCOME_KEY_PREFIX = 'shuttle_welcome_sent_';
const SHUTTLE_STATE_KEY_PREFIX = 'shuttle_state_';
const SHUTTLE_ORDERS_KEY_PREFIX = 'shuttle_orders_';
const SHUTTLE_LIST_CACHE_TTL_MS = 5 * 60 * 1000;
const SHUTTLE_DATE_CHOICES_COUNT = 10;
const SHUTTLE_STATUS_ACTIVE_VALUE = 'פעיל активный';
const SHUTTLE_STATUS_CANCEL_VALUE = 'ביטול נסיעה отмена поезд';
const SHUTTLE_STATUS_ACTIVE_LABEL = 'פעיל';
const SHUTTLE_STATUS_CANCEL_LABEL = 'בוטל';
const SHUTTLE_DAY_NAMES = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'] as const;
const SHUTTLE_SHIFT_OPTIONS = [
  { label: '05:00', value: "'05:00" },
  { label: '06:00', value: "'06:00" },
  { label: '12:00', value: "'12:00" },
  { label: '14:00', value: "'14:00" },
  { label: '22:00', value: "'22:00" }
] as const;
const READ_RECEIPT_BATCH_SIZE = 80;
const READ_RECEIPT_FLUSH_DEBOUNCE_MS = 900;
const DELETED_MESSAGE_PLACEHOLDER = '🚫 הודעה זו נמחקה';

type HrAwaitingState = 'step' | 'action' | 'free-text';

interface HrConversationState {
  awaiting: HrAwaitingState;
  stepId: string | null;
  actions: HrActionOption[];
}

type ShuttleAwaitingState = 'menu' | 'date' | 'shift' | 'station' | 'cancel-select';

interface ShuttleOrderDraft {
  date: string;
  dayName: string;
  shiftLabel: string;
  shiftValue: string;
  station: string;
}

export interface ShuttleOrderRecord extends ShuttleOrderDraft {
  id: string;
  employee: string;
  statusValue: string;
  statusLabel: string;
  submittedAt: number;
  cancelledAt?: number;
}

export interface ShuttleOrdersDashboard {
  ongoing: ShuttleOrderRecord[];
  past: ShuttleOrderRecord[];
}

interface ShuttleDateChoice {
  value: string;
  dayName: string;
  label: string;
}

interface ShuttleConversationState {
  awaiting: ShuttleAwaitingState;
  draft: Partial<ShuttleOrderDraft> | null;
  cancelCandidateIds: string[];
}

interface MessageActionSnapshot {
  body: string;
  imageUrl?: string | null;
  thumbnailUrl?: string | null;
  editedAt?: number | null;
  deletedAt?: number | null;
}

interface SendMessageOptions {
  replyTo?: MessageReference | null;
  forwarded?: boolean;
  forwardedFrom?: string | null;
  forwardedFromName?: string | null;
}

interface SendMessagePayload extends SendMessageOptions {
  body: string;
  imageUrl: string | null;
  thumbnailUrl?: string | null;
}

interface DeliveryTelemetryCounters {
  pushPayloadReceived: number;
  pushImmediateMessageBuilt: number;
  pushMessageApplied: number;
  pushMessageNoop: number;
  pushMissingMessageContext: number;
  pushRecoveryPullScheduled: number;
  ssePayloadReceived: number;
  sseMessageApplied: number;
  sseMessageNoop: number;
  pollMessagesFetched: number;
  pollMessagesApplied: number;
}

type BadgeCapableNavigator = Navigator & {
  setAppBadge?: (count?: number) => Promise<void>;
  clearAppBadge?: () => Promise<void>;
};

type BadgeMessage =
  | { action: 'set-app-badge-count'; count: number }
  | { action: 'clear-app-badge' }
  | { action: 'clear-device-attention' };

export interface IncomingReactionNotice {
  id: string;
  chatId: string;
  groupName: string;
  reactorName: string;
  emoji: string;
}

export interface ActivatedChatMeta {
  chatId: string;
  unreadBeforeOpen: number;
  activatedAt: number;
}

export interface ShuttleQuickPickerOption {
  value: string;
  label: string;
}

export interface ShuttleQuickPickerState {
  key: string;
  title: string;
  helperText?: string;
  mode: 'buttons' | 'select';
  options: ShuttleQuickPickerOption[];
  allowBack: boolean;
}

export interface ShuttleBreadcrumbStep {
  key: string;
  label: string;
  value: string;
  active: boolean;
  completed: boolean;
}

@Injectable({ providedIn: 'root' })
export class ChatStoreService {
  readonly currentUser = signal<string | null>(null);
  readonly contacts = signal<Contact[]>([]);
  readonly groups = signal<ChatGroup[]>([]);
  readonly activeChatId = signal<string | null>(null);
  readonly lastActivatedChatMeta = signal<ActivatedChatMeta | null>(null);
  readonly unreadByChat = signal<Record<string, number>>({});
  readonly loading = signal(false);
  readonly syncing = signal(false);
  readonly uploading = signal(false);
  readonly networkOnline = signal(typeof navigator !== 'undefined' ? navigator.onLine : true);
  readonly lastError = signal<string | null>(null);
  readonly incomingReactionNotice = signal<IncomingReactionNotice | null>(null);

  private readonly messagesByChat = signal<Record<string, ChatMessage[]>>({});
  private stream: EventSource | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private contactsAccessSyncTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private pullInFlight = false;
  private initializedUser: string | null = null;
  private lastContactsFetchAt = 0;
  private lastGroupsFetchAt = 0;
  private hrStepsCache: { at: number; steps: HrStepOption[] } = { at: 0, steps: [] };
  private hrActionsCache: Record<string, { at: number; actions: HrActionOption[] }> = {};
  private hrInitInFlight = false;
  private shuttleInitInFlight = false;
  private shuttleStationsCache: { at: number; items: string[] } = { at: 0, items: [] };
  private shuttleEmployeesCache: { at: number; items: string[] } = { at: 0, items: [] };
  private readonly shuttlePickerRevision = signal(0);
  private lastAppliedAppBadgeCount = -1;
  private lastServerBadgeResetAt = 0;
  private lastForegroundSyncAt = 0;
  private readonly readReceiptSentByChat = new Map<string, Set<string>>();
  private readonly pendingReadReceiptByChat = new Map<string, Set<string>>();
  private readonly readReceiptFlushTimerByChat = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly readReceiptFlushInFlightByChat = new Set<string>();
  private pushRegisterInFlight = false;
  private lastPushRegisterAttemptAt = 0;
  private contactsAccessSyncInFlight = false;
  private authBootstrapPromise: Promise<void> | null = null;
  private deliveryTelemetryFlushTimer: ReturnType<typeof setInterval> | null = null;
  private deliveryTelemetryInFlight = false;
  private deliveryTelemetryLastFlushedAt = 0;
  private deliveryTelemetryDeviceId = '';
  private deliveryTelemetryCounters: DeliveryTelemetryCounters = this.createEmptyDeliveryTelemetryCounters();
  private readonly systemChatIdSet = new Set<string>(
    SYSTEM_CHAT_IDS.map((id) => this.normalizeChatId(id)).filter(Boolean)
  );
  private incomingBatchDepth = 0;
  private pendingPersistAfterIncomingBatch = false;

  readonly chatItems = computed<ChatListItem[]>(() => {
    const groups = this.groups();
    const contacts = this.contacts();
    const messageMap = this.messagesByChat();
    const unreadMap = this.unreadByChat();
    const groupsById = new Map(groups.map((group) => [group.id, group]));
    const contactsById = new Map(contacts.map((contact) => [contact.username, contact]));
    const chatIds = new Set<string>();

    for (const contact of contacts) {
      chatIds.add(contact.username);
    }
    for (const group of groups) {
      chatIds.add(group.id);
    }
    for (const id of Object.keys(messageMap)) {
      chatIds.add(id);
    }
    for (const systemId of this.systemChatIdSet) {
      chatIds.add(systemId);
    }
    const items: ChatListItem[] = [];

    for (const chatId of chatIds) {
      const group = groupsById.get(chatId);
      const contact = contactsById.get(chatId);
      const messages = messageMap[chatId] ?? [];
      const lastMessage = messages[messages.length - 1];

      const title = group?.name ?? contact?.displayName ?? chatId;
      const subtitle = lastMessage ? this.getMessagePreview(lastMessage) : (group ? 'אין הודעות בקבוצה' : '');
      const lastTimestamp = lastMessage?.timestamp ?? 0;
      const unread = unreadMap[chatId] ?? 0;
      const pinned = this.isSystemChat(chatId);

      items.push({
        id: chatId,
        title,
        info: contact?.info,
        subtitle,
        lastTimestamp,
        unread,
        isGroup: Boolean(group),
        pinned,
        avatarUrl: contact?.upic || null
      });
    }

    return items.sort((a, b) => {
      if (a.pinned && !b.pinned) return -1;
      if (!a.pinned && b.pinned) return 1;
      return b.lastTimestamp - a.lastTimestamp;
    });
  });

  readonly activeChat = computed<ChatListItem | null>(() => {
    const active = this.activeChatId();
    if (!active) return null;
    return this.chatItems().find((chat) => chat.id === active) ?? null;
  });

  readonly activeMessages = computed<ChatMessage[]>(() => {
    const active = this.activeChatId();
    if (!active) return [];
    return this.messagesByChat()[active] ?? [];
  });

  readonly canSendToActiveChat = computed<boolean>(() => {
    const active = this.activeChatId();
    if (!active) return false;
    const group = this.groups().find((item) => item.id === active);
    if (!group) return true;
    if (group.type !== 'community') return true;
    return this.normalizeUser(group.createdBy) === this.normalizeUser(this.currentUser() ?? '');
  });

  private readonly appBadgeSyncEffect = effect(() => {
    const unreadMap = this.unreadByChat();
    const unreadTotal = Object.values(unreadMap).reduce((sum, count) => sum + (Number(count) || 0), 0);
    this.syncAppBadge(unreadTotal);
  });

  constructor(private readonly api: ChatApiService) {
    if (typeof window !== 'undefined') {
      window.addEventListener('online', this.handleOnline);
      window.addEventListener('offline', this.handleOffline);
      window.addEventListener('focus', this.handleWindowFocus);
      document.addEventListener('visibilitychange', this.handleVisibilityChange);
    }
    if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
      navigator.serviceWorker.addEventListener('message', this.handleServiceWorkerMessage);
    }
  }

  isAuthenticated(): boolean {
    return Boolean(this.currentUser());
  }

  async ensureSessionReady(): Promise<void> {
    if (!this.authBootstrapPromise) {
      this.authBootstrapPromise = this.bootstrapSessionUser();
    }
    await this.authBootstrapPromise;
  }

  private async bootstrapSessionUser(): Promise<void> {
    this.removeLegacyStoredUser();
    try {
      const sessionUser = await this.api.getSessionUser();
      if (!sessionUser) {
        this.currentUser.set(null);
        return;
      }
      const user = this.normalizeUser(sessionUser);
      if (!user) {
        this.currentUser.set(null);
        return;
      }
      this.currentUser.set(user);
      this.restoreState(user);
    } catch {
      this.currentUser.set(null);
    }
  }

  async initialize(): Promise<void> {
    await this.ensureSessionReady();
    const user = this.currentUser();
    if (!user) return;
    if (this.initializedUser === user) return;

    this.initializedUser = user;
    await this.refresh(true);
    // Ensure first chat/message snapshot is loaded before startup loader can finish.
    await this.pullMessages(user);
    this.clearDeviceAttention({ resetServerBadge: true });
    // Recover silently if a device lost its push subscription.
    void this.tryRegisterPush(user, { force: true });
    this.connectRealtime(user);
    await this.flushOutbox();
    this.startBackgroundContactsAccessSync(user);
    void this.syncContactsAccessInBackground(user);
    this.startDeliveryTelemetry(user);

    const storedActive = this.getStoredActiveChat(user);
    if (storedActive && this.chatItems().some((chat) => chat.id === storedActive)) {
      this.setActiveChat(storedActive);
      return;
    }

    if (this.shouldOpenHomeOnInit(user)) {
      this.activeChatId.set(null);
      return;
    }

    if (!this.activeChatId()) {
      const preferredChat = this.pickInitialChatId();
      if (preferredChat) {
        this.setActiveChat(preferredChat);
      }
    }
  }

  async registerUser(rawValue: string): Promise<void> {
    const normalized = this.normalizePhone(rawValue);
    if (!normalized) {
      throw new Error('מספר טלפון לא תקין');
    }

    const user = await this.api.createSession(this.normalizeUser(normalized));
    await this.applyAuthenticatedSessionUser(user);
  }

  async requestUserVerificationCode(rawValue: string): Promise<string> {
    const normalized = this.normalizePhone(rawValue);
    if (!normalized) {
      throw new Error('מספר טלפון לא תקין');
    }

    await this.api.requestSessionCode(this.normalizeUser(normalized));
    return normalized;
  }

  async verifyUserVerificationCode(rawPhone: string, rawCode: string): Promise<void> {
    const normalizedPhone = this.normalizePhone(rawPhone);
    const normalizedCode = String(rawCode || '').trim();
    if (!normalizedPhone) {
      throw new Error('מספר טלפון לא תקין');
    }
    if (!/^\d{6}$/.test(normalizedCode)) {
      throw new Error('יש להזין קוד אימות בן 6 ספרות');
    }

    const user = await this.api.verifySessionCode(this.normalizeUser(normalizedPhone), normalizedCode);
    await this.applyAuthenticatedSessionUser(user);
  }

  private async applyAuthenticatedSessionUser(user: string): Promise<void> {
    this.stopRealtime();
    this.stopBackgroundContactsAccessSync();
    void this.flushDeliveryTelemetry({ force: true, includeZero: false });
    this.stopDeliveryTelemetry();

    this.currentUser.set(user);
    this.initializedUser = null;
    this.contacts.set([]);
    this.groups.set([]);
    this.messagesByChat.set({});
    this.unreadByChat.set({});
    this.resetReadReceiptTrackingState();
    this.activeChatId.set(null);
    this.lastError.set(null);

    this.restoreState(user);
    await this.tryRegisterPush(user, { force: true });
    await this.initialize();
  }

  async logout(): Promise<void> {
    try {
      await this.api.clearSession();
    } catch {
      // Keep local logout resilient even if network fails.
    }
    const user = this.currentUser();
    this.stopRealtime();
    this.stopBackgroundContactsAccessSync();
    void this.flushDeliveryTelemetry({ force: true, includeZero: false });
    this.stopDeliveryTelemetry();
    this.initializedUser = null;
    if (user) {
      localStorage.removeItem(this.activeChatKey(user));
      localStorage.removeItem(this.homeViewKey(user));
    }
    this.currentUser.set(null);
    this.contacts.set([]);
    this.groups.set([]);
    this.messagesByChat.set({});
    this.unreadByChat.set({});
    this.resetReadReceiptTrackingState();
    this.activeChatId.set(null);
    this.lastError.set(null);
  }

  async refresh(force = false): Promise<void> {
    const user = this.currentUser();
    if (!user) return;

    const now = Date.now();
    const shouldFetchContacts = force || now - this.lastContactsFetchAt >= CONTACTS_TTL_MS;
    const shouldFetchGroups = force || now - this.lastGroupsFetchAt >= GROUPS_TTL_MS;
    if (!shouldFetchContacts && !shouldFetchGroups) return;

    this.loading.set(true);
    this.lastError.set(null);

    const contactsPromise = shouldFetchContacts ? this.api.getContacts(user) : Promise.resolve(this.contacts());
    const groupsPromise = shouldFetchGroups ? this.api.getGroups(user) : Promise.resolve(this.groups());
    const [contactsResult, groupsResult] = await Promise.allSettled([contactsPromise, groupsPromise]);

    if (contactsResult.status === 'fulfilled') {
      const contacts = this.normalizeContacts(contactsResult.value);
      this.contacts.set(contacts);
      this.lastContactsFetchAt = now;
    } else {
      this.lastError.set('טעינת אנשי קשר נכשלה');
    }

    if (groupsResult.status === 'fulfilled') {
      const groups = this.normalizeGroups(groupsResult.value, user);
      this.groups.set(groups);
      this.lastGroupsFetchAt = now;
    } else {
      this.lastError.set('טעינת קבוצות נכשלה');
    }

    this.loading.set(false);
    this.schedulePersist();
  }

  async preloadLatestMessagesBeforeCacheCleanup(): Promise<void> {
    const user = this.currentUser();
    if (!user || !this.networkOnline()) return;

    try {
      await this.pullMessages(user);
    } catch {
      // Best-effort pre-sync before cache cleanup.
    }

    try {
      await this.refresh(true);
    } catch {
      // Best-effort pre-sync before cache cleanup.
    }

    try {
      await this.flushOutbox();
    } catch {
      // Best-effort pre-sync before cache cleanup.
    }
  }

  setActiveChat(chatId: string | null): void {
    if (!chatId) {
      this.activeChatId.set(null);
      this.lastActivatedChatMeta.set(null);
      return;
    }

    const normalized = this.normalizeChatId(chatId);
    const unreadBeforeOpen = Math.max(0, Math.floor(Number(this.unreadByChat()[normalized] ?? 0)));
    this.lastActivatedChatMeta.set({
      chatId: normalized,
      unreadBeforeOpen,
      activatedAt: Date.now()
    });
    this.activeChatId.set(normalized);
    const user = this.currentUser();
    if (user) {
      localStorage.setItem(this.activeChatKey(user), normalized);
      localStorage.removeItem(this.homeViewKey(user));
    }
    this.seedPendingReadReceiptsFromUnreadCount(normalized, unreadBeforeOpen);
    void this.onChatActivated(normalized);
    this.schedulePersist();
  }

  markActiveChatReadAtBottom(chatId?: string | null): void {
    const normalizedChatId = this.normalizeChatId(chatId ?? this.activeChatId() ?? '');
    if (!normalizedChatId) return;
    const unreadCount = Math.max(0, Math.floor(Number(this.unreadByChat()[normalizedChatId] ?? 0)));

    // Clear local unread badge as soon as user reaches the chat bottom.
    this.clearUnreadCountForChat(normalizedChatId);

    const isGroupChat = this.groups().some((group) => group.id === normalizedChatId);
    const isSystemChat = this.isSystemChat(normalizedChatId);
    if (isGroupChat || isSystemChat) {
      return;
    }

    this.seedPendingReadReceiptsFromUnreadCount(
      normalizedChatId,
      unreadCount
    );
    this.scheduleReadReceiptFlush(normalizedChatId);
  }

  clearLastActiveChat(): void {
    const user = this.currentUser();
    this.activeChatId.set(null);
    if (!user) return;

    localStorage.removeItem(this.activeChatKey(user));
    localStorage.setItem(this.homeViewKey(user), '1');
  }

  startDirectChat(username: string): void {
    const normalized = this.normalizeUser(username);
    if (!normalized) return;

    const exists = this.contacts().some((contact) => contact.username === normalized);
    if (!exists) {
      const fallback: Contact = {
        username: normalized,
        displayName: normalized
      };
      this.contacts.update((contacts) => [fallback, ...contacts]);
    }

    this.setActiveChat(normalized);
  }

  async createGroup(payload: {
    name: string;
    members: string[];
    type: GroupType;
  }): Promise<void> {
    const user = this.currentUser();
    if (!user) {
      throw new Error('יש להתחבר לפני יצירת קבוצה');
    }

    const groupName = payload.name.trim();
    if (!groupName) {
      throw new Error('יש להזין שם לקבוצה');
    }

    const members = Array.from(
      new Set([...payload.members.map((member) => this.normalizeUser(member)), user])
    ).filter(Boolean);

    if (members.length < 2) {
      throw new Error('יש לבחור לפחות שני משתתפים');
    }

    const groupId = `group:${this.generateId('grp')}`;
    const group: ChatGroup = {
      id: groupId,
      name: groupName,
      members,
      createdBy: user,
      updatedAt: Date.now(),
      type: payload.type
    };

    this.groups.update((groups) => [group, ...groups.filter((item) => item.id !== group.id)]);
    this.setActiveChat(group.id);
    this.schedulePersist();

    const membersToNotify = group.members.filter((member) => member !== user);
    if (!membersToNotify.length) return;

    const groupUpdatePayload = {
      groupId: group.id,
      groupName: group.name,
      groupMembers: group.members,
      groupCreatedBy: group.createdBy,
      groupUpdatedAt: group.updatedAt,
      groupType: group.type,
      membersToNotify
    } as const;

    if (!this.networkOnline()) {
      this.queueGroupUpdate(groupUpdatePayload);
      return;
    }

    try {
      await this.api.sendGroupUpdate(groupUpdatePayload);
    } catch {
      this.queueGroupUpdate(groupUpdatePayload);
    }
  }

  async updateCommunityGroupMembers(groupId: string, nextMembers: string[]): Promise<void> {
    const user = this.currentUser();
    if (!user) {
      throw new Error('יש להתחבר לפני עדכון קבוצה');
    }

    const normalizedGroupId = this.normalizeChatId(groupId);
    const group = this.groups().find((item) => item.id === normalizedGroupId);
    if (!group) {
      throw new Error('הקבוצה לא נמצאה');
    }

    const normalizedUser = this.normalizeUser(user);
    const adminUser = this.normalizeUser(group.createdBy);
    if (normalizedUser !== adminUser) {
      throw new Error('רק מנהל קבוצה יכול לעדכן משתתפים');
    }

    const normalizedNextMembers = Array.from(
      new Set(nextMembers.map((member) => this.normalizeUser(member)).filter(Boolean))
    );
    if (!normalizedNextMembers.includes(adminUser)) {
      normalizedNextMembers.unshift(adminUser);
    }
    if (normalizedNextMembers.length < 2) {
      throw new Error('קבוצה חייבת לכלול לפחות שני משתתפים');
    }

    const previousMembers = group.members.map((member) => this.normalizeUser(member)).filter(Boolean);
    const updatedGroup: ChatGroup = {
      ...group,
      members: normalizedNextMembers,
      updatedAt: Date.now()
    };

    this.groups.update((groups) =>
      groups.map((item) => (item.id === updatedGroup.id ? updatedGroup : item))
    );
    this.schedulePersist();

    const membersToNotify = Array.from(
      new Set([...previousMembers, ...updatedGroup.members].map((member) => this.normalizeUser(member)))
    ).filter((member) => member && member !== normalizedUser);
    if (!membersToNotify.length) return;

    const groupUpdatePayload: GroupUpdatePayload = {
      groupId: updatedGroup.id,
      groupName: updatedGroup.name,
      groupMembers: updatedGroup.members,
      groupCreatedBy: updatedGroup.createdBy,
      groupUpdatedAt: updatedGroup.updatedAt,
      groupType: updatedGroup.type,
      membersToNotify
    };

    if (!this.networkOnline()) {
      this.queueGroupUpdate(groupUpdatePayload);
      return;
    }

    try {
      await this.api.sendGroupUpdate(groupUpdatePayload);
    } catch {
      this.queueGroupUpdate(groupUpdatePayload);
    }
  }

  canSendToChat(chatId: string): boolean {
    const normalizedChatId = this.normalizeChatId(chatId);
    if (!normalizedChatId) return false;
    const group = this.groups().find((item) => item.id === normalizedChatId);
    if (!group) return true;
    if (group.type !== 'community') return true;
    return this.normalizeUser(group.createdBy) === this.normalizeUser(this.currentUser() ?? '');
  }

  getShuttleQuickPickerState(): ShuttleQuickPickerState | null {
    this.shuttlePickerRevision();
    const activeChatId = this.activeChatId();
    if (!this.isShuttleChat(activeChatId)) {
      return null;
    }
    const user = this.currentUser();
    if (!user) {
      return null;
    }

    const state = this.loadShuttleState(user) ?? this.defaultShuttleState();
    if (state.awaiting === 'menu') {
      return {
        key: 'menu',
        title: 'מה תרצה לבצע?',
        helperText: 'בחר פעולה בלחיצה',
        mode: 'buttons',
        options: [
          { value: 'הזמנה חדשה', label: 'הזמנה חדשה' },
          { value: 'הבקשות שלי', label: 'הבקשות שלי' },
          { value: 'ביטול הזמנה קיימת', label: 'ביטול הזמנה קיימת' }
        ],
        allowBack: false
      };
    }

    if (state.awaiting === 'date') {
      return {
        key: 'date',
        title: 'בחר תאריך נסיעה',
        helperText: 'התאריכים זמינים ל-10 הימים הקרובים',
        mode: 'buttons',
        options: this.getShuttleDateChoices().map((choice) => ({
          value: choice.label,
          label: choice.label
        })),
        allowBack: true
      };
    }

    if (state.awaiting === 'shift') {
      return {
        key: 'shift',
        title: 'בחר משמרת',
        helperText: 'הסעה לעבודה',
        mode: 'buttons',
        options: SHUTTLE_SHIFT_OPTIONS.map((option) => ({
          value: option.label,
          label: option.label
        })),
        allowBack: true
      };
    }

    if (state.awaiting === 'station') {
      const stations = this.shuttleStationsCache.items;
      return {
        key: `station-${stations.length}`,
        title: 'בחר תחנה',
        helperText: 'לחץ על הרשימה ובחר תחנה',
        mode: 'select',
        options: stations.map((station) => ({
          value: station,
          label: station
        })),
        allowBack: true
      };
    }

    if (state.awaiting === 'cancel-select') {
      const cancelOptions = this.getShuttleCancelCandidateOrders(user, state)
        .filter((order) => this.isShuttleOrderOngoing(order))
        .map((order) => {
          const summary = this.buildShuttleOrderSummary(order);
          return {
            value: summary,
            label: summary
          };
        });
      return {
        key: `cancel-${cancelOptions.length}`,
        title: 'בחר הזמנה לביטול',
        helperText: cancelOptions.length ? 'בחר הזמנה מהרשימה ולחץ אישור' : 'אין הזמנות פעילות לביטול',
        mode: 'select',
        options: cancelOptions,
        allowBack: true
      };
    }

    return null;
  }

  getShuttleOrdersDashboard(): ShuttleOrdersDashboard | null {
    this.shuttlePickerRevision();
    const activeChatId = this.activeChatId();
    if (!this.isShuttleChat(activeChatId)) {
      return null;
    }
    const user = this.currentUser();
    if (!user) {
      return null;
    }

    const orders = this.loadShuttleOrders(user)
      .slice()
      .sort((a, b) => (b.submittedAt || 0) - (a.submittedAt || 0));
    const ongoing: ShuttleOrderRecord[] = [];
    const past: ShuttleOrderRecord[] = [];
    orders.forEach((order) => {
      if (this.isShuttleOrderOngoing(order)) {
        ongoing.push(order);
      } else {
        past.push(order);
      }
    });
    return { ongoing, past };
  }

  getShuttleFlowBreadcrumbs(): ShuttleBreadcrumbStep[] | null {
    this.shuttlePickerRevision();
    const activeChatId = this.activeChatId();
    if (!this.isShuttleChat(activeChatId)) {
      return null;
    }

    const user = this.currentUser();
    if (!user) {
      return null;
    }

    const state = this.loadShuttleState(user) ?? this.defaultShuttleState();
    const draft = state.draft || {};

    if (state.awaiting === 'cancel-select') {
      return [
        {
          key: 'menu',
          label: 'פעולה',
          value: 'ביטול הזמנה',
          active: false,
          completed: true
        },
        {
          key: 'cancel-select',
          label: 'בחירת הזמנה',
          value: '',
          active: true,
          completed: false
        }
      ];
    }

    const dateValue = String(draft.dayName || '').trim() && String(draft.date || '').trim()
      ? `${String(draft.dayName || '').trim()} ${String(draft.date || '').trim()}`
      : '';
    const shiftValue = String(draft.shiftLabel || '').trim();
    const stationValue = String(draft.station || '').trim();
    const awaiting = state.awaiting;

    return [
      {
        key: 'menu',
        label: 'פעולה',
        value: awaiting === 'menu' ? '' : 'הזמנה חדשה',
        active: awaiting === 'menu',
        completed: awaiting !== 'menu'
      },
      {
        key: 'date',
        label: 'תאריך',
        value: dateValue,
        active: awaiting === 'date',
        completed: Boolean(dateValue) && awaiting !== 'date'
      },
      {
        key: 'shift',
        label: 'משמרת',
        value: shiftValue,
        active: awaiting === 'shift',
        completed: Boolean(shiftValue) && awaiting !== 'shift'
      },
      {
        key: 'station',
        label: 'תחנה',
        value: stationValue,
        active: awaiting === 'station',
        completed: false
      }
    ];
  }

  async submitShuttleQuickPickerSelection(rawValue: string): Promise<void> {
    const activeChatId = this.activeChatId();
    if (!this.isShuttleChat(activeChatId)) {
      throw new Error('הצ׳אט הפעיל אינו הזמנת הסעה');
    }

    const value = String(rawValue || '').trim();
    if (!value) {
      throw new Error('בחירה חסרה');
    }

    const handledByShuttleFlow = await this.handleShuttleOutgoing(value);
    if (!handledByShuttleFlow) {
      throw new Error('הבחירה לא עובדה. נסה שוב.');
    }
  }

  async cancelShuttleOrderById(orderId: string): Promise<void> {
    const user = this.currentUser();
    if (!user) {
      throw new Error('יש להתחבר לפני ביטול הזמנה');
    }

    const normalizedId = String(orderId || '').trim();
    if (!normalizedId) {
      throw new Error('הזמנה לא תקינה');
    }

    const targetOrder = this.loadShuttleOrders(user).find((order) => order.id === normalizedId);
    if (!targetOrder) {
      throw new Error('הזמנה לא נמצאה');
    }
    if (!this.isShuttleOrderOngoing(targetOrder)) {
      throw new Error('ניתן למחוק רק הזמנה פעילה');
    }

    await this.submitShuttleOrder(user, targetOrder, SHUTTLE_STATUS_CANCEL_VALUE);
    this.markShuttleOrderCancelled(user, targetOrder.id);
    this.sendShuttleSystemMessage(
      `ההזמנה בוטלה בהצלחה ✅\n${this.buildShuttleOrderSummary({
        ...targetOrder,
        statusValue: SHUTTLE_STATUS_CANCEL_VALUE,
        statusLabel: SHUTTLE_STATUS_CANCEL_LABEL
      })}`,
      { recordType: 'shuttle-cancel-success' }
    );
  }

  async sendTextMessage(text: string, options: SendMessageOptions = {}): Promise<void> {
    const body = text.trim();
    if (!body) return;

    await this.sendMessageInternal({
      body,
      imageUrl: null,
      ...options
    });
  }

  async forwardMessageToChat(destinationChatId: string, sourceMessage: ChatMessage): Promise<void> {
    const targetChatId = this.normalizeChatId(destinationChatId);
    if (!targetChatId) {
      throw new Error('צ׳אט יעד לא תקין');
    }

    if (!sourceMessage || sourceMessage.deletedAt) {
      throw new Error('לא ניתן להעביר הודעה שנמחקה');
    }

    if (!this.canSendToChat(targetChatId)) {
      throw new Error('אין הרשאה לשלוח בצ׳אט היעד');
    }

    const sourceBody = String(sourceMessage.body ?? '');
    const sourceImageUrl = sourceMessage.imageUrl ?? null;
    if (!sourceBody.trim() && !sourceImageUrl) {
      throw new Error('אין תוכן להעברה');
    }

    const sourceSender = this.normalizeUser(sourceMessage.sender || '');
    const sourceSenderName = String(
      sourceMessage.senderDisplayName || (sourceSender ? this.getDisplayName(sourceSender) : '')
    ).trim();

    await this.dispatchMessageToChat(
      targetChatId,
      {
        body: sourceBody,
        imageUrl: sourceImageUrl,
        thumbnailUrl: sourceMessage.thumbnailUrl ?? null,
        forwarded: true,
        forwardedFrom: sourceSender || null,
        forwardedFromName: sourceSenderName || null
      },
      { activateChat: false }
    );
  }

  async editSentMessageForEveryone(messageId: string, nextBody: string): Promise<void> {
    const user = this.currentUser();
    if (!user) {
      throw new Error('יש להתחבר לפני עריכת הודעה');
    }

    const normalizedMessageId = String(messageId || '').trim();
    const trimmedBody = String(nextBody || '').trim();
    if (!normalizedMessageId || !trimmedBody) {
      throw new Error('תוכן העריכה חסר');
    }
    if (!this.isNetworkReachable()) {
      throw new Error('לא ניתן לערוך הודעה ללא חיבור');
    }

    const target = this.findOutgoingMessageForAction(normalizedMessageId);
    if (!target) {
      throw new Error('לא נמצאה הודעה לעריכה');
    }
    if (target.message.deletedAt) {
      throw new Error('לא ניתן לערוך הודעה שנמחקה');
    }

    const currentBody = String(target.message.body || '').trim();
    if (trimmedBody === currentBody) {
      return;
    }

    const editTimestamp = Date.now();
    const normalizedUser = this.normalizeUser(user);
    const group = target.message.groupId
      ? this.groups().find((item) => item.id === this.normalizeChatId(target.message.groupId ?? '')) ?? null
      : null;
    const recipients = group
      ? group.members
          .map((member) => this.normalizeUser(member))
          .filter((member) => Boolean(member && member !== normalizedUser))
      : [this.normalizeUser(target.message.chatId)].filter(Boolean);
    const payload: EditMessagePayload = {
      sender: normalizedUser,
      messageId: normalizedMessageId,
      body: trimmedBody,
      editedAt: editTimestamp,
      timestamp: Number(target.message.timestamp || Date.now()),
      recipients,
      recipient: recipients.length === 1 ? recipients[0] : undefined,
      groupId: group?.id || target.message.groupId || undefined,
      groupName: group?.name || target.message.groupName || undefined,
      groupMembers: group?.members,
      groupCreatedBy: group?.createdBy,
      groupUpdatedAt: group?.updatedAt,
      groupType: group?.type
    };

    const snapshot: MessageActionSnapshot = {
      body: target.message.body,
      editedAt: target.message.editedAt ?? null,
      deletedAt: target.message.deletedAt ?? null
    };
    const optimisticApplied = this.applyMessageEditLocally(normalizedMessageId, trimmedBody, editTimestamp);
    if (!optimisticApplied) {
      return;
    }

    try {
      await this.api.editMessageForEveryone(payload);
    } catch (error) {
      this.restoreMessageSnapshotLocally(normalizedMessageId, snapshot);
      throw error;
    }
  }

  async deleteSentMessageForEveryone(messageId: string): Promise<void> {
    const user = this.currentUser();
    if (!user) {
      throw new Error('יש להתחבר לפני מחיקת הודעה');
    }

    const normalizedMessageId = String(messageId || '').trim();
    if (!normalizedMessageId) {
      throw new Error('מזהה הודעה חסר');
    }
    if (!this.isNetworkReachable()) {
      throw new Error('לא ניתן למחוק הודעה ללא חיבור');
    }

    const target = this.findOutgoingMessageForAction(normalizedMessageId);
    if (!target) {
      throw new Error('לא נמצאה הודעה למחיקה');
    }
    if (target.message.deletedAt) {
      return;
    }

    const deleteTimestamp = Date.now();
    const normalizedUser = this.normalizeUser(user);
    const group = target.message.groupId
      ? this.groups().find((item) => item.id === this.normalizeChatId(target.message.groupId ?? '')) ?? null
      : null;
    const recipients = group
      ? group.members
          .map((member) => this.normalizeUser(member))
          .filter((member) => Boolean(member && member !== normalizedUser))
      : [this.normalizeUser(target.message.chatId)].filter(Boolean);
    const payload: DeleteMessagePayload = {
      sender: normalizedUser,
      messageId: normalizedMessageId,
      deletedAt: deleteTimestamp,
      timestamp: Number(target.message.timestamp || Date.now()),
      recipients,
      recipient: recipients.length === 1 ? recipients[0] : undefined,
      groupId: group?.id || target.message.groupId || undefined,
      groupName: group?.name || target.message.groupName || undefined,
      groupMembers: group?.members,
      groupCreatedBy: group?.createdBy,
      groupUpdatedAt: group?.updatedAt,
      groupType: group?.type
    };

    const optimisticApplied = this.applyMessageDeleteLocally(normalizedMessageId, deleteTimestamp);
    if (!optimisticApplied) {
      return;
    }

    await this.api.deleteMessageForEveryone(payload);
  }

  async sendFile(file: File): Promise<void> {
    if (!file) return;

    this.uploading.set(true);
    this.lastError.set(null);
    try {
      const upload = await this.api.uploadFile(file);
      if (upload.status !== 'success' || !upload.url) {
        throw new Error('Upload did not return a file URL');
      }

      const lower = upload.url.toLowerCase();
      const isDocument = /\.(pdf|doc|docx)(\?|$)/.test(lower);
      if (isDocument) {
        await this.sendMessageInternal({
          body: upload.url,
          imageUrl: null
        });
      } else {
        await this.sendMessageInternal({
          body: '',
          imageUrl: upload.url,
          thumbnailUrl: upload.thumbUrl ?? null
        });
      }
    } catch {
      this.lastError.set('שגיאה בהעלאת קובץ');
    } finally {
      this.uploading.set(false);
    }
  }

  async sendReaction(targetMessageId: string, emoji: string): Promise<void> {
    const currentUser = this.currentUser();
    const activeChatId = this.activeChatId();
    if (!currentUser || !activeChatId) {
      throw new Error('אין צ׳אט פעיל.');
    }

    const normalizedTargetId = String(targetMessageId || '').trim();
    const normalizedEmoji = String(emoji || '').trim();
    if (!normalizedTargetId || !normalizedEmoji) {
      return;
    }

    const chatMessages = this.messagesByChat()[activeChatId] ?? [];
    const targetMessage = chatMessages.find((message) => message.messageId === normalizedTargetId) ?? null;
    const group = this.groups().find((item) => item.id === activeChatId) ?? null;
    const fallbackGroup = targetMessage?.groupId
      ? this.groups().find((item) => item.id === this.normalizeChatId(targetMessage.groupId || '')) ?? null
      : null;
    const effectiveGroup = group ?? fallbackGroup;
    const targetGroupType: GroupType | null =
      targetMessage?.groupType === 'community' || targetMessage?.groupType === 'group'
        ? targetMessage.groupType
        : (effectiveGroup?.type ?? null);
    const isCommunityGroup = targetGroupType === 'community' || (!targetGroupType && !this.canSendToActiveChat());
    if (!isCommunityGroup) {
      throw new Error('ניתן להגיב רק בקבוצת קהילה.');
    }

    const reaction: MessageReaction = {
      emoji: normalizedEmoji,
      reactor: currentUser,
      reactorName: this.getDisplayName(currentUser)
    };

    const fallbackGroupId = this.normalizeChatId(activeChatId);
    if (!fallbackGroupId) {
      throw new Error('קבוצת יעד לא נמצאה.');
    }
    this.applyReactionToMessage(fallbackGroupId, normalizedTargetId, reaction);

    if (!this.networkOnline()) {
      this.lastError.set('לא ניתן לשלוח תגובה ללא חיבור.');
      throw new Error('Offline');
    }

    const activeChat = this.activeChat();
    const groupId = effectiveGroup?.id || fallbackGroupId;
    const groupName = effectiveGroup?.name || activeChat?.title || groupId;
    const groupMembers = effectiveGroup?.members ?? [];
    const groupCreatedBy = effectiveGroup?.createdBy || '';
    const groupUpdatedAt = effectiveGroup?.updatedAt || Date.now();
    const groupType: GroupType = effectiveGroup?.type === 'group' ? 'group' : 'community';

    await this.api.sendReaction({
      groupId,
      groupName,
      groupMembers,
      groupCreatedBy,
      groupUpdatedAt,
      groupType,
      targetMessageId: normalizedTargetId,
      emoji: normalizedEmoji,
      reactor: currentUser,
      reactorName: reaction.reactorName || currentUser
    });
  }

  clearIncomingReactionNotice(): void {
    this.incomingReactionNotice.set(null);
  }

  async flushOutbox(): Promise<void> {
    const user = this.currentUser();
    if (!user || !this.networkOnline()) return;

    const outbox = this.loadOutbox(user);
    if (!outbox.length) return;

    this.syncing.set(true);
    const nextOutbox: OutboxItem[] = [];

    for (const item of outbox) {
      try {
        if (item.kind === 'direct') {
          await this.api.sendDirectMessage(item.payload);
          this.setMessageStatus(item.messageId, 'sent');
          continue;
        }

        if (item.kind === 'group') {
          for (const recipient of item.recipients) {
            await this.api.sendDirectMessage({
              ...item.payload,
              originalSender: recipient
            });
          }
          this.setMessageStatus(item.messageId, 'sent');
          continue;
        }

        await this.api.sendGroupUpdate(item.payload);
      } catch {
        const attempts = item.attempts + 1;
        if ('messageId' in item) {
          this.setMessageStatus(item.messageId, attempts >= 4 ? 'failed' : 'queued');
        }
        if (attempts < 4) {
          nextOutbox.push({ ...item, attempts });
        }
      }
    }

    this.saveOutbox(user, nextOutbox);
    this.syncing.set(false);
    this.schedulePersist();
  }

  private pickInitialChatId(): string | null {
    const items = this.chatItems();
    if (!items.length) return null;

    const latestNonPinned = items.find((item) => item.lastTimestamp > 0 && !item.pinned);
    if (latestNonPinned) return latestNonPinned.id;

    const latestAny = items.find((item) => item.lastTimestamp > 0);
    if (latestAny) return latestAny.id;

    const firstNonPinned = items.find((item) => !item.pinned);
    if (firstNonPinned) return firstNonPinned.id;

    return items[0]?.id ?? null;
  }

  private getStoredActiveChat(user: string): string | null {
    const value = localStorage.getItem(this.activeChatKey(user));
    return value ? this.normalizeChatId(value) : null;
  }

  private activeChatKey(user: string): string {
    return `modern-chat-active:${user}`;
  }

  private homeViewKey(user: string): string {
    return `modern-chat-home:${user}`;
  }

  private shouldOpenHomeOnInit(user: string): boolean {
    return localStorage.getItem(this.homeViewKey(user)) === '1';
  }

  private async onChatActivated(chatId: string): Promise<void> {
    if (this.isHrChat(chatId)) {
      await this.ensureHrFlowOnOpen();
      return;
    }
    if (this.isShuttleChat(chatId)) {
      await this.ensureShuttleFlowOnOpen();
    }
  }

  private isHrChat(chatId: string | null): boolean {
    return this.normalizeChatId(chatId ?? '') === this.normalizeChatId(HR_CHAT_NAME);
  }

  private isShuttleChat(chatId: string | null): boolean {
    return this.normalizeChatId(chatId ?? '') === this.normalizeChatId(SHUTTLE_CHAT_NAME);
  }

  private async ensureHrFlowOnOpen(): Promise<void> {
    const user = this.currentUser();
    if (!user || this.hrInitInFlight) return;

    this.hrInitInFlight = true;
    try {
      if (!this.shouldInitializeHrFlowOnOpen(user)) {
        return;
      }
      await this.startHrFlow({ skipWelcome: false });
    } finally {
      this.hrInitInFlight = false;
    }
  }

  private shouldInitializeHrFlowOnOpen(user: string): boolean {
    const chatId = this.normalizeChatId(HR_CHAT_NAME);
    const hrMessages = this.messagesByChat()[chatId] ?? [];

    // Returning users should continue from existing conversation history.
    if (hrMessages.length > 0) {
      return false;
    }

    // If we already have an HR state or welcome marker, this is not first-time.
    if (this.loadHrState(user)) {
      return false;
    }

    if (localStorage.getItem(this.hrWelcomeKey(user))) {
      return false;
    }

    return true;
  }

  private async handleHrOutgoing(messageBody: string): Promise<boolean> {
    const user = this.currentUser();
    if (!user) return false;
    const trimmed = String(messageBody || '').trim();
    if (!trimmed) return false;

    if (trimmed === '0') {
      this.resetHrState(user);
      await this.startHrFlow({ skipWelcome: this.hasHrWelcomeMessage(user) });
      return true;
    }

    const state = this.loadHrState(user) ?? { awaiting: 'step', stepId: null, actions: [] };
    if (state.awaiting === 'step') {
      const steps = await this.fetchHrStepsCached();
      const index = Number.parseInt(trimmed, 10) - 1;
      if (!steps.length || Number.isNaN(index) || index < 0 || index >= steps.length) {
        this.sendHrSystemMessage('בחירה לא תקינה, נסה שוב.');
        return true;
      }

      const selected = steps[index];
      const actions = await this.fetchHrActionsCached(selected.id);
      if (!actions.length) {
        this.sendHrSystemMessage('לא נמצאו פעולות לשלב זה.');
        return true;
      }

      this.saveHrState(user, { awaiting: 'action', stepId: selected.id, actions });
      this.sendHrSystemMessage(this.buildHrActionsMessage(actions));
      return true;
    }

    if (state.awaiting === 'action') {
      const index = Number.parseInt(trimmed, 10) - 1;
      if (Number.isNaN(index) || index < 0 || index >= state.actions.length) {
        this.sendHrSystemMessage('בחירה לא תקינה, נסה שוב.');
        return true;
      }

      const selectedAction = state.actions[index];
      const returnValue = String(selectedAction.returnValue || '').trim();
      if (returnValue.toUpperCase() === 'FREE TEXT') {
        this.saveHrState(user, { ...state, awaiting: 'free-text' });
        this.sendHrSystemMessage('נא כתוב את הודעתך.');
        return true;
      }

      if (returnValue) {
        const normalizedUrl = this.buildHrAssetUrl(returnValue);
        const lower = returnValue.toLowerCase();
        const isImage = /\.(jpeg|jpg|gif|png|webp)(\?|$)/.test(lower);
        const isDoc = /\.(pdf|doc|docx)(\?|$)/.test(lower);

        if (isImage) {
          this.sendHrSystemMessage('', { imageUrl: normalizedUrl, recordType: 'hr-asset' });
          return true;
        }

        if (isDoc) {
          this.sendHrSystemMessage(normalizedUrl, { recordType: 'hr-asset' });
          return true;
        }

        this.sendHrSystemMessage(returnValue);
        return true;
      }

      if (selectedAction.stepName) {
        this.sendHrSystemMessage(selectedAction.stepName);
      }
      return true;
    }

    if (state.awaiting === 'free-text') {
      return false;
    }

    return false;
  }

  private async fetchHrStepsCached(): Promise<HrStepOption[]> {
    const now = Date.now();
    if (this.hrStepsCache.steps.length && now - this.hrStepsCache.at < HR_STEPS_CACHE_TTL_MS) {
      return this.hrStepsCache.steps;
    }

    try {
      const steps = await this.api.getHrSteps();
      this.hrStepsCache = { at: now, steps };
      return steps;
    } catch {
      return [];
    }
  }

  private async fetchHrActionsCached(stepId: string): Promise<HrActionOption[]> {
    const key = String(stepId || '').trim();
    if (!key) return [];

    const now = Date.now();
    const cached = this.hrActionsCache[key];
    if (cached && now - cached.at < HR_ACTIONS_CACHE_TTL_MS) {
      return cached.actions;
    }

    try {
      const actions = await this.api.getHrActions(key);
      this.hrActionsCache[key] = { at: now, actions };
      return actions;
    } catch {
      return [];
    }
  }

  private async startHrFlow(options: { skipWelcome?: boolean } = {}): Promise<void> {
    const user = this.currentUser();
    if (!user) return;

    if (!options.skipWelcome) {
      const contactName = this.getDisplayName(user);
      const welcome = `${contactName} שלום, הגעת ל Tzipi- מערכת הפניות של משאבי אנוש.\nבמערכת זו ניתן לקבל ולשלוח טפסים וכן לפנות במלל חופשי למשאבי אנוש ולהמשיך התכתבות.`;
      this.sendHrSystemMessage(welcome, { recordType: 'hr-welcome' });
      localStorage.setItem(this.hrWelcomeKey(user), '1');
    }

    const steps = await this.fetchHrStepsCached();
    if (steps.length) {
      this.sendHrSystemMessage(this.buildHrStepsMessage(steps), { recordType: 'hr-steps' });
    }

    this.saveHrState(user, { awaiting: 'step', stepId: null, actions: [] });
  }

  private buildHrStepsMessage(steps: HrStepOption[]): string {
    const prompt = 'יש לבחור באמצעות מענה בהודעת ווטסאפ, את מספר הענף הרלוונטי לפנייה:';
    const lines = steps.map((step, index) => `${index + 1}. ${step.name}`);
    return `${prompt}\n${lines.join('\n')}`;
  }

  private buildHrActionsMessage(actions: HrActionOption[]): string {
    const prompt = 'יש לבחור באמצעות מענה בהודעת ווטסאפ, את מספר הענף הרלוונטי לפנייה:';
    const lines = actions.map((action, index) => `${index + 1}. ${action.stepName || 'פעולה'}`);
    return `${prompt}\n${lines.join('\n')}`;
  }

  private sendHrSystemMessage(
    body: string,
    options: { imageUrl?: string | null; recordType?: string } = {}
  ): void {
    const chatId = this.normalizeChatId(HR_CHAT_NAME);
    const message: ChatMessage = {
      id: this.generateId('rec'),
      messageId: this.generateId('hr'),
      chatId,
      sender: chatId,
      senderDisplayName: HR_CHAT_NAME,
      recordType: options.recordType,
      body,
      imageUrl: options.imageUrl ?? null,
      direction: 'incoming',
      timestamp: Date.now(),
      deliveryStatus: 'delivered'
    };

    this.appendMessage(message);
    if (this.activeChatId() !== chatId) {
      this.unreadByChat.update((map) => ({
        ...map,
        [chatId]: (map[chatId] ?? 0) + 1
      }));
    }
  }

  private hrWelcomeKey(user: string): string {
    return `${HR_WELCOME_KEY_PREFIX}${this.normalizeUser(user)}`;
  }

  private hrStateKey(user: string): string {
    return `${HR_STATE_KEY_PREFIX}${this.normalizeUser(user)}`;
  }

  private hasHrWelcomeMessage(user: string): boolean {
    if (localStorage.getItem(this.hrWelcomeKey(user))) {
      return true;
    }
    const chatId = this.normalizeChatId(HR_CHAT_NAME);
    return (this.messagesByChat()[chatId] ?? []).some((message) => message.recordType === 'hr-welcome');
  }

  private loadHrState(user: string): HrConversationState | null {
    const raw = localStorage.getItem(this.hrStateKey(user));
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as HrConversationState;
      if (!parsed || !parsed.awaiting) return null;
      return {
        awaiting: parsed.awaiting,
        stepId: parsed.stepId ?? null,
        actions: Array.isArray(parsed.actions) ? parsed.actions : []
      };
    } catch {
      return null;
    }
  }

  private saveHrState(user: string, state: HrConversationState): void {
    localStorage.setItem(this.hrStateKey(user), JSON.stringify(state));
  }

  private resetHrState(user: string): void {
    localStorage.removeItem(this.hrStateKey(user));
    localStorage.removeItem(this.hrWelcomeKey(user));
  }

  private buildHrAssetUrl(value: string): string {
    const trimmed = String(value || '').trim();
    if (!trimmed) return '';
    if (/^https?:\/\//i.test(trimmed)) {
      return trimmed;
    }
    const encoded = encodeURIComponent(trimmed).replace(/%2F/g, '/');
    return `${HR_UPLOAD_BASE_URL}${encoded}`;
  }

  private defaultShuttleState(): ShuttleConversationState {
    return {
      awaiting: 'menu',
      draft: null,
      cancelCandidateIds: []
    };
  }

  private async ensureShuttleFlowOnOpen(): Promise<void> {
    const user = this.currentUser();
    if (!user || this.shuttleInitInFlight) return;

    this.shuttleInitInFlight = true;
    try {
      if (!this.shouldInitializeShuttleFlowOnOpen(user)) {
        return;
      }
      await this.startShuttleFlow({ skipWelcome: false });
    } finally {
      this.shuttleInitInFlight = false;
    }
  }

  private shouldInitializeShuttleFlowOnOpen(user: string): boolean {
    const chatId = this.normalizeChatId(SHUTTLE_CHAT_NAME);
    const shuttleMessages = this.messagesByChat()[chatId] ?? [];

    if (shuttleMessages.length > 0) {
      return false;
    }
    if (this.loadShuttleState(user)) {
      return false;
    }
    if (localStorage.getItem(this.shuttleWelcomeKey(user))) {
      return false;
    }
    return true;
  }

  private async handleShuttleOutgoing(messageBody: string): Promise<boolean> {
    const user = this.currentUser();
    if (!user) return false;
    const trimmed = String(messageBody || '').trim();
    if (!trimmed) return false;

    if (trimmed === '0' || trimmed.includes('חזרה')) {
      this.saveShuttleState(user, this.defaultShuttleState());
      this.sendShuttleMenu();
      return true;
    }

    const state = this.loadShuttleState(user) ?? this.defaultShuttleState();
    switch (state.awaiting) {
      case 'menu':
        return this.handleShuttleMenuSelection(user, trimmed);
      case 'date':
        return this.handleShuttleDateSelection(user, state, trimmed);
      case 'shift':
        return this.handleShuttleShiftSelection(user, state, trimmed);
      case 'station':
        return this.handleShuttleStationSelection(user, state, trimmed);
      case 'cancel-select':
        return this.handleShuttleCancelSelection(user, state, trimmed);
      default:
        this.saveShuttleState(user, this.defaultShuttleState());
        this.sendShuttleMenu();
        return true;
    }
  }

  private async handleShuttleMenuSelection(user: string, value: string): Promise<boolean> {
    const command = this.parseShuttleMenuCommand(value);
    if (!command) {
      this.sendShuttleSystemMessage('בחירה לא תקינה. נא לבחור אחת מהאפשרויות המוצגות.', {
        recordType: 'shuttle-invalid'
      });
      this.saveShuttleState(user, this.defaultShuttleState());
      this.sendShuttleMenu();
      return true;
    }

    if (command === 'new') {
      this.saveShuttleState(user, {
        awaiting: 'date',
        draft: null,
        cancelCandidateIds: []
      });
      return true;
    }

    if (command === 'list') {
      this.saveShuttleState(user, this.defaultShuttleState());
      this.sendShuttleMenu();
      return true;
    }

    await this.startShuttleCancelFlow(user);
    return true;
  }

  private async handleShuttleDateSelection(
    user: string,
    _state: ShuttleConversationState,
    value: string
  ): Promise<boolean> {
    const choices = this.getShuttleDateChoices();
    const pickedIndex = this.parseShuttleSelection(
      value,
      choices.length,
      choices.map((choice) => choice.label)
    );
    if (pickedIndex < 0) {
      this.sendShuttleSystemMessage('בחירה לא תקינה. נא לבחור תאריך מהרשימה.', {
        recordType: 'shuttle-invalid'
      });
      return true;
    }

    const picked = choices[pickedIndex];
    this.saveShuttleState(user, {
      awaiting: 'shift',
      draft: {
        date: picked.value,
        dayName: picked.dayName
      },
      cancelCandidateIds: []
    });
    return true;
  }

  private async handleShuttleShiftSelection(
    user: string,
    state: ShuttleConversationState,
    value: string
  ): Promise<boolean> {
    const pickedIndex = this.parseShuttleSelection(
      value,
      SHUTTLE_SHIFT_OPTIONS.length,
      SHUTTLE_SHIFT_OPTIONS.map((option) => option.label)
    );
    if (pickedIndex < 0) {
      this.sendShuttleSystemMessage('בחירה לא תקינה. נא לבחור משמרת מהרשימה.', {
        recordType: 'shuttle-invalid'
      });
      return true;
    }

    const shift = SHUTTLE_SHIFT_OPTIONS[pickedIndex];
    const stations = await this.fetchShuttleStationsCached();
    if (!stations.length) {
      this.sendShuttleSystemMessage('לא ניתן לטעון תחנות כרגע. נסה שוב מאוחר יותר.', {
        recordType: 'shuttle-error'
      });
      this.saveShuttleState(user, this.defaultShuttleState());
      this.sendShuttleMenu();
      return true;
    }

    this.saveShuttleState(user, {
      awaiting: 'station',
      draft: {
        ...(state.draft || {}),
        shiftLabel: shift.label,
        shiftValue: shift.value
      },
      cancelCandidateIds: []
    });
    return true;
  }

  private async handleShuttleStationSelection(
    user: string,
    state: ShuttleConversationState,
    value: string
  ): Promise<boolean> {
    const stations = await this.fetchShuttleStationsCached();
    if (!stations.length) {
      this.sendShuttleSystemMessage('לא ניתן לטעון תחנות כרגע. נסה שוב מאוחר יותר.', {
        recordType: 'shuttle-error'
      });
      this.saveShuttleState(user, this.defaultShuttleState());
      this.sendShuttleMenu();
      return true;
    }

    const pickedIndex = this.parseShuttleSelection(value, stations.length, stations);
    if (pickedIndex < 0) {
      this.sendShuttleSystemMessage('בחירה לא תקינה. נא לבחור תחנה מהרשימה.', {
        recordType: 'shuttle-invalid'
      });
      return true;
    }

    const station = stations[pickedIndex];
    const draft = {
      ...(state.draft || {}),
      station
    };
    const isDraftReady = Boolean(draft.date && draft.dayName && draft.shiftLabel && draft.shiftValue && draft.station);
    if (!isDraftReady) {
      this.sendShuttleSystemMessage('חסרים נתוני הזמנה. מתחילים מחדש.', {
        recordType: 'shuttle-error'
      });
      this.saveShuttleState(user, this.defaultShuttleState());
      this.sendShuttleMenu();
      return true;
    }

    const completeDraft = draft as ShuttleOrderDraft;
    try {
      const employee = await this.submitShuttleOrder(user, completeDraft, SHUTTLE_STATUS_ACTIVE_VALUE);
      this.persistShuttleOrder(user, {
        id: this.generateId('shuttle'),
        employee,
        date: completeDraft.date,
        dayName: completeDraft.dayName,
        shiftLabel: completeDraft.shiftLabel,
        shiftValue: completeDraft.shiftValue,
        station: completeDraft.station,
        statusValue: SHUTTLE_STATUS_ACTIVE_VALUE,
        statusLabel: SHUTTLE_STATUS_ACTIVE_LABEL,
        submittedAt: Date.now()
      });
      this.sendShuttleSystemMessage(
        `הבקשה נשלחה בהצלחה ✅\n${this.buildShuttleOrderSummary({
          ...completeDraft,
          id: '',
          employee,
          statusValue: SHUTTLE_STATUS_ACTIVE_VALUE,
          statusLabel: SHUTTLE_STATUS_ACTIVE_LABEL,
          submittedAt: Date.now()
        })}`,
        { recordType: 'shuttle-submit-success' }
      );
    } catch {
      this.sendShuttleSystemMessage('שליחת הבקשה נכשלה. נסה שוב בעוד מספר רגעים.', {
        recordType: 'shuttle-submit-failed'
      });
    }

    this.saveShuttleState(user, this.defaultShuttleState());
    this.sendShuttleMenu();
    return true;
  }

  private async handleShuttleCancelSelection(
    user: string,
    state: ShuttleConversationState,
    value: string
  ): Promise<boolean> {
    const candidateOrders = this.getShuttleCancelCandidateOrders(user, state);
    if (!candidateOrders.length) {
      this.sendShuttleSystemMessage('אין הזמנות פעילות לביטול.', { recordType: 'shuttle-cancel-empty' });
      this.saveShuttleState(user, this.defaultShuttleState());
      this.sendShuttleMenu();
      return true;
    }

    const pickedIndex = this.parseShuttleSelection(
      value,
      candidateOrders.length,
      candidateOrders.map((order) => this.buildShuttleOrderSummary(order))
    );
    if (pickedIndex < 0) {
      this.sendShuttleSystemMessage('בחירה לא תקינה. נא לבחור הזמנה לביטול מתוך הרשימה.', {
        recordType: 'shuttle-invalid'
      });
      return true;
    }

    const targetOrder = candidateOrders[pickedIndex];
    if (!targetOrder) {
      this.sendShuttleSystemMessage('ההזמנה לא נמצאה. מתחילים מחדש.', {
        recordType: 'shuttle-cancel-missing'
      });
      this.saveShuttleState(user, this.defaultShuttleState());
      this.sendShuttleMenu();
      return true;
    }

    try {
      await this.submitShuttleOrder(user, targetOrder, SHUTTLE_STATUS_CANCEL_VALUE);
      this.markShuttleOrderCancelled(user, targetOrder.id);
      this.sendShuttleSystemMessage(
        `ההזמנה בוטלה בהצלחה ✅\n${this.buildShuttleOrderSummary({
          ...targetOrder,
          statusValue: SHUTTLE_STATUS_CANCEL_VALUE,
          statusLabel: SHUTTLE_STATUS_CANCEL_LABEL
        })}`,
        { recordType: 'shuttle-cancel-success' }
      );
    } catch {
      this.sendShuttleSystemMessage('ביטול ההזמנה נכשל. נסה שוב בעוד מספר רגעים.', {
        recordType: 'shuttle-cancel-failed'
      });
    }

    this.saveShuttleState(user, this.defaultShuttleState());
    this.sendShuttleMenu();
    return true;
  }

  private async startShuttleFlow(options: { skipWelcome?: boolean } = {}): Promise<void> {
    const user = this.currentUser();
    if (!user) return;

    if (!options.skipWelcome) {
      const contactName = this.getDisplayName(user);
      this.sendShuttleSystemMessage(
        `${contactName} שלום, ברוך/ה הבא/ה להזמנת הסעה.\nכאן ניתן להזמין הסעה, לצפות בבקשות שלך ולבטל בקשה קיימת.`,
        { recordType: 'shuttle-welcome' }
      );
      localStorage.setItem(this.shuttleWelcomeKey(user), '1');
    }

    this.saveShuttleState(user, this.defaultShuttleState());
    this.sendShuttleMenu();
  }

  private sendShuttleMenu(): void {
    // The guided shuttle picker UI is rendered in the composer area.
    // Keeping this method as a single reset hook avoids touching all call sites.
  }

  private async startShuttleCancelFlow(user: string): Promise<void> {
    const activeOrders = this.loadShuttleOrders(user)
      .filter((order) => this.isShuttleOrderOngoing(order))
      .sort((a, b) => (b.submittedAt || 0) - (a.submittedAt || 0));

    if (!activeOrders.length) {
      this.sendShuttleSystemMessage('אין בקשות פעילות לביטול.', { recordType: 'shuttle-cancel-empty' });
      this.saveShuttleState(user, this.defaultShuttleState());
      this.sendShuttleMenu();
      return;
    }

    this.saveShuttleState(user, {
      awaiting: 'cancel-select',
      draft: null,
      cancelCandidateIds: activeOrders.map((order) => order.id)
    });
  }

  private async fetchShuttleStationsCached(): Promise<string[]> {
    const now = Date.now();
    if (this.shuttleStationsCache.items.length && now - this.shuttleStationsCache.at < SHUTTLE_LIST_CACHE_TTL_MS) {
      return this.shuttleStationsCache.items;
    }

    try {
      const stations = await this.api.getShuttleStations();
      if (stations.length) {
        this.shuttleStationsCache = { at: now, items: stations };
        return stations;
      }
    } catch {
      // Keep flow resilient and report fallback in the conversation.
    }
    return [];
  }

  private async fetchShuttleEmployeesCached(): Promise<string[]> {
    const now = Date.now();
    if (this.shuttleEmployeesCache.items.length && now - this.shuttleEmployeesCache.at < SHUTTLE_LIST_CACHE_TTL_MS) {
      return this.shuttleEmployeesCache.items;
    }

    try {
      const employees = await this.api.getShuttleEmployees();
      if (employees.length) {
        this.shuttleEmployeesCache = { at: now, items: employees };
        return employees;
      }
    } catch {
      // Keep flow resilient and report fallback in the conversation.
    }
    return [];
  }

  private getShuttleDateChoices(): ShuttleDateChoice[] {
    const today = new Date();
    const choices: ShuttleDateChoice[] = [];
    for (let i = 0; i < SHUTTLE_DATE_CHOICES_COUNT; i += 1) {
      const date = new Date(today);
      date.setDate(today.getDate() + i);
      const value = this.toIsoDate(date);
      const dayName = SHUTTLE_DAY_NAMES[date.getDay()];
      choices.push({
        value,
        dayName,
        label: `${dayName} ${value}`
      });
    }
    return choices;
  }

  private getShuttleMainMenuMessage(): string {
    return [
      'היי, זהו חדר הזמנת ההסעה.',
      'בחר פעולה:',
      '1. הזמנה חדשה',
      '2. הבקשות שלי',
      '3. ביטול הזמנה קיימת',
      'אפשר להקליד 0 בכל שלב כדי לחזור לתפריט הראשי.'
    ].join('\n');
  }

  private getShuttleDatePromptMessage(): string {
    const lines = this.getShuttleDateChoices().map((choice, index) => `${index + 1}. ${choice.label}`);
    return ['בחר תאריך נסיעה:', ...lines].join('\n');
  }

  private getShuttleShiftPromptMessage(): string {
    const lines = SHUTTLE_SHIFT_OPTIONS.map((shift, index) => `${index + 1}. ${shift.label}`);
    return ['בחר משמרת (הסעה לעבודה):', ...lines].join('\n');
  }

  private getShuttleStationsPromptMessage(stations: string[]): string {
    const lines = stations.map((station, index) => `${index + 1}. ${station}`);
    return ['בחר תחנה:', ...lines].join('\n');
  }

  private buildShuttleOrderSummary(order: ShuttleOrderRecord): string {
    const statusLabel = order.statusLabel || (
      order.statusValue === SHUTTLE_STATUS_CANCEL_VALUE
        ? SHUTTLE_STATUS_CANCEL_LABEL
        : SHUTTLE_STATUS_ACTIVE_LABEL
    );
    const dayAndDate = `${String(order.dayName || '').trim()} ${String(order.date || '').trim()}`.trim();
    const shift = String(order.shiftLabel || '').trim();
    const station = String(order.station || '').trim();
    return `[${statusLabel}] ${dayAndDate} | ${shift} | ${station}`.trim();
  }

  private getShuttleCancelCandidateOrders(
    user: string,
    state: ShuttleConversationState
  ): ShuttleOrderRecord[] {
    const candidateIdSet = new Set(
      (Array.isArray(state.cancelCandidateIds) ? state.cancelCandidateIds : [])
        .map((id) => String(id || '').trim())
        .filter(Boolean)
    );
    return this.loadShuttleOrders(user)
      .filter((order) => candidateIdSet.has(order.id) && this.isShuttleOrderOngoing(order))
      .sort((a, b) => (b.submittedAt || 0) - (a.submittedAt || 0));
  }

  private normalizeShuttleText(value: string): string {
    return String(value || '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
  }

  private parseShuttleMenuCommand(input: string): 'new' | 'list' | 'cancel' | '' {
    const trimmed = String(input || '').trim();
    if (!trimmed) return '';
    if (trimmed === '1' || trimmed.includes('חדש')) return 'new';
    if (trimmed === '2' || trimmed.includes('הצג') || trimmed.includes('בקשות')) return 'list';
    if (trimmed === '3' || trimmed.includes('ביטול') || trimmed.includes('מחק')) return 'cancel';
    return '';
  }

  private parseShuttleSelection(input: string, maxLength: number, labels: string[] = []): number {
    const normalizedInput = String(input || '').trim();
    const index = /^\d+$/.test(normalizedInput) ? Number.parseInt(normalizedInput, 10) - 1 : Number.NaN;
    if (Number.isNaN(index) || index < 0 || index >= maxLength) {
      if (!labels.length) return -1;
      const normalizedNeedle = this.normalizeShuttleText(normalizedInput);
      if (!normalizedNeedle) return -1;

      const exactIndex = labels.findIndex((label) =>
        this.normalizeShuttleText(label) === normalizedNeedle
      );
      if (exactIndex >= 0) {
        return exactIndex;
      }

      const partialIndex = labels.findIndex((label) =>
        this.normalizeShuttleText(label).includes(normalizedNeedle)
      );
      if (partialIndex >= 0) {
        return partialIndex;
      }
      return -1;
    }
    return index;
  }

  private async submitShuttleOrder(
    user: string,
    draft: ShuttleOrderDraft,
    statusValue: string
  ): Promise<string> {
    const employee = await this.resolveShuttleEmployeeValue(user);
    await this.api.submitShuttleOrder({
      employee,
      date: draft.date,
      dateAlt: this.toIsoDate(new Date()),
      shift: draft.shiftValue,
      station: draft.station,
      status: statusValue
    });
    return employee;
  }

  private persistShuttleOrder(user: string, order: ShuttleOrderRecord): void {
    const orders = this.loadShuttleOrders(user);
    orders.unshift(order);
    this.saveShuttleOrders(user, orders.slice(0, 300));
  }

  private markShuttleOrderCancelled(user: string, orderId: string): void {
    const orders = this.loadShuttleOrders(user);
    const updated = orders.map((order) => {
      if (order.id !== orderId) {
        return order;
      }
      return {
        ...order,
        statusValue: SHUTTLE_STATUS_CANCEL_VALUE,
        statusLabel: SHUTTLE_STATUS_CANCEL_LABEL,
        cancelledAt: Date.now()
      };
    });
    this.saveShuttleOrders(user, updated);
  }

  private async resolveShuttleEmployeeValue(user: string): Promise<string> {
    const normalizedUser = this.normalizeUser(user);
    const userPhone = this.extractShuttlePhone(user);
    const displayName = String(this.getDisplayName(user) || '').trim();
    const employees = await this.fetchShuttleEmployeesCached();

    if (employees.length) {
      const exact = employees.find((entry) => this.normalizeUser(entry) === normalizedUser);
      if (exact) return exact;

      if (userPhone) {
        const byPhone = employees.find((entry) => this.extractShuttlePhone(entry) === userPhone);
        if (byPhone) return byPhone;
      }

      if (displayName) {
        const normalizedDisplayName = this.normalizeUser(displayName);
        const byName = employees.find((entry) =>
          this.normalizeUser(entry).includes(normalizedDisplayName)
        );
        if (byName) return byName;
      }
    }

    if (displayName && userPhone && !displayName.includes(userPhone)) {
      return `${displayName} ${userPhone}`;
    }
    if (displayName) return displayName;
    return user;
  }

  private extractShuttlePhone(value: string): string {
    const digits = String(value || '').replace(/\D/g, '');
    if (!digits) return '';
    const embedded = digits.match(/05\d{8}/);
    if (embedded?.[0]) {
      return embedded[0];
    }
    if (/^5\d{8}$/.test(digits)) {
      return `0${digits}`;
    }
    if (/^9725\d{8}$/.test(digits)) {
      return `0${digits.slice(3)}`;
    }
    if (/^97205\d{8}$/.test(digits)) {
      return `0${digits.slice(4)}`;
    }
    if (digits.length > 10) {
      const tail = digits.slice(-10);
      if (/^05\d{8}$/.test(tail)) {
        return tail;
      }
    }
    return '';
  }

  private toIsoDate(date: Date): string {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  private isShuttleOrderOngoing(order: ShuttleOrderRecord): boolean {
    if (String(order.statusValue || '').trim() === SHUTTLE_STATUS_CANCEL_VALUE) {
      return false;
    }
    const orderDate = this.parseShuttleDate(order.date);
    if (!orderDate) {
      return true;
    }
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return orderDate.getTime() >= today.getTime();
  }

  private parseShuttleDate(value: string): Date | null {
    const normalized = String(value || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
      return null;
    }
    const parsed = new Date(`${normalized}T00:00:00`);
    if (Number.isNaN(parsed.getTime())) {
      return null;
    }
    parsed.setHours(0, 0, 0, 0);
    return parsed;
  }

  private shuttleWelcomeKey(user: string): string {
    return `${SHUTTLE_WELCOME_KEY_PREFIX}${this.normalizeUser(user)}`;
  }

  private shuttleStateKey(user: string): string {
    return `${SHUTTLE_STATE_KEY_PREFIX}${this.normalizeUser(user)}`;
  }

  private shuttleOrdersKey(user: string): string {
    return `${SHUTTLE_ORDERS_KEY_PREFIX}${this.normalizeUser(user)}`;
  }

  private loadShuttleState(user: string): ShuttleConversationState | null {
    const raw = localStorage.getItem(this.shuttleStateKey(user));
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as ShuttleConversationState;
      const awaiting: ShuttleAwaitingState = (
        parsed?.awaiting === 'menu' ||
        parsed?.awaiting === 'date' ||
        parsed?.awaiting === 'shift' ||
        parsed?.awaiting === 'station' ||
        parsed?.awaiting === 'cancel-select'
      )
        ? parsed.awaiting
        : 'menu';
      const draftSource = parsed?.draft && typeof parsed.draft === 'object'
        ? parsed.draft
        : null;
      const draft = draftSource
        ? {
          date: String(draftSource.date ?? '').trim(),
          dayName: String(draftSource.dayName ?? '').trim(),
          shiftLabel: String(draftSource.shiftLabel ?? '').trim(),
          shiftValue: String(draftSource.shiftValue ?? '').trim(),
          station: String(draftSource.station ?? '').trim()
        }
        : null;
      return {
        awaiting,
        draft,
        cancelCandidateIds: Array.isArray(parsed?.cancelCandidateIds)
          ? parsed.cancelCandidateIds.map((id) => String(id || '').trim()).filter(Boolean)
          : []
      };
    } catch {
      return null;
    }
  }

  private saveShuttleState(user: string, state: ShuttleConversationState): void {
    localStorage.setItem(this.shuttleStateKey(user), JSON.stringify(state));
    this.bumpShuttlePickerRevision();
  }

  private loadShuttleOrders(user: string): ShuttleOrderRecord[] {
    const raw = localStorage.getItem(this.shuttleOrdersKey(user));
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed
        .filter((item) => item && typeof item === 'object')
        .map((item) => ({
          id: String(item.id || '').trim(),
          employee: String(item.employee || '').trim(),
          date: String(item.date || '').trim(),
          dayName: String(item.dayName || '').trim(),
          shiftLabel: String(item.shiftLabel || '').trim(),
          shiftValue: String(item.shiftValue || '').trim(),
          station: String(item.station || '').trim(),
          statusValue: String(item.statusValue || SHUTTLE_STATUS_ACTIVE_VALUE).trim(),
          statusLabel: String(item.statusLabel || '').trim(),
          submittedAt: Number(item.submittedAt || 0),
          cancelledAt: item.cancelledAt ? Number(item.cancelledAt) : undefined
        }))
        .filter((item) => Boolean(item.id && item.date && item.shiftValue && item.station));
    } catch {
      return [];
    }
  }

  private saveShuttleOrders(user: string, orders: ShuttleOrderRecord[]): void {
    localStorage.setItem(this.shuttleOrdersKey(user), JSON.stringify(orders));
    this.bumpShuttlePickerRevision();
  }

  private bumpShuttlePickerRevision(): void {
    this.shuttlePickerRevision.update((value) => value + 1);
  }

  private sendShuttleSystemMessage(
    body: string,
    options: { imageUrl?: string | null; recordType?: string } = {}
  ): void {
    const chatId = this.normalizeChatId(SHUTTLE_CHAT_NAME);
    const message: ChatMessage = {
      id: this.generateId('rec'),
      messageId: this.generateId('shuttle'),
      chatId,
      sender: chatId,
      senderDisplayName: SHUTTLE_CHAT_NAME,
      recordType: options.recordType,
      body,
      imageUrl: options.imageUrl ?? null,
      direction: 'incoming',
      timestamp: Date.now(),
      deliveryStatus: 'delivered'
    };

    this.appendMessage(message);
    if (this.activeChatId() !== chatId) {
      this.unreadByChat.update((map) => ({
        ...map,
        [chatId]: (map[chatId] ?? 0) + 1
      }));
    }
  }

  private async sendMessageInternal(payload: SendMessagePayload): Promise<void> {
    const chatId = this.activeChatId();
    if (!chatId) {
      throw new Error('No active chat');
    }
    await this.dispatchMessageToChat(chatId, payload, { activateChat: true });
  }

  private async dispatchMessageToChat(
    chatIdRaw: string,
    payload: SendMessagePayload,
    options: { activateChat?: boolean } = {}
  ): Promise<void> {
    const user = this.currentUser();
    const chatId = this.normalizeChatId(chatIdRaw);
    if (!user || !chatId) {
      throw new Error('No active chat');
    }

    const group = this.groups().find((item) => item.id === chatId) ?? null;
    if (group && group.type === 'community' && this.normalizeUser(group.createdBy) !== user) {
      this.lastError.set('רק מנהל יכול לשלוח בקבוצת קהילה');
      return;
    }

    const metadata = this.normalizeSendMessageOptions(payload);
    const messageId = this.generateId('msg');
    const newMessage: ChatMessage = {
      id: this.generateId('rec'),
      messageId,
      chatId,
      sender: user,
      senderDisplayName: this.getDisplayName(user),
      body: payload.body,
      imageUrl: payload.imageUrl,
      thumbnailUrl: payload.thumbnailUrl ?? null,
      direction: 'outgoing',
      timestamp: Date.now(),
      deliveryStatus: this.networkOnline() ? 'pending' : 'queued',
      groupId: group?.id ?? null,
      groupName: group?.name ?? null,
      groupType: group?.type ?? null,
      editedAt: null,
      deletedAt: null,
      replyTo: metadata.replyTo ?? null,
      forwarded: metadata.forwarded,
      forwardedFrom: metadata.forwardedFrom ?? null,
      forwardedFromName: metadata.forwardedFromName ?? null
    };

    this.appendMessage(newMessage);
    if (options.activateChat !== false) {
      this.setActiveChat(chatId);
    }

    if (this.isHrChat(chatId) && payload.body.trim()) {
      const handledByHrFlow = await this.handleHrOutgoing(payload.body);
      if (handledByHrFlow) {
        this.setMessageStatus(messageId, 'delivered');
        return;
      }
    }

    if (this.isShuttleChat(chatId) && payload.body.trim()) {
      const handledByShuttleFlow = await this.handleShuttleOutgoing(payload.body);
      if (handledByShuttleFlow) {
        this.setMessageStatus(messageId, 'delivered');
        return;
      }
    }

    if (!this.networkOnline()) {
      if (group) {
        this.queueGroupMessage(group, messageId, payload.body, payload.imageUrl, undefined, metadata);
      } else {
        this.queueDirectMessage(chatId, messageId, payload.body, payload.imageUrl, metadata);
      }
      this.setMessageStatus(messageId, 'queued');
      return;
    }

    if (group) {
      await this.sendGroupMessage(group, messageId, payload.body, payload.imageUrl, metadata);
      return;
    }

    await this.sendDirectMessage(chatId, messageId, payload.body, payload.imageUrl, metadata);
  }

  private async sendDirectMessage(
    originalSender: string,
    messageId: string,
    body: string,
    imageUrl: string | null,
    options: SendMessageOptions = {}
  ): Promise<void> {
    const user = this.currentUser();
    if (!user) return;

    const metadata = this.normalizeSendMessageOptions(options);
    const payload: ReplyPayload = {
      user,
      senderName: this.getDisplayName(user),
      reply: body,
      imageUrl,
      originalSender,
      messageId,
      replyToMessageId: metadata.replyTo?.messageId,
      replyToSender: metadata.replyTo?.sender,
      replyToSenderName: metadata.replyTo?.senderDisplayName,
      replyToBody: metadata.replyTo?.body,
      replyToImageUrl: metadata.replyTo?.imageUrl ?? null,
      forwarded: metadata.forwarded ? true : undefined,
      forwardedFrom: metadata.forwardedFrom || undefined,
      forwardedFromName: metadata.forwardedFromName || undefined
    };

    try {
      await this.api.sendDirectMessage(payload);
      this.setMessageStatus(messageId, 'sent');
    } catch {
      this.queueDirectMessage(originalSender, messageId, body, imageUrl, metadata);
      this.setMessageStatus(messageId, 'queued');
    }
  }

  private async sendGroupMessage(
    group: ChatGroup,
    messageId: string,
    body: string,
    imageUrl: string | null,
    options: SendMessageOptions = {}
  ): Promise<void> {
    const user = this.currentUser();
    if (!user) return;

    const metadata = this.normalizeSendMessageOptions(options);
    const basePayload: Omit<ReplyPayload, 'originalSender'> = {
      user,
      senderName: this.getDisplayName(user),
      reply: body,
      imageUrl,
      messageId,
      groupId: group.id,
      groupName: group.name,
      groupMembers: group.members,
      groupCreatedBy: group.createdBy,
      groupUpdatedAt: group.updatedAt,
      groupType: group.type,
      groupSenderName: this.getDisplayName(user),
      replyToMessageId: metadata.replyTo?.messageId,
      replyToSender: metadata.replyTo?.sender,
      replyToSenderName: metadata.replyTo?.senderDisplayName,
      replyToBody: metadata.replyTo?.body,
      replyToImageUrl: metadata.replyTo?.imageUrl ?? null,
      forwarded: metadata.forwarded ? true : undefined,
      forwardedFrom: metadata.forwardedFrom || undefined,
      forwardedFromName: metadata.forwardedFromName || undefined
    };

    const recipients = group.members.filter((member) => this.normalizeUser(member) !== user);
    if (!recipients.length) {
      this.setMessageStatus(messageId, 'sent');
      return;
    }

    const failedRecipients: string[] = [];
    for (const recipient of recipients) {
      try {
        await this.api.sendDirectMessage({
          ...basePayload,
          originalSender: recipient
        });
      } catch {
        failedRecipients.push(recipient);
      }
    }

    if (failedRecipients.length) {
      this.queueGroupMessage(group, messageId, body, imageUrl, failedRecipients, metadata);
      this.setMessageStatus(messageId, 'queued');
      return;
    }

    this.setMessageStatus(messageId, 'sent');
  }

  private scheduleReadReceiptFlush(chatId: string): void {
    const normalizedChatId = this.normalizeChatId(chatId);
    if (!normalizedChatId) return;
    const pending = this.pendingReadReceiptByChat.get(normalizedChatId);
    if (!pending || pending.size === 0) return;

    const existingTimer = this.readReceiptFlushTimerByChat.get(normalizedChatId);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    const timer = setTimeout(() => {
      this.readReceiptFlushTimerByChat.delete(normalizedChatId);
      void this.flushPendingReadReceiptsForChat(normalizedChatId);
    }, READ_RECEIPT_FLUSH_DEBOUNCE_MS);
    this.readReceiptFlushTimerByChat.set(normalizedChatId, timer);
  }

  private async flushPendingReadReceiptsForChat(chatId: string): Promise<void> {
    const user = this.currentUser();
    if (!user || !this.networkOnline()) return;

    const normalizedChatId = this.normalizeChatId(chatId);
    if (!normalizedChatId) return;
    if (this.groups().some((group) => group.id === normalizedChatId)) return;
    if (this.isSystemChat(normalizedChatId)) return;
    if (this.readReceiptFlushInFlightByChat.has(normalizedChatId)) {
      this.scheduleReadReceiptFlush(normalizedChatId);
      return;
    }

    const pendingSet = this.pendingReadReceiptByChat.get(normalizedChatId);
    if (!pendingSet || pendingSet.size === 0) return;

    const sentSet = this.readReceiptSentByChat.get(normalizedChatId) ?? new Set<string>();
    const messageIds = Array.from(pendingSet).filter((messageId) => messageId && !sentSet.has(messageId));
    if (!messageIds.length) {
      this.pendingReadReceiptByChat.delete(normalizedChatId);
      return;
    }

    this.readReceiptFlushInFlightByChat.add(normalizedChatId);
    const nextSent = new Set(sentSet);
    const readAt = Date.now();
    let sentAnyBatch = false;

    try {
      for (let index = 0; index < messageIds.length; index += READ_RECEIPT_BATCH_SIZE) {
        const batch = messageIds.slice(index, index + READ_RECEIPT_BATCH_SIZE);
        if (!batch.length) continue;
        await this.api.sendReadReceipt({
          reader: this.normalizeUser(user),
          sender: normalizedChatId,
          messageIds: batch,
          readAt
        });
        sentAnyBatch = true;
        batch.forEach((messageId) => {
          nextSent.add(messageId);
          pendingSet.delete(messageId);
        });
      }
    } catch {
      // Best-effort only; remaining pending IDs stay queued for a later bottom reach.
    } finally {
      this.readReceiptFlushInFlightByChat.delete(normalizedChatId);
    }

    if (nextSent.size !== sentSet.size) {
      this.readReceiptSentByChat.set(normalizedChatId, nextSent);
    }
    if (pendingSet.size === 0) {
      this.pendingReadReceiptByChat.delete(normalizedChatId);
    }
    if (sentAnyBatch) {
      this.unreadByChat.update((map) => ({
        ...map,
        [normalizedChatId]: 0
      }));
      this.schedulePersist();
    }
  }

  private trackIncomingMessageForReadReceipt(chatId: string, messageId: string): void {
    const normalizedChatId = this.normalizeChatId(chatId);
    const normalizedMessageId = String(messageId || '').trim();
    if (!normalizedChatId || !normalizedMessageId) return;

    const sentSet = this.readReceiptSentByChat.get(normalizedChatId);
    if (sentSet?.has(normalizedMessageId)) return;

    const pendingSet = this.pendingReadReceiptByChat.get(normalizedChatId) ?? new Set<string>();
    pendingSet.add(normalizedMessageId);
    this.pendingReadReceiptByChat.set(normalizedChatId, pendingSet);
  }

  private seedPendingReadReceiptsFromUnreadCount(chatId: string, unreadCountRaw: number): void {
    const normalizedChatId = this.normalizeChatId(chatId);
    if (!normalizedChatId) return;
    const unreadCount = Math.max(0, Math.floor(Number(unreadCountRaw) || 0));
    if (unreadCount <= 0) return;

    const sentSet = this.readReceiptSentByChat.get(normalizedChatId) ?? new Set<string>();
    const incomingMessageIds = (this.messagesByChat()[normalizedChatId] ?? [])
      .filter((message) => message.direction === 'incoming' && Boolean(message.messageId))
      .map((message) => String(message.messageId || '').trim())
      .filter(Boolean);
    if (!incomingMessageIds.length) return;

    const unreadTailIds = incomingMessageIds.slice(-unreadCount).filter((messageId) => !sentSet.has(messageId));
    if (!unreadTailIds.length) return;

    const pendingSet = this.pendingReadReceiptByChat.get(normalizedChatId) ?? new Set<string>();
    unreadTailIds.forEach((messageId) => pendingSet.add(messageId));
    this.pendingReadReceiptByChat.set(normalizedChatId, pendingSet);
  }

  private resetReadReceiptTrackingState(): void {
    this.readReceiptSentByChat.clear();
    this.pendingReadReceiptByChat.clear();
    this.readReceiptFlushInFlightByChat.clear();
    for (const timer of this.readReceiptFlushTimerByChat.values()) {
      clearTimeout(timer);
    }
    this.readReceiptFlushTimerByChat.clear();
  }

  private clearUnreadCountForChat(chatId: string): void {
    const normalizedChatId = this.normalizeChatId(chatId);
    if (!normalizedChatId) return;

    let changed = false;
    this.unreadByChat.update((map) => {
      const current = Math.max(0, Math.floor(Number(map[normalizedChatId] ?? 0)));
      if (current <= 0) {
        return map;
      }
      changed = true;
      return {
        ...map,
        [normalizedChatId]: 0
      };
    });

    if (changed) {
      this.schedulePersist();
    }
  }

  private queueDirectMessage(
    originalSender: string,
    messageId: string,
    body: string,
    imageUrl: string | null,
    options: SendMessageOptions = {}
  ): void {
    const user = this.currentUser();
    if (!user) return;

    const metadata = this.normalizeSendMessageOptions(options);
    const item: OutboxDirectItem = {
      id: this.generateId('out'),
      kind: 'direct',
      payload: {
        user,
        senderName: this.getDisplayName(user),
        reply: body,
        imageUrl,
        originalSender,
        messageId,
        replyToMessageId: metadata.replyTo?.messageId,
        replyToSender: metadata.replyTo?.sender,
        replyToSenderName: metadata.replyTo?.senderDisplayName,
        replyToBody: metadata.replyTo?.body,
        replyToImageUrl: metadata.replyTo?.imageUrl ?? null,
        forwarded: metadata.forwarded ? true : undefined,
        forwardedFrom: metadata.forwardedFrom || undefined,
        forwardedFromName: metadata.forwardedFromName || undefined
      },
      messageId,
      attempts: 0,
      createdAt: Date.now()
    };

    this.appendOutbox(user, item);
  }

  private queueGroupMessage(
    group: ChatGroup,
    messageId: string,
    body: string,
    imageUrl: string | null,
    recipients?: string[],
    options: SendMessageOptions = {}
  ): void {
    const user = this.currentUser();
    if (!user) return;

    const metadata = this.normalizeSendMessageOptions(options);
    const targets = recipients
      ? recipients
      : group.members.filter((member) => this.normalizeUser(member) !== user);
    if (!targets.length) return;

    const item: OutboxGroupItem = {
      id: this.generateId('out'),
      kind: 'group',
      messageId,
      recipients: targets,
      payload: {
        user,
        senderName: this.getDisplayName(user),
        reply: body,
        imageUrl,
        messageId,
        groupId: group.id,
        groupName: group.name,
        groupMembers: group.members,
        groupCreatedBy: group.createdBy,
        groupUpdatedAt: group.updatedAt,
        groupType: group.type,
        groupSenderName: this.getDisplayName(user),
        replyToMessageId: metadata.replyTo?.messageId,
        replyToSender: metadata.replyTo?.sender,
        replyToSenderName: metadata.replyTo?.senderDisplayName,
        replyToBody: metadata.replyTo?.body,
        replyToImageUrl: metadata.replyTo?.imageUrl ?? null,
        forwarded: metadata.forwarded ? true : undefined,
        forwardedFrom: metadata.forwardedFrom || undefined,
        forwardedFromName: metadata.forwardedFromName || undefined
      },
      attempts: 0,
      createdAt: Date.now()
    };

    this.appendOutbox(user, item);
  }

  private queueGroupUpdate(payload: OutboxGroupUpdateItem['payload']): void {
    const user = this.currentUser();
    if (!user) return;

    const item: OutboxGroupUpdateItem = {
      id: this.generateId('out'),
      kind: 'group-update',
      payload,
      attempts: 0,
      createdAt: Date.now()
    };

    this.appendOutbox(user, item);
  }

  private connectRealtime(user: string): void {
    this.stopRealtime();
    this.startPolling(user);

    if (!this.isNetworkReachable()) {
      return;
    }

    try {
      this.stream = this.api.createMessageStream(user);
      this.stream.addEventListener('message', (event: MessageEvent<string>) => {
        this.handleIncomingPayload(event.data);
      });
      this.stream.addEventListener('connected', () => {
        // Immediately pull queued messages after stream handshake.
        void this.pullMessages(user);
      });

      this.stream.onerror = () => {
        this.stopStreamOnly();
        this.scheduleStreamReconnect(user);
      };
    } catch {
      this.scheduleStreamReconnect(user);
    }
  }

  private startPolling(user: string): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
    }

    this.pollTimer = setInterval(() => {
      void this.pullMessages(user);
    }, POLL_INTERVAL_MS);

    void this.pullMessages(user);
  }

  private stopStreamOnly(): void {
    if (this.stream) {
      this.stream.close();
      this.stream = null;
    }
  }

  private stopRealtime(): void {
    this.stopStreamOnly();

    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private startBackgroundContactsAccessSync(user: string): void {
    this.stopBackgroundContactsAccessSync();
    this.contactsAccessSyncTimer = setInterval(() => {
      void this.syncContactsAccessInBackground(user);
    }, CONTACTS_ACCESS_SYNC_INTERVAL_MS);
  }

  private stopBackgroundContactsAccessSync(): void {
    if (this.contactsAccessSyncTimer) {
      clearInterval(this.contactsAccessSyncTimer);
      this.contactsAccessSyncTimer = null;
    }
    this.contactsAccessSyncInFlight = false;
  }

  private async syncContactsAccessInBackground(user: string): Promise<void> {
    if (this.contactsAccessSyncInFlight) return;
    if (this.currentUser() !== user) return;
    if (!this.isNetworkReachable()) return;

    this.contactsAccessSyncInFlight = true;
    try {
      const contacts = this.normalizeContacts(await this.api.getContacts(user));
      if (this.haveContactsChanged(this.contacts(), contacts)) {
        this.contacts.set(contacts);
        this.schedulePersist();
      }
      this.lastContactsFetchAt = Date.now();
    } catch {
      // Silent background check to avoid noisy UX.
    } finally {
      this.contactsAccessSyncInFlight = false;
    }
  }

  private haveContactsChanged(current: Contact[], next: Contact[]): boolean {
    if (current.length !== next.length) {
      return true;
    }
    const currentSignature = current
      .map((item) => `${item.username}|${item.displayName}|${item.info || ''}|${item.phone || ''}|${item.upic || ''}`)
      .join('\n');
    const nextSignature = next
      .map((item) => `${item.username}|${item.displayName}|${item.info || ''}|${item.phone || ''}|${item.upic || ''}`)
      .join('\n');
    return currentSignature !== nextSignature;
  }

  private startDeliveryTelemetry(user: string): void {
    if (!user) {
      return;
    }
    this.stopDeliveryTelemetry();
    this.deliveryTelemetryCounters = this.createEmptyDeliveryTelemetryCounters();
    this.deliveryTelemetryLastFlushedAt = Date.now();
    this.ensureDeliveryTelemetryDeviceId();
    this.deliveryTelemetryFlushTimer = setInterval(() => {
      void this.flushDeliveryTelemetry();
    }, DELIVERY_TELEMETRY_FLUSH_INTERVAL_MS);
  }

  private stopDeliveryTelemetry(): void {
    if (this.deliveryTelemetryFlushTimer) {
      clearInterval(this.deliveryTelemetryFlushTimer);
      this.deliveryTelemetryFlushTimer = null;
    }
    this.deliveryTelemetryInFlight = false;
  }

  private createEmptyDeliveryTelemetryCounters(): DeliveryTelemetryCounters {
    return {
      pushPayloadReceived: 0,
      pushImmediateMessageBuilt: 0,
      pushMessageApplied: 0,
      pushMessageNoop: 0,
      pushMissingMessageContext: 0,
      pushRecoveryPullScheduled: 0,
      ssePayloadReceived: 0,
      sseMessageApplied: 0,
      sseMessageNoop: 0,
      pollMessagesFetched: 0,
      pollMessagesApplied: 0
    };
  }

  private incrementDeliveryTelemetry(counter: keyof DeliveryTelemetryCounters, delta = 1): void {
    const normalizedDelta = Math.max(0, Math.floor(Number(delta) || 0));
    if (!normalizedDelta) return;
    this.deliveryTelemetryCounters[counter] += normalizedDelta;
    void this.flushDeliveryTelemetry();
  }

  private totalDeliveryTelemetryEvents(counters: DeliveryTelemetryCounters): number {
    return Object.values(counters).reduce((sum, value) => sum + (Number(value) || 0), 0);
  }

  private ensureDeliveryTelemetryDeviceId(): string {
    if (this.deliveryTelemetryDeviceId) {
      return this.deliveryTelemetryDeviceId;
    }
    const stored = this.safeStorageGet(DELIVERY_TELEMETRY_DEVICE_ID_KEY).trim();
    if (stored) {
      this.deliveryTelemetryDeviceId = stored;
      return stored;
    }
    const nextId = (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function')
      ? crypto.randomUUID()
      : `dev_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    this.deliveryTelemetryDeviceId = nextId;
    this.safeStorageSet(DELIVERY_TELEMETRY_DEVICE_ID_KEY, nextId);
    return nextId;
  }

  private async flushDeliveryTelemetry(options: { force?: boolean; includeZero?: boolean } = {}): Promise<void> {
    const user = this.currentUser();
    if (!user) return;
    if (this.deliveryTelemetryInFlight) return;

    const force = Boolean(options.force);
    const includeZero = Boolean(options.includeZero);
    const now = Date.now();
    const elapsed = now - this.deliveryTelemetryLastFlushedAt;
    const snapshot = { ...this.deliveryTelemetryCounters };
    const totalEvents = this.totalDeliveryTelemetryEvents(snapshot);

    if (!force && totalEvents < DELIVERY_TELEMETRY_FLUSH_MIN_EVENTS && elapsed < DELIVERY_TELEMETRY_FLUSH_INTERVAL_MS) {
      return;
    }
    if (!includeZero && totalEvents <= 0) {
      return;
    }

    this.deliveryTelemetryInFlight = true;
    this.deliveryTelemetryCounters = this.createEmptyDeliveryTelemetryCounters();
    try {
      const unreadTotal = Object.values(this.unreadByChat()).reduce((sum, count) => sum + (Number(count) || 0), 0);
      await this.api.sendClientLog(
        'delivery-telemetry',
        {
          ...snapshot,
          deviceId: this.ensureDeliveryTelemetryDeviceId(),
          activeChatId: this.activeChatId(),
          unreadTotal,
          inForeground: this.isAppInForeground(),
          networkOnline: this.networkOnline(),
          at: now
        },
        user
      );
      this.deliveryTelemetryLastFlushedAt = now;
    } catch {
      // Merge back on failure to avoid dropping telemetry counters.
      (Object.keys(snapshot) as Array<keyof DeliveryTelemetryCounters>).forEach((key) => {
        this.deliveryTelemetryCounters[key] += snapshot[key];
      });
    } finally {
      this.deliveryTelemetryInFlight = false;
    }
  }

  private scheduleStreamReconnect(user: string): void {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.currentUser() !== user) return;
      this.connectRealtime(user);
    }, STREAM_RETRY_MS);
  }

  private async pullMessages(user: string): Promise<void> {
    if (this.pullInFlight || !this.isNetworkReachable()) return;
    if (this.currentUser() !== user) return;

    this.pullInFlight = true;
    try {
      const messages = await this.api.pollMessages();
      this.incrementDeliveryTelemetry('pollMessagesFetched', messages.length);
      let appliedCount = 0;
      this.runIncomingBatch(() => {
        const bufferedRegularMessages: IncomingServerMessage[] = [];
        const flushBufferedRegularMessages = (): void => {
          if (!bufferedRegularMessages.length) return;
          appliedCount += this.applyRegularIncomingMessagesBulk(bufferedRegularMessages);
          bufferedRegularMessages.length = 0;
        };

        for (const message of messages) {
          const incomingType = String(message.type ?? '').trim().toLowerCase();
          if (this.isIncomingActionType(incomingType)) {
            flushBufferedRegularMessages();
            if (this.applyIncomingMessage(message)) {
              appliedCount += 1;
            }
            continue;
          }

          bufferedRegularMessages.push(message);
        }

        flushBufferedRegularMessages();
      });
      this.incrementDeliveryTelemetry('pollMessagesApplied', appliedCount);
    } catch {
      // Polling failures are expected during network interruptions.
    } finally {
      this.pullInFlight = false;
    }
  }

  private isIncomingActionType(incomingType: string): boolean {
    return (
      incomingType === 'delete-action' ||
      incomingType === 'edit-action' ||
      incomingType === 'reaction' ||
      incomingType === 'group-update' ||
      incomingType === 'read-receipt'
    );
  }

  private applyRegularIncomingMessagesBulk(messages: IncomingServerMessage[]): number {
    if (!messages.length) return 0;

    const currentMessageMap = this.messagesByChat();
    const nextMessageMap: Record<string, ChatMessage[]> = { ...currentMessageMap };
    const mutableListChats = new Set<string>();
    const knownMessageIdsByChat = new Map<string, Set<string>>();
    const nextUnreadMap: Record<string, number> = { ...this.unreadByChat() };

    let groupsSnapshot = this.groups();
    let messagesChanged = false;
    let unreadChanged = false;
    let appliedCount = 0;

    const getMessageIdSet = (chatId: string): Set<string> => {
      const existing = knownMessageIdsByChat.get(chatId);
      if (existing) return existing;
      const set = new Set((nextMessageMap[chatId] ?? []).map((message) => message.messageId));
      knownMessageIdsByChat.set(chatId, set);
      return set;
    };

    const getMutableList = (chatId: string): ChatMessage[] => {
      if (!mutableListChats.has(chatId)) {
        nextMessageMap[chatId] = nextMessageMap[chatId] ? [...nextMessageMap[chatId]] : [];
        mutableListChats.add(chatId);
      }
      return nextMessageMap[chatId] ?? [];
    };

    for (const incoming of messages) {
      const sender = this.normalizeUser(incoming.sender ?? '');
      if (!sender) continue;

      const isGroup = Boolean(incoming.groupId);
      const chatId = isGroup
        ? this.normalizeChatId(incoming.groupId ?? '')
        : this.normalizeChatId(sender);
      if (!chatId) continue;

      const messageId = String(incoming.messageId ?? this.generateId('srv')).trim();
      if (!messageId) continue;
      const incomingBody = this.resolveIncomingMessageBody(incoming);
      const incomingImageUrl = this.resolveIncomingImageUrl(incoming);

      const knownMessageIds = getMessageIdSet(chatId);
      if (knownMessageIds.has(messageId)) {
        if (!this.hasRenderableIncomingContent(incomingBody, incomingImageUrl)) {
          continue;
        }
        const list = getMutableList(chatId);
        if (this.hydrateIncomingMessageInList(list, messageId, incomingBody, incomingImageUrl)) {
          messagesChanged = true;
          appliedCount += 1;
        }
        continue;
      }

      if (!this.hasRenderableIncomingContent(incomingBody, incomingImageUrl)) {
        continue;
      }

      if (isGroup && incoming.groupId && incoming.groupName) {
        this.ensureGroupFromIncoming(incoming);
        groupsSnapshot = this.groups();
      }
      const incomingGroup = isGroup
        ? groupsSnapshot.find((item) => item.id === chatId) ?? null
        : null;
      const normalizedIncomingGroupType: GroupType | null =
        incoming.groupType === 'community' || incoming.groupType === 'group'
          ? incoming.groupType
          : (incomingGroup?.type ?? null);

      const replyTo = this.normalizeMessageReference({
        messageId: incoming.replyToMessageId,
        sender: incoming.replyToSender,
        senderDisplayName: incoming.replyToSenderName,
        body: incoming.replyToBody,
        imageUrl: incoming.replyToImageUrl ?? null
      });
      const forwardedFrom = incoming.forwardedFrom ? this.normalizeUser(incoming.forwardedFrom) : '';
      const forwardedFromName = String(incoming.forwardedFromName || '').trim();
      const record: ChatMessage = {
        id: this.generateId('rec'),
        messageId,
        chatId,
        sender,
        senderDisplayName: incoming.groupSenderName || this.getDisplayName(sender),
        body: incomingBody,
        imageUrl: incomingImageUrl,
        direction: 'incoming',
        timestamp: Number(incoming.timestamp ?? Date.now()),
        deliveryStatus: 'delivered',
        groupId: incoming.groupId ? this.normalizeChatId(incoming.groupId) : null,
        groupName: incoming.groupName ?? null,
        groupType: normalizedIncomingGroupType,
        editedAt: Number.isFinite(Number(incoming.editedAt)) ? Number(incoming.editedAt) : null,
        deletedAt: Number.isFinite(Number(incoming.deletedAt)) ? Number(incoming.deletedAt) : null,
        replyTo,
        forwarded: Boolean(incoming.forwarded),
        forwardedFrom: forwardedFrom || null,
        forwardedFromName: forwardedFromName || null
      };

      const list = getMutableList(chatId);
      if (!list.length || list[list.length - 1].timestamp <= record.timestamp) {
        list.push(record);
      } else {
        const insertAt = this.findMessageInsertIndexByTimestamp(list, record.timestamp);
        list.splice(insertAt, 0, record);
      }

      knownMessageIds.add(messageId);
      messagesChanged = true;
      appliedCount += 1;

      if (!isGroup && !this.isSystemChat(chatId)) {
        this.trackIncomingMessageForReadReceipt(chatId, messageId);
      }

      nextUnreadMap[chatId] = (nextUnreadMap[chatId] ?? 0) + 1;
      unreadChanged = true;
    }

    if (messagesChanged) {
      this.messagesByChat.set(nextMessageMap);
    }
    if (unreadChanged) {
      this.unreadByChat.set(nextUnreadMap);
    }
    if (messagesChanged || unreadChanged) {
      this.schedulePersist();
    }

    return appliedCount;
  }

  private handleIncomingPayload(rawData: string): void {
    try {
      this.incrementDeliveryTelemetry('ssePayloadReceived');
      const message = JSON.parse(rawData) as IncomingServerMessage;
      if (this.applyIncomingMessage(message)) {
        this.incrementDeliveryTelemetry('sseMessageApplied');
      } else {
        this.incrementDeliveryTelemetry('sseMessageNoop');
      }
    } catch {
      // Ignore malformed realtime payloads.
    }
  }

  private applyIncomingMessage(incoming: IncomingServerMessage): boolean {
    const incomingType = String(incoming.type ?? '').trim().toLowerCase();
    if (incomingType === 'delete-action') {
      return this.applyIncomingDeleteAction(incoming);
    }
    if (incomingType === 'edit-action') {
      return this.applyIncomingEditAction(incoming);
    }
    if (incomingType === 'reaction') {
      return this.applyIncomingReaction(incoming);
    }
    if (incomingType === 'group-update') {
      return this.applyIncomingGroupUpdate(incoming);
    }
    if (incomingType === 'read-receipt') {
      return this.applyIncomingReadReceipt(incoming);
    }

    const sender = this.normalizeUser(incoming.sender ?? '');
    if (!sender) return false;

    const isGroup = Boolean(incoming.groupId);
    const chatId = isGroup
      ? this.normalizeChatId(incoming.groupId ?? '')
      : this.normalizeChatId(sender);
    if (!chatId) return false;

    const messageId = String(incoming.messageId ?? this.generateId('srv')).trim();
    if (!messageId) return false;
    const incomingBody = this.resolveIncomingMessageBody(incoming);
    const incomingImageUrl = this.resolveIncomingImageUrl(incoming);

    const alreadyExists = (this.messagesByChat()[chatId] ?? []).some(
      (message) => message.messageId === messageId
    );
    if (alreadyExists) {
      return this.hydrateExistingIncomingMessage(chatId, messageId, incomingBody, incomingImageUrl);
    }
    if (!this.hasRenderableIncomingContent(incomingBody, incomingImageUrl)) {
      return false;
    }

    if (isGroup && incoming.groupId && incoming.groupName) {
      this.ensureGroupFromIncoming(incoming);
    }
    const incomingGroup = isGroup
      ? this.groups().find((item) => item.id === chatId) ?? null
      : null;
    const normalizedIncomingGroupType: GroupType | null =
      incoming.groupType === 'community' || incoming.groupType === 'group'
        ? incoming.groupType
        : (incomingGroup?.type ?? null);

    const replyTo = this.normalizeMessageReference({
      messageId: incoming.replyToMessageId,
      sender: incoming.replyToSender,
      senderDisplayName: incoming.replyToSenderName,
      body: incoming.replyToBody,
      imageUrl: incoming.replyToImageUrl ?? null
    });
    const forwardedFrom = incoming.forwardedFrom ? this.normalizeUser(incoming.forwardedFrom) : '';
    const forwardedFromName = String(incoming.forwardedFromName || '').trim();
    const record: ChatMessage = {
      id: this.generateId('rec'),
      messageId,
      chatId,
      sender,
      senderDisplayName: incoming.groupSenderName || this.getDisplayName(sender),
      body: incomingBody,
      imageUrl: incomingImageUrl,
      direction: 'incoming',
      timestamp: Number(incoming.timestamp ?? Date.now()),
      deliveryStatus: 'delivered',
      groupId: incoming.groupId ? this.normalizeChatId(incoming.groupId) : null,
      groupName: incoming.groupName ?? null,
      groupType: normalizedIncomingGroupType,
      editedAt: Number.isFinite(Number(incoming.editedAt)) ? Number(incoming.editedAt) : null,
      deletedAt: Number.isFinite(Number(incoming.deletedAt)) ? Number(incoming.deletedAt) : null,
      replyTo,
      forwarded: Boolean(incoming.forwarded),
      forwardedFrom: forwardedFrom || null,
      forwardedFromName: forwardedFromName || null
    };

    this.appendMessage(record);
    if (!isGroup && !this.isSystemChat(chatId)) {
      this.trackIncomingMessageForReadReceipt(chatId, messageId);
    }

    this.unreadByChat.update((map) => ({
      ...map,
      [chatId]: (map[chatId] ?? 0) + 1
    }));

    this.schedulePersist();
    return true;
  }

  private normalizeIncomingBodyValue(value: unknown): string {
    if (typeof value === 'string') {
      return value.trim();
    }
    if (value && typeof value === 'object') {
      const nested = value as Record<string, unknown>;
      const nestedBody = nested['longText'] ?? nested['shortText'] ?? nested['text'] ?? nested['body'] ?? '';
      return String(nestedBody || '').trim();
    }
    return String(value ?? '').trim();
  }

  private normalizeIncomingImageValue(value: unknown): string | null {
    const normalized = String(value ?? '').trim();
    return normalized || null;
  }

  private resolveIncomingMessageBody(incoming: IncomingServerMessage): string {
    const payload = incoming as Record<string, unknown>;
    const rawBody = incoming.body
      ?? payload['messageText']
      ?? payload['groupMessageText']
      ?? payload['longText']
      ?? payload['shortText']
      ?? payload['text']
      ?? payload['message']
      ?? payload['reply']
      ?? payload['body']
      ?? '';
    return this.normalizeIncomingBodyValue(rawBody);
  }

  private resolveIncomingImageUrl(incoming: IncomingServerMessage): string | null {
    const payload = incoming as Record<string, unknown>;
    const rawImage = incoming.imageUrl
      ?? payload['image']
      ?? payload['imageUrl']
      ?? null;
    return this.normalizeIncomingImageValue(rawImage);
  }

  private hasRenderableIncomingContent(body: string, imageUrl: string | null): boolean {
    return Boolean(String(body || '').trim() || String(imageUrl || '').trim());
  }

  private hydrateExistingIncomingMessage(
    chatId: string,
    messageId: string,
    incomingBody: string,
    incomingImageUrl: string | null
  ): boolean {
    if (!this.hasRenderableIncomingContent(incomingBody, incomingImageUrl)) {
      return false;
    }

    let changed = false;
    this.messagesByChat.update((messageMap) => {
      const list = messageMap[chatId];
      if (!list?.length) {
        return messageMap;
      }

      const nextList = [...list];
      if (!this.hydrateIncomingMessageInList(nextList, messageId, incomingBody, incomingImageUrl)) {
        return messageMap;
      }
      changed = true;
      return {
        ...messageMap,
        [chatId]: nextList
      };
    });

    if (changed) {
      this.schedulePersist();
    }
    return changed;
  }

  private hydrateIncomingMessageInList(
    list: ChatMessage[],
    messageId: string,
    incomingBody: string,
    incomingImageUrl: string | null
  ): boolean {
    const index = list.findIndex((message) => message.messageId === messageId);
    if (index < 0) return false;

    const current = list[index];
    if (current.direction !== 'incoming' || current.deletedAt) {
      return false;
    }

    const currentBody = String(current.body || '').trim();
    const currentImage = String(current.imageUrl || '').trim();
    const nextBody = currentBody || incomingBody;
    const nextImage = currentImage || String(incomingImageUrl || '').trim();
    if (nextBody === currentBody && nextImage === currentImage) {
      return false;
    }

    list[index] = {
      ...current,
      body: nextBody,
      imageUrl: nextImage || null
    };
    return true;
  }

  private applyIncomingGroupUpdate(incoming: IncomingServerMessage): boolean {
    const groupId = this.normalizeChatId(incoming.groupId ?? '');
    if (!groupId || !incoming.groupName) return false;

    const currentUser = this.normalizeUser(this.currentUser() ?? '');
    const members = Array.isArray(incoming.groupMembers)
      ? incoming.groupMembers.map((member) => this.normalizeUser(member)).filter(Boolean)
      : [];
    if (currentUser && members.length && !members.includes(currentUser)) {
      this.removeGroupLocally(groupId);
      return true;
    }

    this.ensureGroupFromIncoming(incoming);
    this.schedulePersist();
    return true;
  }

  private applyIncomingReadReceipt(incoming: IncomingServerMessage): boolean {
    const messageIds = Array.isArray(incoming.messageIds)
      ? incoming.messageIds.map((id) => String(id || '').trim()).filter(Boolean)
      : String(incoming.messageId ?? '')
          .split(',')
          .map((id) => String(id || '').trim())
          .filter(Boolean);
    if (!messageIds.length) return false;

    return this.markOutgoingMessagesAsRead(messageIds);
  }

  private applyIncomingEditAction(incoming: IncomingServerMessage): boolean {
    const messageId = String(incoming.messageId ?? '').trim();
    const body = String(incoming.body ?? '').trim();
    if (!messageId || !body) return false;

    const editedAtValue = Number(incoming.editedAt ?? incoming.timestamp ?? Date.now());
    const editedAt = Number.isFinite(editedAtValue) ? editedAtValue : Date.now();
    return this.applyMessageEditLocally(messageId, body, editedAt);
  }

  private applyIncomingDeleteAction(incoming: IncomingServerMessage): boolean {
    const messageIds = Array.isArray(incoming.messageIds)
      ? incoming.messageIds.map((id) => String(id || '').trim()).filter(Boolean)
      : String(incoming.messageId ?? '')
          .split(',')
          .map((id) => String(id || '').trim())
          .filter(Boolean);
    if (!messageIds.length) return false;

    const deletedAtValue = Number(incoming.deletedAt ?? incoming.timestamp ?? Date.now());
    const deletedAt = Number.isFinite(deletedAtValue) ? deletedAtValue : Date.now();
    let changed = false;
    messageIds.forEach((messageId) => {
      changed = this.applyMessageDeleteLocally(messageId, deletedAt, { skipPersist: true }) || changed;
    });
    if (changed) {
      this.schedulePersist();
    }
    return changed;
  }

  private applyIncomingReaction(incoming: IncomingServerMessage): boolean {
    const groupId = this.normalizeChatId(incoming.groupId ?? '');
    if (!groupId) return false;

    if (incoming.groupName) {
      this.ensureGroupFromIncoming(incoming);
    }

    const targetMessageId = String(incoming.targetMessageId ?? incoming.messageId ?? '').trim();
    const emoji = String(incoming.emoji ?? '').trim();
    const reactor = this.normalizeUser(incoming.reactor ?? incoming.sender ?? '');
    if (!targetMessageId || !emoji || !reactor) {
      return false;
    }

    const reaction: MessageReaction = {
      emoji,
      reactor,
      reactorName: String(incoming.reactorName ?? '').trim() || this.getDisplayName(reactor)
    };

    const changed = this.applyReactionToMessage(groupId, targetMessageId, reaction);
    if (!changed) return false;

    const currentUser = this.normalizeUser(this.currentUser() ?? '');
    if (currentUser && reactor === currentUser) {
      return true;
    }

    const group = this.groups().find((item) => item.id === groupId);
    const groupName = String(incoming.groupName ?? group?.name ?? groupId).trim() || groupId;
    const reactorName = reaction.reactorName || this.getDisplayName(reactor);

    this.incomingReactionNotice.set({
      id: `${groupId}:${targetMessageId}:${reactor}:${emoji}`,
      chatId: groupId,
      groupName,
      reactorName,
      emoji
    });
    return true;
  }

  private ensureGroupFromIncoming(incoming: IncomingServerMessage): void {
    if (!incoming.groupId || !incoming.groupName) return;
    const user = this.currentUser();
    if (!user) return;

    const normalizedId = this.normalizeChatId(incoming.groupId);
    const normalizedType: GroupType = incoming.groupType === 'community' ? 'community' : 'group';
    const updatedAt = Number(incoming.groupUpdatedAt ?? Date.now());

    this.groups.update((groups) => {
      const existing = groups.find((group) => group.id === normalizedId);
      if (!existing) {
        const nextGroup: ChatGroup = {
          id: normalizedId,
          name: incoming.groupName ?? normalizedId,
          members: (incoming.groupMembers ?? []).map((member) => this.normalizeUser(member)),
          createdBy: this.normalizeUser(incoming.groupCreatedBy ?? user),
          updatedAt,
          type: normalizedType
        };

        return [nextGroup, ...groups];
      }

      if (updatedAt < existing.updatedAt) {
        return groups;
      }

      return groups.map((group) =>
        group.id === normalizedId
          ? {
              ...group,
              name: incoming.groupName ?? group.name,
              members: Array.isArray(incoming.groupMembers)
                ? incoming.groupMembers.map((member) => this.normalizeUser(member))
                : group.members,
              createdBy: incoming.groupCreatedBy
                ? this.normalizeUser(incoming.groupCreatedBy)
                : group.createdBy,
              type: normalizedType,
              updatedAt
            }
          : group
      );
    });
  }

  private applyReactionToMessage(
    chatId: string,
    targetMessageId: string,
    reaction: MessageReaction
  ): boolean {
    const normalizedChatId = this.normalizeChatId(chatId);
    const normalizedTargetId = String(targetMessageId || '').trim();
    const normalizedReactor = this.normalizeUser(reaction.reactor);
    const normalizedEmoji = String(reaction.emoji || '').trim();
    if (!normalizedChatId || !normalizedTargetId || !normalizedReactor || !normalizedEmoji) {
      return false;
    }

    let changed = false;
    this.messagesByChat.update((messageMap) => {
      const list = messageMap[normalizedChatId];
      if (!list?.length) {
        return messageMap;
      }

      const nextList = list.map((message) => {
        if (message.messageId !== normalizedTargetId) {
          return message;
        }

        const reactions = Array.isArray(message.reactions) ? [...message.reactions] : [];
        const existingIndex = reactions.findIndex(
          (item) => this.normalizeUser(item.reactor) === normalizedReactor
        );
        const nextReaction: MessageReaction = {
          emoji: normalizedEmoji,
          reactor: normalizedReactor,
          reactorName: reaction.reactorName
        };

        if (existingIndex >= 0) {
          const current = reactions[existingIndex];
          if (
            current.emoji === nextReaction.emoji &&
            (current.reactorName ?? '') === (nextReaction.reactorName ?? '')
          ) {
            return message;
          }
          reactions[existingIndex] = nextReaction;
        } else {
          reactions.push(nextReaction);
        }

        changed = true;
        return {
          ...message,
          reactions
        };
      });

      if (!changed) {
        return messageMap;
      }

      return {
        ...messageMap,
        [normalizedChatId]: nextList
      };
    });

    if (changed) {
      this.schedulePersist();
    }
    return changed;
  }

  private removeGroupLocally(groupId: string): void {
    let groupRemoved = false;
    this.groups.update((groups) => {
      if (!groups.some((group) => group.id === groupId)) {
        return groups;
      }
      groupRemoved = true;
      return groups.filter((group) => group.id !== groupId);
    });
    if (!groupRemoved) return;

    this.messagesByChat.update((messageMap) => {
      if (!(groupId in messageMap)) {
        return messageMap;
      }
      const next = { ...messageMap };
      delete next[groupId];
      return next;
    });

    this.unreadByChat.update((map) => {
      if (!(groupId in map)) {
        return map;
      }
      const next = { ...map };
      delete next[groupId];
      return next;
    });

    if (this.activeChatId() === groupId) {
      this.activeChatId.set(null);
      const user = this.currentUser();
      if (user) {
        localStorage.removeItem(this.activeChatKey(user));
      }
    }

    this.schedulePersist();
  }

  private findOutgoingMessageForAction(messageId: string): { chatId: string; message: ChatMessage } | null {
    const normalizedId = String(messageId || '').trim();
    if (!normalizedId) return null;

    const messageMap = this.messagesByChat();
    for (const [chatId, list] of Object.entries(messageMap)) {
      const message = list.find(
        (item) => item.messageId === normalizedId && item.direction === 'outgoing'
      );
      if (message) {
        return { chatId, message };
      }
    }
    return null;
  }

  private restoreMessageSnapshotLocally(messageId: string, snapshot: MessageActionSnapshot): boolean {
    const normalizedId = String(messageId || '').trim();
    if (!normalizedId) return false;

    let changed = false;
    this.messagesByChat.update((messageMap) => {
      const nextMap: Record<string, ChatMessage[]> = {};
      for (const [chatId, list] of Object.entries(messageMap)) {
        const nextList = list.map((message) => {
          if (message.messageId !== normalizedId) {
            return message;
          }
          changed = true;
          return {
            ...message,
            body: snapshot.body,
            imageUrl: snapshot.imageUrl ?? null,
            thumbnailUrl: snapshot.thumbnailUrl ?? null,
            editedAt: snapshot.editedAt ?? null,
            deletedAt: snapshot.deletedAt ?? null
          };
        });
        nextMap[chatId] = nextList;
      }
      return changed ? nextMap : messageMap;
    });

    if (changed) {
      this.schedulePersist();
    }
    return changed;
  }

  private applyMessageEditLocally(messageId: string, body: string, editedAt: number): boolean {
    const normalizedId = String(messageId || '').trim();
    const nextBody = String(body || '').trim();
    if (!normalizedId || !nextBody) return false;

    let changed = false;
    this.messagesByChat.update((messageMap) => {
      const nextMap: Record<string, ChatMessage[]> = {};
      for (const [chatId, list] of Object.entries(messageMap)) {
        const nextList = list.map((message) => {
          if (message.messageId !== normalizedId) {
            return message;
          }
          if (message.deletedAt) {
            return message;
          }
          if (String(message.body || '') === nextBody) {
            return message;
          }
          changed = true;
          return {
            ...message,
            body: nextBody,
            editedAt
          };
        });
        nextMap[chatId] = nextList;
      }
      return changed ? nextMap : messageMap;
    });

    if (changed) {
      this.schedulePersist();
    }
    return changed;
  }

  private applyMessageDeleteLocally(
    messageId: string,
    deletedAt: number,
    options: { skipPersist?: boolean } = {}
  ): boolean {
    const normalizedId = String(messageId || '').trim();
    if (!normalizedId) return false;

    let changed = false;
    this.messagesByChat.update((messageMap) => {
      const nextMap: Record<string, ChatMessage[]> = {};
      for (const [chatId, list] of Object.entries(messageMap)) {
        const nextList = list.map((message) => {
          if (message.messageId !== normalizedId) {
            return message;
          }
          if (message.deletedAt) {
            return message;
          }
          changed = true;
          return {
            ...message,
            body: DELETED_MESSAGE_PLACEHOLDER,
            imageUrl: null,
            thumbnailUrl: null,
            editedAt: null,
            deletedAt
          };
        });
        nextMap[chatId] = nextList;
      }
      return changed ? nextMap : messageMap;
    });

    if (changed && !options.skipPersist) {
      this.schedulePersist();
    }
    return changed;
  }

  private appendMessage(message: ChatMessage): void {
    const chatId = this.normalizeChatId(message.chatId);
    if (!chatId) return;

    const normalizedSender = this.normalizeUser(message.sender);
    const normalizedReplyTo = this.normalizeMessageReference(message.replyTo ?? null);
    const normalizedForwardedFrom = message.forwardedFrom
      ? this.normalizeUser(message.forwardedFrom)
      : '';
    const normalizedForwardedFromName = String(message.forwardedFromName || '').trim();
    const nextMessage: ChatMessage = {
      ...message,
      chatId,
      sender: normalizedSender,
      replyTo: normalizedReplyTo,
      forwarded: Boolean(message.forwarded),
      forwardedFrom: normalizedForwardedFrom || null,
      forwardedFromName: normalizedForwardedFromName || null
    };

    this.messagesByChat.update((messageMap) => {
      const existingList = messageMap[chatId] ?? [];
      if (existingList.some((entry) => entry.messageId === nextMessage.messageId)) {
        return messageMap;
      }

      const list = [...existingList];
      if (!list.length || list[list.length - 1].timestamp <= nextMessage.timestamp) {
        list.push(nextMessage);
      } else {
        const insertAt = this.findMessageInsertIndexByTimestamp(list, nextMessage.timestamp);
        list.splice(insertAt, 0, nextMessage);
      }

      return {
        ...messageMap,
        [chatId]: list
      };
    });

    this.schedulePersist();
  }

  private findMessageInsertIndexByTimestamp(list: ChatMessage[], timestamp: number): number {
    let low = 0;
    let high = list.length;
    while (low < high) {
      const mid = Math.floor((low + high) / 2);
      if (list[mid].timestamp <= timestamp) {
        low = mid + 1;
      } else {
        high = mid;
      }
    }
    return low;
  }

  private setMessageStatus(messageId: string, status: DeliveryStatus): void {
    this.messagesByChat.update((messageMap) => {
      let changed = false;
      const next: Record<string, ChatMessage[]> = {};

      for (const [chatId, list] of Object.entries(messageMap)) {
        const updated = list.map((message) => {
          if (message.messageId !== messageId) return message;
          if (!this.shouldApplyDeliveryStatusTransition(message.deliveryStatus, status)) {
            return message;
          }
          changed = true;
          return { ...message, deliveryStatus: status };
        });
        next[chatId] = updated;
      }

      return changed ? next : messageMap;
    });

    this.schedulePersist();
  }

  private markOutgoingMessagesAsRead(messageIds: string[]): boolean {
    const targetIds = new Set(messageIds.map((id) => String(id || '').trim()).filter(Boolean));
    if (!targetIds.size) return false;

    let changed = false;
    this.messagesByChat.update((messageMap) => {
      const next: Record<string, ChatMessage[]> = {};

      for (const [chatId, list] of Object.entries(messageMap)) {
        const updated = list.map((message) => {
          if (message.direction !== 'outgoing') return message;
          if (!targetIds.has(message.messageId)) return message;
          if (message.deliveryStatus === 'read') return message;

          changed = true;
          return { ...message, deliveryStatus: 'read' as DeliveryStatus };
        });
        next[chatId] = updated;
      }

      return changed ? next : messageMap;
    });

    if (changed) {
      this.schedulePersist();
    }
    return changed;
  }

  private shouldApplyDeliveryStatusTransition(
    currentStatus: DeliveryStatus,
    nextStatus: DeliveryStatus
  ): boolean {
    if (currentStatus === nextStatus) return false;

    // Never downgrade after read receipt is applied.
    if (currentStatus === 'read') return false;

    // Failure is only valid while still in unsent states.
    if (nextStatus === 'failed') {
      return currentStatus === 'pending' || currentStatus === 'queued';
    }

    // Don't allow pending/queued to overwrite sent/delivered/read.
    if (
      (nextStatus === 'pending' || nextStatus === 'queued') &&
      (currentStatus === 'sent' || currentStatus === 'delivered')
    ) {
      return false;
    }

    return true;
  }

  private tryRegisterPush = async (
    user: string,
    options: { force?: boolean } = {}
  ): Promise<void> => {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
    if (!user) return;
    const force = Boolean(options.force);
    const now = Date.now();
    if (
      this.pushRegisterInFlight ||
      (!force && now - this.lastPushRegisterAttemptAt < PUSH_REGISTER_MIN_INTERVAL_MS)
    ) {
      return;
    }
    this.lastPushRegisterAttemptAt = now;
    this.pushRegisterInFlight = true;

    try {
      const permission = Notification.permission === 'granted'
        ? 'granted'
        : await Notification.requestPermission();
      if (permission !== 'granted') return;

      const registration = await navigator.serviceWorker.ready;
      void registration.update().catch(() => undefined);

      const userKey = this.normalizeUser(user);
      const storedEndpointKey = this.pushEndpointStorageKey(userKey);
      const storedRegisteredAtKey = this.pushRegisteredAtStorageKey(userKey);
      const storedEndpoint = this.safeStorageGet(storedEndpointKey);
      const lastRegisteredAt = Number(this.safeStorageGet(storedRegisteredAtKey) || 0);

      let subscription = await registration.pushManager.getSubscription();
      const hasValidSubscriptionKeys = Boolean(
        subscription?.toJSON()?.keys?.['p256dh'] && subscription?.toJSON()?.keys?.['auth']
      );
      const shouldRefreshSubscription = !subscription || !hasValidSubscriptionKeys;
      if (shouldRefreshSubscription && subscription) {
        try {
          await subscription.unsubscribe();
        } catch {
          // Ignore unsubscribe failures and continue with subscribe attempt.
        }
        subscription = null;
      }

      if (!subscription) {
        subscription = await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: this.urlBase64ToUint8Array(this.api.vapidPublicKey)
        });
      }
      if (!subscription) return;

      const endpoint = String(subscription.endpoint || '');
      const endpointChanged = Boolean(endpoint && endpoint !== storedEndpoint);
      const refreshIntervalMs = this.isIosDevice()
        ? 60 * 60 * 1000
        : PUSH_REGISTER_REFRESH_MS;
      const registrationIsStale =
        !Number.isFinite(lastRegisteredAt) || now - lastRegisteredAt >= refreshIntervalMs;
      if (!force && !endpointChanged && !registrationIsStale) {
        return;
      }

      await this.api.registerDevice(userKey, subscription);
      this.safeStorageSet(storedEndpointKey, endpoint);
      this.safeStorageSet(storedRegisteredAtKey, String(now));
    } catch {
      // Registration is best-effort to keep setup responsive.
    } finally {
      this.pushRegisterInFlight = false;
    }
  };

  private getMessagePreview(message: ChatMessage): string {
    const forwardedPrefix = message.forwarded ? '↪ הועברה: ' : '';
    if (message.imageUrl) {
      const imagePreview = message.direction === 'outgoing' ? 'אתה: שלחת תמונה' : '📷 תמונה';
      return this.truncatePreview(`${forwardedPrefix}${imagePreview}`);
    }
    if (!message.body) {
      return '';
    }

    const trimmed = message.body.trim();
    const isDocumentLink = /^https?:\/\/\S+\.(pdf|doc|docx)(\?|$)/i.test(trimmed);
    if (isDocumentLink) {
      const documentPreview = message.direction === 'outgoing' ? 'אתה: מסמך' : 'מסמך';
      return this.truncatePreview(`${forwardedPrefix}${documentPreview}`);
    }

    const preview = message.direction === 'outgoing' ? `אתה: ${trimmed}` : trimmed;
    return this.truncatePreview(`${forwardedPrefix}${preview}`);
  }

  private truncatePreview(value: string, maxChars = 100): string {
    const compact = value.replace(/\s+/g, ' ').trim();
    if (compact.length <= maxChars) {
      return compact;
    }
    return `${compact.slice(0, maxChars)}…`;
  }

  private normalizeSendMessageOptions(options: SendMessageOptions = {}): SendMessageOptions {
    const replyTo = this.normalizeMessageReference(options.replyTo ?? null);
    const forwarded = Boolean(options.forwarded);
    const forwardedFrom = options.forwardedFrom ? this.normalizeUser(options.forwardedFrom) : '';
    const forwardedFromName = String(options.forwardedFromName || '').trim();
    return {
      replyTo,
      forwarded,
      forwardedFrom: forwardedFrom || null,
      forwardedFromName: forwardedFromName || null
    };
  }

  private normalizeMessageReference(rawValue: unknown): MessageReference | null {
    if (!rawValue || typeof rawValue !== 'object') {
      return null;
    }

    const value = rawValue as Partial<MessageReference>;
    const messageId = String(value.messageId || '').trim();
    const sender = this.normalizeUser(String(value.sender || ''));
    if (!messageId || !sender) {
      return null;
    }

    const senderDisplayName = String(value.senderDisplayName || '').trim();
    const body = typeof value.body === 'string' ? value.body : '';
    const imageUrl = typeof value.imageUrl === 'string' ? value.imageUrl.trim() : '';
    if (!body.trim() && !imageUrl) {
      return null;
    }

    return {
      messageId,
      sender,
      senderDisplayName: senderDisplayName || undefined,
      body,
      imageUrl: imageUrl || null
    };
  }

  private getDisplayName(username: string): string {
    const normalized = this.normalizeUser(username);
    const contact = this.contacts().find((item) => item.username === normalized);
    if (contact?.displayName) return contact.displayName;

    const group = this.groups().find((item) => item.id === normalized);
    if (group?.name) return group.name;

    return normalized;
  }

  private normalizeContacts(contacts: Contact[]): Contact[] {
    const seen = new Set<string>();
    return contacts
      .map((contact) => {
        const username = this.normalizeUser(contact.username);
        const parsedName = this.extractNameAndInfo(contact.displayName || '');
        const fallbackInfo = parsedName.info || undefined;
        return {
          username,
          displayName: (parsedName.name || username).trim(),
          info: contact.info?.trim() || fallbackInfo,
          phone: contact.phone?.trim() || undefined,
          upic: contact.upic?.trim() || undefined
        } satisfies Contact;
      })
      .filter((contact) => {
        if (!contact.username || seen.has(contact.username)) return false;
        seen.add(contact.username);
        return true;
      });
  }

  private extractNameAndInfo(value: string): { name: string; info?: string } {
    const source = String(value || '').trim();
    if (!source) {
      return { name: '' };
    }

    const infoParts: string[] = [];
    const withoutParentheses = source.replace(/\(([^()]*)\)/g, (_full, group: string) => {
      const cleanedGroup = String(group || '').replace(/\s+/g, ' ').trim();
      if (cleanedGroup) {
        infoParts.push(cleanedGroup);
      }
      return ' ';
    });

    return {
      name: withoutParentheses.replace(/\s+/g, ' ').trim(),
      info: infoParts.length ? infoParts.join(' | ') : undefined
    };
  }

  private normalizeGroups(groups: ChatGroup[], fallbackCreator: string): ChatGroup[] {
    const seen = new Set<string>();
    return groups
      .map((group): ChatGroup => {
        const type: GroupType = group.type === 'community' ? 'community' : 'group';
        return {
          id: this.normalizeChatId(group.id),
          name: group.name.trim(),
          members: Array.from(new Set(group.members.map((member) => this.normalizeUser(member)))),
          createdBy: this.normalizeUser(group.createdBy || fallbackCreator),
          updatedAt: Number(group.updatedAt || Date.now()),
          type
        };
      })
      .filter((group) => {
        if (!group.id || !group.name || seen.has(group.id)) return false;
        seen.add(group.id);
        return true;
      });
  }

  private normalizeChatId(value: string): string {
    return this.normalizeUser(value);
  }

  private isSystemChat(chatId: string): boolean {
    const normalized = this.normalizeChatId(chatId);
    return Boolean(normalized && this.systemChatIdSet.has(normalized));
  }

  private normalizeUser(value: string): string {
    return String(value || '').trim().toLowerCase();
  }

  private normalizePhone(value: string): string {
    const digits = String(value || '').replace(/\D/g, '');
    if (!/^0\d{9}$/.test(digits)) {
      return '';
    }
    return digits;
  }

  private removeLegacyStoredUser(): void {
    if (typeof localStorage === 'undefined') {
      return;
    }
    localStorage.removeItem('username');
  }

  private stateKey(user: string): string {
    return `modern-chat-state:${user}`;
  }

  private outboxKey(user: string): string {
    return `modern-chat-outbox:${user}`;
  }

  private restoreState(user: string): void {
    const raw = localStorage.getItem(this.stateKey(user));
    if (!raw) return;

    try {
      const parsed = JSON.parse(raw) as Partial<PersistedChatState>;
      const contacts = this.normalizeContacts(Array.isArray(parsed.contacts) ? parsed.contacts : []);
      const groups = this.normalizeGroups(Array.isArray(parsed.groups) ? parsed.groups : [], user);
      const groupsById = new Map(groups.map((group) => [group.id, group]));
      const unreadByChat = parsed.unreadByChat && typeof parsed.unreadByChat === 'object'
        ? parsed.unreadByChat
        : {};

      const messageMap: Record<string, ChatMessage[]> = {};
      for (const record of parsed.messages ?? []) {
        if (!record || !record.chatId) continue;
        const chatId = this.normalizeChatId(record.chatId);
        const normalizedGroupId = record.groupId ? this.normalizeChatId(record.groupId) : null;
        const normalizedGroupType: GroupType | null =
          record.groupType === 'group' || record.groupType === 'community'
            ? record.groupType
            : (normalizedGroupId ? (groupsById.get(normalizedGroupId)?.type ?? null) : null);
        const normalized: ChatMessage = {
          ...record,
          chatId,
          sender: this.normalizeUser(record.sender),
          messageId: String(record.messageId || this.generateId('msg')),
          body: String(record.body ?? ''),
          timestamp: Number(record.timestamp ?? Date.now()),
          direction: record.direction === 'incoming' ? 'incoming' : 'outgoing',
          deliveryStatus: record.deliveryStatus ?? 'sent',
          groupId: normalizedGroupId,
          editedAt: Number.isFinite(Number(record.editedAt)) ? Number(record.editedAt) : null,
          deletedAt: Number.isFinite(Number(record.deletedAt)) ? Number(record.deletedAt) : null,
          groupType: normalizedGroupType,
          replyTo: this.normalizeMessageReference(record.replyTo ?? null),
          forwarded: Boolean(record.forwarded),
          forwardedFrom: record.forwardedFrom ? this.normalizeUser(record.forwardedFrom) : null,
          forwardedFromName: String(record.forwardedFromName || '').trim() || null
        };

        if (!messageMap[chatId]) {
          messageMap[chatId] = [];
        }
        if (!messageMap[chatId].some((message) => message.messageId === normalized.messageId)) {
          messageMap[chatId].push(normalized);
        }
      }

      for (const list of Object.values(messageMap)) {
        list.sort((a, b) => a.timestamp - b.timestamp);
      }

      this.contacts.set(contacts);
      this.groups.set(groups);
      this.unreadByChat.set(unreadByChat);
      this.messagesByChat.set(messageMap);
    } catch {
      // Ignore corrupted persisted state and continue with empty runtime state.
    }
  }

  private schedulePersist(): void {
    if (this.incomingBatchDepth > 0) {
      this.pendingPersistAfterIncomingBatch = true;
      return;
    }
    this.schedulePersistNow();
  }

  private schedulePersistNow(): void {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
    }
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.persistState();
    }, 250);
  }

  private runIncomingBatch<T>(work: () => T): T {
    this.incomingBatchDepth += 1;
    try {
      return work();
    } finally {
      this.incomingBatchDepth -= 1;
      if (this.incomingBatchDepth === 0 && this.pendingPersistAfterIncomingBatch) {
        this.pendingPersistAfterIncomingBatch = false;
        this.schedulePersistNow();
      }
    }
  }

  private persistState(): void {
    const user = this.currentUser();
    if (!user) return;

    const flattened = Object.values(this.messagesByChat()).flat();
    flattened.sort((a, b) => a.timestamp - b.timestamp);
    const tail = flattened.slice(-MAX_PERSISTED_MESSAGES);

    const payload: PersistedChatState = {
      contacts: this.contacts(),
      groups: this.groups(),
      unreadByChat: this.unreadByChat(),
      messages: tail
    };

    localStorage.setItem(this.stateKey(user), JSON.stringify(payload));
  }

  private loadOutbox(user: string): OutboxItem[] {
    const raw = localStorage.getItem(this.outboxKey(user));
    if (!raw) return [];

    try {
      const parsed = JSON.parse(raw) as unknown;
      return Array.isArray(parsed) ? (parsed as OutboxItem[]) : [];
    } catch {
      return [];
    }
  }

  private saveOutbox(user: string, items: OutboxItem[]): void {
    localStorage.setItem(this.outboxKey(user), JSON.stringify(items));
  }

  private appendOutbox(user: string, item: OutboxItem): void {
    const current = this.loadOutbox(user);
    current.push(item);
    this.saveOutbox(user, current);
  }

  private generateId(prefix: string): string {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return `${prefix}_${crypto.randomUUID()}`;
    }
    return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  }

  private urlBase64ToUint8Array(base64String: string): Uint8Array<ArrayBuffer> {
    const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const rawData = window.atob(base64);
    const outputArray = new Uint8Array(new ArrayBuffer(rawData.length));
    for (let i = 0; i < rawData.length; i += 1) {
      outputArray[i] = rawData.charCodeAt(i);
    }
    return outputArray;
  }

  private handleOnline = (): void => {
    this.networkOnline.set(true);
    const user = this.currentUser();
    if (!user) return;
    this.clearDeviceAttention({ resetServerBadge: true });
    void this.tryRegisterPush(user, { force: true });
    this.connectRealtime(user);
    this.syncForegroundState({ forceRefresh: true });
  };

  private handleOffline = (): void => {
    this.networkOnline.set(false);
  };

  private isNetworkReachable(): boolean {
    if (this.networkOnline()) {
      return true;
    }
    if (typeof navigator !== 'undefined' && navigator.onLine) {
      // Recover from stale offline events where online never fires.
      this.networkOnline.set(true);
      return true;
    }
    return false;
  }

  private handleWindowFocus = (): void => {
    this.refreshPushRegistrationForCurrentUser(false);
    this.clearDeviceAttention({ resetServerBadge: true });
    this.syncForegroundState();
  };

  private handleVisibilityChange = (): void => {
    if (typeof document === 'undefined' || document.visibilityState !== 'visible') {
      return;
    }
    this.refreshPushRegistrationForCurrentUser(false);
    this.clearDeviceAttention({ resetServerBadge: true });
    this.syncForegroundState();
  };

  private handleServiceWorkerMessage = (event: MessageEvent<unknown>): void => {
    const currentUser = this.currentUser();
    if (!currentUser) return;

    const eventData = event.data;
    if (!eventData || typeof eventData !== 'object') return;

    const messageData = eventData as { action?: unknown; payload?: unknown; url?: unknown; chat?: unknown };
    const action = String(messageData.action ?? '').trim();
    if (action === 'notification-clicked') {
      this.clearDeviceAttention({ resetServerBadge: true });
      const clickedChatId = this.resolveNotificationChatId(messageData, currentUser);
      if (clickedChatId) {
        this.setActiveChat(clickedChatId);
      }
      this.syncForegroundState({ forceRefresh: true });
      return;
    }
    if (action !== 'push-payload') return;
    this.incrementDeliveryTelemetry('pushPayloadReceived');

    const payloadRaw = messageData.payload;
    if (!payloadRaw || typeof payloadRaw !== 'object') return;
    const payload = payloadRaw as Record<string, unknown>;

    const payloadUser = this.normalizeUser(String(payload['user'] ?? ''));
    if (payloadUser && payloadUser !== currentUser) return;

    const payloadType = String(payload['type'] ?? '').trim().toLowerCase();
    if (payloadType === 'subscription-auth-refresh') {
      this.refreshPushRegistrationForCurrentUser(true);
      this.syncForegroundState({ forceRefresh: true });
      return;
    }
    const numericGroupUpdatedAt = Number(payload['groupUpdatedAt']);
    const numericReadAt = Number(payload['readAt']);
    const payloadMessageIds = Array.isArray(payload['messageIds'])
      ? payload['messageIds'].map((id) => String(id || '').trim()).filter(Boolean)
      : String(payload['messageId'] ?? '')
          .split(',')
          .map((id) => String(id || '').trim())
          .filter(Boolean);

    const incoming: IncomingServerMessage = {
      type: payloadType,
      messageId: typeof payload['messageId'] === 'string' ? payload['messageId'] : undefined,
      messageIds: payloadMessageIds.length ? payloadMessageIds : undefined,
      readAt: Number.isFinite(numericReadAt) ? numericReadAt : undefined,
      sender: typeof payload['sender'] === 'string' ? payload['sender'] : undefined,
      targetMessageId:
        typeof payload['targetMessageId'] === 'string' ? payload['targetMessageId'] : undefined,
      emoji: typeof payload['emoji'] === 'string' ? payload['emoji'] : undefined,
      reactor: typeof payload['reactor'] === 'string' ? payload['reactor'] : undefined,
      reactorName: typeof payload['reactorName'] === 'string' ? payload['reactorName'] : undefined,
      groupId: typeof payload['groupId'] === 'string' ? payload['groupId'] : undefined,
      groupName: typeof payload['groupName'] === 'string' ? payload['groupName'] : undefined,
      groupMembers: Array.isArray(payload['groupMembers'])
        ? payload['groupMembers'].map((member) => String(member || '').trim()).filter(Boolean)
        : undefined,
      groupCreatedBy:
        typeof payload['groupCreatedBy'] === 'string' ? payload['groupCreatedBy'] : undefined,
      groupUpdatedAt: Number.isFinite(numericGroupUpdatedAt) ? numericGroupUpdatedAt : undefined,
      groupType: payload['groupType'] === 'community' ? 'community' : 'group'
    };

    if (payloadType !== 'reaction' && payloadType !== 'group-update' && payloadType !== 'read-receipt') {
      const immediateMessage = this.buildIncomingMessageFromPushPayload(payload, incoming);
      if (immediateMessage) {
        this.incrementDeliveryTelemetry('pushImmediateMessageBuilt');
        if (this.applyIncomingMessage(immediateMessage)) {
          this.incrementDeliveryTelemetry('pushMessageApplied');
        } else {
          this.incrementDeliveryTelemetry('pushMessageNoop');
        }
      } else {
        this.incrementDeliveryTelemetry('pushMissingMessageContext');
      }
      // For regular pushes, recover with immediate + delayed pulls so chat list stays fresh.
      this.syncForegroundState({ forceRefresh: true });
      this.schedulePushRecoveryPulls();
      return;
    }

    if (this.applyIncomingMessage(incoming)) {
      this.incrementDeliveryTelemetry('pushMessageApplied');
    } else {
      this.incrementDeliveryTelemetry('pushMessageNoop');
    }
  };

  private buildIncomingMessageFromPushPayload(
    payload: Record<string, unknown>,
    seed: IncomingServerMessage
  ): IncomingServerMessage | null {
    const sender = this.normalizeUser(String(payload['sender'] ?? seed.sender ?? '').trim());
    const groupId = String(payload['groupId'] ?? seed.groupId ?? '').trim();
    const messageId = String(payload['messageId'] ?? seed.messageId ?? '').trim();
    if (!messageId || (!sender && !groupId)) {
      return null;
    }

    const bodyFromPayload = this.normalizeIncomingBodyValue(
      payload['messageText'] ??
      payload['groupMessageText'] ??
      payload['longText'] ??
      payload['shortText'] ??
      payload['text'] ??
      payload['message'] ??
      payload['reply'] ??
      payload['body'] ??
      ''
    );
    const imageUrl = this.normalizeIncomingImageValue(
      payload['image'] ??
      payload['imageUrl'] ??
      payload['thumbnailUrl'] ??
      null
    );
    const incoming: IncomingServerMessage = {
      ...seed,
      messageId,
      sender: sender || (groupId ? groupId : ''),
      body: bodyFromPayload,
      imageUrl
    };
    if (groupId) {
      incoming.groupId = groupId;
      incoming.groupName = String(payload['groupName'] ?? seed.groupName ?? '').trim() || groupId;
      incoming.groupType = payload['groupType'] === 'community' ? 'community' : (seed.groupType ?? 'group');
    }
    return incoming;
  }

  private schedulePushRecoveryPulls(): void {
    const user = this.currentUser();
    if (!user) return;
    this.incrementDeliveryTelemetry('pushRecoveryPullScheduled', PUSH_RECOVERY_PULL_DELAYS_MS.length);
    for (const delayMs of PUSH_RECOVERY_PULL_DELAYS_MS) {
      setTimeout(() => {
        if (this.currentUser() !== user) return;
        if (!this.isNetworkReachable()) return;
        void this.pullMessages(user);
      }, delayMs);
    }
  }

  private resolveNotificationChatId(
    messageData: { url?: unknown; chat?: unknown; payload?: unknown },
    currentUser: string
  ): string | null {
    const candidates: string[] = [];

    if (typeof messageData.chat === 'string' && messageData.chat.trim()) {
      candidates.push(messageData.chat.trim());
    }

    if (typeof messageData.url === 'string' && messageData.url.trim()) {
      try {
        const parsed = new URL(
          messageData.url.trim(),
          typeof window !== 'undefined' ? window.location.origin : 'https://www.tzmc.co.il'
        );
        const chatFromUrl = String(parsed.searchParams.get('chat') || '').trim();
        if (chatFromUrl) {
          candidates.push(chatFromUrl);
        }
      } catch {
        // Ignore malformed route URLs from external notifications.
      }
    }

    const payload = messageData.payload && typeof messageData.payload === 'object'
      ? (messageData.payload as Record<string, unknown>)
      : null;
    if (payload) {
      ['chat', 'groupId', 'sender'].forEach((key) => {
        const value = payload[key];
        if (typeof value === 'string' && value.trim()) {
          candidates.push(value.trim());
        }
      });
    }

    for (const candidate of candidates) {
      const normalized = this.normalizeChatId(candidate);
      if (!normalized) continue;
      if (normalized === currentUser) continue;
      return normalized;
    }
    return null;
  }

  private syncForegroundState(options: { forceRefresh?: boolean } = {}): void {
    const user = this.currentUser();
    if (!user || !this.isNetworkReachable()) return;

    const forceRefresh = Boolean(options.forceRefresh);
    const now = Date.now();
    if (!forceRefresh && now - this.lastForegroundSyncAt < FOREGROUND_SYNC_MIN_INTERVAL_MS) {
      return;
    }
    this.lastForegroundSyncAt = now;

    void this.pullMessages(user);
    void this.flushOutbox();
    void this.refresh(forceRefresh);
  }

  private syncAppBadge(unreadTotal: number): void {
    if (typeof navigator === 'undefined') return;

    if (this.isAppInForeground()) {
      this.clearDeviceAttention();
      return;
    }

    const normalizedUnread = Math.max(0, Math.floor(Number(unreadTotal) || 0));
    if (this.lastAppliedAppBadgeCount === normalizedUnread) {
      return;
    }
    this.lastAppliedAppBadgeCount = normalizedUnread;

    const badgeNavigator = navigator as BadgeCapableNavigator;
    if (normalizedUnread > 0) {
      if (typeof badgeNavigator.setAppBadge === 'function') {
        void badgeNavigator.setAppBadge(normalizedUnread).catch(() => undefined);
        return;
      }
      this.postBadgeMessageToServiceWorker({ action: 'set-app-badge-count', count: normalizedUnread });
      return;
    }

    if (typeof badgeNavigator.clearAppBadge === 'function') {
      void badgeNavigator.clearAppBadge().catch(() => undefined);
      return;
    }
    if (typeof badgeNavigator.setAppBadge === 'function') {
      void badgeNavigator.setAppBadge(0).catch(() => undefined);
      return;
    }
    this.postBadgeMessageToServiceWorker({ action: 'clear-app-badge' });
  }

  private isAppInForeground(): boolean {
    if (typeof document === 'undefined') return false;
    return document.visibilityState === 'visible';
  }

  private clearDeviceAttention(options: { resetServerBadge?: boolean } = {}): void {
    if (typeof navigator === 'undefined') return;

    const badgeNavigator = navigator as BadgeCapableNavigator;
    if (typeof badgeNavigator.clearAppBadge === 'function') {
      void badgeNavigator.clearAppBadge().catch(() => undefined);
    } else if (typeof badgeNavigator.setAppBadge === 'function') {
      void badgeNavigator.setAppBadge(0).catch(() => undefined);
    }
    this.postBadgeMessageToServiceWorker({ action: 'clear-device-attention' });

    if (!options.resetServerBadge) {
      return;
    }

    const user = this.currentUser();
    if (!user || !this.networkOnline()) {
      return;
    }
    const now = Date.now();
    if (now - this.lastServerBadgeResetAt < BADGE_RESET_MIN_INTERVAL_MS) {
      return;
    }
    this.lastServerBadgeResetAt = now;
    void this.api.resetServerBadge(user).catch(() => undefined);
  }

  private postBadgeMessageToServiceWorker(message: BadgeMessage): void {
    if (!('serviceWorker' in navigator)) return;

    void navigator.serviceWorker.ready
      .then((registration) => {
        const activeWorker = registration.active ?? navigator.serviceWorker.controller;
        activeWorker?.postMessage(message);
      })
      .catch(() => undefined);
  }

  private refreshPushRegistrationForCurrentUser(force: boolean): void {
    const user = this.currentUser();
    if (!user) return;
    void this.tryRegisterPush(user, { force });
  }

  private pushEndpointStorageKey(user: string): string {
    return `modern-chat-push-endpoint:${this.normalizeUser(user)}`;
  }

  private pushRegisteredAtStorageKey(user: string): string {
    return `modern-chat-push-registered-at:${this.normalizeUser(user)}`;
  }

  private isIosDevice(): boolean {
    if (typeof navigator === 'undefined') return false;
    return /iP(hone|ad|od)/i.test(navigator.userAgent);
  }

  private safeStorageGet(key: string): string {
    try {
      return localStorage.getItem(key) ?? '';
    } catch {
      return '';
    }
  }

  private safeStorageSet(key: string, value: string): void {
    try {
      localStorage.setItem(key, value);
    } catch {
      // Ignore storage persistence issues on constrained/private browsers.
    }
  }
}
