import { Injectable, computed, effect, signal } from '@angular/core';
import { SYSTEM_CHAT_IDS } from '../config/runtime-config';
import {
  ChatGroup,
  ChatListItem,
  ChatMessage,
  Contact,
  DeliveryStatus,
  GroupUpdatePayload,
  GroupType,
  IncomingServerMessage,
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
const GROUPS_TTL_MS = 2 * 60 * 1000;
const POLL_INTERVAL_MS = 15000;
const STREAM_RETRY_MS = 5000;
const MAX_PERSISTED_MESSAGES = 2500;
const PUSH_REGISTER_MIN_INTERVAL_MS = 30000;
const PUSH_REGISTER_REFRESH_MS = 6 * 60 * 60 * 1000;
const FOREGROUND_SYNC_MIN_INTERVAL_MS = 4000;
const BADGE_RESET_MIN_INTERVAL_MS = 30000;
const HR_CHAT_NAME = 'ציפי';
const HR_WELCOME_KEY_PREFIX = 'hr_welcome_sent_';
const HR_STATE_KEY_PREFIX = 'hr_state_';
const HR_UPLOAD_BASE_URL = 'https://www.tzmc.co.il/notify/uploads/';
const HR_STEPS_CACHE_TTL_MS = 5 * 60 * 1000;
const HR_ACTIONS_CACHE_TTL_MS = 5 * 60 * 1000;
const READ_RECEIPT_BATCH_SIZE = 80;

type HrAwaitingState = 'step' | 'action' | 'free-text';

interface HrConversationState {
  awaiting: HrAwaitingState;
  stepId: string | null;
  actions: HrActionOption[];
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

@Injectable({ providedIn: 'root' })
export class ChatStoreService {
  readonly currentUser = signal<string | null>(this.readStoredUser());
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
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private pullInFlight = false;
  private initializedUser: string | null = null;
  private lastContactsFetchAt = 0;
  private lastGroupsFetchAt = 0;
  private hrStepsCache: { at: number; steps: HrStepOption[] } = { at: 0, steps: [] };
  private hrActionsCache: Record<string, { at: number; actions: HrActionOption[] }> = {};
  private hrInitInFlight = false;
  private lastAppliedAppBadgeCount = -1;
  private lastServerBadgeResetAt = 0;
  private lastForegroundSyncAt = 0;
  private readonly readReceiptSentByChat = new Map<string, Set<string>>();
  private pushRegisterInFlight = false;
  private lastPushRegisterAttemptAt = 0;

  readonly chatItems = computed<ChatListItem[]>(() => {
    const groupsById = new Map(this.groups().map((group) => [group.id, group]));
    const contactsById = new Map(this.contacts().map((contact) => [contact.username, contact]));
    const chatIds = new Set<string>();

    for (const contact of this.contacts()) {
      chatIds.add(contact.username);
    }
    for (const group of this.groups()) {
      chatIds.add(group.id);
    }
    for (const id of Object.keys(this.messagesByChat())) {
      chatIds.add(id);
    }
    for (const systemId of SYSTEM_CHAT_IDS) {
      chatIds.add(this.normalizeUser(systemId));
    }

    const unreadMap = this.unreadByChat();
    const messageMap = this.messagesByChat();
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
      const pinned = SYSTEM_CHAT_IDS.some((id) => this.normalizeUser(id) === chatId);

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
    const storedUser = this.currentUser();
    if (storedUser) {
      this.restoreState(storedUser);
    }

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

  async initialize(): Promise<void> {
    const user = this.currentUser();
    if (!user) return;
    if (this.initializedUser === user) return;

    this.initializedUser = user;
    await this.refresh(true);
    this.clearDeviceAttention({ resetServerBadge: true });
    // Recover silently if a device lost its push subscription.
    void this.tryRegisterPush(user, { force: true });
    this.connectRealtime(user);
    await this.flushOutbox();

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

    const user = this.normalizeUser(normalized);
    this.stopRealtime();

    localStorage.setItem('username', user);
    this.currentUser.set(user);
    this.initializedUser = null;
    this.contacts.set([]);
    this.groups.set([]);
    this.messagesByChat.set({});
    this.unreadByChat.set({});
    this.readReceiptSentByChat.clear();
    this.activeChatId.set(null);
    this.lastError.set(null);

    this.restoreState(user);
    await this.tryRegisterPush(user, { force: true });
    await this.initialize();
  }

  logout(): void {
    const user = this.currentUser();
    this.stopRealtime();
    this.initializedUser = null;
    localStorage.removeItem('username');
    if (user) {
      localStorage.removeItem(this.activeChatKey(user));
      localStorage.removeItem(this.homeViewKey(user));
    }
    this.currentUser.set(null);
    this.contacts.set([]);
    this.groups.set([]);
    this.messagesByChat.set({});
    this.unreadByChat.set({});
    this.readReceiptSentByChat.clear();
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
    this.unreadByChat.update((map) => ({
      ...map,
      [normalized]: 0
    }));
    void this.sendReadReceiptsForChat(normalized);
    void this.onChatActivated(normalized);
    this.schedulePersist();
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

  async sendTextMessage(text: string): Promise<void> {
    const body = text.trim();
    if (!body) return;

    await this.sendMessageInternal({
      body,
      imageUrl: null
    });
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

    const group = this.groups().find((item) => item.id === activeChatId) ?? null;
    const isCommunityGroup = group ? group.type === 'community' : !this.canSendToActiveChat();
    if (!isCommunityGroup) {
      throw new Error('ניתן להגיב רק בקבוצת קהילה.');
    }

    const normalizedTargetId = String(targetMessageId || '').trim();
    const normalizedEmoji = String(emoji || '').trim();
    if (!normalizedTargetId || !normalizedEmoji) {
      return;
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
    const groupId = group?.id || fallbackGroupId;
    const groupName = group?.name || activeChat?.title || groupId;
    const groupMembers = group?.members ?? [];
    const groupCreatedBy = group?.createdBy || '';
    const groupUpdatedAt = group?.updatedAt || Date.now();
    const groupType: GroupType = group?.type === 'group' ? 'group' : 'community';

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
    if (!this.isHrChat(chatId)) return;
    await this.ensureHrFlowOnOpen();
  }

  private isHrChat(chatId: string | null): boolean {
    return this.normalizeChatId(chatId ?? '') === this.normalizeChatId(HR_CHAT_NAME);
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

  private async sendMessageInternal(payload: {
    body: string;
    imageUrl: string | null;
    thumbnailUrl?: string | null;
  }): Promise<void> {
    const user = this.currentUser();
    const chatId = this.activeChatId();
    if (!user || !chatId) {
      throw new Error('No active chat');
    }

    const group = this.groups().find((item) => item.id === chatId) ?? null;
    if (group && group.type === 'community' && this.normalizeUser(group.createdBy) !== user) {
      this.lastError.set('רק מנהל יכול לשלוח בקבוצת קהילה');
      return;
    }

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
      groupName: group?.name ?? null
    };

    this.appendMessage(newMessage);
    this.setActiveChat(chatId);

    if (this.isHrChat(chatId) && payload.body.trim()) {
      const handledByHrFlow = await this.handleHrOutgoing(payload.body);
      if (handledByHrFlow) {
        this.setMessageStatus(messageId, 'delivered');
        return;
      }
    }

    if (!this.networkOnline()) {
      if (group) {
        this.queueGroupMessage(group, messageId, payload.body, payload.imageUrl);
      } else {
        this.queueDirectMessage(chatId, messageId, payload.body, payload.imageUrl);
      }
      this.setMessageStatus(messageId, 'queued');
      return;
    }

    if (group) {
      await this.sendGroupMessage(group, messageId, payload.body, payload.imageUrl);
      return;
    }

    await this.sendDirectMessage(chatId, messageId, payload.body, payload.imageUrl);
  }

  private async sendDirectMessage(
    originalSender: string,
    messageId: string,
    body: string,
    imageUrl: string | null
  ): Promise<void> {
    const user = this.currentUser();
    if (!user) return;

    const payload: ReplyPayload = {
      user,
      senderName: this.getDisplayName(user),
      reply: body,
      imageUrl,
      originalSender,
      messageId
    };

    try {
      await this.api.sendDirectMessage(payload);
      this.setMessageStatus(messageId, 'sent');
    } catch {
      this.queueDirectMessage(originalSender, messageId, body, imageUrl);
      this.setMessageStatus(messageId, 'queued');
    }
  }

  private async sendGroupMessage(
    group: ChatGroup,
    messageId: string,
    body: string,
    imageUrl: string | null
  ): Promise<void> {
    const user = this.currentUser();
    if (!user) return;

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
      groupSenderName: this.getDisplayName(user)
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
      this.queueGroupMessage(group, messageId, body, imageUrl, failedRecipients);
      this.setMessageStatus(messageId, 'queued');
      return;
    }

    this.setMessageStatus(messageId, 'sent');
  }

  private async sendReadReceiptsForChat(chatId: string): Promise<void> {
    const user = this.currentUser();
    if (!user || !this.networkOnline()) return;

    const normalizedChatId = this.normalizeChatId(chatId);
    if (!normalizedChatId) return;
    if (this.groups().some((group) => group.id === normalizedChatId)) return;
    if (SYSTEM_CHAT_IDS.some((id) => this.normalizeChatId(id) === normalizedChatId)) return;

    const messages = this.messagesByChat()[normalizedChatId] ?? [];
    if (!messages.length) return;

    const sentSet = this.readReceiptSentByChat.get(normalizedChatId) ?? new Set<string>();
    const messageIds = messages
      .filter((message) => message.direction === 'incoming' && Boolean(message.messageId))
      .map((message) => message.messageId)
      .filter((messageId) => !sentSet.has(messageId));
    if (!messageIds.length) return;

    const nextSent = new Set(sentSet);
    for (let index = 0; index < messageIds.length; index += READ_RECEIPT_BATCH_SIZE) {
      const batch = messageIds.slice(index, index + READ_RECEIPT_BATCH_SIZE);
      try {
        await this.api.sendReadReceipt({
          reader: this.normalizeUser(user),
          sender: normalizedChatId,
          messageIds: batch,
          readAt: Date.now()
        });
        batch.forEach((messageId) => nextSent.add(messageId));
      } catch {
        // Best-effort only; next activation/receive/focus will retry unsent batches.
        break;
      }
    }

    if (nextSent.size !== sentSet.size) {
      this.readReceiptSentByChat.set(normalizedChatId, nextSent);
    }
  }

  private queueDirectMessage(
    originalSender: string,
    messageId: string,
    body: string,
    imageUrl: string | null
  ): void {
    const user = this.currentUser();
    if (!user) return;

    const item: OutboxDirectItem = {
      id: this.generateId('out'),
      kind: 'direct',
      payload: {
        user,
        senderName: this.getDisplayName(user),
        reply: body,
        imageUrl,
        originalSender,
        messageId
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
    recipients?: string[]
  ): void {
    const user = this.currentUser();
    if (!user) return;

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
        groupSenderName: this.getDisplayName(user)
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

    if (!this.networkOnline()) {
      return;
    }

    try {
      this.stream = this.api.createMessageStream(user);
      this.stream.onmessage = (event: MessageEvent<string>) => {
        this.handleIncomingPayload(event.data);
      };

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

  private scheduleStreamReconnect(user: string): void {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.currentUser() !== user) return;
      this.connectRealtime(user);
    }, STREAM_RETRY_MS);
  }

  private async pullMessages(user: string): Promise<void> {
    if (this.pullInFlight || !this.networkOnline()) return;
    if (this.currentUser() !== user) return;

    this.pullInFlight = true;
    try {
      const messages = await this.api.pollMessages(user);
      for (const message of messages) {
        this.applyIncomingMessage(message);
      }
    } catch {
      // Polling failures are expected during network interruptions.
    } finally {
      this.pullInFlight = false;
    }
  }

  private handleIncomingPayload(rawData: string): void {
    try {
      const message = JSON.parse(rawData) as IncomingServerMessage;
      this.applyIncomingMessage(message);
    } catch {
      // Ignore malformed realtime payloads.
    }
  }

  private applyIncomingMessage(incoming: IncomingServerMessage): void {
    const incomingType = String(incoming.type ?? '').trim().toLowerCase();
    if (incomingType === 'reaction') {
      this.applyIncomingReaction(incoming);
      return;
    }
    if (incomingType === 'group-update') {
      this.applyIncomingGroupUpdate(incoming);
      return;
    }
    if (incomingType === 'read-receipt') {
      this.applyIncomingReadReceipt(incoming);
      return;
    }

    const sender = this.normalizeUser(incoming.sender ?? '');
    if (!sender) return;

    const isGroup = Boolean(incoming.groupId);
    const chatId = isGroup
      ? this.normalizeChatId(incoming.groupId ?? '')
      : this.normalizeChatId(sender);
    if (!chatId) return;

    const messageId = String(incoming.messageId ?? this.generateId('srv')).trim();
    if (!messageId) return;

    const alreadyExists = (this.messagesByChat()[chatId] ?? []).some(
      (message) => message.messageId === messageId
    );
    if (alreadyExists) return;

    if (isGroup && incoming.groupId && incoming.groupName) {
      this.ensureGroupFromIncoming(incoming);
    }

    const record: ChatMessage = {
      id: this.generateId('rec'),
      messageId,
      chatId,
      sender,
      senderDisplayName: incoming.groupSenderName || this.getDisplayName(sender),
      body: String(incoming.body ?? ''),
      imageUrl: incoming.imageUrl ?? null,
      direction: 'incoming',
      timestamp: Number(incoming.timestamp ?? Date.now()),
      deliveryStatus: 'delivered',
      groupId: incoming.groupId ? this.normalizeChatId(incoming.groupId) : null,
      groupName: incoming.groupName ?? null
    };

    this.appendMessage(record);

    if (this.activeChatId() !== chatId) {
      this.unreadByChat.update((map) => ({
        ...map,
        [chatId]: (map[chatId] ?? 0) + 1
      }));
    } else {
      this.unreadByChat.update((map) => ({
        ...map,
        [chatId]: 0
      }));
      void this.sendReadReceiptsForChat(chatId);
    }

    this.schedulePersist();
  }

  private applyIncomingGroupUpdate(incoming: IncomingServerMessage): void {
    const groupId = this.normalizeChatId(incoming.groupId ?? '');
    if (!groupId || !incoming.groupName) return;

    const currentUser = this.normalizeUser(this.currentUser() ?? '');
    const members = Array.isArray(incoming.groupMembers)
      ? incoming.groupMembers.map((member) => this.normalizeUser(member)).filter(Boolean)
      : [];
    if (currentUser && members.length && !members.includes(currentUser)) {
      this.removeGroupLocally(groupId);
      return;
    }

    this.ensureGroupFromIncoming(incoming);
    this.schedulePersist();
  }

  private applyIncomingReadReceipt(incoming: IncomingServerMessage): void {
    const messageIds = Array.isArray(incoming.messageIds)
      ? incoming.messageIds.map((id) => String(id || '').trim()).filter(Boolean)
      : String(incoming.messageId ?? '')
          .split(',')
          .map((id) => String(id || '').trim())
          .filter(Boolean);
    if (!messageIds.length) return;

    this.markOutgoingMessagesAsRead(messageIds);
  }

  private applyIncomingReaction(incoming: IncomingServerMessage): void {
    const groupId = this.normalizeChatId(incoming.groupId ?? '');
    if (!groupId) return;

    if (incoming.groupName) {
      this.ensureGroupFromIncoming(incoming);
    }

    const targetMessageId = String(incoming.targetMessageId ?? incoming.messageId ?? '').trim();
    const emoji = String(incoming.emoji ?? '').trim();
    const reactor = this.normalizeUser(incoming.reactor ?? incoming.sender ?? '');
    if (!targetMessageId || !emoji || !reactor) {
      return;
    }

    const reaction: MessageReaction = {
      emoji,
      reactor,
      reactorName: String(incoming.reactorName ?? '').trim() || this.getDisplayName(reactor)
    };

    const changed = this.applyReactionToMessage(groupId, targetMessageId, reaction);
    if (!changed) return;

    const currentUser = this.normalizeUser(this.currentUser() ?? '');
    if (currentUser && reactor === currentUser) {
      return;
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

  private appendMessage(message: ChatMessage): void {
    const chatId = this.normalizeChatId(message.chatId);
    if (!chatId) return;

    const nextMessage: ChatMessage = {
      ...message,
      chatId,
      sender: this.normalizeUser(message.sender)
    };

    this.messagesByChat.update((messageMap) => {
      const list = messageMap[chatId] ? [...messageMap[chatId]] : [];
      if (list.some((entry) => entry.messageId === nextMessage.messageId)) {
        return messageMap;
      }
      list.push(nextMessage);
      list.sort((a, b) => a.timestamp - b.timestamp);
      return {
        ...messageMap,
        [chatId]: list
      };
    });

    this.schedulePersist();
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

  private markOutgoingMessagesAsRead(messageIds: string[]): void {
    const targetIds = new Set(messageIds.map((id) => String(id || '').trim()).filter(Boolean));
    if (!targetIds.size) return;

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
    if (message.imageUrl) {
      const imagePreview = message.direction === 'outgoing' ? 'אתה: שלחת תמונה' : '📷 תמונה';
      return this.truncatePreview(imagePreview);
    }
    if (!message.body) {
      return '';
    }

    const trimmed = message.body.trim();
    const isDocumentLink = /^https?:\/\/\S+\.(pdf|doc|docx)(\?|$)/i.test(trimmed);
    if (isDocumentLink) {
      const documentPreview = message.direction === 'outgoing' ? 'אתה: מסמך' : 'מסמך';
      return this.truncatePreview(documentPreview);
    }

    const preview = message.direction === 'outgoing' ? `אתה: ${trimmed}` : trimmed;
    return this.truncatePreview(preview);
  }

  private truncatePreview(value: string, maxChars = 100): string {
    const compact = value.replace(/\s+/g, ' ').trim();
    if (compact.length <= maxChars) {
      return compact;
    }
    return `${compact.slice(0, maxChars)}…`;
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

  private readStoredUser(): string | null {
    const value = localStorage.getItem('username');
    return value ? this.normalizeUser(value) : null;
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
      const unreadByChat = parsed.unreadByChat && typeof parsed.unreadByChat === 'object'
        ? parsed.unreadByChat
        : {};

      const messageMap: Record<string, ChatMessage[]> = {};
      for (const record of parsed.messages ?? []) {
        if (!record || !record.chatId) continue;
        const chatId = this.normalizeChatId(record.chatId);
        const normalized: ChatMessage = {
          ...record,
          chatId,
          sender: this.normalizeUser(record.sender),
          messageId: String(record.messageId || this.generateId('msg')),
          body: String(record.body ?? ''),
          timestamp: Number(record.timestamp ?? Date.now()),
          direction: record.direction === 'incoming' ? 'incoming' : 'outgoing',
          deliveryStatus: record.deliveryStatus ?? 'sent'
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
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
    }
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.persistState();
    }, 250);
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
    if (payloadType !== 'reaction' && payloadType !== 'group-update' && payloadType !== 'read-receipt') {
      // For regular message pushes, force a near-immediate pull so opened app isn't stale.
      this.syncForegroundState();
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

    this.applyIncomingMessage(incoming);
  };

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
    if (!user || !this.networkOnline()) return;

    const forceRefresh = Boolean(options.forceRefresh);
    const now = Date.now();
    if (!forceRefresh && now - this.lastForegroundSyncAt < FOREGROUND_SYNC_MIN_INTERVAL_MS) {
      return;
    }
    this.lastForegroundSyncAt = now;

    void this.pullMessages(user);
    void this.flushOutbox();
    void this.refresh(forceRefresh);
    const activeChat = this.activeChatId();
    if (activeChat) {
      void this.sendReadReceiptsForChat(activeChat);
    }
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
