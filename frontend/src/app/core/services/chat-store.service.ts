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
  ReactionPayload,
  ReplyPayload,
  TypingPayload
} from '../models/chat.models';
import {
  ChatApiService,
  HrActionOption,
  HrStepOption,
  RealtimeSocket,
  ShuttleUserOrderPayload,
  UserPushSubscriptionPayload
} from './chat-api.service';

const CONTACTS_TTL_MS = 5 * 60 * 1000;
const CONTACTS_ACCESS_SYNC_INTERVAL_MS = 60 * 1000;
const GROUPS_TTL_MS = 2 * 60 * 1000;
const POLL_INTERVAL_MS = 15000;
const STREAM_RETRY_MS = 5000;
const SOCKET_RETRY_MS = 3500;
const SOCKET_FALLBACK_TO_SSE_DELAY_MS = 1800;
const SOCKET_ACK_TIMEOUT_MS = 6000;
const SOCKET_MAX_FAILURES_BEFORE_COOLDOWN = 3;
const SOCKET_FAILURE_COOLDOWN_MS = 5 * 60 * 1000;
const MAX_PERSISTED_MESSAGES = 2500;
const PUSH_REGISTER_MIN_INTERVAL_MS = 30000;
const PUSH_REGISTER_REFRESH_MS = 6 * 60 * 60 * 1000;
const FOREGROUND_SYNC_MIN_INTERVAL_MS = 4000;
const BADGE_RESET_MIN_INTERVAL_MS = 30000;
const PUSH_RECOVERY_PULL_DELAYS_MS = [1200, 3600];
const LOGS_RECOVERY_MIN_INTERVAL_MS = 2 * 60 * 1000;
const LOGS_RECOVERY_MAX_FETCH_LIMIT = 1000;
const LOGS_RECOVERY_FULL_SYNC_FETCH_LIMIT = 200000;
const DELIVERY_TELEMETRY_FLUSH_INTERVAL_MS = 60 * 1000;
const DELIVERY_TELEMETRY_FLUSH_MIN_EVENTS = 4;
const DELIVERY_TELEMETRY_DEVICE_ID_KEY = 'modern-chat-delivery-device-id';
const HR_CHAT_NAME = 'ציפי';
const SHUTTLE_CHAT_NAME = 'הזמנת הסעה';
const SHUTTLE_CHAT_TITLE = 'הזמנת הסעה / Заказ шаттла';
const SHUTTLE_OPERATIONS_CHAT_NAME = 'הסעות';
const HR_WELCOME_KEY_PREFIX = 'hr_welcome_sent_';
const HR_STATE_KEY_PREFIX = 'hr_state_';
const HR_UPLOAD_BASE_URL = '/notify/uploads/';
const HR_STEPS_CACHE_TTL_MS = 5 * 60 * 1000;
const HR_ACTIONS_CACHE_TTL_MS = 5 * 60 * 1000;
const SHUTTLE_WELCOME_KEY_PREFIX = 'shuttle_welcome_sent_';
const SHUTTLE_STATE_KEY_PREFIX = 'shuttle_state_';
const SHUTTLE_ORDERS_KEY_PREFIX = 'shuttle_orders_';
const SHUTTLE_LANGUAGE_KEY_PREFIX = 'shuttle_language_';
const SHUTTLE_LIST_CACHE_TTL_MS = 5 * 60 * 1000;
const SHUTTLE_REMOTE_ORDERS_SYNC_TTL_MS = 45 * 1000;
const SHUTTLE_DATE_CHOICES_COUNT = 10;
const SHUTTLE_REMINDER_LEAD_MS = 2 * 60 * 60 * 1000;
const SHUTTLE_REMINDER_HISTORY_KEY_PREFIX = 'shuttle_reminder_2h_sent_';
const SHUTTLE_REMINDER_HISTORY_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const SHUTTLE_STATUS_ACTIVE_VALUE = 'פעיל активный';
const SHUTTLE_STATUS_CANCEL_VALUE = 'ביטול נסיעה отмена поезд';
const DOVRUT_GROUP_NAME = 'דוברות';
const DOVRUT_GROUP_ID = DOVRUT_GROUP_NAME;
const DOVRUT_TEST_GROUP_NAME = 'בדיקה - דוברות';
const DOVRUT_TEST_GROUP_ID = DOVRUT_TEST_GROUP_NAME;
const DOVRUT_SYSTEM_CREATOR = 'dovrut-system';
const DOVRUT_ALLOWED_WRITERS = ['0506501040', '0506267447', '0543108095'] as const;
const DOVRUT_TEST_ALLOWED_WRITERS = ['0546799693'] as const;
const DOVRUT_TEST_GROUP_MEMBERS = ['0546799693', '0550000001', '0547997273', '0505203520'] as const;
const SHUTTLE_OPERATIONS_GROUP_MEMBERS = ['0546799693', '0550000001', '0506267410', '0505203520'] as const;
const BADGE_RESET_ALL_ALLOWED_USERS = ['0546799693'] as const;
interface HardcodedCommunityGroupConfig {
  id: string;
  name: string;
  staticMembers?: readonly string[];
  allowedWriters: readonly string[];
}
const HARDCODED_COMMUNITY_GROUPS: readonly HardcodedCommunityGroupConfig[] = [
  {
    id: DOVRUT_GROUP_ID,
    name: DOVRUT_GROUP_NAME,
    allowedWriters: DOVRUT_ALLOWED_WRITERS
  },
  {
    id: DOVRUT_TEST_GROUP_ID,
    name: DOVRUT_TEST_GROUP_NAME,
    staticMembers: DOVRUT_TEST_GROUP_MEMBERS,
    allowedWriters: DOVRUT_TEST_ALLOWED_WRITERS
  }
];
const SHUTTLE_DAY_NAMES_BY_LANGUAGE: Record<ShuttleLanguage, readonly string[]> = {
  he: ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'] as const,
  ru: ['Воскресенье', 'Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота'] as const
};
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
const TYPING_IDLE_MS = 2200;
const TYPING_HEARTBEAT_MS = 1200;
const TYPING_STALE_MS = 6500;
const INCOMING_SEMANTIC_DEDUP_TIMESTAMP_TOLERANCE_MS = 2000;
const INCOMING_SYSTEM_SEMANTIC_DEDUP_TIMESTAMP_TOLERANCE_MS = 90 * 1000;
const DELETED_MESSAGE_SUPPRESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DELETED_MESSAGE_SUPPRESSION_MAX_ENTRIES = 2500;
const DELETED_MESSAGE_SUPPRESSION_TIMESTAMP_TOLERANCE_MS = 2 * 60 * 1000;

type HrAwaitingState = 'step' | 'action' | 'free-text';

interface HrConversationState {
  awaiting: HrAwaitingState;
  stepId: string | null;
  actions: HrActionOption[];
}

type ShuttleAwaitingState = 'menu' | 'date' | 'shift' | 'station' | 'cancel-select';
export type ShuttleLanguage = 'he' | 'ru';

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

export interface ShuttleOperationsOrderRecord extends ShuttleOrderRecord {
  sourceUser: string;
  sourceDisplayName: string;
  sourceOrderId: string;
  compositeId: string;
  canCancel: boolean;
}

export interface ShuttleOperationsDateGroup {
  date: string;
  dayName: string;
  orderCount: number;
  orders: ShuttleOperationsOrderRecord[];
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

interface DeletedIncomingMessageFingerprint {
  chatId: string;
  sender: string;
  body: string;
  imageUrl: string;
  timestamp: number;
  deletedAt: number;
}

interface SendMessageOptions {
  replyTo?: MessageReference | null;
  forwarded?: boolean;
  forwardedFrom?: string | null;
  forwardedFromName?: string | null;
  hrFlowInput?: string | null;
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

type BadgeCapableServiceWorkerRegistration = ServiceWorkerRegistration & {
  setAppBadge?: (count?: number) => Promise<void>;
  clearAppBadge?: () => Promise<void>;
  setBadge?: (count?: number) => Promise<void>;
  clearBadge?: () => Promise<void>;
};

type BadgeMessage =
  | { action: 'set-app-badge-count'; count: number }
  | { action: 'clear-app-badge' }
  | { action: 'clear-device-attention' }
  | { action: 'flush-offline-replies' };

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
  submitValue?: string;
  disabled?: boolean;
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

export type RealtimeTransportMode = 'socket' | 'sse' | 'polling';

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
  readonly shuttleAccessAllowed = signal(true);
  readonly realtimeTransportMode = signal<RealtimeTransportMode>('polling');
  readonly realtimeTransportLabel = computed(() => {
    const mode = this.realtimeTransportMode();
    if (mode === 'socket') return 'Socket';
    if (mode === 'sse') return 'SSE';
    return 'Polling';
  });
  readonly typingUsersByChat = signal<Record<string, string[]>>({});
  readonly activeTypingLabel = computed<string | null>(() => {
    const activeChatId = this.activeChatId();
    if (!activeChatId) return null;
    const typingUsers = this.typingUsersByChat()[activeChatId] ?? [];
    const currentUser = this.normalizeUser(this.currentUser() ?? '');
    const filteredUsers = typingUsers.filter((user) => user && user !== currentUser);
    if (!filteredUsers.length) {
      return null;
    }
    if (filteredUsers.length === 1) {
      return `${this.getDisplayName(filteredUsers[0])} מקליד...`;
    }
    return `${filteredUsers.length} משתמשים מקלידים...`;
  });

  private readonly messagesByChat = signal<Record<string, ChatMessage[]>>({});
  private socket: RealtimeSocket | null = null;
  private socketConnected = false;
  private socketConnecting = false;
  private stream: EventSource | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private contactsAccessSyncTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private socketReconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private socketSseFallbackTimer: ReturnType<typeof setTimeout> | null = null;
  private shuttingDownRealtime = false;
  private socketConsecutiveFailures = 0;
  private socketDisabledUntil = 0;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private typingStopTimer: ReturnType<typeof setTimeout> | null = null;
  private typingStateChatId: string | null = null;
  private typingStateActive = false;
  private typingLastSentAt = 0;
  private readonly typingCleanupTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private pullInFlight = false;
  private initializedUser: string | null = null;
  private lastContactsFetchAt = 0;
  private lastGroupsFetchAt = 0;
  private hrStepsCache: { at: number; steps: HrStepOption[] } = { at: 0, steps: [] };
  private hrActionsCache: Record<string, { at: number; actions: HrActionOption[] }> = {};
  private hrInitInFlight = false;
  private readonly hrStateRevision = signal(0);
  private shuttleInitInFlight = false;
  private shuttleStationsCache: { at: number; items: string[] } = { at: 0, items: [] };
  private shuttleEmployeesCache: { at: number; items: string[] } = { at: 0, items: [] };
  private shuttleOperationsInitInFlight = false;
  private readonly shuttleOperationsOrders = signal<ShuttleOperationsOrderRecord[]>([]);
  private readonly shuttleOperationsOrdersLoading = signal(false);
  private shuttleOperationsLastSyncedAt = 0;
  private shuttleOperationsSyncPromise: Promise<void> | null = null;
  private readonly shuttleOrdersSyncAt = new Map<string, number>();
  private readonly shuttleOrdersSyncInFlight = new Set<string>();
  private readonly shuttleOrdersSyncPromiseByUser = new Map<string, Promise<void>>();
  private readonly shuttleReminderTimersByKey = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly shuttlePickerRevision = signal(0);
  private lastAppliedAppBadgeCount = -1;
  private lastServerBadgeResetAt = 0;
  private serverBadgeResetInFlight = false;
  private lastForegroundSyncAt = 0;
  private logsRecoveryInFlight = false;
  private lastLogsRecoveryAt = 0;
  private readonly readReceiptSentByChat = new Map<string, Set<string>>();
  private readonly pendingReadReceiptByChat = new Map<string, Set<string>>();
  private readonly readReceiptFlushTimerByChat = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly readReceiptFlushInFlightByChat = new Set<string>();
  private readonly deletedMessageIdTombstones = new Map<string, number>();
  private deletedIncomingFingerprints: DeletedIncomingMessageFingerprint[] = [];
  private pushRegisterInFlight = false;
  private lastPushRegisterAttemptAt = 0;
  private contactsAccessSyncInFlight = false;
  private authBootstrapPromise: Promise<void> | null = null;
  private deliveryTelemetryFlushTimer: ReturnType<typeof setInterval> | null = null;
  private deliveryTelemetryInFlight = false;
  private deliveryTelemetryLastFlushedAt = 0;
  private deliveryTelemetryDeviceId = '';
  private deliveryTelemetryCounters: DeliveryTelemetryCounters = this.createEmptyDeliveryTelemetryCounters();
  private pendingServiceWorkerMessages: Array<{
    action?: unknown;
    payload?: unknown;
    url?: unknown;
    chat?: unknown;
  }> = [];
  private pendingPushDrainInFlight = false;
  private readonly systemChatIdSet = new Set<string>(
    SYSTEM_CHAT_IDS.map((id) => this.normalizeChatId(id)).filter(Boolean)
  );
  private readonly shuttleChatIdSet = new Set<string>(
    [SHUTTLE_CHAT_NAME, SHUTTLE_CHAT_TITLE].map((id) => this.normalizeChatId(id)).filter(Boolean)
  );
  private readonly communityWriterSetByGroupId = new Map<string, Set<string>>(
    HARDCODED_COMMUNITY_GROUPS.map((group) => [
      this.normalizeChatId(group.id),
      new Set(group.allowedWriters.map((value) => this.normalizeUser(value)).filter(Boolean))
    ])
  );
  private readonly dovrutWriterSet = new Set<string>(
    HARDCODED_COMMUNITY_GROUPS
      .flatMap((group) => group.allowedWriters)
      .map((value) => this.normalizeUser(value))
      .filter(Boolean)
  );
  private readonly badgeResetAllAdminUsersSet = new Set<string>(
    BADGE_RESET_ALL_ALLOWED_USERS.map((value) => this.normalizeUser(value)).filter(Boolean)
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
    const canAccessShuttle = this.shuttleAccessAllowed();
    for (const systemId of this.systemChatIdSet) {
      if (this.isShuttleChat(systemId) && !canAccessShuttle) {
        continue;
      }
      chatIds.add(systemId);
    }
    const items: ChatListItem[] = [];

    for (const chatId of chatIds) {
      const group = groupsById.get(chatId);
      const contact = contactsById.get(chatId);
      const messages = messageMap[chatId] ?? [];
      const lastMessage = messages[messages.length - 1];
      const isShuttle = this.isShuttleChat(chatId);
      if (isShuttle && !canAccessShuttle) {
        continue;
      }

      const title = group?.name ?? contact?.displayName ?? (isShuttle ? SHUTTLE_CHAT_TITLE : chatId);
      const subtitle = lastMessage ? this.getMessagePreview(lastMessage) : (group ? 'אין הודעות בקבוצה' : '');
      const lastTimestamp = lastMessage?.timestamp ?? 0;
      const unread = unreadMap[chatId] ?? 0;
      const pinned = this.isSystemChat(chatId) || this.isDovrutGroup(chatId);

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
      const aIsDovrut = this.isDovrutGroup(a.id);
      const bIsDovrut = this.isDovrutGroup(b.id);
      if (aIsDovrut && !bIsDovrut) return -1;
      if (!aIsDovrut && bIsDovrut) return 1;
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
    if (group.type !== 'community' && !this.isDovrutGroup(group.id)) return true;
    return this.canUserSendToCommunityGroup(group, this.currentUser());
  });

  private readonly appBadgeSyncEffect = effect(() => {
    const unreadMap = this.unreadByChat();
    const unreadTotal = Object.values(unreadMap).reduce((sum, count) => sum + (Number(count) || 0), 0);
    this.syncAppBadge(unreadTotal);
  });

  private readonly dovrutGroupSyncEffect = effect(() => {
    const user = this.currentUser();
    if (!user) return;
    const contacts = this.contacts();
    const groups = this.groups();
    this.syncHardcodedCommunityGroups(contacts, groups);
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
    this.clearHomeScreenBadgeOnAppOpen();
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
      this.rescheduleShuttleRemindersForUser(user);
    } catch {
      this.currentUser.set(null);
    }
  }

  async initialize(): Promise<void> {
    await this.ensureSessionReady();
    const user = this.currentUser();
    if (!user) return;

    // If already initialized for this user, just check for new background payloads
    if (this.initializedUser === user) {
      this.flushPendingServiceWorkerMessages();
      await this.consumePendingPushPayloadsFromServiceWorker();
      this.schedulePendingPushDrainRetry();
      return;
    }

    this.initializedUser = user;
    this.flushPendingServiceWorkerMessages();

    /**
     * SYNC STEP 1: Drain Service Worker Cache
     * Pulls messages that the Service Worker managed to catch while the app was closed.
     */
    await this.consumePendingPushPayloadsFromServiceWorker();
    this.schedulePendingPushDrainRetry();

    /**
     * SYNC STEP 2: Aggressive Logs Recovery (The Fix)
     * This fills any gaps that the Service Worker missed (e.g., if the phone was offline 
     * or the OS killed the SW). We use 'force: true' to bypass the standard recovery cooldown.
     */
    void this.recoverMissedMessagesFromLogs(user, {
      force: true,           // Ensures we sync every time the app starts
      incrementUnread: true, // Marks missed messages as unread so they appear in badges
      limit: 1000            // Window large enough to cover several hours of activity
    }).catch(() => undefined);

    // Continue with standard initialization
    await this.refreshShuttleAccessForCurrentUser(user, { force: true });

    // Open quickly from cached/local state only.
    this.applyInitialChatSelection(user);

    this.connectRealtime(user);
    this.startDeliveryTelemetry(user);
    this.startBackgroundContactsAccessSync(user);
    this.runInitializeBackgroundTasks(user);
  }

  private applyInitialChatSelection(user: string): void {
    const currentActive = this.activeChatId();
    if (currentActive && this.chatItems().some((chat) => chat.id === currentActive)) {
      return;
    }

    if (this.shouldOpenHomeOnInit(user)) {
      this.activeChatId.set(null);
      this.lastActivatedChatMeta.set(null);
      return;
    }

    const storedActive = this.getStoredActiveChat(user);
    if (storedActive && this.chatItems().some((chat) => chat.id === storedActive)) {
      this.setActiveChat(storedActive);
      return;
    }

    if (!this.activeChatId()) {
      const preferredChat = this.pickInitialChatId();
      if (preferredChat) {
        this.setActiveChat(preferredChat);
      }
    }
  }

  private runInitializeBackgroundTasks(user: string): void {
    if (this.currentUser() !== user) {
      return;
    }

    this.clearDeviceAttention({ resetServerBadge: true });
    // Recover silently if a device lost its push subscription.
    void this.ensurePushRegistrationHealth(user, {
      forceRegister: true,
      promptIfNeeded: false,
      requireStandaloneOnMobile: true
    }).catch(() => undefined);
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

  requiresHomeScreenInstallForPush(): boolean {
    return this.shouldRequireStandaloneInstallForPush() && !this.isRunningStandaloneApp();
  }

  async ensurePushRegistrationReadyForCurrentUser(options: { promptIfNeeded?: boolean } = {}): Promise<void> {
    const user = this.currentUser();
    if (!user) {
      throw new Error('יש להתחבר מחדש לפני השלמת רישום התראות');
    }
    await this.ensurePushRegistrationHealth(user, {
      forceRegister: true,
      promptIfNeeded: options.promptIfNeeded !== false,
      requireStandaloneOnMobile: true
    });
  }

  private async applyAuthenticatedSessionUser(user: string): Promise<void> {
    this.stopRealtime();
    this.stopBackgroundContactsAccessSync();
    void this.flushDeliveryTelemetry({ force: true, includeZero: false });
    this.stopDeliveryTelemetry();

    const previousUser = this.currentUser();
    if (previousUser) {
      this.clearShuttleReminderTimersForUser(previousUser);
    }

    this.currentUser.set(user);
    this.initializedUser = null;
    this.clearDeletedMessageSuppressions();
    this.contacts.set([]);
    this.groups.set([]);
    this.messagesByChat.set({});
    this.unreadByChat.set({});
    this.shuttleAccessAllowed.set(true);
    this.shuttleOperationsOrders.set([]);
    this.shuttleOperationsOrdersLoading.set(false);
    this.shuttleOperationsLastSyncedAt = 0;
    this.shuttleOperationsSyncPromise = null;
    this.resetReadReceiptTrackingState();
    this.activeChatId.set(null);
    this.lastError.set(null);

    this.restoreState(user);
    this.rescheduleShuttleRemindersForUser(user);
    try {
      await this.ensurePushRegistrationHealth(user, {
        forceRegister: true,
        promptIfNeeded: false,
        requireStandaloneOnMobile: true
      });
    } catch {
      // Keep login resilient; strict completion is enforced in setup flow.
    }
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
      this.clearShuttleReminderTimersForUser(user);
      localStorage.removeItem(this.activeChatKey(user));
      localStorage.removeItem(this.homeViewKey(user));
    }
    this.currentUser.set(null);
    this.clearDeletedMessageSuppressions();
    this.contacts.set([]);
    this.groups.set([]);
    this.messagesByChat.set({});
    this.unreadByChat.set({});
    this.shuttleAccessAllowed.set(true);
    this.shuttleOperationsOrders.set([]);
    this.shuttleOperationsOrdersLoading.set(false);
    this.shuttleOperationsLastSyncedAt = 0;
    this.shuttleOperationsSyncPromise = null;
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

    await this.refreshShuttleAccessForCurrentUser(user, { force });

    this.loading.set(false);
    this.schedulePersist();
  }

  async preloadLatestMessagesBeforeCacheCleanup(): Promise<void> {
    // Intentionally no-op: message sync must stay manual-only.
  }

  setActiveChat(chatId: string | null): void {
    const previousActiveChat = this.activeChatId();
    if (previousActiveChat && previousActiveChat !== this.normalizeChatId(chatId ?? '')) {
      this.cancelTypingForActiveChat();
    }
    if (!chatId) {
      this.activeChatId.set(null);
      this.lastActivatedChatMeta.set(null);
      return;
    }

    const normalized = this.normalizeChatId(chatId);
    if (this.isShuttleChat(normalized) && !this.shuttleAccessAllowed()) {
      return;
    }
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
    this.cancelTypingForActiveChat();
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
      admins: [user],
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
      groupAdmins: group.admins ?? [],
      actorUser: user,
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
    const adminUsers = this.getGroupAdminList(group);
    if (!adminUsers.includes(normalizedUser)) {
      throw new Error('רק מנהל קבוצה יכול לעדכן משתתפים');
    }

    const normalizedNextMembers = Array.from(
      new Set(nextMembers.map((member) => this.normalizeUser(member)).filter(Boolean))
    );
    adminUsers.forEach((adminUser) => {
      if (!normalizedNextMembers.includes(adminUser)) {
        normalizedNextMembers.unshift(adminUser);
      }
    });
    if (!normalizedNextMembers.includes(normalizedUser)) {
      normalizedNextMembers.unshift(normalizedUser);
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
      groupAdmins: updatedGroup.admins ?? [],
      actorUser: normalizedUser,
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

  async updateGroupTitle(groupId: string, nextTitle: string): Promise<void> {
    const user = this.currentUser();
    if (!user) {
      throw new Error('יש להתחבר לפני עדכון שם קבוצה');
    }

    const normalizedGroupId = this.normalizeChatId(groupId);
    const group = this.groups().find((item) => item.id === normalizedGroupId);
    if (!group) {
      throw new Error('הקבוצה לא נמצאה');
    }

    const normalizedUser = this.normalizeUser(user);
    if (!this.canUserManageGroup(group, normalizedUser)) {
      throw new Error('רק מנהלי קבוצה יכולים לעדכן שם קבוצה');
    }

    const title = String(nextTitle || '').trim();
    if (title.length < 2) {
      throw new Error('יש להזין שם קבוצה תקין');
    }

    if (title === group.name) {
      return;
    }

    const updatedGroup: ChatGroup = {
      ...group,
      name: title,
      updatedAt: Date.now()
    };

    this.groups.update((groups) =>
      groups.map((item) => (item.id === updatedGroup.id ? updatedGroup : item))
    );
    this.schedulePersist();

    const membersToNotify = Array.from(
      new Set(updatedGroup.members.map((member) => this.normalizeUser(member)).filter(Boolean))
    ).filter((member) => member && member !== normalizedUser);
    if (!membersToNotify.length) return;

    const groupUpdatePayload: GroupUpdatePayload = {
      groupId: updatedGroup.id,
      groupName: updatedGroup.name,
      groupMembers: updatedGroup.members,
      groupCreatedBy: updatedGroup.createdBy,
      groupAdmins: updatedGroup.admins ?? [],
      actorUser: normalizedUser,
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
    if (this.isShuttleOperationsRoomChat(normalizedChatId)) {
      return false;
    }
    if (this.isShuttleChat(normalizedChatId) && !this.shuttleAccessAllowed()) {
      return false;
    }
    const group = this.groups().find((item) => item.id === normalizedChatId);
    if (!group) return true;
    if (group.type !== 'community' && !this.isDovrutGroup(group.id)) return true;
    return this.canUserSendToCommunityGroup(group, this.currentUser());
  }

  isDovrutGroupChat(chatId: string | null | undefined): boolean {
    return this.isDovrutGroup(String(chatId || ''));
  }

  isDovrutAdminUser(user: string | null | undefined): boolean {
    const normalizedUser = this.normalizeUser(String(user || '').trim());
    if (!normalizedUser) return false;
    return this.dovrutWriterSet.has(normalizedUser);
  }

  canCurrentUserResetAllBadges(): boolean {
    const normalizedUser = this.normalizeUser(this.currentUser() ?? '');
    if (!normalizedUser) return false;
    return this.badgeResetAllAdminUsersSet.has(normalizedUser);
  }

  async resetAllServerBadgesForAdmin(): Promise<number> {
    const user = this.currentUser();
    if (!user) {
      throw new Error('יש להתחבר לפני איפוס מונים');
    }
    if (!this.canCurrentUserResetAllBadges()) {
      throw new Error('אין הרשאה לאיפוס כל המונים');
    }
    if (!this.networkOnline()) {
      throw new Error('אין חיבור לרשת');
    }

    const result = await this.api.resetAllServerBadges(user);
    this.unreadByChat.set({});
    this.lastServerBadgeResetAt = Date.now();
    this.clearDeviceAttention();
    this.schedulePersist();
    return result.clearedKeys;
  }

  getHrComposerActionsForActiveChat(): {
    canGoBack: boolean;
    hasOpenSession: boolean;
    canWriteMessage: boolean;
  } | null {
    this.hrStateRevision();
    const user = this.currentUser();
    const activeChatId = this.activeChatId();
    if (!user || !this.isHrChat(activeChatId)) {
      return null;
    }
    const state = this.loadHrState(user);
    if (!state) {
      return {
        canGoBack: false,
        hasOpenSession: false,
        canWriteMessage: false
      };
    }
    return {
      canGoBack: state.awaiting !== 'step',
      hasOpenSession: true,
      canWriteMessage: state.awaiting === 'free-text'
    };
  }

  isShuttleOperationsRoomChat(chatId: string | null | undefined): boolean {
    return false;
  }

  canCurrentUserManageShuttleOperationsOrders(): boolean {
    const currentUser = this.currentUser();
    if (!currentUser) return false;
    return this.isShuttleOperationsAdminUser(currentUser);
  }

  private isShuttleOperationsAdminUser(user: string | null | undefined): boolean {
    const normalizedUser = this.normalizeUser(String(user || '').trim());
    if (!normalizedUser) return false;
    const writerSet = this.communityWriterSetByGroupId.get(this.normalizeChatId(SHUTTLE_OPERATIONS_CHAT_NAME));
    return Boolean(writerSet && writerSet.has(normalizedUser));
  }

  private canUserSendToCommunityGroup(group: ChatGroup, user: string | null): boolean {
    const normalizedUser = this.normalizeUser(user ?? '');
    if (!normalizedUser) return false;
    const admins = Array.isArray(group.admins)
      ? group.admins.map((admin) => this.normalizeUser(admin)).filter(Boolean)
      : [];
    if (admins.includes(normalizedUser)) {
      return true;
    }
    const writerSet = this.communityWriterSetByGroupId.get(this.normalizeChatId(group.id));
    if (writerSet) {
      return writerSet.has(normalizedUser);
    }
    return this.normalizeUser(group.createdBy) === normalizedUser;
  }

  private getGroupAdminList(group: ChatGroup): string[] {
    const admins = Array.from(
      new Set((group.admins ?? []).map((admin) => this.normalizeUser(admin)).filter(Boolean))
    );
    const createdBy = this.normalizeUser(group.createdBy || '');
    if (createdBy && !admins.includes(createdBy)) {
      admins.unshift(createdBy);
    }
    return admins;
  }

  private canUserManageGroup(group: ChatGroup, user: string | null): boolean {
    const normalizedUser = this.normalizeUser(user ?? '');
    if (!normalizedUser) return false;
    if (this.isDovrutGroup(group.id)) {
      return this.isDovrutAdminUser(normalizedUser);
    }
    return this.getGroupAdminList(group).includes(normalizedUser);
  }

  private isDovrutGroup(groupId: string): boolean {
    return this.communityWriterSetByGroupId.has(this.normalizeChatId(groupId));
  }

  private syncHardcodedCommunityGroups(contacts: Contact[], groups: ChatGroup[]): void {
    let nextGroups = groups.slice();
    let changed = false;
    const creator = this.normalizeUser(DOVRUT_SYSTEM_CREATOR);
    const currentUser = this.normalizeUser(this.currentUser() ?? '');
    const removedShuttleOpsGroupId = this.normalizeChatId(SHUTTLE_OPERATIONS_CHAT_NAME);
    const filteredGroups = nextGroups.filter((group) => group.id !== removedShuttleOpsGroupId);
    if (filteredGroups.length !== nextGroups.length) {
      nextGroups = filteredGroups;
      changed = true;
    }
    const hardcodedGroupIds = HARDCODED_COMMUNITY_GROUPS.map((group) => this.normalizeChatId(group.id));
    for (const hardcodedGroup of HARDCODED_COMMUNITY_GROUPS) {
      const normalizedId = this.normalizeChatId(hardcodedGroup.id);
      const expectedMembers = this.resolveHardcodedCommunityMembers(hardcodedGroup, contacts);
      const existingIndex = nextGroups.findIndex((group) => group.id === normalizedId);
      const existing = existingIndex >= 0 ? nextGroups[existingIndex] : null;
      const shouldIncludeForCurrentUser = !Array.isArray(hardcodedGroup.staticMembers)
        || expectedMembers.includes(currentUser);
      if (!shouldIncludeForCurrentUser) {
        if (existingIndex >= 0) {
          nextGroups.splice(existingIndex, 1);
          changed = true;
        }
        continue;
      }
      const existingMembers = existing
        ? Array.from(new Set(existing.members.map((member) => this.normalizeUser(member)).filter(Boolean)))
          .sort((a, b) => a.localeCompare(b))
        : [];
      const shouldUpdate = (
        !existing ||
        existing.name !== hardcodedGroup.name ||
        existing.type !== 'community' ||
        this.normalizeUser(existing.createdBy) !== creator ||
        !this.areStringArraysEqual(existingMembers, expectedMembers)
      );
      if (!shouldUpdate) {
        continue;
      }

      changed = true;
      const admins = Array.from(
        this.communityWriterSetByGroupId.get(normalizedId) ?? []
      );
      const nextGroup: ChatGroup = {
        id: normalizedId,
        name: hardcodedGroup.name,
        members: expectedMembers,
        admins,
        createdBy: creator,
        updatedAt: Date.now(),
        type: 'community'
      };
      if (existingIndex >= 0) {
        nextGroups[existingIndex] = nextGroup;
      } else {
        nextGroups = [nextGroup, ...nextGroups];
      }
    }

    if (!changed) {
      return;
    }

    const hardcodedGroupsInOrder = hardcodedGroupIds
      .map((groupId) => nextGroups.find((group) => group.id === groupId))
      .filter((group): group is ChatGroup => Boolean(group));
    const remainingGroups = nextGroups.filter((group) => !hardcodedGroupIds.includes(group.id));
    this.groups.set([...hardcodedGroupsInOrder, ...remainingGroups]);
    this.schedulePersist();
  }

  private resolveHardcodedCommunityMembers(config: HardcodedCommunityGroupConfig, contacts: Contact[]): string[] {
    if (Array.isArray(config.staticMembers) && config.staticMembers.length) {
      return Array.from(
        new Set(config.staticMembers.map((member) => this.normalizeUser(member)).filter(Boolean))
      ).sort((a, b) => a.localeCompare(b));
    }
    return this.computeDovrutMembers(contacts);
  }

  private computeDovrutMembers(contacts: Contact[]): string[] {
    return Array.from(
      new Set(
        contacts
          .map((contact) => this.normalizeUser(contact.username))
          .filter(Boolean)
      )
    ).sort((a, b) => a.localeCompare(b));
  }

  private normalizeContactStatus(value: unknown): number | null {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return Math.trunc(value);
    }
    const normalized = String(value ?? '').trim();
    if (!normalized) return null;
    const parsed = Number.parseInt(normalized, 10);
    return Number.isFinite(parsed) ? parsed : null;
  }

  private areStringArraysEqual(a: string[], b: string[]): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) {
      if (a[i] !== b[i]) return false;
    }
    return true;
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

    const newOrderLabel = this.shuttleText('הזמנה חדשה', 'Новый заказ');
    const state = this.loadShuttleState(user) ?? this.defaultShuttleState();
    if (state.awaiting === 'menu') {
      return {
        key: 'menu',
        title: this.shuttleText('מה תרצה לבצע?', 'Что хотите сделать?'),
        helperText: this.shuttleText('הזמנה חדשה בלחיצה אחת', 'Новый заказ в одно нажатие'),
        mode: 'buttons',
        options: [
          { value: newOrderLabel, label: newOrderLabel }
        ],
        allowBack: false
      };
    }

    if (state.awaiting === 'date') {
      return {
        key: 'date',
        title: this.shuttleText('בחר תאריך נסיעה', 'Выберите дату поездки'),
        helperText: this.shuttleText('התאריכים זמינים ל-10 הימים הקרובים', 'Доступны даты на ближайшие 10 дней'),
        mode: 'buttons',
        options: this.getShuttleDateChoices().map((choice) => ({
          value: choice.label,
          label: choice.label
        })),
        allowBack: true
      };
    }

    if (state.awaiting === 'shift') {
      const selectedDate = this.normalizeShuttleDateToIso(String(state.draft?.date || '').trim());
      const shiftOptions = this.getShuttleShiftOptionsForDate(selectedDate);
      const hasEnabledShift = shiftOptions.some((option) => !option.disabled);
      return {
        key: 'shift',
        title: this.shuttleText('בחר משמרת', 'Выберите смену'),
        helperText: hasEnabledShift
          ? this.shuttleText('הסעה לעבודה', 'Трансфер на работу')
          : this.shuttleText(
            'אין משמרות זמינות בשעה הקרובה לתאריך שנבחר. בחר תאריך אחר.',
            'На ближайший час для выбранной даты нет доступных смен. Выберите другую дату.'
          ),
        mode: 'buttons',
        options: shiftOptions,
        allowBack: true
      };
    }

    if (state.awaiting === 'station') {
      const stations = this.shuttleStationsCache.items;
      return {
        key: `station-${stations.length}`,
        title: this.shuttleText('בחר תחנה', 'Выберите станцию'),
        helperText: this.shuttleText('לחץ על הרשימה ובחר תחנה', 'Выберите станцию из списка'),
        mode: 'select',
        options: stations.map((station) => ({
          value: station,
          label: station
        })),
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
      .map((order) => ({
        ...order,
        dayName: this.resolveShuttleDayNameFromIso(order.date) || order.dayName,
        statusLabel: this.resolveShuttleStatusLabel(order.statusValue || order.statusLabel)
      }))
      .slice()
      .sort((a, b) => this.compareShuttleOrdersByDateTimeAsc(a, b));
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

  getShuttleOrdersLoading(): boolean {
    this.shuttlePickerRevision();
    const activeChatId = this.activeChatId();
    if (!this.isShuttleChat(activeChatId)) {
      return false;
    }
    const user = this.currentUser();
    if (!user) {
      return false;
    }
    return this.shuttleOrdersSyncInFlight.has(this.normalizeUser(user));
  }

  getShuttleOperationsDateGroupsForActiveChat(): ShuttleOperationsDateGroup[] | null {
    this.shuttlePickerRevision();
    const activeChatId = this.activeChatId();
    if (!this.isShuttleOperationsRoomChat(activeChatId)) {
      return null;
    }
    const orders = this.shuttleOperationsOrders();
    if (!orders.length) {
      return [];
    }
    const groupsByDate = new Map<string, ShuttleOperationsOrderRecord[]>();
    orders.forEach((order) => {
      const dateKey = this.normalizeShuttleDateToIso(String(order.date || '').trim()) || String(order.date || '').trim();
      if (!dateKey) return;
      const list = groupsByDate.get(dateKey) ?? [];
      list.push(order);
      groupsByDate.set(dateKey, list);
    });
    return Array.from(groupsByDate.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([date, list]) => {
        const sortedOrders = list.slice().sort((a, b) => this.compareShuttleOrdersByDateTimeAsc(a, b));
        const dayName = this.resolveShuttleDayNameFromIso(date) || (sortedOrders[0]?.dayName ?? '');
        return {
          date,
          dayName,
          orderCount: sortedOrders.length,
          orders: sortedOrders
        };
      });
  }

  getShuttleOperationsOrdersLoading(): boolean {
    this.shuttlePickerRevision();
    return this.shuttleOperationsOrdersLoading();
  }

  async refreshShuttleOperationsOrdersForActiveUser(
    options: { force?: boolean; throwOnError?: boolean; silent?: boolean } = {}
  ): Promise<void> {
    const activeChatId = this.activeChatId();
    if (!this.isShuttleOperationsRoomChat(activeChatId)) {
      return;
    }
    await this.refreshShuttleOperationsOrders(options);
  }

  async cancelShuttleOperationsOrderByCompositeId(orderCompositeId: string): Promise<void> {
    const currentUser = this.currentUser();
    if (!currentUser) {
      throw new Error(this.shuttleText('יש להתחבר לפני ביטול הזמנה', 'Войдите в систему перед отменой заказа'));
    }
    if (!this.isShuttleOperationsAdminUser(currentUser)) {
      throw new Error(this.shuttleText('רק מנהל חדר ההסעות יכול לבטל הזמנות', 'Только админ комнаты трансферов может отменять заказы'));
    }
    const normalizedId = String(orderCompositeId || '').trim();
    if (!normalizedId) {
      throw new Error(this.shuttleText('הזמנה לא תקינה', 'Некорректный заказ'));
    }

    const targetOrder = this.shuttleOperationsOrders().find((order) => order.compositeId === normalizedId);
    if (!targetOrder) {
      throw new Error(this.shuttleText('הזמנה לא נמצאה', 'Заказ не найден'));
    }
    if (!this.isShuttleOrderOngoing(targetOrder)) {
      throw new Error(this.shuttleText('ניתן למחוק רק הזמנה פעילה', 'Можно удалить только активный заказ'));
    }

    await this.submitShuttleOrder(targetOrder.sourceUser, targetOrder, SHUTTLE_STATUS_CANCEL_VALUE);
    await this.confirmShuttleOrderCancellationSynced(targetOrder.sourceUser, targetOrder);
    await this.refreshShuttleOperationsOrders({ force: true, throwOnError: true });
  }

  getShuttleLanguage(): ShuttleLanguage {
    this.shuttlePickerRevision();
    const user = this.currentUser();
    if (!user) {
      return this.defaultShuttleLanguage();
    }
    return this.loadShuttleLanguage(user);
  }

  setShuttleLanguage(language: ShuttleLanguage): void {
    const user = this.currentUser();
    if (!user) {
      return;
    }
    const normalizedLanguage = this.resolveShuttleLanguage(language);
    localStorage.setItem(this.shuttleLanguageKey(user), normalizedLanguage);
    this.bumpShuttlePickerRevision();
  }

  async refreshShuttleOrdersForActiveUser(): Promise<void> {
    const activeChatId = this.activeChatId();
    if (!this.isShuttleChat(activeChatId)) {
      return;
    }
    const user = this.currentUser();
    if (!user) {
      throw new Error(this.shuttleText('יש להתחבר לפני טעינת הזמנות', 'Войдите в систему перед загрузкой заказов'));
    }
    await this.refreshShuttleOrdersFromRemote(user, { force: true, throwOnError: true });
  }

  async forceSyncAllMessagesAndClearCache(): Promise<void> {
    const user = this.currentUser();
    if (!user) {
      throw new Error('יש להתחבר לפני סנכרון מלא');
    }
    if (!this.networkOnline()) {
      throw new Error('אין חיבור לרשת');
    }

    // First, try sending pending outgoing items before cache reset.
    await this.flushOutbox();

    const groupsSnapshotBeforeCacheClear = this.groups().map((group) => ({
      ...group,
      members: Array.isArray(group.members) ? [...group.members] : []
    }));

    this.clearLocalChatCacheForUser(user, { keepOutbox: true });
    this.resetRuntimeStateAfterCacheClear(user);

    await this.refresh(true);
    await this.pullMessages(user);
    await this.recoverMissedMessagesFromLogs(user, {
      force: true,
      incrementUnread: false,
      fallbackGroups: groupsSnapshotBeforeCacheClear,
      limit: LOGS_RECOVERY_FULL_SYNC_FETCH_LIMIT
    });
    this.unreadByChat.set({});
    this.resetReadReceiptTrackingState();

    await this.refreshShuttleAccessForCurrentUser(user, { force: true });
    if (this.shuttleAccessAllowed()) {
      await this.refreshShuttleOrdersFromRemote(user, { force: true, throwOnError: true });
    }
    await this.refreshShuttleOperationsOrders({ force: true });

    this.applyInitialChatSelection(user);
    this.schedulePersist();
    this.lastServerBadgeResetAt = 0;
    this.clearDeviceAttention({ resetServerBadge: true, forceServerBadgeReset: true });
  }

  private shouldSkipLogsMessage(message: IncomingServerMessage): boolean {
    const incomingType = String(message.type ?? '').trim().toLowerCase();
    if (this.isIncomingActionType(incomingType)) {
      return false;
    }
    const sender = this.normalizeUser(String(message.sender ?? '').trim());
    if (!sender || sender === 'system') {
      return true;
    }
    const normalizedBody = String(message.body ?? '').trim().toLowerCase();
    return normalizedBody === 'new notification' || normalizedBody === 'new reaction';
  }

  private buildImportableLogsMessagesForSync(
    logsMessages: IncomingServerMessage[],
    fallbackGroups: ChatGroup[] = []
  ): IncomingServerMessage[] {
    if (!Array.isArray(logsMessages) || !logsMessages.length) {
      return [];
    }

    const nonSystemLogs = logsMessages.filter((message) => !this.shouldSkipLogsMessage(message));
    if (!nonSystemLogs.length) {
      return [];
    }

    const normalizedLogs = this.normalizeLogsMessagesForImport(nonSystemLogs, fallbackGroups);
    const knownGroupNamesById = new Map<string, string>();
    [...fallbackGroups, ...this.groups()].forEach((group) => {
      const groupId = this.normalizeChatId(String(group.id || '').trim());
      const groupName = String(group.name || '').trim();
      if (!groupId) return;
      if (!groupName) return;
      if (this.normalizeChatId(groupName) === groupId) return;
      if (!knownGroupNamesById.has(groupId)) {
        knownGroupNamesById.set(groupId, groupName);
      }
    });

    return normalizedLogs
      .map((message) => {
        const groupId = this.normalizeChatId(String(message.groupId ?? '').trim());
        if (!groupId) return message;
        const incomingGroupName = String(message.groupName ?? '').trim();
        const knownGroupName = knownGroupNamesById.get(groupId) ?? '';
        if (incomingGroupName && this.normalizeChatId(incomingGroupName) !== groupId) {
          return message;
        }
        return {
          ...message,
          // Never drop logs message just because group metadata was not preloaded.
          // Use groupId fallback so full sync can still reconstruct the chat history.
          groupName: knownGroupName || incomingGroupName || groupId
        };
      })
      .filter((message): message is IncomingServerMessage => Boolean(message));
  }

  // frontend/src/app/core/services/chat-store.service.ts

  /**
   * Finds the highest timestamp among all messages currently in the local store.
   */
  private getLatestMessageTimestamp(): number {
    let maxTs = 0;
    // Access the signal's value (messagesByChat is a Record of chatID -> messages)
    const allChats = this.messagesByChat();

    for (const chatId in allChats) {
      const messages = allChats[chatId];
      if (messages.length > 0) {
        const lastMsg = messages[messages.length - 1];
        if (lastMsg.timestamp > maxTs) {
          maxTs = lastMsg.timestamp;
        }
      }
    }
    return maxTs;
  }

  private async recoverMissedMessagesFromLogs(
    user: string,
    options: {
      force?: boolean;
      incrementUnread?: boolean;
      fallbackGroups?: ChatGroup[];
      limit?: number;
    } = {}
  ): Promise<number> {
    const normalizedUser = this.normalizeUser(user);
    if (!normalizedUser || this.currentUser() !== normalizedUser || !this.isNetworkReachable()) {
      return 0;
    }

    const force = Boolean(options.force);
    const now = Date.now();

    // Prevent spamming the server if not forced
    if (!force && now - this.lastLogsRecoveryAt < LOGS_RECOVERY_MIN_INTERVAL_MS) {
      return 0;
    }
    if (this.logsRecoveryInFlight) {
      return 0;
    }

    this.logsRecoveryInFlight = true;
    try {
      const requestedLimit = Number(options.limit);
      const safeLimit = Number.isFinite(requestedLimit)
        ? Math.min(200000, Math.max(1, Math.floor(requestedLimit)))
        : 1000; // Default limit

      // When forcing a full sync, fetch ALL messages (since=0).
      // Otherwise use the timestamp optimization to only fetch messages newer than what we already have.
      const lastKnownTs = force ? 0 : this.getLatestMessageTimestamp();

      const logsMessages: IncomingServerMessage[] = [];
      let offset = 0;
      const pageSize = 500;

      while (logsMessages.length < safeLimit) {
        const remaining = safeLimit - logsMessages.length;
        const currentLimit = Math.min(pageSize, remaining);

        // Pass lastKnownTs to the API
        const page = await this.api.getMessagesFromLogs(
          normalizedUser,
          currentLimit,
          offset,
          lastKnownTs
        );

        if (!page.length) break;

        logsMessages.push(...page);
        offset += page.length;

        if (page.length < currentLimit) break;
      }

      const fallbackGroups = Array.isArray(options.fallbackGroups) ? options.fallbackGroups : [];
      const importableLogs = this.buildImportableLogsMessagesForSync(logsMessages, fallbackGroups);

      if (!importableLogs.length) {
        this.lastLogsRecoveryAt = Date.now();
        return 0;
      }

      // Process and merge the new messages into the UI
      this.ensureGroupsFromImportedLogs(importableLogs, fallbackGroups);
      const appliedCount = this.applyIncomingMessagesBatch(importableLogs, {
        incrementUnread: options.incrementUnread !== false,
        trackReadReceipts: false,
        applyActions: true,
        updateGroupMetadata: false
      });

      this.lastLogsRecoveryAt = Date.now();
      return appliedCount;
    } catch (err) {
      console.error('Failed to recover missed messages:', err);
      return 0;
    } finally {
      this.logsRecoveryInFlight = false;
    }
  }

  private normalizeLogsMessagesForImport(
    messages: IncomingServerMessage[],
    fallbackGroups: ChatGroup[] = []
  ): IncomingServerMessage[] {
    if (!Array.isArray(messages) || !messages.length) {
      return [];
    }
    const groupsById = new Map<string, ChatGroup>();
    this.groups().forEach((group) => groupsById.set(group.id, group));
    fallbackGroups.forEach((group) => {
      if (!groupsById.has(group.id)) {
        groupsById.set(group.id, group);
      }
    });
    return messages.map((message) => {
      const incoming = { ...message };
      const normalizedSender = this.normalizeUser(String(incoming.sender ?? '').trim());
      const normalizedGroupId = this.normalizeChatId(String(incoming.groupId ?? '').trim());
      const normalizedGroupName = String(incoming.groupName ?? '').trim();

      let resolvedGroupId = normalizedGroupId;
      if (!resolvedGroupId && normalizedSender && /^group:/i.test(normalizedSender)) {
        resolvedGroupId = this.normalizeChatId(normalizedSender);
      }
      if (!resolvedGroupId && normalizedSender && groupsById.has(this.normalizeChatId(normalizedSender))) {
        resolvedGroupId = this.normalizeChatId(normalizedSender);
      }
      if (!resolvedGroupId) {
        return incoming;
      }

      const existingGroup = groupsById.get(resolvedGroupId) ?? null;
      const shouldUseExistingName = (
        !normalizedGroupName ||
        this.normalizeChatId(normalizedGroupName) === resolvedGroupId
      );
      const rawBody = String(incoming.body ?? '').trim();
      const senderPrefixMatch = rawBody.match(/^([^:\n]{1,80})\s*:\s*(.+)$/);
      const inferredSenderName = senderPrefixMatch ? String(senderPrefixMatch[1] || '').trim() : '';
      const inferredBody = senderPrefixMatch ? String(senderPrefixMatch[2] || '').trim() : rawBody;

      return {
        ...incoming,
        groupId: resolvedGroupId,
        groupName: shouldUseExistingName
          ? (existingGroup?.name || normalizedGroupName || resolvedGroupId)
          : normalizedGroupName,
        groupType: incoming.groupType ?? existingGroup?.type ?? 'group',
        groupSenderName: String(incoming.groupSenderName ?? '').trim() || inferredSenderName || undefined,
        body: inferredBody || rawBody
      };
    });
  }

  private ensureGroupsFromImportedLogs(
    messages: IncomingServerMessage[],
    fallbackGroups: ChatGroup[] = []
  ): void {
    if (!Array.isArray(messages) || !messages.length) return;
    const currentUser = this.normalizeUser(this.currentUser() ?? '');
    const fallbackById = new Map<string, ChatGroup>();
    fallbackGroups.forEach((group) => fallbackById.set(group.id, group));

    this.groups.update((groups) => {
      let changed = false;
      const existingById = new Map(groups.map((group) => [group.id, group]));
      const nextGroups = groups.slice();

      for (const message of messages) {
        const groupId = this.normalizeChatId(String(message.groupId ?? '').trim());
        if (!groupId) continue;

        const incomingGroupName = String(message.groupName ?? '').trim();
        const fallbackGroup = fallbackById.get(groupId) ?? null;
        const resolvedGroupName = (
          incomingGroupName && this.normalizeChatId(incomingGroupName) !== groupId
            ? incomingGroupName
            : (fallbackGroup?.name || incomingGroupName || groupId)
        );
        const resolvedType: GroupType = message.groupType === 'community' ? 'community' : 'group';

        const existing = existingById.get(groupId) ?? null;
        if (!existing) {
          changed = true;
          const members = Array.isArray(fallbackGroup?.members)
            ? Array.from(new Set(fallbackGroup!.members.map((member) => this.normalizeUser(member)).filter(Boolean)))
            : (currentUser ? [currentUser] : []);
          const nextGroup: ChatGroup = {
            id: groupId,
            name: resolvedGroupName,
            members,
            createdBy: this.normalizeUser(fallbackGroup?.createdBy || currentUser || 'system'),
            updatedAt: Date.now(),
            type: resolvedType
          };
          nextGroups.unshift(nextGroup);
          existingById.set(groupId, nextGroup);
          continue;
        }

        const existingName = String(existing.name || '').trim();
        const existingNameLooksLikeId = this.normalizeChatId(existingName) === groupId;
        const resolvedNameLooksLikeId = this.normalizeChatId(resolvedGroupName) === groupId;
        if (existingNameLooksLikeId && !resolvedNameLooksLikeId) {
          changed = true;
          const updatedGroup: ChatGroup = {
            ...existing,
            name: resolvedGroupName,
            updatedAt: Math.max(existing.updatedAt || 0, Date.now())
          };
          const index = nextGroups.findIndex((group) => group.id === groupId);
          if (index >= 0) {
            nextGroups[index] = updatedGroup;
          }
          existingById.set(groupId, updatedGroup);
        }
      }

      return changed ? nextGroups : groups;
    });
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

    const draftDate = String(draft.date || '').trim();
    const draftDayName = this.resolveShuttleDayNameFromIso(draftDate) || String(draft.dayName || '').trim();
    const dateValue = draftDayName && draftDate
      ? `${draftDayName} ${draftDate}`
      : '';
    const shiftValue = String(draft.shiftLabel || '').trim();
    const stationValue = String(draft.station || '').trim();
    const awaiting = state.awaiting === 'cancel-select' ? 'menu' : state.awaiting;

    const breadcrumbs: ShuttleBreadcrumbStep[] = [];
    if (awaiting !== 'menu') {
      breadcrumbs.push({
        key: 'menu',
        label: '',
        value: this.shuttleText('הזמנה חדשה', 'Новый заказ'),
        active: false,
        completed: true
      });
    }
    if (dateValue) {
      breadcrumbs.push({
        key: 'date',
        label: '',
        value: dateValue,
        active: false,
        completed: true
      });
    }
    if (shiftValue) {
      breadcrumbs.push({
        key: 'shift',
        label: '',
        value: shiftValue,
        active: false,
        completed: true
      });
    }
    if (stationValue) {
      breadcrumbs.push({
        key: 'station',
        label: '',
        value: stationValue,
        active: false,
        completed: true
      });
    }

    if (!breadcrumbs.length) {
      return null;
    }

    const lastIndex = breadcrumbs.length - 1;
    breadcrumbs[lastIndex] = {
      ...breadcrumbs[lastIndex],
      active: true
    };
    return breadcrumbs;
  }

  async submitShuttleQuickPickerSelection(rawValue: string): Promise<void> {
    const activeChatId = this.activeChatId();
    if (!this.isShuttleChat(activeChatId)) {
      throw new Error(this.shuttleText('הצ׳אט הפעיל אינו הזמנת הסעה', 'Активный чат не является чатом трансфера'));
    }

    const value = String(rawValue || '').trim();
    if (!value) {
      throw new Error(this.shuttleText('בחירה חסרה', 'Выбор не выполнен'));
    }

    const handledByShuttleFlow = await this.handleShuttleOutgoing(value);
    if (!handledByShuttleFlow) {
      throw new Error(this.shuttleText('הבחירה לא עובדה. נסה שוב.', 'Выбор не обработан. Попробуйте снова.'));
    }
  }

  async cancelShuttleOrderById(orderId: string): Promise<void> {
    const user = this.currentUser();
    if (!user) {
      throw new Error(this.shuttleText('יש להתחבר לפני ביטול הזמנה', 'Войдите в систему перед отменой заказа'));
    }

    const normalizedId = String(orderId || '').trim();
    if (!normalizedId) {
      throw new Error(this.shuttleText('הזמנה לא תקינה', 'Некорректный заказ'));
    }

    const targetOrder = this.loadShuttleOrders(user).find((order) => order.id === normalizedId);
    if (!targetOrder) {
      throw new Error(this.shuttleText('הזמנה לא נמצאה', 'Заказ не найден'));
    }
    if (!this.isShuttleOrderOngoing(targetOrder)) {
      throw new Error(this.shuttleText('ניתן למחוק רק הזמנה פעילה', 'Можно удалить только активный заказ'));
    }

    await this.submitShuttleOrder(user, targetOrder, SHUTTLE_STATUS_CANCEL_VALUE);
    await this.confirmShuttleOrderCancellationSynced(user, targetOrder);
    this.sendShuttleSystemMessage(
      `${this.shuttleText('ההזמנה בוטלה בהצלחה ✅', 'Заказ успешно отменен ✅')}\n${this.buildShuttleOrderSummary({
        ...targetOrder,
        statusValue: SHUTTLE_STATUS_CANCEL_VALUE,
        statusLabel: this.resolveShuttleStatusLabel(SHUTTLE_STATUS_CANCEL_VALUE)
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
      groupAdmins: group?.admins,
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
      groupAdmins: group?.admins,
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

    const reaction: MessageReaction = {
      emoji: normalizedEmoji,
      reactor: currentUser,
      reactorName: this.getDisplayName(currentUser)
    };

    const fallbackGroupId = this.normalizeChatId(activeChatId);
    if (!fallbackGroupId) {
      throw new Error('יעד לא נמצא.');
    }
    this.applyReactionToMessage(fallbackGroupId, normalizedTargetId, reaction);

    if (!this.networkOnline()) {
      this.lastError.set('לא ניתן לשלוח תגובה ללא חיבור.');
      throw new Error('Offline');
    }

    const activeChat = this.activeChat();
    let payload: ReactionPayload;

    if (effectiveGroup) {
      payload = {
        groupId: effectiveGroup.id,
        groupName: effectiveGroup.name || activeChat?.title || effectiveGroup.id,
        groupMembers: effectiveGroup.members ?? [],
        groupCreatedBy: effectiveGroup.createdBy || '',
        groupAdmins: effectiveGroup.admins ?? [],
        groupUpdatedAt: effectiveGroup.updatedAt || Date.now(),
        groupType: effectiveGroup.type === 'group' ? 'group' : 'community',
        targetMessageId: normalizedTargetId,
        emoji: normalizedEmoji,
        reactor: currentUser,
        reactorName: reaction.reactorName || currentUser
      };
    } else {
      payload = {
        targetUser: fallbackGroupId,
        targetMessageId: normalizedTargetId,
        emoji: normalizedEmoji,
        reactor: currentUser,
        reactorName: reaction.reactorName || currentUser
      };
    }

    await this.sendReactionTransport(payload);
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
          await this.sendReplyTransport(item.payload);
          this.setMessageStatus(item.messageId, 'sent');
          continue;
        }

        if (item.kind === 'group') {
          const recipients = Array.from(
            new Set(item.recipients.map((recipient) => this.normalizeUser(recipient)).filter(Boolean))
          ).filter((recipient) => recipient !== this.normalizeUser(item.payload.user));
          if (!recipients.length) {
            this.setMessageStatus(item.messageId, 'sent');
            continue;
          }
          await this.sendReplyTransport({
            ...item.payload,
            originalSender: recipients[0],
            membersToNotify: recipients
          });
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
    // Default startup behavior should open the main/home page.
    return localStorage.getItem(this.homeViewKey(user)) !== '0';
  }

  private async onChatActivated(chatId: string): Promise<void> {
    if (this.isHrChat(chatId)) {
      await this.ensureHrFlowOnOpen();
      return;
    }
    if (this.isShuttleOperationsRoomChat(chatId)) {
      await this.ensureShuttleOperationsFlowOnOpen();
      return;
    }
    if (this.isShuttleChat(chatId)) {
      if (!this.shuttleAccessAllowed()) {
        return;
      }
      await this.ensureShuttleFlowOnOpen();
    }
  }

  private isHrChat(chatId: string | null): boolean {
    return this.normalizeChatId(chatId ?? '') === this.normalizeChatId(HR_CHAT_NAME);
  }

  private isShuttleChat(chatId: string | null): boolean {
    const normalized = this.normalizeChatId(chatId ?? '');
    return Boolean(normalized && this.shuttleChatIdSet.has(normalized));
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

    if (trimmed === '__hr_end__') {
      this.resetHrState(user);
      this.sendHrSystemMessage('השיחה הסתיימה. ניתן להתחיל מחדש בכל רגע.');
      return true;
    }

    if (trimmed === '0') {
      this.resetHrState(user);
      await this.startHrFlow({ skipWelcome: this.hasHrWelcomeMessage(user) });
      return true;
    }

    const state = this.loadHrState(user) ?? { awaiting: 'step', stepId: null, actions: [] };
    if (state.awaiting === 'step') {
      const steps = await this.getHrStepsForCurrentUser();
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

  private async getHrStepsForCurrentUser(): Promise<HrStepOption[]> {
    const steps = await this.fetchHrStepsCached();
    return this.filterHrStepsForCurrentUser(steps);
  }

  private filterHrStepsForCurrentUser(steps: HrStepOption[]): HrStepOption[] {
    if (!Array.isArray(steps) || !steps.length) {
      return [];
    }
    const sectorKeys = this.getCurrentUserHrSectorKeys();
    return steps.filter((step) => this.isHrStepAllowedForCurrentUser(step, sectorKeys));
  }

  private isHrStepAllowedForCurrentUser(step: HrStepOption, sectorKeys: readonly string[]): boolean {
    if (step.showToAllUsers) {
      return true;
    }
    if (!sectorKeys.length) {
      return false;
    }
    return this.isHrStepMatchForSector(step, sectorKeys);
  }

  private getCurrentUserHrSectorKeys(): string[] {
    const currentUser = this.normalizeUser(this.currentUser() ?? '');
    if (!currentUser) {
      return [];
    }
    const currentContact = this.contacts().find((contact) => contact.username === currentUser);
    if (!currentContact) {
      return [];
    }
    const parsedDisplay = this.extractNameAndInfo(currentContact.displayName || '');
    const rawValues = [currentContact.info, parsedDisplay.info]
      .map((value) => String(value || '').trim())
      .filter(Boolean);
    if (!rawValues.length) {
      return [];
    }
    return Array.from(
      new Set(
        rawValues
          .flatMap((value) => this.extractHrSectorTokens(value))
          .map((token) => this.normalizeHrSectorKey(token))
          .filter(Boolean)
      )
    );
  }

  private isHrStepMatchForSector(step: HrStepOption, sectorKeys: readonly string[]): boolean {
    const stepTokens = Array.from(
      new Set(
        [step.subject, step.name]
          .flatMap((value) => this.extractHrSectorTokens(String(value || '')))
          .map((token) => this.normalizeHrSectorKey(token))
          .filter(Boolean)
      )
    );
    if (!stepTokens.length) {
      return false;
    }
    return sectorKeys.some((sectorKey) =>
      stepTokens.some(
        (stepToken) =>
          stepToken === sectorKey ||
          stepToken.includes(sectorKey) ||
          sectorKey.includes(stepToken)
      )
    );
  }

  private extractHrSectorTokens(value: string): string[] {
    const source = String(value || '').replace(/\s+/g, ' ').trim();
    if (!source) {
      return [];
    }
    return source
      .split(/[|,;/\n]+/g)
      .map((token) => token.trim())
      .filter(Boolean);
  }

  private normalizeHrSectorKey(value: string): string {
    return String(value || '')
      .toLowerCase()
      .replace(/[()"'`]/g, ' ')
      .replace(/[_-]/g, ' ')
      .replace(/ענף|מחלקה|מחלקת|סקטור|sektor|sector|department/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
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

    const steps = await this.getHrStepsForCurrentUser();
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
    this.bumpHrStateRevision();
  }

  private resetHrState(user: string): void {
    localStorage.removeItem(this.hrStateKey(user));
    localStorage.removeItem(this.hrWelcomeKey(user));
    this.bumpHrStateRevision();
  }

  private bumpHrStateRevision(): void {
    this.hrStateRevision.update((value) => value + 1);
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
      try {
        await this.refreshShuttleOrdersFromRemote(user);
      } catch {
        // Keep shuttle room usable with locally cached orders.
      }
      if (!this.shouldInitializeShuttleFlowOnOpen(user)) {
        return;
      }
      await this.startShuttleFlow({ skipWelcome: false });
    } finally {
      this.shuttleInitInFlight = false;
    }
  }

  private async ensureShuttleOperationsFlowOnOpen(): Promise<void> {
    const user = this.currentUser();
    if (!user || this.shuttleOperationsInitInFlight) {
      return;
    }
    this.shuttleOperationsInitInFlight = true;
    try {
      await this.refreshShuttleOperationsOrders({ force: false });
    } finally {
      this.shuttleOperationsInitInFlight = false;
    }
  }

  private async refreshShuttleOperationsOrders(
    options: { force?: boolean; throwOnError?: boolean; silent?: boolean } = {}
  ): Promise<void> {
    const currentUser = this.currentUser();
    if (!currentUser) {
      this.shuttleOperationsOrders.set([]);
      return;
    }
    const normalizedCurrentUser = this.normalizeUser(currentUser);
    const staticMembers = Array.from(
      new Set(SHUTTLE_OPERATIONS_GROUP_MEMBERS.map((member) => this.normalizeUser(member)).filter(Boolean))
    );
    if (!staticMembers.includes(normalizedCurrentUser)) {
      this.shuttleOperationsOrders.set([]);
      return;
    }

    const now = Date.now();
    if (!options.force && now - this.shuttleOperationsLastSyncedAt < SHUTTLE_REMOTE_ORDERS_SYNC_TTL_MS) {
      return;
    }
    if (this.shuttleOperationsSyncPromise) {
      if (options.throwOnError) {
        return this.shuttleOperationsSyncPromise;
      }
      await this.shuttleOperationsSyncPromise.catch(() => undefined);
      return;
    }

    const showLoadingState = !options.silent;
    if (showLoadingState) {
      this.shuttleOperationsOrdersLoading.set(true);
      this.bumpShuttlePickerRevision();
    }
    const syncTask = (async () => {
      const fromDate = this.toIsoDate(new Date());
      const remoteOrders = await this.api.getShuttleOperationsOrders(fromDate, {
        force: options.force === true
      });
      const loadedOrders: ShuttleOperationsOrderRecord[] = [];
      const contactsByUser = new Map(
        this.contacts().map((contact) => [this.normalizeUser(contact.username), contact])
      );
      const contactsByPhone = new Map<string, Contact>();
      this.contacts().forEach((contact) => {
        const phone = this.normalizePhone(contact.username) || this.extractShuttlePhone(contact.username);
        if (phone) {
          contactsByPhone.set(phone, contact);
        }
      });

      const mappedOrders = remoteOrders
        .map((item, index) => this.mapShuttleRemoteOrder(item, index))
        .filter((item): item is ShuttleOrderRecord => Boolean(item))
        .filter((item) => {
          const orderDate = this.parseShuttleDate(item.date);
          if (!orderDate) return false;
          const today = new Date();
          today.setHours(0, 0, 0, 0);
          return orderDate.getTime() >= today.getTime();
        });
      mappedOrders.forEach((order) => {
        const sourcePhone = this.normalizePhone(order.employee) || this.extractShuttlePhone(order.employee);
        const sourceUser = sourcePhone || this.normalizeUser(order.employee) || `unknown-${order.id}`;
        const contact = contactsByUser.get(sourceUser) || contactsByPhone.get(sourcePhone || '');
        const employeeLabel = this.normalizeShuttleEmployeeName(order.employee);
        const sourceDisplayName = String(
          contact?.displayName ||
          employeeLabel ||
          sourceUser
        ).trim();
        loadedOrders.push({
          ...order,
          sourceUser,
          sourceDisplayName,
          sourceOrderId: order.id,
          compositeId: `${sourceUser}::${order.id}`,
          canCancel: this.isShuttleOrderOngoing(order)
        });
      });

      const dedupedByIdentity = new Map<string, ShuttleOperationsOrderRecord>();
      loadedOrders.forEach((order, index) => {
        const dateKey = this.normalizeShuttleDateToIso(String(order.date || '').trim()) || String(order.date || '').trim();
        const shiftKey = this.normalizeShuttleShiftLabel(String(order.shiftLabel || order.shiftValue || '').trim());
        const stationKey = this.normalizeShuttleText(String(order.station || '').trim());
        const identity = `${order.sourceUser}|${dateKey}|${shiftKey}|${stationKey}|${order.sourceOrderId || index}`;
        if (!dedupedByIdentity.has(identity)) {
          dedupedByIdentity.set(identity, order);
        }
      });
      const nextOrders = Array.from(dedupedByIdentity.values())
        .sort((a, b) => this.compareShuttleOrdersByDateTimeAsc(a, b));
      this.shuttleOperationsOrders.set(nextOrders);
      this.shuttleOperationsLastSyncedAt = Date.now();
    })();

    this.shuttleOperationsSyncPromise = syncTask;
    try {
      await syncTask;
    } catch (error) {
      if (options.throwOnError) {
        throw error;
      }
    } finally {
      this.shuttleOperationsSyncPromise = null;
      if (showLoadingState) {
        this.shuttleOperationsOrdersLoading.set(false);
        this.bumpShuttlePickerRevision();
      }
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

    if (trimmed === '0' || trimmed.includes('חזרה') || this.normalizeShuttleText(trimmed).includes('назад')) {
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
        this.saveShuttleState(user, this.defaultShuttleState());
        return true;
      default:
        this.saveShuttleState(user, this.defaultShuttleState());
        this.sendShuttleMenu();
        return true;
    }
  }

  private async handleShuttleMenuSelection(user: string, value: string): Promise<boolean> {
    const command = this.parseShuttleMenuCommand(value);
    if (command !== 'new') {
      this.sendShuttleSystemMessage(
        this.shuttleText('בחירה לא תקינה. נא לבחור אחת מהאפשרויות המוצגות.', 'Некорректный выбор. Выберите один из предложенных вариантов.'),
        {
          recordType: 'shuttle-invalid'
        }
      );
      this.saveShuttleState(user, this.defaultShuttleState());
      this.sendShuttleMenu();
      return true;
    }

    this.saveShuttleState(user, {
      awaiting: 'date',
      draft: null,
      cancelCandidateIds: []
    });
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
      this.sendShuttleSystemMessage(this.shuttleText('בחירה לא תקינה. נא לבחור תאריך מהרשימה.', 'Некорректный выбор. Выберите дату из списка.'), {
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
    const selectedDate = this.normalizeShuttleDateToIso(String(state.draft?.date || '').trim());
    const availableShiftOptions = this.getShuttleShiftOptionsForDate(selectedDate).filter((option) => !option.disabled);
    if (!availableShiftOptions.length) {
      this.sendShuttleSystemMessage(
        this.shuttleText(
          'אין משמרות זמינות בשעה הקרובה לתאריך שנבחר. בחר תאריך אחר.',
          'На ближайший час для выбранной даты нет доступных смен. Выберите другую дату.'
        ),
        {
          recordType: 'shuttle-invalid'
        }
      );
      this.saveShuttleState(user, {
        awaiting: 'date',
        draft: null,
        cancelCandidateIds: []
      });
      return true;
    }
    const pickedIndex = this.parseShuttleSelection(
      value,
      availableShiftOptions.length,
      availableShiftOptions.map((option) => option.label)
    );
    if (pickedIndex < 0) {
      this.sendShuttleSystemMessage(this.shuttleText('בחירה לא תקינה. נא לבחור משמרת מהרשימה.', 'Некорректный выбор. Выберите смену из списка.'), {
        recordType: 'shuttle-invalid'
      });
      return true;
    }

    const shift = availableShiftOptions[pickedIndex];
    const stations = await this.fetchShuttleStationsCached();
    if (!stations.length) {
      this.sendShuttleSystemMessage(this.shuttleText('לא ניתן לטעון תחנות כרגע. נסה שוב מאוחר יותר.', 'Сейчас не удалось загрузить станции. Попробуйте позже.'), {
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
        shiftValue: shift.submitValue || shift.value
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
      this.sendShuttleSystemMessage(this.shuttleText('לא ניתן לטעון תחנות כרגע. נסה שוב מאוחר יותר.', 'Сейчас не удалось загрузить станции. Попробуйте позже.'), {
        recordType: 'shuttle-error'
      });
      this.saveShuttleState(user, this.defaultShuttleState());
      this.sendShuttleMenu();
      return true;
    }

    const pickedIndex = this.parseShuttleSelection(value, stations.length, stations);
    if (pickedIndex < 0) {
      this.sendShuttleSystemMessage(this.shuttleText('בחירה לא תקינה. נא לבחור תחנה מהרשימה.', 'Некорректный выбор. Выберите станцию из списка.'), {
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
      this.sendShuttleSystemMessage(this.shuttleText('חסרים נתוני הזמנה. מתחילים מחדש.', 'Недостаточно данных заказа. Начинаем заново.'), {
        recordType: 'shuttle-error'
      });
      this.saveShuttleState(user, this.defaultShuttleState());
      this.sendShuttleMenu();
      return true;
    }

    const completeDraft = draft as ShuttleOrderDraft;
    if (this.shouldDisableShuttleShiftForDate(completeDraft.date, completeDraft.shiftLabel)) {
      this.sendShuttleSystemMessage(
        this.shuttleText(
          'המשמרת שנבחרה כבר לא זמינה להזמנה. בחר משמרת אחרת.',
          'Выбранная смена уже недоступна для заказа. Выберите другую смену.'
        ),
        {
          recordType: 'shuttle-invalid'
        }
      );
      this.saveShuttleState(user, {
        awaiting: 'shift',
        draft: {
          date: completeDraft.date,
          dayName: completeDraft.dayName
        },
        cancelCandidateIds: []
      });
      return true;
    }
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
        statusLabel: this.resolveShuttleStatusLabel(SHUTTLE_STATUS_ACTIVE_VALUE),
        submittedAt: Date.now()
      });
      this.sendShuttleSystemMessage(
        `${this.shuttleText('הבקשה נשלחה בהצלחה ✅', 'Запрос успешно отправлен ✅')}\n${this.buildShuttleOrderSummary({
          ...completeDraft,
          id: '',
          employee,
          statusValue: SHUTTLE_STATUS_ACTIVE_VALUE,
          statusLabel: this.resolveShuttleStatusLabel(SHUTTLE_STATUS_ACTIVE_VALUE),
          submittedAt: Date.now()
        })}`,
        { recordType: 'shuttle-submit-success' }
      );
    } catch (error) {
      const fallbackMessage = this.shuttleText('שליחת הבקשה נכשלה. נסה שוב בעוד מספר רגעים.', 'Не удалось отправить запрос. Попробуйте снова через пару минут.');
      const errorMessage = error instanceof Error ? String(error.message || '').trim() : '';
      this.sendShuttleSystemMessage(errorMessage || fallbackMessage, {
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
      this.sendShuttleSystemMessage(this.shuttleText('אין הזמנות פעילות לביטול.', 'Нет активных заказов для отмены.'), {
        recordType: 'shuttle-cancel-empty'
      });
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
      this.sendShuttleSystemMessage(this.shuttleText('בחירה לא תקינה. נא לבחור הזמנה לביטול מתוך הרשימה.', 'Некорректный выбор. Выберите заказ для отмены из списка.'), {
        recordType: 'shuttle-invalid'
      });
      return true;
    }

    const targetOrder = candidateOrders[pickedIndex];
    if (!targetOrder) {
      this.sendShuttleSystemMessage(this.shuttleText('ההזמנה לא נמצאה. מתחילים מחדש.', 'Заказ не найден. Начинаем заново.'), {
        recordType: 'shuttle-cancel-missing'
      });
      this.saveShuttleState(user, this.defaultShuttleState());
      this.sendShuttleMenu();
      return true;
    }

    try {
      await this.submitShuttleOrder(user, targetOrder, SHUTTLE_STATUS_CANCEL_VALUE);
      await this.confirmShuttleOrderCancellationSynced(user, targetOrder);
      this.sendShuttleSystemMessage(
        `${this.shuttleText('ההזמנה בוטלה בהצלחה ✅', 'Заказ успешно отменен ✅')}\n${this.buildShuttleOrderSummary({
          ...targetOrder,
          statusValue: SHUTTLE_STATUS_CANCEL_VALUE,
          statusLabel: this.resolveShuttleStatusLabel(SHUTTLE_STATUS_CANCEL_VALUE)
        })}`,
        { recordType: 'shuttle-cancel-success' }
      );
    } catch (error) {
      const fallbackMessage = this.shuttleText('ביטול ההזמנה נכשל. נסה שוב בעוד מספר רגעים.', 'Не удалось отменить заказ. Попробуйте снова через пару минут.');
      const errorMessage = error instanceof Error ? String(error.message || '').trim() : '';
      this.sendShuttleSystemMessage(errorMessage || fallbackMessage, {
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
        this.shuttleText(
          `${contactName} שלום, ברוך/ה הבא/ה להזמנת הסעה.\nכאן ניתן להזמין הסעה, לצפות בבקשות שלך ולבטל בקשה קיימת.`,
          `Здравствуйте, ${contactName}! Добро пожаловать в чат заказа трансфера.\nЗдесь можно оформить трансфер, просмотреть свои заявки и отменить существующую заявку.`
        ),
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
      .sort((a, b) => this.compareShuttleOrdersByDateTimeAsc(a, b));

    if (!activeOrders.length) {
      this.sendShuttleSystemMessage(this.shuttleText('אין בקשות פעילות לביטול.', 'Нет активных заявок для отмены.'), {
        recordType: 'shuttle-cancel-empty'
      });
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

  private async refreshShuttleOrdersFromRemote(
    user: string,
    options: { force?: boolean; throwOnError?: boolean } = {}
  ): Promise<void> {
    const normalizedUser = this.normalizeUser(user);
    const now = Date.now();
    const lastSyncedAt = this.shuttleOrdersSyncAt.get(normalizedUser) ?? 0;
    if (!options.force && now - lastSyncedAt < SHUTTLE_REMOTE_ORDERS_SYNC_TTL_MS) {
      return;
    }
    if (this.shuttleOrdersSyncInFlight.has(normalizedUser)) {
      const activeSync = this.shuttleOrdersSyncPromiseByUser.get(normalizedUser);
      if (activeSync) {
        await activeSync.catch(() => undefined);
      } else {
        return;
      }
      if (!options.force) {
        return;
      }
    }

    this.shuttleOrdersSyncInFlight.add(normalizedUser);
    this.bumpShuttlePickerRevision();
    const syncTask = (async () => {
      const remoteOrders = await this.api.getShuttleUserOrders(user);
      const mappedOrders = remoteOrders
        .map((item, index) => this.mapShuttleRemoteOrder(item, index))
        .filter((item): item is ShuttleOrderRecord => Boolean(item))
        .sort((a, b) => (b.submittedAt || 0) - (a.submittedAt || 0));

      if (mappedOrders.length > 0 || this.loadShuttleOrders(user).length === 0 || options.force) {
        this.saveShuttleOrders(user, mappedOrders.slice(0, 300));
      }
      this.shuttleOrdersSyncAt.set(normalizedUser, Date.now());
    })();
    this.shuttleOrdersSyncPromiseByUser.set(normalizedUser, syncTask);
    try {
      await syncTask;
    } catch (error) {
      if (!options.force) {
        this.shuttleOrdersSyncAt.set(normalizedUser, now);
      }
      if (options.throwOnError) {
        throw error;
      }
    } finally {
      this.shuttleOrdersSyncInFlight.delete(normalizedUser);
      this.shuttleOrdersSyncPromiseByUser.delete(normalizedUser);
      this.bumpShuttlePickerRevision();
    }
  }

  private mapShuttleRemoteOrder(item: ShuttleUserOrderPayload, index: number): ShuttleOrderRecord | null {
    const rawDate = String(item.dateIso || item.date || '').trim();
    const dateIso = this.normalizeShuttleDateToIso(rawDate);
    if (!dateIso) {
      return null;
    }

    const dayName = this.resolveShuttleDayNameFromIso(dateIso) || String(item.dayName || '').trim();
    const shiftLabel = this.normalizeShuttleShiftLabel(String(item.shift || '').trim());
    const shiftValue = this.normalizeShuttleShiftValue(String(item.shiftValue || '').trim(), shiftLabel);
    const station = String(item.station || '').trim();
    if (!shiftLabel || !shiftValue || !station) {
      return null;
    }

    const statusValue = this.resolveShuttleRemoteStatusValue(item);
    const cancelHint = this.resolveShuttleRemoteCancelHint(item);
    const isCancelled = cancelHint ?? this.isShuttleStatusCancelled(statusValue);
    const statusLabel = this.resolveShuttleStatusLabel(isCancelled ? SHUTTLE_STATUS_CANCEL_VALUE : statusValue);
    const submittedAtRaw = Number(item.submittedAt || 0);
    const dateTimestamp = this.parseShuttleDate(dateIso)?.getTime() ?? Date.now();
    const submittedAt = Number.isFinite(submittedAtRaw) && submittedAtRaw > 0
      ? submittedAtRaw
      : dateTimestamp + index;
    const cancelledAtRaw = Number(item.cancelledAt || 0);
    const explicitId = String(item.id || '').trim();
    const sheetRow = Number(item.sheetRow || 0);

    return {
      id: explicitId || (
        Number.isFinite(sheetRow) && sheetRow > 0
          ? `sheet-${sheetRow}`
          : `srv-${dateIso}-${shiftLabel}-${station}-${index}`
      ),
      employee: String(item.employee || '').trim(),
      date: dateIso,
      dayName,
      shiftLabel,
      shiftValue,
      station,
      statusValue: isCancelled ? SHUTTLE_STATUS_CANCEL_VALUE : statusValue,
      statusLabel,
      submittedAt,
      cancelledAt: Number.isFinite(cancelledAtRaw) && cancelledAtRaw > 0 ? cancelledAtRaw : undefined
    };
  }

  private resolveShuttleRemoteStatusValue(item: ShuttleUserOrderPayload): string {
    const record = item as Record<string, unknown>;
    const candidateKeys = [
      'statusValue',
      'status',
      'status_value',
      'statusvalue',
      'tripStatus',
      'trip_status',
      'state',
      'סטטוס',
      'מצב'
    ] as const;

    for (const key of candidateKeys) {
      const value = record[key];
      if (value !== undefined && value !== null && String(value).trim()) {
        return String(value).trim();
      }
    }

    return SHUTTLE_STATUS_ACTIVE_VALUE;
  }

  private resolveShuttleRemoteCancelHint(item: ShuttleUserOrderPayload): boolean | null {
    const record = item as Record<string, unknown>;
    const cancelCandidates = [
      item.isCancelled,
      record['isCancelled'],
      record['isCanceled'],
      record['cancelled'],
      record['canceled']
    ];
    for (const value of cancelCandidates) {
      const normalized = this.parseShuttleBoolean(value);
      if (normalized !== null) {
        return normalized;
      }
    }

    const activeCandidates = [
      record['isActive'],
      record['active']
    ];
    for (const value of activeCandidates) {
      const normalized = this.parseShuttleBoolean(value);
      if (normalized !== null) {
        return !normalized;
      }
    }

    return null;
  }

  private parseShuttleBoolean(value: unknown): boolean | null {
    if (typeof value === 'boolean') {
      return value;
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value !== 0;
    }
    const normalized = String(value ?? '').trim().toLowerCase();
    if (!normalized) {
      return null;
    }
    if (['1', 'true', 'yes', 'y'].includes(normalized)) {
      return true;
    }
    if (['0', 'false', 'no', 'n'].includes(normalized)) {
      return false;
    }
    return null;
  }

  private async confirmShuttleOrderCancellationSynced(user: string, targetOrder: ShuttleOrderRecord): Promise<void> {
    const maxAttempts = 3;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      await this.refreshShuttleOrdersFromRemote(user, { force: true, throwOnError: true });
      const latestOrders = this.loadShuttleOrders(user);
      const matchedOrder = this.findShuttleOrderByIdentity(latestOrders, targetOrder);

      // Some sheet deployments only return active orders. Missing entry after cancel is acceptable.
      if (!matchedOrder) {
        return;
      }

      const cancelled = this.isShuttleStatusCancelled(String(matchedOrder.statusValue || matchedOrder.statusLabel || ''));
      if (cancelled) {
        return;
      }

      if (attempt < maxAttempts - 1) {
        await this.waitForShuttleSyncRetry(700);
      }
    }

    throw new Error(
      this.shuttleText(
        'העדכון לגליון לא אושר. נסה שוב בעוד רגע.',
        'Обновление в таблице не подтверждено. Повторите попытку через минуту.'
      )
    );
  }

  private findShuttleOrderByIdentity(
    orders: ShuttleOrderRecord[],
    targetOrder: ShuttleOrderRecord
  ): ShuttleOrderRecord | null {
    const targetDate = this.normalizeShuttleDateToIso(String(targetOrder.date || '').trim());
    const targetShift = this.normalizeShuttleShiftLabel(String(targetOrder.shiftLabel || targetOrder.shiftValue || '').trim());
    const targetStation = this.normalizeShuttleText(String(targetOrder.station || '').trim());

    for (const order of Array.isArray(orders) ? orders : []) {
      const orderDate = this.normalizeShuttleDateToIso(String(order.date || '').trim());
      const orderShift = this.normalizeShuttleShiftLabel(String(order.shiftLabel || order.shiftValue || '').trim());
      const orderStation = this.normalizeShuttleText(String(order.station || '').trim());
      if (orderDate === targetDate && orderShift === targetShift && orderStation === targetStation) {
        return order;
      }
    }

    return null;
  }

  private waitForShuttleSyncRetry(ms: number): Promise<void> {
    const delay = Math.max(0, Number(ms) || 0);
    return new Promise((resolve) => {
      setTimeout(resolve, delay);
    });
  }

  private normalizeShuttleDateToIso(value: string): string {
    const normalized = String(value || '').trim();
    if (!normalized) return '';
    if (/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
      return normalized;
    }

    const slashMatch = normalized.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (!slashMatch) {
      return '';
    }
    const month = String(Number(slashMatch[1])).padStart(2, '0');
    const day = String(Number(slashMatch[2])).padStart(2, '0');
    const year = slashMatch[3];
    return `${year}-${month}-${day}`;
  }

  private resolveShuttleDayNameFromIso(dateIso: string): string {
    const parsed = this.parseShuttleDate(dateIso);
    if (!parsed) {
      return '';
    }
    const dayNames = SHUTTLE_DAY_NAMES_BY_LANGUAGE[this.getShuttleLanguage()];
    return dayNames[parsed.getDay()] || '';
  }

  private normalizeShuttleShiftLabel(value: string): string {
    const cleaned = String(value || '').trim().replace(/^'+/, '');
    const extracted = this.extractShuttleTimeLabel(cleaned);
    if (!extracted) {
      return cleaned;
    }
    return extracted;
  }

  private normalizeShuttleShiftValue(rawValue: string, shiftLabel: string): string {
    const cleanedRaw = String(rawValue || '').trim();
    if (cleanedRaw) {
      if (/^'\d{1,2}:\d{2}$/.test(cleanedRaw)) {
        const noQuote = cleanedRaw.slice(1);
        const normalizedLabel = this.normalizeShuttleShiftLabel(noQuote);
        return `'${normalizedLabel}`;
      }
      if (/^\d{1,2}:\d{2}$/.test(cleanedRaw)) {
        const normalizedLabel = this.normalizeShuttleShiftLabel(cleanedRaw);
        return `'${normalizedLabel}`;
      }
      const normalizedFromRaw = this.normalizeShuttleShiftLabel(cleanedRaw);
      if (/^\d{2}:\d{2}$/.test(normalizedFromRaw)) {
        return `'${normalizedFromRaw}`;
      }
      return cleanedRaw;
    }

    if (/^\d{2}:\d{2}$/.test(shiftLabel)) {
      return `'${shiftLabel}`;
    }
    return shiftLabel;
  }

  private extractShuttleTimeLabel(value: string): string {
    const normalized = String(value || '').trim();
    if (!normalized) {
      return '';
    }

    const hhmm = normalized.match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
    if (hhmm) {
      const hours = String(Number(hhmm[1])).padStart(2, '0');
      return `${hours}:${hhmm[2]}`;
    }

    const parsedDate = new Date(normalized);
    if (!Number.isNaN(parsedDate.getTime())) {
      const hours = String(parsedDate.getHours()).padStart(2, '0');
      const minutes = String(parsedDate.getMinutes()).padStart(2, '0');
      return `${hours}:${minutes}`;
    }

    const embedded = normalized.match(/(\d{1,2}):(\d{2})(?::\d{2})?/);
    if (embedded) {
      const hours = String(Number(embedded[1])).padStart(2, '0');
      return `${hours}:${embedded[2]}`;
    }

    return '';
  }

  private isShuttleStatusCancelled(statusValue: string): boolean {
    const rawStatus = String(statusValue ?? '').trim();
    if (!rawStatus) {
      return false;
    }
    if (/^0(?:\.0+)?$/.test(rawStatus)) {
      return true;
    }
    if (/^1(?:\.0+)?$/.test(rawStatus)) {
      return false;
    }

    const normalized = this.normalizeShuttleText(statusValue);
    if (!normalized) {
      return false;
    }
    return (
      normalized === 'cancel' ||
      normalized === 'cancelled' ||
      normalized === 'canceled' ||
      normalized === 'inactive' ||
      normalized === 'false' ||
      normalized.includes('ביטול') ||
      normalized.includes('בוטל') ||
      normalized.includes('отмена') ||
      normalized.includes('отмен')
    );
  }

  private async refreshShuttleAccessForCurrentUser(
    user: string,
    options: { force?: boolean } = {}
  ): Promise<void> {
    const normalizedUser = this.normalizeUser(user);
    const previousAccess = this.shuttleAccessAllowed();
    if (!normalizedUser) {
      this.shuttleAccessAllowed.set(false);
      return;
    }

    try {
      let employees: string[] = [];
      const now = Date.now();
      const mustRevalidateWhileDenied = !previousAccess;
      const hasFreshCache =
        !options.force &&
        !mustRevalidateWhileDenied &&
        this.shuttleEmployeesCache.items.length > 0 &&
        now - this.shuttleEmployeesCache.at < SHUTTLE_LIST_CACHE_TTL_MS;
      if (hasFreshCache) {
        employees = this.shuttleEmployeesCache.items;
      } else {
        employees = await this.fetchShuttleEmployeesCached();
      }

      if (!Array.isArray(employees) || employees.length === 0) {
        // Do not hide shuttle room on transient list fetch failures.
        this.shuttleAccessAllowed.set(previousAccess);
        return;
      }

      const allowed = this.isUserAllowedForShuttle(normalizedUser, employees);
      this.shuttleAccessAllowed.set(allowed);
      this.enforceShuttleAccessVisibility(normalizedUser, allowed);
    } catch {
      // Keep previous visibility on network/script errors.
      this.shuttleAccessAllowed.set(previousAccess);
    }
  }

  private isUserAllowedForShuttle(user: string, employees: string[]): boolean {
    const normalizedUser = this.normalizeUser(user);
    if (!normalizedUser) return false;
    if (!Array.isArray(employees) || employees.length === 0) {
      return false;
    }

    const userPhone = this.extractShuttlePhone(normalizedUser) || this.normalizePhone(normalizedUser);
    return employees.some((entry) => {
      const normalizedEntry = this.normalizeUser(String(entry || '').trim());
      if (!normalizedEntry) {
        return false;
      }
      if (normalizedEntry === normalizedUser) {
        return true;
      }
      const entryPhone = this.extractShuttlePhone(normalizedEntry);
      return Boolean(userPhone && entryPhone && userPhone === entryPhone);
    });
  }

  private enforceShuttleAccessVisibility(user: string, allowed: boolean): void {
    if (allowed) {
      return;
    }

    const active = this.activeChatId();
    if (active && this.isShuttleChat(active)) {
      this.activeChatId.set(null);
      this.lastActivatedChatMeta.set(null);
    }

    const shuttleIds = Array.from(this.shuttleChatIdSet);
    this.unreadByChat.update((current) => {
      let changed = false;
      const next = { ...current };
      for (const chatId of shuttleIds) {
        if (Object.prototype.hasOwnProperty.call(next, chatId)) {
          delete next[chatId];
          changed = true;
        }
      }
      return changed ? next : current;
    });
    this.messagesByChat.update((current) => {
      let changed = false;
      const next = { ...current };
      for (const chatId of shuttleIds) {
        if (Object.prototype.hasOwnProperty.call(next, chatId)) {
          delete next[chatId];
          changed = true;
        }
      }
      return changed ? next : current;
    });

    this.clearShuttleReminderTimersForUser(user);
    localStorage.removeItem(this.shuttleWelcomeKey(user));
    localStorage.removeItem(this.shuttleStateKey(user));
    localStorage.removeItem(this.shuttleOrdersKey(user));
    localStorage.removeItem(this.shuttleLanguageKey(user));
    const storedActive = this.getStoredActiveChat(user);
    if (storedActive && this.isShuttleChat(storedActive)) {
      localStorage.removeItem(this.activeChatKey(user));
    }
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
    const dayNames = SHUTTLE_DAY_NAMES_BY_LANGUAGE[this.getShuttleLanguage()];
    const today = new Date();
    const choices: ShuttleDateChoice[] = [];
    for (let i = 0; i < SHUTTLE_DATE_CHOICES_COUNT; i += 1) {
      const date = new Date(today);
      date.setDate(today.getDate() + i);
      const value = this.toIsoDate(date);
      const dayName = dayNames[date.getDay()] || '';
      choices.push({
        value,
        dayName,
        label: `${dayName} ${value}`
      });
    }
    return choices;
  }

  private getShuttleShiftOptionsForDate(dateIso: string): ShuttleQuickPickerOption[] {
    return SHUTTLE_SHIFT_OPTIONS.map((option) => ({
      value: option.label,
      label: option.label,
      submitValue: option.value,
      disabled: this.shouldDisableShuttleShiftForDate(dateIso, option.label)
    }));
  }

  private shouldDisableShuttleShiftForDate(dateIso: string, shiftLabel: string): boolean {
    const normalizedDate = this.normalizeShuttleDateToIso(String(dateIso || '').trim());
    if (!normalizedDate || normalizedDate !== this.toIsoDate(new Date())) {
      return false;
    }
    const normalizedShift = this.normalizeShuttleShiftLabel(shiftLabel);
    const shiftMinutes = this.parseShuttleShiftMinutes(normalizedShift);
    if (shiftMinutes < 0) {
      return false;
    }
    const now = new Date();
    const minimumAllowedMinutes = (now.getHours() * 60) + now.getMinutes() + 60;
    return shiftMinutes <= minimumAllowedMinutes;
  }

  private getShuttleMainMenuMessage(): string {
    return [
      this.shuttleText('היי, זהו חדר הזמנת ההסעה.', 'Здравствуйте, это чат заказа трансфера.'),
      this.shuttleText('בחר פעולה:', 'Выберите действие:'),
      `1. ${this.shuttleText('הזמנה חדשה', 'Новый заказ')}`,
      `2. ${this.shuttleText('הבקשות שלי', 'Мои заявки')}`,
      `3. ${this.shuttleText('ביטול הזמנה קיימת', 'Отменить существующий заказ')}`,
      this.shuttleText('אפשר להקליד 0 בכל שלב כדי לחזור לתפריט הראשי.', 'Можно ввести 0 на любом шаге, чтобы вернуться в главное меню.')
    ].join('\n');
  }

  private getShuttleDatePromptMessage(): string {
    const lines = this.getShuttleDateChoices().map((choice, index) => `${index + 1}. ${choice.label}`);
    return [this.shuttleText('בחר תאריך נסיעה:', 'Выберите дату поездки:'), ...lines].join('\n');
  }

  private getShuttleShiftPromptMessage(): string {
    const lines = SHUTTLE_SHIFT_OPTIONS.map((shift, index) => `${index + 1}. ${shift.label}`);
    return [this.shuttleText('בחר משמרת (הסעה לעבודה):', 'Выберите смену (трансфер на работу):'), ...lines].join('\n');
  }

  private getShuttleStationsPromptMessage(stations: string[]): string {
    const lines = stations.map((station, index) => `${index + 1}. ${station}`);
    return [this.shuttleText('בחר תחנה:', 'Выберите станцию:'), ...lines].join('\n');
  }

  private buildShuttleOrderSummary(order: ShuttleOrderRecord): string {
    const statusLabel = this.resolveShuttleStatusLabel(order.statusValue || order.statusLabel);
    const dayName = this.resolveShuttleDayNameFromIso(String(order.date || '').trim()) || String(order.dayName || '').trim();
    const dayAndDate = `${dayName} ${String(order.date || '').trim()}`.trim();
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
      .sort((a, b) => this.compareShuttleOrdersByDateTimeAsc(a, b));
  }

  private compareShuttleOrdersByDateTimeAsc(a: ShuttleOrderRecord, b: ShuttleOrderRecord): number {
    const aSort = this.getShuttleOrderDateTimeSortKey(a);
    const bSort = this.getShuttleOrderDateTimeSortKey(b);
    if (aSort !== bSort) {
      return aSort - bSort;
    }
    const timeDelta = Number(a.submittedAt || 0) - Number(b.submittedAt || 0);
    if (timeDelta !== 0) {
      return timeDelta;
    }
    return String(a.id || '').localeCompare(String(b.id || ''));
  }

  private getShuttleOrderDateTimeSortKey(order: ShuttleOrderRecord): number {
    const date = this.parseShuttleDate(order.date);
    const base = date ? date.getTime() : Number(order.submittedAt || 0) || 0;
    const shiftText = this.normalizeShuttleShiftLabel(String(order.shiftLabel || order.shiftValue || '').trim());
    const shiftMinutes = this.parseShuttleShiftMinutes(shiftText);
    if (date && shiftMinutes >= 0) {
      return base + shiftMinutes * 60 * 1000;
    }
    return base;
  }

  private parseShuttleShiftMinutes(shiftLabel: string): number {
    const match = String(shiftLabel || '').trim().match(/^(\d{2}):(\d{2})$/);
    if (!match) {
      return -1;
    }
    const hours = Number(match[1]);
    const minutes = Number(match[2]);
    if (!Number.isFinite(hours) || !Number.isFinite(minutes)) {
      return -1;
    }
    return hours * 60 + minutes;
  }

  private normalizeShuttleText(value: string): string {
    return String(value || '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
  }

  private parseShuttleMenuCommand(input: string): 'new' | '' {
    const trimmed = String(input || '').trim();
    if (!trimmed) return '';
    const normalized = this.normalizeShuttleText(trimmed);
    if (
      trimmed === '1' ||
      normalized.includes('חדש') ||
      normalized.includes('нов') ||
      normalized.includes('new')
    ) {
      return 'new';
    }
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
    const newOrderKey = this.buildShuttleOrderStatusGroupKey(order);
    const deduped = orders.filter((existing) => this.buildShuttleOrderStatusGroupKey(existing) !== newOrderKey);
    deduped.unshift(order);
    this.saveShuttleOrders(user, deduped.slice(0, 300));
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
        statusLabel: this.resolveShuttleStatusLabel(SHUTTLE_STATUS_CANCEL_VALUE),
        cancelledAt: Date.now()
      };
    });
    this.saveShuttleOrders(user, updated);
  }

  private async resolveShuttleEmployeeValue(user: string): Promise<string> {
    const normalizedUser = this.normalizeUser(user);
    const userPhone = this.extractShuttlePhone(user);
    const displayName = String(this.getDisplayName(user) || '').trim();
    const preferredFullName = this.normalizeShuttleEmployeeName(displayName);
    const employees = await this.fetchShuttleEmployeesCached();

    if (employees.length) {
      const exact = employees.find((entry) => this.normalizeUser(entry) === normalizedUser);
      if (exact) return this.formatShuttleEmployeeLabel(exact, userPhone || normalizedUser, preferredFullName);

      if (userPhone) {
        const byPhone = employees.find((entry) => this.extractShuttlePhone(entry) === userPhone);
        if (byPhone) return this.formatShuttleEmployeeLabel(byPhone, userPhone, preferredFullName);
      }

      if (displayName) {
        const normalizedDisplayName = this.normalizeUser(displayName);
        const byName = employees.find((entry) =>
          this.normalizeUser(entry).includes(normalizedDisplayName)
        );
        if (byName) return this.formatShuttleEmployeeLabel(byName, userPhone || normalizedUser, preferredFullName);
      }
    }

    if (preferredFullName && userPhone && !preferredFullName.includes(userPhone)) {
      return `${preferredFullName} ${userPhone}`;
    }
    if (preferredFullName) return preferredFullName;
    return user;
  }

  private formatShuttleEmployeeLabel(
    value: string,
    fallbackPhone: string,
    preferredName: string
  ): string {
    const normalizedPhone = this.extractShuttlePhone(value) || this.extractShuttlePhone(fallbackPhone);
    const normalizedName = this.normalizeShuttleEmployeeName(value);
    const preferred = this.normalizeShuttleEmployeeName(preferredName);
    const bestName = this.shuttleNameWordCount(normalizedName) >= 2
      ? normalizedName
      : (
        this.shuttleNameWordCount(preferred) >= 2
          ? preferred
          : (normalizedName || preferred)
      );

    if (bestName && normalizedPhone) {
      return `${bestName} ${normalizedPhone}`;
    }
    if (bestName) {
      return bestName;
    }
    if (normalizedPhone) {
      return normalizedPhone;
    }
    return String(value || '').trim();
  }

  private normalizeShuttleEmployeeName(value: string): string {
    const source = String(value || '').trim();
    if (!source) return '';
    return source
      .replace(/\(([^)]*)\)/g, ' ')
      .replace(/\d+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private shuttleNameWordCount(value: string): number {
    const normalized = this.normalizeShuttleEmployeeName(value);
    if (!normalized) return 0;
    return normalized.split(/\s+/).filter(Boolean).length;
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
    if (this.isShuttleStatusCancelled(String(order.statusValue || '').trim())) {
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
    const normalized = this.normalizeShuttleDateToIso(String(value || '').trim());
    if (!normalized) {
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

  private shuttleLanguageKey(user: string): string {
    return `${SHUTTLE_LANGUAGE_KEY_PREFIX}${this.normalizeUser(user)}`;
  }

  private loadShuttleLanguage(user: string): ShuttleLanguage {
    const raw = localStorage.getItem(this.shuttleLanguageKey(user));
    return this.resolveShuttleLanguage(raw);
  }

  private resolveShuttleLanguage(rawValue: unknown): ShuttleLanguage {
    const normalized = String(rawValue || '').trim().toLowerCase();
    if (normalized === 'ru') {
      return 'ru';
    }
    if (normalized === 'he') {
      return 'he';
    }
    return this.defaultShuttleLanguage();
  }

  private defaultShuttleLanguage(): ShuttleLanguage {
    if (typeof navigator === 'undefined') {
      return 'he';
    }
    const languages = [navigator.language, ...(Array.isArray(navigator.languages) ? navigator.languages : [])]
      .map((value) => String(value || '').trim().toLowerCase())
      .filter(Boolean);
    return languages.some((value) => value.startsWith('ru')) ? 'ru' : 'he';
  }

  private shuttleText(he: string, ru: string): string {
    return this.getShuttleLanguage() === 'ru' ? ru : he;
  }

  private resolveShuttleStatusLabel(statusValue: string): string {
    const isCancelled = this.isShuttleStatusCancelled(statusValue);
    return isCancelled
      ? this.shuttleText('בוטל', 'Отменен')
      : this.shuttleText('פעיל', 'Активен');
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
          statusValue: String(item.statusValue ?? SHUTTLE_STATUS_ACTIVE_VALUE).trim(),
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
    this.rescheduleShuttleRemindersForUser(user);
    this.bumpShuttlePickerRevision();
  }

  private rescheduleShuttleRemindersForUser(user: string): void {
    if (typeof window === 'undefined') {
      return;
    }
    const normalizedUser = this.normalizeUser(user);
    if (!normalizedUser) {
      return;
    }

    this.clearShuttleReminderTimersForUser(normalizedUser);
    const orders = this.loadShuttleOrders(normalizedUser);
    const activeReminderKeys = new Set<string>();
    orders.forEach((order) => {
      if (!this.isShuttleOrderOngoing(order)) {
        return;
      }
      const reminderKey = this.buildShuttleReminderKey(order);
      if (!reminderKey) {
        return;
      }
      activeReminderKeys.add(reminderKey);
      this.scheduleShuttleReminderIfNeeded(normalizedUser, order, reminderKey);
    });
    this.pruneShuttleReminderHistory(normalizedUser, activeReminderKeys);
  }

  private scheduleShuttleReminderIfNeeded(
    user: string,
    order: ShuttleOrderRecord,
    reminderKey: string
  ): void {
    const tripAt = this.getShuttleOrderEventTimestamp(order);
    if (tripAt === null || !Number.isFinite(tripAt) || tripAt <= 0) {
      return;
    }
    if (tripAt <= Date.now()) {
      return;
    }
    if (this.hasShuttleReminderBeenSent(user, reminderKey)) {
      return;
    }

    const fireReminder = (): void => {
      if (this.normalizeUser(this.currentUser() || '') !== user) {
        return;
      }
      if (this.hasShuttleReminderBeenSent(user, reminderKey)) {
        return;
      }
      const latestOrder = this.loadShuttleOrders(user).find(
        (item) => this.buildShuttleReminderKey(item) === reminderKey && this.isShuttleOrderOngoing(item)
      );
      if (!latestOrder) {
        return;
      }
      const latestTripAt = this.getShuttleOrderEventTimestamp(latestOrder);
      if (latestTripAt === null || !Number.isFinite(latestTripAt) || latestTripAt <= Date.now()) {
        return;
      }

      this.markShuttleReminderSent(user, reminderKey);
      this.sendShuttle2HourReminderAlert(latestOrder, reminderKey);
    };

    const reminderAt = tripAt - SHUTTLE_REMINDER_LEAD_MS;
    if (reminderAt <= Date.now()) {
      fireReminder();
      return;
    }

    const timerStorageKey = `${user}|${reminderKey}`;
    const delayMs = reminderAt - Date.now();
    const timerId = setTimeout(() => {
      this.shuttleReminderTimersByKey.delete(timerStorageKey);
      fireReminder();
    }, delayMs);
    this.shuttleReminderTimersByKey.set(timerStorageKey, timerId);
  }

  private clearShuttleReminderTimersForUser(user: string): void {
    const normalizedUser = this.normalizeUser(user);
    if (!normalizedUser) {
      return;
    }
    const prefix = `${normalizedUser}|`;
    for (const [timerKey, timerId] of this.shuttleReminderTimersByKey.entries()) {
      if (!timerKey.startsWith(prefix)) {
        continue;
      }
      clearTimeout(timerId);
      this.shuttleReminderTimersByKey.delete(timerKey);
    }
  }

  private sendShuttle2HourReminderAlert(order: ShuttleOrderRecord, reminderKey: string): void {
    const activeSummary = this.buildShuttleOrderSummary({
      ...order,
      statusValue: SHUTTLE_STATUS_ACTIVE_VALUE,
      statusLabel: this.resolveShuttleStatusLabel(SHUTTLE_STATUS_ACTIVE_VALUE)
    });
    this.sendShuttleSystemMessage(`${this.shuttleText('⏰ תזכורת: נותרו כשעתיים להסעה שלך.', '⏰ Напоминание: до вашего трансфера осталось около двух часов.')}\n${activeSummary}`, {
      recordType: 'shuttle-reminder-2h'
    });
    this.showShuttleReminderBrowserNotification(order, reminderKey);
  }

  private showShuttleReminderBrowserNotification(order: ShuttleOrderRecord, reminderKey: string): void {
    if (typeof window === 'undefined' || typeof Notification === 'undefined') {
      return;
    }
    if (Notification.permission !== 'granted') {
      return;
    }

    const dayAndDate = `${this.resolveShuttleDayNameFromIso(String(order.date || '').trim()) || String(order.dayName || '').trim()} ${String(order.date || '').trim()}`.trim();
    const shift = String(order.shiftLabel || '').trim();
    const station = String(order.station || '').trim();
    const detailLine = [dayAndDate, shift, station].filter(Boolean).join(' | ');

    try {
      const notification = new Notification(
        this.shuttleText('תזכורת להסעה בעוד שעתיים', 'Напоминание о трансфере через 2 часа'),
        {
          body: detailLine || this.shuttleText('בדוק את פרטי ההזמנה בצ׳אט.', 'Проверьте детали заказа в чате.'),
          tag: `shuttle-reminder-2h:${reminderKey}`
        });
      notification.onclick = () => {
        try {
          window.focus();
        } catch {
          // Ignore focus failures on restricted browser contexts.
        }
        this.setActiveChat(this.normalizeChatId(SHUTTLE_CHAT_NAME));
        notification.close();
      };
    } catch {
      // Notification display is best-effort.
    }
  }

  private getShuttleOrderEventTimestamp(order: ShuttleOrderRecord): number | null {
    const date = this.parseShuttleDate(order.date);
    if (!date) {
      return null;
    }
    const shiftLabel = this.normalizeShuttleShiftLabel(String(order.shiftLabel || order.shiftValue || '').trim());
    const shiftMinutes = this.parseShuttleShiftMinutes(shiftLabel);
    if (shiftMinutes < 0) {
      return null;
    }
    return date.getTime() + shiftMinutes * 60 * 1000;
  }

  private buildShuttleReminderKey(order: ShuttleOrderRecord): string {
    const dateKey = this.normalizeShuttleDateToIso(String(order.date || '').trim());
    const shiftKey = this.normalizeShuttleShiftLabel(String(order.shiftLabel || order.shiftValue || '').trim());
    const stationKey = this.normalizeShuttleText(String(order.station || '').trim());
    if (!dateKey || !shiftKey || !stationKey) {
      return '';
    }
    return `${dateKey}|${shiftKey}|${stationKey}`;
  }

  private shuttleReminderHistoryKey(user: string): string {
    return `${SHUTTLE_REMINDER_HISTORY_KEY_PREFIX}${this.normalizeUser(user)}`;
  }

  private loadShuttleReminderHistory(user: string): Record<string, number> {
    try {
      const raw = localStorage.getItem(this.shuttleReminderHistoryKey(user));
      if (!raw) {
        return {};
      }
      const parsed = JSON.parse(raw) as unknown;
      if (!parsed || typeof parsed !== 'object') {
        return {};
      }
      const history: Record<string, number> = {};
      for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
        const normalizedKey = String(key || '').trim();
        const numericValue = Number(value || 0);
        if (!normalizedKey || !Number.isFinite(numericValue) || numericValue <= 0) {
          continue;
        }
        history[normalizedKey] = numericValue;
      }
      return history;
    } catch {
      return {};
    }
  }

  private saveShuttleReminderHistory(user: string, history: Record<string, number>): void {
    const compactEntries = Object.entries(history)
      .filter(([key, value]) => {
        const normalizedKey = String(key || '').trim();
        const numericValue = Number(value || 0);
        return Boolean(normalizedKey && Number.isFinite(numericValue) && numericValue > 0);
      })
      .sort((a, b) => Number(b[1]) - Number(a[1]))
      .slice(0, 500);
    const storageKey = this.shuttleReminderHistoryKey(user);
    if (!compactEntries.length) {
      localStorage.removeItem(storageKey);
      return;
    }
    localStorage.setItem(storageKey, JSON.stringify(Object.fromEntries(compactEntries)));
  }

  private hasShuttleReminderBeenSent(user: string, reminderKey: string): boolean {
    if (!reminderKey) {
      return false;
    }
    const history = this.loadShuttleReminderHistory(user);
    return Boolean(history[reminderKey]);
  }

  private markShuttleReminderSent(user: string, reminderKey: string): void {
    if (!reminderKey) {
      return;
    }
    const history = this.loadShuttleReminderHistory(user);
    history[reminderKey] = Date.now();
    this.saveShuttleReminderHistory(user, history);
  }

  private pruneShuttleReminderHistory(user: string, activeReminderKeys: Set<string>): void {
    const history = this.loadShuttleReminderHistory(user);
    const now = Date.now();
    const nextHistory: Record<string, number> = {};
    for (const [reminderKey, sentAtRaw] of Object.entries(history)) {
      const sentAt = Number(sentAtRaw || 0);
      if (activeReminderKeys.has(reminderKey)) {
        nextHistory[reminderKey] = Number.isFinite(sentAt) && sentAt > 0 ? sentAt : now;
        continue;
      }
      if (Number.isFinite(sentAt) && now - sentAt <= SHUTTLE_REMINDER_HISTORY_TTL_MS) {
        nextHistory[reminderKey] = sentAt;
      }
    }
    this.saveShuttleReminderHistory(user, nextHistory);
  }

  private buildShuttleOrderStatusGroupKey(order: ShuttleOrderRecord): string {
    const dateKey = this.normalizeShuttleDateToIso(String(order.date || '').trim()) || String(order.date || '').trim();
    const shiftKey = this.normalizeShuttleShiftLabel(String(order.shiftLabel || order.shiftValue || '').trim())
      || String(order.shiftValue || '').trim();
    const stationKey = this.normalizeShuttleText(String(order.station || '').trim());
    const statusSource = String(order.statusValue || order.statusLabel || '').trim();
    const statusKey = this.isShuttleStatusCancelled(statusSource) ? 'cancel' : 'active';

    if (!dateKey || !shiftKey || !stationKey) {
      return `id:${String(order.id || '').trim()}`;
    }
    return `${dateKey}|${shiftKey}|${stationKey}|${statusKey}`;
  }

  private bumpShuttlePickerRevision(): void {
    this.shuttlePickerRevision.update((value) => value + 1);
  }

  private sendShuttleSystemMessage(
    body: string,
    options: { imageUrl?: string | null; recordType?: string } = {}
  ): void {
    if (!this.shuttleAccessAllowed()) {
      return;
    }
    const chatId = this.normalizeChatId(SHUTTLE_CHAT_NAME);
    const message: ChatMessage = {
      id: this.generateId('rec'),
      messageId: this.generateId('shuttle'),
      chatId,
      sender: chatId,
      senderDisplayName: SHUTTLE_CHAT_TITLE,
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
    this.cancelTypingForActiveChat();
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
    if (this.isShuttleChat(chatId) && !this.shuttleAccessAllowed()) {
      throw new Error('אין הרשאה לחדר הזמנת הסעות');
    }

    const group = this.groups().find((item) => item.id === chatId) ?? null;
    if (group && (group.type === 'community' || this.isDovrutGroup(group.id)) && !this.canUserSendToCommunityGroup(group, user)) {
      this.lastError.set(
        this.isDovrutGroup(group.id)
          ? 'רק מנהלי החדר יכולים לשלוח בחדר זה'
          : 'רק מנהל יכול לשלוח בקבוצת קהילה'
      );
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
      const hrFlowInput = String(payload.hrFlowInput || payload.body).trim();
      const handledByHrFlow = await this.handleHrOutgoing(hrFlowInput);
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
      await this.sendReplyTransport(payload);
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
      groupAdmins: group.admins ?? [],
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

    const normalizedUser = this.normalizeUser(user);
    const recipients = Array.from(
      new Set(group.members.map((member) => this.normalizeUser(member)).filter(Boolean))
    ).filter((member) => member !== normalizedUser);
    if (!recipients.length) {
      this.setMessageStatus(messageId, 'sent');
      return;
    }

    try {
      await this.sendReplyTransport({
        ...basePayload,
        // Backward-compatible fallback if backend ignores membersToNotify.
        originalSender: recipients[0] || group.id,
        membersToNotify: recipients
      });
    } catch {
      this.queueGroupMessage(group, messageId, body, imageUrl, recipients, metadata);
      this.setMessageStatus(messageId, 'queued');
      return;
    }

    this.setMessageStatus(messageId, 'sent');
  }

  private async emitSocketWithAck(
    eventName: string,
    payload: unknown,
    timeoutMs = SOCKET_ACK_TIMEOUT_MS
  ): Promise<Record<string, unknown> | null> {
    if (!this.socket || !this.socketConnected) {
      return null;
    }

    return new Promise<Record<string, unknown> | null>((resolve) => {
      let settled = false;
      const done = (value: Record<string, unknown> | null): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutId);
        resolve(value);
      };
      const timeoutId = setTimeout(() => done(null), timeoutMs);
      try {
        this.socket?.emit(eventName, payload, (ackPayload: unknown) => {
          if (ackPayload && typeof ackPayload === 'object') {
            done(ackPayload as Record<string, unknown>);
            return;
          }
          done(null);
        });
      } catch {
        done(null);
      }
    });
  }

  private async sendReplyTransport(payload: ReplyPayload): Promise<void> {
    const ackPayload = await this.emitSocketWithAck('chat:reply', payload);
    const ackStatus = String(ackPayload?.['status'] ?? '').trim().toLowerCase();
    if (ackStatus === 'success') {
      return;
    }
    await this.api.sendDirectMessage(payload);
  }

  private async sendReactionTransport(payload: ReactionPayload): Promise<void> {
    const ackPayload = await this.emitSocketWithAck('chat:reaction', payload);
    const ackStatus = String(ackPayload?.['status'] ?? '').trim().toLowerCase();
    if (ackStatus === 'success') {
      return;
    }
    await this.api.sendReaction(payload);
  }

  private async sendTypingTransport(payload: TypingPayload): Promise<void> {
    const ackPayload = await this.emitSocketWithAck('chat:typing', payload, 2500);
    const ackStatus = String(ackPayload?.['status'] ?? '').trim().toLowerCase();
    if (ackStatus === 'success') {
      return;
    }
    try {
      await this.api.sendTypingState(payload);
    } catch {
      // Typing indicators are best-effort only.
    }
  }

  private buildTypingPayload(chatId: string, isTyping: boolean): TypingPayload | null {
    const user = this.normalizeUser(this.currentUser() ?? '');
    const normalizedChatId = this.normalizeChatId(chatId);
    if (!user || !normalizedChatId) {
      return null;
    }
    const group = this.groups().find((item) => item.id === normalizedChatId) ?? null;
    if (group) {
      const groupMembers = Array.from(
        new Set(group.members.map((member) => this.normalizeUser(member)).filter(Boolean))
      ).filter((member) => member !== user);
      if (!groupMembers.length) {
        return null;
      }
      return {
        user,
        isTyping,
        chatId: normalizedChatId,
        groupId: group.id,
        groupName: group.name,
        groupMembers
      };
    }
    if (this.isSystemChat(normalizedChatId)) {
      return null;
    }
    return {
      user,
      isTyping,
      chatId: normalizedChatId,
      targetUser: normalizedChatId
    };
  }

  reportTypingActivity(rawText: string): void {
    const text = String(rawText ?? '');
    const activeChatId = this.activeChatId();
    if (!activeChatId || !this.canSendToActiveChat()) {
      this.cancelTypingForActiveChat();
      return;
    }

    if (!text.trim()) {
      this.cancelTypingForActiveChat();
      return;
    }

    if (!this.networkOnline()) {
      return;
    }

    const now = Date.now();
    const shouldSendTyping = (
      !this.typingStateActive ||
      this.typingStateChatId !== activeChatId ||
      now - this.typingLastSentAt >= TYPING_HEARTBEAT_MS
    );
    if (shouldSendTyping) {
      const payload = this.buildTypingPayload(activeChatId, true);
      if (payload) {
        this.typingStateActive = true;
        this.typingStateChatId = activeChatId;
        this.typingLastSentAt = now;
        void this.sendTypingTransport(payload);
      }
    }

    if (this.typingStopTimer) {
      clearTimeout(this.typingStopTimer);
    }
    this.typingStopTimer = setTimeout(() => {
      this.cancelTypingForActiveChat();
    }, TYPING_IDLE_MS);
  }

  cancelTypingForActiveChat(): void {
    if (this.typingStopTimer) {
      clearTimeout(this.typingStopTimer);
      this.typingStopTimer = null;
    }
    const activeTypingChat = this.typingStateChatId;
    const wasTyping = this.typingStateActive;
    this.typingStateActive = false;
    this.typingStateChatId = null;
    this.typingLastSentAt = 0;
    if (!wasTyping || !activeTypingChat || !this.networkOnline()) {
      return;
    }
    const payload = this.buildTypingPayload(activeTypingChat, false);
    if (!payload) {
      return;
    }
    void this.sendTypingTransport(payload);
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
    } catch (err) {
      console.warn('[ChatStore] Failed to flush read receipts for chat:', normalizedChatId, err);
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
    const targets = Array.from(
      new Set(
        (recipients ? recipients : group.members)
          .map((member) => this.normalizeUser(member))
          .filter(Boolean)
      )
    ).filter((member) => member !== user);
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
        groupAdmins: group.admins ?? [],
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
    if (!this.isNetworkReachable()) {
      return;
    }
    void this.connectSocketPreferred(user);
  }

  private setRealtimeTransportMode(mode: RealtimeTransportMode): void {
    if (this.realtimeTransportMode() === mode) {
      return;
    }
    this.realtimeTransportMode.set(mode);
  }

  private resetSocketFailureState(): void {
    this.socketConsecutiveFailures = 0;
    this.socketDisabledUntil = 0;
  }

  private handleSocketConnectFailure(user: string): void {
    if (this.currentUser() !== user) {
      return;
    }
    this.socketConsecutiveFailures += 1;
    this.startSseFallback(user);

    if (this.socketConsecutiveFailures >= SOCKET_MAX_FAILURES_BEFORE_COOLDOWN) {
      this.socketConsecutiveFailures = 0;
      this.socketDisabledUntil = Date.now() + SOCKET_FAILURE_COOLDOWN_MS;
    }

    this.scheduleSocketReconnect(user);
  }

  private async connectSocketPreferred(user: string): Promise<void> {
    this.shuttingDownRealtime = false;
    if (this.socketDisabledUntil > Date.now()) {
      this.startSseFallback(user);
      this.scheduleSocketReconnect(user);
      return;
    }
    if (!this.isNetworkReachable()) {
      this.startSseFallback(user);
      return;
    }
    if (this.socketConnecting) {
      return;
    }
    this.socketConnecting = true;

    if (this.socketSseFallbackTimer) {
      clearTimeout(this.socketSseFallbackTimer);
      this.socketSseFallbackTimer = null;
    }

    this.socketSseFallbackTimer = setTimeout(() => {
      this.socketSseFallbackTimer = null;
      if (!this.socketConnected && this.currentUser() === user) {
        this.startSseFallback(user);
      }
    }, SOCKET_FALLBACK_TO_SSE_DELAY_MS);

    try {
      const socket = await this.api.createRealtimeSocket(user);
      if (this.currentUser() !== user) {
        socket.disconnect();
        return;
      }
      this.shuttingDownRealtime = true;
      this.stopSocketOnly();
      this.shuttingDownRealtime = false;
      this.socket = socket;

      socket.on('connect', () => {
        if (this.currentUser() !== user) return;
        this.resetSocketFailureState();
        this.socketConnected = true;
        this.socketConnecting = false;
        this.setRealtimeTransportMode('socket');
        if (this.socketSseFallbackTimer) {
          clearTimeout(this.socketSseFallbackTimer);
          this.socketSseFallbackTimer = null;
        }
        this.stopStreamOnly();
        this.clearTypingIndicators();
      });

      socket.on('chat:message', (incoming: unknown) => {
        if (!incoming || typeof incoming !== 'object') return;
        this.handleIncomingPayload(incoming as IncomingServerMessage);
      });

      socket.on('chat:connected', () => {
        if (this.currentUser() !== user) return;
        this.resetSocketFailureState();
        this.socketConnected = true;
        this.setRealtimeTransportMode('socket');
        this.stopStreamOnly();
      });

      socket.on('disconnect', () => {
        if (this.shuttingDownRealtime || this.currentUser() !== user) return;
        this.shuttingDownRealtime = true;
        this.stopSocketOnly();
        this.shuttingDownRealtime = false;
        this.socketConnected = false;
        this.socketConnecting = false;
        this.setRealtimeTransportMode('polling');
        this.handleSocketConnectFailure(user);
      });

      socket.on('connect_error', () => {
        if (this.shuttingDownRealtime || this.currentUser() !== user) return;
        this.shuttingDownRealtime = true;
        this.stopSocketOnly();
        this.shuttingDownRealtime = false;
        this.socketConnected = false;
        this.socketConnecting = false;
        this.setRealtimeTransportMode('polling');
        this.handleSocketConnectFailure(user);
      });

      socket.connect();
    } catch {
      this.shuttingDownRealtime = true;
      this.stopSocketOnly();
      this.shuttingDownRealtime = false;
      this.socketConnecting = false;
      this.socketConnected = false;
      this.setRealtimeTransportMode('polling');
      this.handleSocketConnectFailure(user);
    }
  }

  private startSseFallback(user: string): void {
    if (this.socketConnected || !this.isNetworkReachable()) {
      return;
    }
    if (this.stream) {
      return;
    }
    try {
      this.stream = this.api.createMessageStream(user);
      this.setRealtimeTransportMode('sse');
      this.stream.addEventListener('message', (event: MessageEvent<string>) => {
        this.handleIncomingPayload(event.data);
      });
      this.stream.addEventListener('connected', () => {
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

    if (!this.socketConnected && !this.stream) {
      this.setRealtimeTransportMode('polling');
    }

    void this.pullMessages(user);
  }

  private stopSocketOnly(): void {
    this.socketConnected = false;
    this.socketConnecting = false;
    if (this.socket) {
      this.socket.disconnect();
      this.socket = null;
    }
    if (this.stream) {
      this.setRealtimeTransportMode('sse');
    } else {
      this.setRealtimeTransportMode('polling');
    }
  }

  private stopStreamOnly(): void {
    if (this.stream) {
      this.stream.close();
      this.stream = null;
    }
    if (!this.socketConnected) {
      this.setRealtimeTransportMode('polling');
    }
  }

  private stopRealtime(): void {
    this.shuttingDownRealtime = true;
    this.cancelTypingForActiveChat();
    this.clearTypingIndicators();
    this.stopSocketOnly();
    this.stopStreamOnly();

    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.socketReconnectTimer) {
      clearTimeout(this.socketReconnectTimer);
      this.socketReconnectTimer = null;
    }
    if (this.socketSseFallbackTimer) {
      clearTimeout(this.socketSseFallbackTimer);
      this.socketSseFallbackTimer = null;
    }
    if (this.typingStopTimer) {
      clearTimeout(this.typingStopTimer);
      this.typingStopTimer = null;
    }
    this.setRealtimeTransportMode('polling');
    this.shuttingDownRealtime = false;
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
      await this.refreshShuttleAccessForCurrentUser(user, { force: true });
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
      .map((item) => `${item.username}|${item.displayName}|${item.info || ''}|${item.phone || ''}|${item.upic || ''}|${this.normalizeContactStatus(item.status) ?? ''}`)
      .join('\n');
    const nextSignature = next
      .map((item) => `${item.username}|${item.displayName}|${item.info || ''}|${item.phone || ''}|${item.upic || ''}|${this.normalizeContactStatus(item.status) ?? ''}`)
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
    if (this.socketConnected || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.currentUser() !== user) return;
      this.startSseFallback(user);
    }, STREAM_RETRY_MS);
  }

  private scheduleSocketReconnect(user: string): void {
    if (this.socketReconnectTimer) return;
    const waitMs = this.socketDisabledUntil > Date.now()
      ? Math.max(SOCKET_RETRY_MS, this.socketDisabledUntil - Date.now())
      : SOCKET_RETRY_MS;
    this.socketReconnectTimer = setTimeout(() => {
      this.socketReconnectTimer = null;
      if (this.currentUser() !== user || !this.isNetworkReachable()) return;
      void this.connectSocketPreferred(user);
    }, waitMs);
  }

  private async pullMessages(user: string): Promise<void> {
    if (this.pullInFlight || !this.isNetworkReachable()) return;
    if (this.currentUser() !== user) return;

    this.pullInFlight = true;
    try {
      const messages = await this.api.pollMessages();
      this.incrementDeliveryTelemetry('pollMessagesFetched', messages.length);
      const appliedCount = this.applyIncomingMessagesBatch(messages);
      this.incrementDeliveryTelemetry('pollMessagesApplied', appliedCount);
    } catch {
      // Polling failures are expected during network interruptions.
    } finally {
      this.pullInFlight = false;
    }
  }

  private applyIncomingMessagesBatch(
    messages: IncomingServerMessage[],
    options: {
      incrementUnread?: boolean;
      trackReadReceipts?: boolean;
      applyActions?: boolean;
      updateGroupMetadata?: boolean;
    } = {}
  ): number {
    if (!Array.isArray(messages) || messages.length === 0) {
      return 0;
    }

    let appliedCount = 0;
    this.runIncomingBatch(() => {
      const bufferedRegularMessages: IncomingServerMessage[] = [];
      const deferredActions: IncomingServerMessage[] = [];
      const flushBufferedRegularMessages = (): void => {
        if (!bufferedRegularMessages.length) return;
        appliedCount += this.applyRegularIncomingMessagesBulk(bufferedRegularMessages, options);
        bufferedRegularMessages.length = 0;
      };

      for (const message of messages) {
        const incomingType = String(message.type ?? '').trim().toLowerCase();
        if (this.isIncomingActionType(incomingType)) {
          if (options.applyActions === false) {
            continue;
          }
          flushBufferedRegularMessages();
          const actionApplied = this.applyIncomingMessage(message);
          if (actionApplied) {
            appliedCount += 1;
            continue;
          }

          // Full sync batches can arrive out-of-order (action before base message).
          // Retry mutating actions once after all regular messages are applied.
          if (
            incomingType === 'delete-action' ||
            incomingType === 'edit-action' ||
            incomingType === 'reaction' ||
            incomingType === 'read-receipt'
          ) {
            deferredActions.push(message);
          }
          continue;
        }

        bufferedRegularMessages.push(message);
      }

      flushBufferedRegularMessages();
      if (deferredActions.length) {
        for (const deferredAction of deferredActions) {
          if (this.applyIncomingMessage(deferredAction)) {
            appliedCount += 1;
          }
        }
      }
    });

    return appliedCount;
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

  private applyRegularIncomingMessagesBulk(
    messages: IncomingServerMessage[],
    options: {
      incrementUnread?: boolean;
      trackReadReceipts?: boolean;
      updateGroupMetadata?: boolean;
    } = {}
  ): number {
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
      const currentUser = this.normalizeUser(this.currentUser() ?? '');
      const incomingToUser = this.normalizeChatId(String(incoming.toUser ?? incoming.recipient ?? '').trim());
      const isOutgoingFromCurrentUser = Boolean(currentUser && sender === currentUser);

      const isGroup = Boolean(incoming.groupId);
      const chatId = isGroup
        ? this.normalizeChatId(incoming.groupId ?? '')
        : (
          isOutgoingFromCurrentUser && incomingToUser && incomingToUser !== currentUser
            ? incomingToUser
            : this.normalizeChatId(sender)
        );
      if (!chatId) continue;
      if (this.isShuttleChat(chatId) && !this.shuttleAccessAllowed()) {
        continue;
      }

      const messageId = String(incoming.messageId ?? this.generateId('srv')).trim();
      if (!messageId) continue;
      const incomingBody = this.resolveIncomingMessageBody(incoming);
      const incomingImageUrl = this.resolveIncomingImageUrl(incoming);
      const incomingTimestampRaw = Number(incoming.timestamp ?? Date.now());
      const incomingTimestamp = Number.isFinite(incomingTimestampRaw) && incomingTimestampRaw > 0
        ? incomingTimestampRaw
        : Date.now();
      const normalizedGroupId = isGroup ? this.normalizeChatId(incoming.groupId ?? '') : '';
      const semanticDedupToleranceMs = this.resolveIncomingSemanticDedupToleranceMs({
        sender,
        isGroup
      });

      const knownMessageIds = getMessageIdSet(chatId);
      const deletedTombstone = this.getDeletedMessageTombstone(messageId);
      if (deletedTombstone) {
        const hadMessageInList = knownMessageIds.has(messageId);
        knownMessageIds.add(messageId);
        if (hadMessageInList) {
          const list = getMutableList(chatId);
          if (this.applyMessageDeleteInMutableList(list, messageId, deletedTombstone)) {
            messagesChanged = true;
            appliedCount += 1;
          }
        }
        continue;
      }

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
      if (this.isSuppressedByDeletedIncomingFingerprint({
        chatId,
        sender,
        body: incomingBody,
        imageUrl: incomingImageUrl,
        timestamp: incomingTimestamp
      })) {
        this.rememberDeletedMessageTombstone(messageId, incomingTimestamp);
        knownMessageIds.add(messageId);
        continue;
      }

      const list = getMutableList(chatId);
      const equivalentMessageIndex = this.findEquivalentIncomingMessageIndex(list, {
        sender,
        body: incomingBody,
        imageUrl: incomingImageUrl,
        timestamp: incomingTimestamp,
        groupId: normalizedGroupId || null,
        toleranceMs: semanticDedupToleranceMs
      });
      if (equivalentMessageIndex >= 0) {
        // Treat same-content/same-time messages as duplicates even if backend messageId differs.
        knownMessageIds.add(messageId);
        continue;
      }

      if (options.updateGroupMetadata !== false && isGroup && incoming.groupId && incoming.groupName) {
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
        direction: isOutgoingFromCurrentUser ? 'outgoing' : 'incoming',
        timestamp: incomingTimestamp,
        deliveryStatus: 'delivered',
        groupId: normalizedGroupId || null,
        groupName: incoming.groupName ?? null,
        groupType: normalizedIncomingGroupType,
        editedAt: Number.isFinite(Number(incoming.editedAt)) ? Number(incoming.editedAt) : null,
        deletedAt: Number.isFinite(Number(incoming.deletedAt)) ? Number(incoming.deletedAt) : null,
        replyTo,
        forwarded: Boolean(incoming.forwarded),
        forwardedFrom: forwardedFrom || null,
        forwardedFromName: forwardedFromName || null
      };

      if (!list.length || list[list.length - 1].timestamp <= record.timestamp) {
        list.push(record);
      } else {
        const insertAt = this.findMessageInsertIndexByTimestamp(list, record.timestamp);
        list.splice(insertAt, 0, record);
      }

      knownMessageIds.add(messageId);
      messagesChanged = true;
      appliedCount += 1;

      if (
        options.trackReadReceipts !== false &&
        !isGroup &&
        !isOutgoingFromCurrentUser &&
        !this.isSystemChat(chatId)
      ) {
        this.trackIncomingMessageForReadReceipt(chatId, messageId);
      }

      if (
        options.incrementUnread !== false &&
        !isOutgoingFromCurrentUser &&
        this.shouldIncrementUnreadForChat(chatId)
      ) {
        nextUnreadMap[chatId] = (nextUnreadMap[chatId] ?? 0) + 1;
        unreadChanged = true;
      }
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

  private handleIncomingPayload(rawData: string | IncomingServerMessage): void {
    try {
      this.incrementDeliveryTelemetry('ssePayloadReceived');
      const message = typeof rawData === 'string'
        ? (JSON.parse(rawData) as IncomingServerMessage)
        : rawData;
      if (this.applyIncomingMessage(message)) {
        this.incrementDeliveryTelemetry('sseMessageApplied');
      } else {
        this.incrementDeliveryTelemetry('sseMessageNoop');
      }
    } catch {
      // Ignore malformed realtime payloads.
    }
  }

  private typingTimerKey(chatId: string, user: string): string {
    return `${chatId}::${user}`;
  }

  private clearTypingIndicators(): void {
    this.typingUsersByChat.set({});
    this.typingCleanupTimers.forEach((timer) => clearTimeout(timer));
    this.typingCleanupTimers.clear();
  }

  private clearTypingIndicatorForUser(chatId: string, user: string): void {
    const normalizedChatId = this.normalizeChatId(chatId);
    const normalizedUser = this.normalizeUser(user);
    if (!normalizedChatId || !normalizedUser) {
      return;
    }

    const timerKey = this.typingTimerKey(normalizedChatId, normalizedUser);
    const cleanupTimer = this.typingCleanupTimers.get(timerKey);
    if (cleanupTimer) {
      clearTimeout(cleanupTimer);
      this.typingCleanupTimers.delete(timerKey);
    }

    const current = this.typingUsersByChat();
    const users = current[normalizedChatId] ?? [];
    if (!users.includes(normalizedUser)) {
      return;
    }
    const nextUsers = users.filter((entry) => entry !== normalizedUser);
    const nextState: Record<string, string[]> = { ...current };
    if (nextUsers.length) {
      nextState[normalizedChatId] = nextUsers;
    } else {
      delete nextState[normalizedChatId];
    }
    this.typingUsersByChat.set(nextState);
  }

  private applyIncomingTypingSignal(incoming: IncomingServerMessage): boolean {
    const sender = this.normalizeUser(incoming.sender ?? '');
    if (!sender || sender === this.normalizeUser(this.currentUser() ?? '')) {
      return false;
    }
    const groupChatId = this.normalizeChatId(incoming.groupId ?? incoming.chatId ?? '');
    const chatId = groupChatId || this.normalizeChatId(sender);
    if (!chatId) {
      return false;
    }

    const shouldMarkTyping = incoming.isTyping !== false;
    if (!shouldMarkTyping) {
      this.clearTypingIndicatorForUser(chatId, sender);
      return true;
    }

    const current = this.typingUsersByChat();
    const users = current[chatId] ?? [];
    if (!users.includes(sender)) {
      this.typingUsersByChat.set({
        ...current,
        [chatId]: [...users, sender]
      });
    }

    const timerKey = this.typingTimerKey(chatId, sender);
    const existingTimer = this.typingCleanupTimers.get(timerKey);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }
    const cleanupTimer = setTimeout(() => {
      this.clearTypingIndicatorForUser(chatId, sender);
    }, TYPING_STALE_MS);
    this.typingCleanupTimers.set(timerKey, cleanupTimer);
    return true;
  }

  private applyIncomingMessage(incoming: IncomingServerMessage): boolean {
    const incomingType = String(incoming.type ?? '').trim().toLowerCase();
    if (incomingType === 'typing') {
      return this.applyIncomingTypingSignal(incoming);
    }
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
    if (incomingType === 'typing') {
      return this.applyIncomingTypingSignal(incoming);
    }

    const sender = this.normalizeUser(incoming.sender ?? '');
    if (!sender) return false;
    const currentUser = this.normalizeUser(this.currentUser() ?? '');
    const incomingToUser = this.normalizeChatId(String(incoming.toUser ?? incoming.recipient ?? '').trim());
    const isOutgoingFromCurrentUser = Boolean(currentUser && sender === currentUser);

    const isGroup = Boolean(incoming.groupId);
    const chatId = isGroup
      ? this.normalizeChatId(incoming.groupId ?? '')
      : (
        isOutgoingFromCurrentUser && incomingToUser && incomingToUser !== currentUser
          ? incomingToUser
          : this.normalizeChatId(sender)
      );
    if (!chatId) return false;
    if (this.isShuttleChat(chatId) && !this.shuttleAccessAllowed()) {
      return false;
    }

    const messageId = String(incoming.messageId ?? this.generateId('srv')).trim();
    if (!messageId) return false;
    const incomingBody = this.resolveIncomingMessageBody(incoming);
    const incomingImageUrl = this.resolveIncomingImageUrl(incoming);
    const incomingTimestampRaw = Number(incoming.timestamp ?? Date.now());
    const incomingTimestamp = Number.isFinite(incomingTimestampRaw) && incomingTimestampRaw > 0
      ? incomingTimestampRaw
      : Date.now();
    const normalizedGroupId = incoming.groupId ? this.normalizeChatId(incoming.groupId ?? '') : null;
    const semanticDedupToleranceMs = this.resolveIncomingSemanticDedupToleranceMs({
      sender,
      isGroup
    });
    const deletedTombstone = this.getDeletedMessageTombstone(messageId);
    if (deletedTombstone) {
      const changed = this.applyMessageDeleteLocally(messageId, deletedTombstone, { skipPersist: true });
      if (changed) {
        this.schedulePersist();
      }
      return changed;
    }

    this.clearTypingIndicatorForUser(chatId, sender);

    const alreadyExists = (this.messagesByChat()[chatId] ?? []).some(
      (message) => message.messageId === messageId
    );
    if (alreadyExists) {
      return this.hydrateExistingIncomingMessage(chatId, messageId, incomingBody, incomingImageUrl);
    }
    if (!this.hasRenderableIncomingContent(incomingBody, incomingImageUrl)) {
      return false;
    }
    if (this.isSuppressedByDeletedIncomingFingerprint({
      chatId,
      sender,
      body: incomingBody,
      imageUrl: incomingImageUrl,
      timestamp: incomingTimestamp
    })) {
      this.rememberDeletedMessageTombstone(messageId, incomingTimestamp);
      return false;
    }
    const existingChatMessages = this.messagesByChat()[chatId] ?? [];
    const equivalentMessageIndex = this.findEquivalentIncomingMessageIndex(existingChatMessages, {
      sender,
      body: incomingBody,
      imageUrl: incomingImageUrl,
      timestamp: incomingTimestamp,
      groupId: normalizedGroupId,
      toleranceMs: semanticDedupToleranceMs
    });
    if (equivalentMessageIndex >= 0) {
      return false;
    }

    if (isGroup && incoming.groupId && incoming.groupName) {
      this.ensureGroupFromIncoming(incoming);
    }
    this.clearTypingIndicatorForUser(chatId, sender);
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
      direction: isOutgoingFromCurrentUser ? 'outgoing' : 'incoming',
      timestamp: incomingTimestamp,
      deliveryStatus: 'delivered',
      groupId: normalizedGroupId,
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
    if (!isGroup && !isOutgoingFromCurrentUser && !this.isSystemChat(chatId)) {
      this.trackIncomingMessageForReadReceipt(chatId, messageId);
    }

    if (!isOutgoingFromCurrentUser && this.shouldIncrementUnreadForChat(chatId)) {
      this.unreadByChat.update((map) => ({
        ...map,
        [chatId]: (map[chatId] ?? 0) + 1
      }));
    }

    this.schedulePersist();
    return true;
  }

  private shouldIncrementUnreadForChat(chatId: string): boolean {
    const normalizedChatId = this.normalizeChatId(chatId);
    if (!normalizedChatId) {
      return true;
    }
    const activeChatId = this.normalizeChatId(this.activeChatId() ?? '');
    if (!activeChatId || activeChatId !== normalizedChatId) {
      return true;
    }
    return !this.isAppInForeground();
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

  private normalizeIncomingTextForDedup(value: string): string {
    return String(value || '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private findEquivalentIncomingMessageIndex(
    list: ChatMessage[],
    candidate: {
      sender: string;
      body: string;
      imageUrl: string | null;
      timestamp: number;
      groupId: string | null;
      toleranceMs?: number;
    }
  ): number {
    const candidateSender = this.normalizeUser(candidate.sender);
    const candidateBody = this.normalizeIncomingTextForDedup(candidate.body);
    const candidateImage = String(candidate.imageUrl || '').trim();
    const candidateTimestamp = Number(candidate.timestamp) || 0;
    const candidateGroupId = this.normalizeChatId(String(candidate.groupId || ''));
    const toleranceMs = Math.max(
      INCOMING_SEMANTIC_DEDUP_TIMESTAMP_TOLERANCE_MS,
      Math.floor(Number(candidate.toleranceMs || INCOMING_SEMANTIC_DEDUP_TIMESTAMP_TOLERANCE_MS))
    );
    if (!candidateSender || !Number.isFinite(candidateTimestamp)) {
      return -1;
    }
    if (!candidateBody && !candidateImage) {
      return -1;
    }

    return list.findIndex((message) => {
      if (!message || message.direction !== 'incoming' || message.deletedAt) {
        return false;
      }
      if (this.normalizeUser(message.sender) !== candidateSender) {
        return false;
      }
      const messageGroupId = this.normalizeChatId(String(message.groupId || ''));
      if (candidateGroupId && messageGroupId !== candidateGroupId) {
        return false;
      }
      const messageBody = this.normalizeIncomingTextForDedup(message.body);
      const messageImage = String(message.imageUrl || '').trim();
      if (messageBody !== candidateBody || messageImage !== candidateImage) {
        return false;
      }
      const messageTimestamp = Number(message.timestamp) || 0;
      return Math.abs(messageTimestamp - candidateTimestamp) <= toleranceMs;
    });
  }

  private resolveIncomingSemanticDedupToleranceMs(
    context: { sender: string; isGroup: boolean }
  ): number {
    if (context.isGroup) {
      return INCOMING_SEMANTIC_DEDUP_TIMESTAMP_TOLERANCE_MS;
    }
    const normalizedSender = this.normalizeUser(String(context.sender || '').trim());
    if (!normalizedSender) {
      return INCOMING_SEMANTIC_DEDUP_TIMESTAMP_TOLERANCE_MS;
    }
    if (this.isLikelyPhoneIdentity(normalizedSender)) {
      return INCOMING_SEMANTIC_DEDUP_TIMESTAMP_TOLERANCE_MS;
    }
    // System/non-phone senders are often injected by multiple pipelines with different IDs.
    return INCOMING_SYSTEM_SEMANTIC_DEDUP_TIMESTAMP_TOLERANCE_MS;
  }

  private isLikelyPhoneIdentity(value: string): boolean {
    const digits = String(value || '').replace(/\D/g, '');
    return (
      /^0\d{9}$/.test(digits) ||
      /^5\d{8}$/.test(digits) ||
      /^9725\d{8}$/.test(digits) ||
      /^97205\d{8}$/.test(digits)
    );
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

  private applyMessageDeleteInMutableList(list: ChatMessage[], messageId: string, deletedAt: number): boolean {
    const index = list.findIndex((message) => message.messageId === messageId);
    if (index < 0) {
      return false;
    }
    const current = list[index];
    if (current.deletedAt) {
      return false;
    }
    this.rememberDeletedIncomingFingerprint(current, deletedAt);
    list[index] = {
      ...current,
      body: DELETED_MESSAGE_PLACEHOLDER,
      imageUrl: null,
      thumbnailUrl: null,
      editedAt: null,
      deletedAt
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
    let consumed = false;
    messageIds.forEach((messageId) => {
      this.rememberDeletedMessageTombstone(messageId, deletedAt);
      consumed = true;
      changed = this.applyMessageDeleteLocally(messageId, deletedAt, { skipPersist: true }) || changed;
    });
    if (changed) {
      this.schedulePersist();
    }
    return changed || consumed;
  }

  private applyIncomingReaction(incoming: IncomingServerMessage): boolean {
    const isGroup = Boolean(incoming.groupId);
    const sender = this.normalizeUser(incoming.reactor ?? incoming.sender ?? '');
    const currentUser = this.normalizeUser(this.currentUser() ?? '');
    const incomingToUser = this.normalizeChatId(String(incoming.toUser ?? incoming.recipient ?? (incoming as any).targetUser ?? '').trim());
    const isOutgoingFromCurrentUser = Boolean(currentUser && sender === currentUser);

    // Properly resolve the Chat ID regardless of whether it's a group or a direct message
    const chatId = isGroup
      ? this.normalizeChatId(incoming.groupId ?? '')
      : (
        isOutgoingFromCurrentUser && incomingToUser && incomingToUser !== currentUser
          ? incomingToUser
          : this.normalizeChatId(sender)
      );

    if (!chatId) return false;

    if (isGroup && incoming.groupName) {
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

    // Apply to the specific resolved chatId
    const changed = this.applyReactionToMessage(chatId, targetMessageId, reaction);
    if (!changed) return false;

    if (currentUser && reactor === currentUser) {
      return true;
    }
    if (isGroup && !this.canCurrentUserReceiveReactionNotification(chatId, incoming)) {
      return true;
    }

    const group = isGroup ? this.groups().find((item) => item.id === chatId) : null;
    const groupName = isGroup ? (String(incoming.groupName ?? group?.name ?? chatId).trim() || chatId) : '';
    const reactorName = reaction.reactorName || this.getDisplayName(reactor);

    this.incomingReactionNotice.set({
      id: `${chatId}:${targetMessageId}:${reactor}:${emoji}`,
      chatId,
      groupName,
      reactorName,
      emoji
    });
    return true;
  }

  private canCurrentUserReceiveReactionNotification(
    groupId: string,
    incoming: IncomingServerMessage
  ): boolean {
    const currentUser = this.normalizeUser(this.currentUser() ?? '');
    if (!currentUser) return false;
    if (this.isDovrutGroup(groupId)) {
      return this.isDovrutAdminUser(currentUser);
    }
    const incomingAdmins = Array.isArray(incoming.groupAdmins)
      ? incoming.groupAdmins.map((admin) => this.normalizeUser(admin)).filter(Boolean)
      : [];
    if (incomingAdmins.includes(currentUser)) {
      return true;
    }
    const incomingCreatedBy = this.normalizeUser(String(incoming.groupCreatedBy ?? '').trim());
    if (incomingCreatedBy && incomingCreatedBy === currentUser) {
      return true;
    }
    const group = this.groups().find((item) => item.id === groupId) ?? null;
    if (!group) {
      return false;
    }
    return this.getGroupAdminList(group).includes(currentUser);
  }

  private ensureGroupFromIncoming(incoming: IncomingServerMessage): void {
    if (!incoming.groupId || !incoming.groupName) return;
    const user = this.currentUser();
    if (!user) return;

    const normalizedId = this.normalizeChatId(incoming.groupId);
    const normalizedType: GroupType = incoming.groupType === 'community' ? 'community' : 'group';
    const updatedAt = Number(incoming.groupUpdatedAt ?? Date.now());
    const normalizedAdmins = Array.isArray(incoming.groupAdmins)
      ? incoming.groupAdmins.map((admin) => this.normalizeUser(admin)).filter(Boolean)
      : [];

    this.groups.update((groups) => {
      const existing = groups.find((group) => group.id === normalizedId);
      if (!existing) {
        const nextGroup: ChatGroup = {
          id: normalizedId,
          name: incoming.groupName ?? normalizedId,
          members: (incoming.groupMembers ?? []).map((member) => this.normalizeUser(member)),
          admins: normalizedAdmins,
          createdBy: this.normalizeUser(incoming.groupCreatedBy ?? normalizedAdmins[0] ?? user),
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
            admins: normalizedAdmins.length
              ? normalizedAdmins
              : (Array.isArray(group.admins) ? group.admins : []),
            createdBy: incoming.groupCreatedBy
              ? this.normalizeUser(incoming.groupCreatedBy)
              : (normalizedAdmins[0] || group.createdBy),
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
    const normalizedTargetId = String(targetMessageId || '').trim();
    const normalizedReactor = this.normalizeUser(reaction.reactor);
    const normalizedEmoji = String(reaction.emoji || '').trim();
    if (!normalizedTargetId || !normalizedReactor || !normalizedEmoji) {
      return false;
    }

    let changed = false;
    this.messagesByChat.update((messageMap) => {
      const nextMap: Record<string, ChatMessage[]> = {};

      // Iterate through all chats to find the target message ID securely
      for (const [iterChatId, list] of Object.entries(messageMap)) {
        if (!list?.length) {
          nextMap[iterChatId] = list;
          continue;
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

        nextMap[iterChatId] = nextList;
      }

      return changed ? nextMap : messageMap;
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
    this.rememberDeletedMessageTombstone(normalizedId, deletedAt);

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
          this.rememberDeletedIncomingFingerprint(message, deletedAt);
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

  private clearDeletedMessageSuppressions(): void {
    this.deletedMessageIdTombstones.clear();
    this.deletedIncomingFingerprints = [];
  }

  private pruneDeletedMessageSuppressions(now = Date.now()): void {
    const minKeptTimestamp = now - DELETED_MESSAGE_SUPPRESSION_TTL_MS;
    for (const [messageId, deletedAt] of this.deletedMessageIdTombstones.entries()) {
      if (!messageId || !Number.isFinite(deletedAt) || deletedAt < minKeptTimestamp) {
        this.deletedMessageIdTombstones.delete(messageId);
      }
    }

    this.deletedIncomingFingerprints = this.deletedIncomingFingerprints
      .filter((entry) => Number.isFinite(entry.deletedAt) && entry.deletedAt >= minKeptTimestamp)
      .slice(-DELETED_MESSAGE_SUPPRESSION_MAX_ENTRIES);
  }

  private rememberDeletedMessageTombstone(messageId: string, deletedAt: number): void {
    const normalizedId = String(messageId || '').trim();
    if (!normalizedId) {
      return;
    }
    const resolvedDeletedAt = Number.isFinite(deletedAt) && deletedAt > 0 ? deletedAt : Date.now();
    const existing = this.deletedMessageIdTombstones.get(normalizedId);
    if (!existing || resolvedDeletedAt > existing) {
      this.deletedMessageIdTombstones.set(normalizedId, resolvedDeletedAt);
    }
    this.pruneDeletedMessageSuppressions();
  }

  private getDeletedMessageTombstone(messageId: string): number | null {
    const normalizedId = String(messageId || '').trim();
    if (!normalizedId) {
      return null;
    }
    this.pruneDeletedMessageSuppressions();
    const deletedAt = this.deletedMessageIdTombstones.get(normalizedId);
    if (!Number.isFinite(deletedAt || NaN) || Number(deletedAt) <= 0) {
      return null;
    }
    return Number(deletedAt);
  }

  private rememberDeletedIncomingFingerprint(message: ChatMessage, deletedAt: number): void {
    if (!message) {
      return;
    }
    const chatId = this.normalizeChatId(message.chatId);
    const sender = this.normalizeUser(message.sender);
    const body = this.normalizeIncomingTextForDedup(String(message.body || ''));
    const imageUrl = String(message.imageUrl || '').trim();
    const timestamp = Number(message.timestamp || 0);
    if (!chatId || !sender || !Number.isFinite(timestamp) || (!body && !imageUrl)) {
      return;
    }

    const resolvedDeletedAt = Number.isFinite(deletedAt) && deletedAt > 0 ? deletedAt : Date.now();
    this.pruneDeletedMessageSuppressions(resolvedDeletedAt);
    const existingIndex = this.deletedIncomingFingerprints.findIndex((entry) =>
      entry.chatId === chatId &&
      entry.sender === sender &&
      entry.body === body &&
      entry.imageUrl === imageUrl &&
      Math.abs(entry.timestamp - timestamp) <= DELETED_MESSAGE_SUPPRESSION_TIMESTAMP_TOLERANCE_MS
    );

    const nextEntry: DeletedIncomingMessageFingerprint = {
      chatId,
      sender,
      body,
      imageUrl,
      timestamp,
      deletedAt: resolvedDeletedAt
    };

    if (existingIndex >= 0) {
      this.deletedIncomingFingerprints[existingIndex] = nextEntry;
      return;
    }
    this.deletedIncomingFingerprints.push(nextEntry);
    if (this.deletedIncomingFingerprints.length > DELETED_MESSAGE_SUPPRESSION_MAX_ENTRIES) {
      this.deletedIncomingFingerprints = this.deletedIncomingFingerprints.slice(
        -DELETED_MESSAGE_SUPPRESSION_MAX_ENTRIES
      );
    }
  }

  private isSuppressedByDeletedIncomingFingerprint(candidate: {
    chatId: string;
    sender: string;
    body: string;
    imageUrl: string | null;
    timestamp: number;
  }): boolean {
    const chatId = this.normalizeChatId(candidate.chatId);
    const sender = this.normalizeUser(candidate.sender);
    const body = this.normalizeIncomingTextForDedup(candidate.body);
    const imageUrl = String(candidate.imageUrl || '').trim();
    const timestamp = Number(candidate.timestamp || 0);
    if (!chatId || !sender || !Number.isFinite(timestamp) || (!body && !imageUrl)) {
      return false;
    }

    this.pruneDeletedMessageSuppressions();
    return this.deletedIncomingFingerprints.some((entry) =>
      entry.chatId === chatId &&
      entry.sender === sender &&
      entry.body === body &&
      entry.imageUrl === imageUrl &&
      Math.abs(entry.timestamp - timestamp) <= DELETED_MESSAGE_SUPPRESSION_TIMESTAMP_TOLERANCE_MS
    );
  }

  private appendMessage(message: ChatMessage): void {
    const chatId = this.normalizeChatId(message.chatId);
    if (!chatId) return;
    if (this.isShuttleChat(chatId) && !this.shuttleAccessAllowed()) {
      return;
    }

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

  private async ensurePushRegistrationHealth(
    user: string,
    options: {
      forceRegister?: boolean;
      promptIfNeeded?: boolean;
      requireStandaloneOnMobile?: boolean;
    } = {}
  ): Promise<void> {
    const normalizedUser = this.normalizeUser(user);
    if (!normalizedUser) {
      throw new Error('יש להתחבר מחדש לפני השלמת רישום התראות');
    }

    const requireStandaloneOnMobile = Boolean(options.requireStandaloneOnMobile);
    if (
      requireStandaloneOnMobile &&
      this.shouldRequireStandaloneInstallForPush() &&
      !this.isRunningStandaloneApp()
    ) {
      throw new Error('יש להתקין את האפליקציה למסך הבית לפני השלמת ההרשמה.');
    }

    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
      if (this.shouldRequireStandaloneInstallForPush()) {
        throw new Error('המכשיר אינו תומך בהתראות דחיפה.');
      }
      return;
    }

    const forceRegister = options.forceRegister !== false;
    const localBefore = await this.hasValidLocalPushRegistration();
    const remoteBefore = await this.hasValidRemotePushRegistration(normalizedUser);
    if (localBefore && remoteBefore && !forceRegister) {
      return;
    }

    await this.tryRegisterPush(normalizedUser, {
      force: forceRegister,
      allowPermissionPrompt: options.promptIfNeeded !== false,
      requireStandaloneOnMobile
    });

    const localAfter = await this.hasValidLocalPushRegistration();
    if (!localAfter) {
      throw new Error('לא נמצאה הרשאת Push פעילה במכשיר. אשר התראות ונסה שוב.');
    }

    let remoteAfter = await this.hasValidRemotePushRegistration(normalizedUser);
    if (!remoteAfter) {
      await this.wait(900);
      remoteAfter = await this.hasValidRemotePushRegistration(normalizedUser);
    }
    if (!remoteAfter) {
      throw new Error('רישום Push לשרת לא הושלם. נסה שוב בעוד כמה שניות.');
    }
  }

  private async hasValidRemotePushRegistration(user: string): Promise<boolean> {
    try {
      const subscriptions = await this.api.getUserPushSubscriptions(user);
      return subscriptions.some((subscription) => this.isValidSheetPushSubscription(subscription));
    } catch {
      return false;
    }
  }

  private isValidSheetPushSubscription(subscription: UserPushSubscriptionPayload): boolean {
    const endpoint = String(subscription?.endpoint || '').trim();
    const p256dh = String(subscription?.keys?.p256dh || '').trim();
    const auth = String(subscription?.keys?.auth || '').trim();
    return Boolean(endpoint && p256dh && auth);
  }

  private async hasValidLocalPushRegistration(): Promise<boolean> {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
      return false;
    }
    try {
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.getSubscription();
      return this.isValidLocalPushSubscription(subscription);
    } catch {
      return false;
    }
  }

  private isValidLocalPushSubscription(subscription: PushSubscription | null): boolean {
    if (!subscription) return false;
    const payload = subscription.toJSON();
    const endpoint = String(payload.endpoint || '').trim();
    const p256dh = String(payload.keys?.['p256dh'] || '').trim();
    const auth = String(payload.keys?.['auth'] || '').trim();
    return Boolean(endpoint && p256dh && auth);
  }

  private wait(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
  }

  private tryRegisterPush = async (
    user: string,
    options: {
      force?: boolean;
      allowPermissionPrompt?: boolean;
      requireStandaloneOnMobile?: boolean;
    } = {}
  ): Promise<void> => {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
    if (!user) return;

    const requireStandaloneOnMobile = Boolean(options.requireStandaloneOnMobile);
    if (
      requireStandaloneOnMobile &&
      this.shouldRequireStandaloneInstallForPush() &&
      !this.isRunningStandaloneApp()
    ) {
      return;
    }

    const force = Boolean(options.force);
    const allowPermissionPrompt = options.allowPermissionPrompt !== false;
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
      if (typeof Notification === 'undefined') {
        return;
      }
      const permission = Notification.permission === 'granted'
        ? 'granted'
        : (
          allowPermissionPrompt
            ? await Notification.requestPermission()
            : Notification.permission
        );
      if (permission !== 'granted') return;

      const registration = await navigator.serviceWorker.ready;
      void registration.update().catch(() => undefined);

      const userKey = this.normalizeUser(user);
      const storedEndpointKey = this.pushEndpointStorageKey(userKey);
      const storedRegisteredAtKey = this.pushRegisteredAtStorageKey(userKey);
      const storedEndpoint = this.safeStorageGet(storedEndpointKey);
      const lastRegisteredAt = Number(this.safeStorageGet(storedRegisteredAtKey) || 0);

      let subscription = await registration.pushManager.getSubscription();
      const hasValidSubscriptionKeys = this.isValidLocalPushSubscription(subscription);
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
    const hrFlowInput = String(options.hrFlowInput || '').trim();
    return {
      replyTo,
      forwarded,
      forwardedFrom: forwardedFrom || null,
      forwardedFromName: forwardedFromName || null,
      hrFlowInput: hrFlowInput || null
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
    if (this.isShuttleChat(normalized)) {
      return SHUTTLE_CHAT_TITLE;
    }
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
          upic: contact.upic?.trim() || undefined,
          status: this.normalizeContactStatus((contact as { status?: unknown }).status) ?? undefined
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
        const admins = Array.from(
          new Set((group.admins ?? []).map((admin) => this.normalizeUser(admin)).filter(Boolean))
        );
        const createdBy = this.normalizeUser(group.createdBy || admins[0] || fallbackCreator);
        return {
          id: this.normalizeChatId(group.id),
          name: group.name.trim(),
          members: Array.from(new Set(group.members.map((member) => this.normalizeUser(member)).filter(Boolean))),
          admins,
          createdBy,
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
    if (this.isShuttleChat(normalized) && !this.shuttleAccessAllowed()) {
      return false;
    }
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

  private clearLocalChatCacheForUser(user: string, options: { keepOutbox?: boolean } = {}): void {
    const keepOutbox = options.keepOutbox !== false;
    localStorage.removeItem(this.stateKey(user));
    if (!keepOutbox) {
      localStorage.removeItem(this.outboxKey(user));
    }
    localStorage.removeItem(this.activeChatKey(user));
    localStorage.removeItem(this.homeViewKey(user));
    localStorage.removeItem(this.hrStateKey(user));
    localStorage.removeItem(this.hrWelcomeKey(user));
    this.bumpHrStateRevision();
    localStorage.removeItem(this.shuttleStateKey(user));
    localStorage.removeItem(this.shuttleWelcomeKey(user));
    localStorage.removeItem(this.shuttleOrdersKey(user));
    localStorage.removeItem(this.shuttleLanguageKey(user));
    localStorage.removeItem(this.shuttleReminderHistoryKey(user));
  }

  private resetRuntimeStateAfterCacheClear(user: string): void {
    this.clearDeletedMessageSuppressions();
    this.contacts.set([]);
    this.groups.set([]);
    this.messagesByChat.set({});
    this.unreadByChat.set({});
    this.activeChatId.set(null);
    this.lastActivatedChatMeta.set(null);
    this.lastContactsFetchAt = 0;
    this.lastGroupsFetchAt = 0;
    this.hrStepsCache = { at: 0, steps: [] };
    this.hrActionsCache = {};
    this.shuttleStationsCache = { at: 0, items: [] };
    this.shuttleEmployeesCache = { at: 0, items: [] };
    this.shuttleOrdersSyncAt.delete(this.normalizeUser(user));
    this.shuttleOperationsOrders.set([]);
    this.shuttleOperationsOrdersLoading.set(false);
    this.shuttleOperationsLastSyncedAt = 0;
    this.shuttleOperationsSyncPromise = null;
    this.clearShuttleReminderTimersForUser(user);
    this.resetReadReceiptTrackingState();
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
    this.postBadgeMessageToServiceWorker({ action: 'flush-offline-replies' });
    this.clearDeviceAttention({ resetServerBadge: true });
    void this.tryRegisterPush(user, {
      force: true,
      allowPermissionPrompt: false,
      requireStandaloneOnMobile: true
    });
    this.connectRealtime(user);
    void this.consumePendingPushPayloadsFromServiceWorker();
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
    this.flushPendingServiceWorkerMessages();
    void this.consumePendingPushPayloadsFromServiceWorker();
  };

  private handleVisibilityChange = (): void => {
    if (typeof document === 'undefined' || document.visibilityState !== 'visible') {
      return;
    }
    this.refreshPushRegistrationForCurrentUser(false);
    this.clearDeviceAttention({ resetServerBadge: true });
    this.flushPendingServiceWorkerMessages();
    void this.consumePendingPushPayloadsFromServiceWorker();
  };

  private handleServiceWorkerMessage = (event: MessageEvent<unknown>): void => {
    const eventData = event.data;
    if (!eventData || typeof eventData !== 'object') return;

    const messageData = eventData as { action?: unknown; payload?: unknown; url?: unknown; chat?: unknown };
    const currentUser = this.currentUser();
    if (!currentUser) {
      this.enqueuePendingServiceWorkerMessage(messageData);
      return;
    }
    this.processServiceWorkerMessageData(messageData, currentUser);
  };

  private enqueuePendingServiceWorkerMessage(messageData: {
    action?: unknown;
    payload?: unknown;
    url?: unknown;
    chat?: unknown;
  }): void {
    const action = String(messageData.action ?? '').trim();
    if (action !== 'notification-clicked' && action !== 'push-payload') {
      return;
    }
    this.pendingServiceWorkerMessages.push(messageData);
    if (this.pendingServiceWorkerMessages.length > 20) {
      this.pendingServiceWorkerMessages.splice(0, this.pendingServiceWorkerMessages.length - 20);
    }
  }

  private flushPendingServiceWorkerMessages(): void {
    const currentUser = this.currentUser();
    if (!currentUser || !this.pendingServiceWorkerMessages.length) {
      return;
    }
    const pendingMessages = this.pendingServiceWorkerMessages.splice(0, this.pendingServiceWorkerMessages.length);
    pendingMessages.forEach((messageData) => {
      this.processServiceWorkerMessageData(messageData, currentUser);
    });
  }

  private async consumePendingPushPayloadsFromServiceWorker(): Promise<void> {
    if (this.pendingPushDrainInFlight) {
      return;
    }
    const currentUser = this.currentUser();
    if (!currentUser) {
      return;
    }
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
      return;
    }
    this.pendingPushDrainInFlight = true;
    try {
      const targetWorker = await this.resolveServiceWorkerMessageTarget();
      if (!targetWorker) {
        return;
      }
      const pendingPayloads = await new Promise<Record<string, unknown>[]>((resolve) => {
        let settled = false;
        const finalize = (value: Record<string, unknown>[]) => {
          if (settled) return;
          settled = true;
          resolve(Array.isArray(value) ? value : []);
        };
        const timeoutId = setTimeout(() => finalize([]), 2500);
        const channel = new MessageChannel();
        channel.port1.onmessage = (replyEvent: MessageEvent<unknown>) => {
          clearTimeout(timeoutId);
          const reply = replyEvent.data as { payloads?: unknown } | null;
          const rawPayloads = reply && typeof reply === 'object'
            ? reply.payloads
            : undefined;
          const payloads: unknown[] = Array.isArray(rawPayloads) ? rawPayloads : [];
          const normalizedPayloads = payloads.filter(
            (item: unknown): item is Record<string, unknown> => Boolean(item) && typeof item === 'object'
          );
          finalize(normalizedPayloads);
        };
        try {
          targetWorker.postMessage({ action: 'drain-pending-push-payloads' }, [channel.port2]);
        } catch {
          clearTimeout(timeoutId);
          finalize([]);
        }
      });

      if (this.currentUser() !== currentUser || !pendingPayloads.length) {
        return;
      }
      pendingPayloads.forEach((payload) => {
        this.incrementDeliveryTelemetry('pushPayloadReceived');
        this.applyIncomingFromPushPayload(payload, currentUser);
      });
    } finally {
      this.pendingPushDrainInFlight = false;
    }
  }

  private async resolveServiceWorkerMessageTarget(): Promise<ServiceWorker | null> {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
      return null;
    }
    const controllerWorker = navigator.serviceWorker.controller;
    if (controllerWorker) {
      return controllerWorker;
    }
    try {
      const registration = await navigator.serviceWorker.getRegistration();
      if (registration) {
        const registrationWorker =
          registration.active ??
          registration.waiting ??
          registration.installing ??
          null;
        if (registrationWorker) {
          return registrationWorker;
        }
      }
    } catch {
      // Ignore registration lookup failure.
    }
    try {
      const readyRegistration = await Promise.race([
        navigator.serviceWorker.ready,
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 800))
      ]);
      if (readyRegistration) {
        return readyRegistration.active ?? readyRegistration.waiting ?? readyRegistration.installing ?? null;
      }
    } catch {
      // Ignore readiness errors and fallback to null.
    }
    return null;
  }

  private schedulePendingPushDrainRetry(): void {
    [700, 2200, 5000].forEach((delayMs) => {
      setTimeout(() => {
        void this.consumePendingPushPayloadsFromServiceWorker();
      }, delayMs);
    });
  }

  public async drainAllPendingPushPayloads(): Promise<void> {
    this.flushPendingServiceWorkerMessages();
    await this.consumePendingPushPayloadsFromServiceWorker();
  }

  private processServiceWorkerMessageData(
    messageData: { action?: unknown; payload?: unknown; url?: unknown; chat?: unknown },
    currentUser: string
  ): void {
    const action = String(messageData.action ?? '').trim();
    if (action === 'notification-clicked') {
      this.clearDeviceAttention({ resetServerBadge: true });
      const clickedPayloadRaw = messageData.payload;
      if (clickedPayloadRaw && typeof clickedPayloadRaw === 'object') {
        this.incrementDeliveryTelemetry('pushPayloadReceived');
        this.applyIncomingFromPushPayload(
          clickedPayloadRaw as Record<string, unknown>,
          currentUser
        );
      }
      const clickedChatId = this.resolveNotificationChatId(messageData, currentUser);
      if (clickedChatId) {
        this.setActiveChat(clickedChatId);
        // Opening from a notification is an explicit read intent for that chat.
        this.clearUnreadCountForChat(clickedChatId);
      }
      return;
    }
    if (action !== 'push-payload') return;
    this.incrementDeliveryTelemetry('pushPayloadReceived');

    const payloadRaw = messageData.payload;
    if (!payloadRaw || typeof payloadRaw !== 'object') return;
    this.applyIncomingFromPushPayload(payloadRaw as Record<string, unknown>, currentUser);
  }

  private applyIncomingFromPushPayload(
    payload: Record<string, unknown>,
    currentUser: string
  ): void {
    const payloadUser = this.normalizeUser(String(payload['user'] ?? ''));
    if (payloadUser && payloadUser !== currentUser) return;

    const payloadType = String(payload['type'] ?? '').trim().toLowerCase();
    if (payloadType === 'subscription-auth-refresh') {
      this.refreshPushRegistrationForCurrentUser(true);
      return;
    }
    const numericGroupUpdatedAt = Number(payload['groupUpdatedAt']);
    const numericReadAt = Number(payload['readAt']);
    const numericPayloadTimestamp = Number(payload['timestamp']);
    const numericPayloadReceivedAt = Number(
      payload['receivedAt'] ??
      payload['_swReceivedAt'] ??
      payload['_queuedAt']
    );
    const resolvedIncomingTimestamp = Number.isFinite(numericPayloadTimestamp) && numericPayloadTimestamp > 0
      ? numericPayloadTimestamp
      : (
        Number.isFinite(numericPayloadReceivedAt) && numericPayloadReceivedAt > 0
          ? numericPayloadReceivedAt
          : undefined
      );
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
      toUser: typeof payload['toUser'] === 'string' ? payload['toUser'] : (typeof payload['targetUser'] === 'string' ? payload['targetUser'] : (typeof payload['recipient'] === 'string' ? payload['recipient'] : undefined)),
      groupName: typeof payload['groupName'] === 'string' ? payload['groupName'] : undefined,
      groupMembers: Array.isArray(payload['groupMembers'])
        ? payload['groupMembers'].map((member) => String(member || '').trim()).filter(Boolean)
        : undefined,
      groupCreatedBy:
        typeof payload['groupCreatedBy'] === 'string' ? payload['groupCreatedBy'] : undefined,
      groupAdmins: Array.isArray(payload['groupAdmins'])
        ? payload['groupAdmins'].map((admin) => String(admin || '').trim()).filter(Boolean)
        : undefined,
      groupUpdatedAt: Number.isFinite(numericGroupUpdatedAt) ? numericGroupUpdatedAt : undefined,
      groupType: payload['groupType'] === 'community' ? 'community' : 'group',
      timestamp: resolvedIncomingTimestamp
    };

    if (payloadType !== 'reaction' && payloadType !== 'group-update' && payloadType !== 'read-receipt') {
      const immediateIncoming = this.buildIncomingMessageFromPushPayload(payload, incoming);
      if (immediateIncoming) {
        this.incrementDeliveryTelemetry('pushImmediateMessageBuilt');
        if (this.applyIncomingMessage(immediateIncoming)) {
          this.incrementDeliveryTelemetry('pushMessageApplied');
        } else {
          this.incrementDeliveryTelemetry('pushMessageNoop');
        }
      } else {
        this.incrementDeliveryTelemetry('pushMissingMessageContext');
      }
      return;
    }

    if (this.applyIncomingMessage(incoming)) {
      this.incrementDeliveryTelemetry('pushMessageApplied');
    } else {
      this.incrementDeliveryTelemetry('pushMessageNoop');
    }
  }

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
      payload['groupMessageText'] ??
      payload['messageText'] ??
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
    void this.recoverMissedMessagesFromLogs(user);
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

  private clearHomeScreenBadgeOnAppOpen(): void {
    if (typeof navigator === 'undefined') return;

    this.lastAppliedAppBadgeCount = 0;
    const badgeNavigator = navigator as BadgeCapableNavigator;
    if (typeof badgeNavigator.clearAppBadge === 'function') {
      void badgeNavigator.clearAppBadge().catch(() => undefined);
    } else if (typeof badgeNavigator.setAppBadge === 'function') {
      void badgeNavigator.setAppBadge(0).catch(() => undefined);
    }

    if ('serviceWorker' in navigator) {
      void navigator.serviceWorker.ready
        .then((registration) => {
          const badgeRegistration = registration as BadgeCapableServiceWorkerRegistration;
          if (typeof badgeRegistration.clearAppBadge === 'function') {
            return badgeRegistration.clearAppBadge().catch(() => undefined);
          }
          if (typeof badgeRegistration.clearBadge === 'function') {
            return badgeRegistration.clearBadge().catch(() => undefined);
          }
          if (typeof badgeRegistration.setAppBadge === 'function') {
            return badgeRegistration.setAppBadge(0).catch(() => undefined);
          }
          if (typeof badgeRegistration.setBadge === 'function') {
            return badgeRegistration.setBadge(0).catch(() => undefined);
          }
          return undefined;
        })
        .catch(() => undefined);
    }

    this.postBadgeMessageToServiceWorker({ action: 'clear-app-badge' });
  }

  private isAppInForeground(): boolean {
    if (typeof document === 'undefined') return false;
    return document.visibilityState === 'visible';
  }

  private clearDeviceAttention(
    options: { resetServerBadge?: boolean; forceServerBadgeReset?: boolean } = {}
  ): void {
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
    const forceServerBadgeReset = Boolean(options.forceServerBadgeReset);
    if (!forceServerBadgeReset && now - this.lastServerBadgeResetAt < BADGE_RESET_MIN_INTERVAL_MS) {
      return;
    }
    if (this.serverBadgeResetInFlight) {
      return;
    }
    this.serverBadgeResetInFlight = true;
    void this.api.resetServerBadge(user)
      .then(() => {
        this.lastServerBadgeResetAt = Date.now();
      })
      .catch(() => undefined)
      .finally(() => {
        this.serverBadgeResetInFlight = false;
      });
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
    void this.tryRegisterPush(user, {
      force,
      allowPermissionPrompt: false,
      requireStandaloneOnMobile: true
    });
  }

  private pushEndpointStorageKey(user: string): string {
    return `modern-chat-push-endpoint:${this.normalizeUser(user)}`;
  }

  private pushRegisteredAtStorageKey(user: string): string {
    return `modern-chat-push-registered-at:${this.normalizeUser(user)}`;
  }

  private shouldRequireStandaloneInstallForPush(): boolean {
    if (typeof navigator === 'undefined') return false;
    const ua = navigator.userAgent || '';
    const isIosUa = /iP(hone|ad|od)/i.test(ua);
    const isIpadOsDesktopUa = /Macintosh/i.test(ua) && navigator.maxTouchPoints > 1;
    // iOS/iPadOS Web Push requires home-screen install. Android does not.
    return isIosUa || isIpadOsDesktopUa;
  }

  private isRunningStandaloneApp(): boolean {
    if (typeof window === 'undefined') return false;
    const mediaStandalone = typeof window.matchMedia === 'function'
      ? window.matchMedia('(display-mode: standalone)').matches
      : false;
    const iosStandalone = Boolean((navigator as Navigator & { standalone?: boolean }).standalone);
    const androidTwa = typeof document !== 'undefined'
      ? String(document.referrer || '').startsWith('android-app://')
      : false;
    return mediaStandalone || iosStandalone || androidTwa;
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
