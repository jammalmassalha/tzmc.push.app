import { Injectable, computed, signal } from '@angular/core';
import { SYSTEM_CHAT_IDS } from '../config/runtime-config';
import {
  ChatGroup,
  ChatListItem,
  ChatMessage,
  Contact,
  DeliveryStatus,
  GroupType,
  IncomingServerMessage,
  OutboxDirectItem,
  OutboxGroupItem,
  OutboxGroupUpdateItem,
  OutboxItem,
  PersistedChatState,
  ReplyPayload
} from '../models/chat.models';
import { ChatApiService } from './chat-api.service';

const CONTACTS_TTL_MS = 5 * 60 * 1000;
const GROUPS_TTL_MS = 2 * 60 * 1000;
const POLL_INTERVAL_MS = 15000;
const STREAM_RETRY_MS = 5000;
const MAX_PERSISTED_MESSAGES = 2500;

@Injectable({ providedIn: 'root' })
export class ChatStoreService {
  readonly currentUser = signal<string | null>(this.readStoredUser());
  readonly contacts = signal<Contact[]>([]);
  readonly groups = signal<ChatGroup[]>([]);
  readonly activeChatId = signal<string | null>(null);
  readonly unreadByChat = signal<Record<string, number>>({});
  readonly loading = signal(false);
  readonly syncing = signal(false);
  readonly uploading = signal(false);
  readonly networkOnline = signal(typeof navigator !== 'undefined' ? navigator.onLine : true);
  readonly lastError = signal<string | null>(null);

  private readonly messagesByChat = signal<Record<string, ChatMessage[]>>({});
  private stream: EventSource | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private pullInFlight = false;
  private initializedUser: string | null = null;
  private lastContactsFetchAt = 0;
  private lastGroupsFetchAt = 0;

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
        subtitle,
        lastTimestamp,
        unread,
        isGroup: Boolean(group),
        pinned
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

  constructor(private readonly api: ChatApiService) {
    const storedUser = this.currentUser();
    if (storedUser) {
      this.restoreState(storedUser);
    }

    if (typeof window !== 'undefined') {
      window.addEventListener('online', this.handleOnline);
      window.addEventListener('offline', this.handleOffline);
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
    this.connectRealtime(user);
    await this.flushOutbox();

    if (!this.activeChatId()) {
      this.activeChatId.set(this.chatItems()[0]?.id ?? null);
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
    this.activeChatId.set(null);
    this.lastError.set(null);

    this.restoreState(user);
    await this.tryRegisterPush(user);
    await this.initialize();
  }

  logout(): void {
    this.stopRealtime();
    this.initializedUser = null;
    localStorage.removeItem('username');
    this.currentUser.set(null);
    this.contacts.set([]);
    this.groups.set([]);
    this.messagesByChat.set({});
    this.unreadByChat.set({});
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

  setActiveChat(chatId: string | null): void {
    if (!chatId) {
      this.activeChatId.set(null);
      return;
    }

    const normalized = this.normalizeChatId(chatId);
    this.activeChatId.set(normalized);
    this.unreadByChat.update((map) => ({
      ...map,
      [normalized]: 0
    }));
    this.schedulePersist();
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
    }

    this.schedulePersist();
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
          changed = true;
          return { ...message, deliveryStatus: status };
        });
        next[chatId] = updated;
      }

      return changed ? next : messageMap;
    });

    this.schedulePersist();
  }

  private tryRegisterPush = async (user: string): Promise<void> => {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;

    try {
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') return;

      const registration = await navigator.serviceWorker.ready;
      const existing = await registration.pushManager.getSubscription();
      const subscription =
        existing ??
        (await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: this.urlBase64ToUint8Array(this.api.vapidPublicKey)
        }));

      await this.api.registerDevice(user, subscription);
    } catch {
      // Registration is best-effort to keep setup responsive.
    }
  };

  private getMessagePreview(message: ChatMessage): string {
    if (message.imageUrl) {
      return message.direction === 'outgoing' ? 'אתה: שלחת תמונה' : '📷 תמונה';
    }
    if (!message.body) {
      return '';
    }

    const trimmed = message.body.trim();
    const isDocumentLink = /^https?:\/\/\S+\.(pdf|doc|docx)(\?|$)/i.test(trimmed);
    if (isDocumentLink) {
      return message.direction === 'outgoing' ? 'אתה: מסמך' : 'מסמך';
    }

    return message.direction === 'outgoing' ? `אתה: ${trimmed}` : trimmed;
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
        return {
          username,
          displayName: (contact.displayName || username).trim(),
          phone: contact.phone?.trim() || undefined
        } satisfies Contact;
      })
      .filter((contact) => {
        if (!contact.username || seen.has(contact.username)) return false;
        seen.add(contact.username);
        return true;
      });
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
    this.connectRealtime(user);
    void this.flushOutbox();
    void this.refresh(false);
  };

  private handleOffline = (): void => {
    this.networkOnline.set(false);
  };
}
