import { Injectable, Signal, resource, ResourceRef } from '@angular/core';
import { getNotifyBaseUrl, runtimeConfig } from '../config/runtime-config';
import {
  ChatGroup,
  CommunityGroupConfig,
  Contact,
  DeleteMessagePayload,
  EditMessagePayload,
  GroupUpdatePayload,
  HelpdeskDashboard,
  HelpdeskManagedUser,
  HelpdeskMyRole,
  HelpdeskNote,
  HelpdeskStatusHistoryEntry,
  HelpdeskTicket,
  HelpdeskTicketPayload,
  IncomingServerMessage,
  ReadReceiptPayload,
  ReactionPayload,
  ReplyPayload,
  TypingPayload
} from '../models/chat.models';

interface FetchRetryOptions {
  retries?: number;
  timeoutMs?: number;
  backoffMs?: number;
}

interface ContactResponse {
  users?: Array<{
    username?: string;
    fullName?: string;
    full_name?: string;
    displayName?: string;
    phone?: string;
    upic?: string;
    status?: number | string;
    accessStatus?: number | string;
    userStatus?: number | string;
  }>;
}

interface GroupsResponse {
  groups?: Array<{
    id?: string;
    groupID?: string;
    groupId?: string;
    name?: string;
    title?: string;
    groupName?: string;
    members?: string[];
    memberList?: string[];
    groupMembers?: string[];
    admins?: string[];
    groupAdmins?: string[];
    createdBy?: string;
    groupCreatedBy?: string;
    updatedAt?: number;
    groupUpdatedAt?: number;
    type?: string;
    groupType?: string;
  }>;
}

interface PollResponse {
  messages?: IncomingServerMessage[];
}

interface LogsMessagesResponse {
  result?: string;
  messages?: IncomingServerMessage[];
  error?: string;
}

interface UploadResponse {
  status?: string;
  url?: string;
  thumbUrl?: string | null;
  type?: string;
}

interface ResetBadgeResponse {
  status?: string;
  scope?: string;
  clearedKeys?: number;
  message?: string;
}

interface VersionResponse {
  version?: string;
  notes?: string[];
  releaseNotes?: string[];
}

interface HrStepsResponse {
  result?: string;
  data?: Array<{
    id?: string | number;
    name?: string;
    subject?: string;
    showToAllUsers?: number | string | boolean;
    show_to_all_users?: number | string | boolean;
  }>;
}

interface HrActionsResponse {
  result?: string;
  data?: Array<{
    stepName?: string;
    returnValue?: string;
  }>;
}

interface SessionResponse {
  authenticated?: boolean;
  user?: string | null;
  csrfToken?: string | null;
  status?: string;
  message?: string;
  retryAfterSeconds?: number;
  verificationRequired?: boolean;
  codeSent?: boolean;
  expiresInSeconds?: number;
}

interface ClientLogPayload {
  event: string;
  payload?: Record<string, unknown>;
  user?: string;
  timestamp?: number;
}

export interface RealtimeSocket {
  connected: boolean;
  auth: Record<string, unknown>;
  on(event: string, listener: (...args: unknown[]) => void): this;
  connect(): this;
  disconnect(): this;
  emit(event: string, ...args: unknown[]): this;
}

export interface HrStepOption {
  id: string;
  name: string;
  subject: string;
  showToAllUsers: boolean;
}

export interface HrActionOption {
  stepName: string;
  returnValue: string;
}

export interface ShuttleOrderSubmitPayload {
  employee: string;
  date: string;
  dateAlt: string;
  shift: string;
  station: string;
  status: string;
}

export interface ShuttleUserOrderPayload {
  id?: string | number;
  sheetRow?: string | number;
  employee?: string;
  employeePhone?: string;
  date?: string;
  dateIso?: string;
  dayName?: string;
  shift?: string;
  shiftLabel?: string;
  shiftValue?: string;
  station?: string;
  status?: string;
  statusValue?: string;
  submittedAt?: string | number;
  cancelledAt?: string | number;
  isCancelled?: boolean;
  isOngoing?: boolean;
}

export interface UserPushSubscriptionPayload {
  endpoint?: string;
  expirationTime?: number | null;
  keys?: {
    p256dh?: string;
    auth?: string;
  };
  type?: string;
  username?: string;
  user?: string;
}

@Injectable({ providedIn: 'root' })
export class ChatApiService {
  private readonly config = runtimeConfig;
  private readonly notifyBaseUrl = getNotifyBaseUrl(this.config.notifyReplyUrl);
  private csrfToken: string | null = null;

  get streamUrlBase(): string {
    return `${this.notifyBaseUrl}/stream`;
  }

  get messagesUrlBase(): string {
    return `${this.notifyBaseUrl}/messages`;
  }

  get vapidPublicKey(): string {
    return this.config.vapidPublicKey;
  }

  async getSessionUser(): Promise<string | null> {
    const response = await this.fetchWithRetry(`${this.notifyBaseUrl}/auth/session`, {}, { retries: 1, timeoutMs: 8000 });
    if (!response.ok) {
      this.csrfToken = null;
      return null;
    }

    const body = (await response.json()) as SessionResponse;
    this.csrfToken = String(body.csrfToken ?? '').trim() || null;
    const user = String(body.user ?? '').trim().toLowerCase();
    if (!body.authenticated) {
      this.csrfToken = null;
    }
    return body.authenticated && user ? user : null;
  }

  async createSession(user: string): Promise<string> {
    const normalized = String(user || '').trim().toLowerCase();
    if (!normalized) {
      throw new Error('מספר טלפון לא תקין');
    }

    const response = await this.fetchWithRetry(
      `${this.notifyBaseUrl}/auth/session`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user: normalized })
      },
      { retries: 1, timeoutMs: 12000 }
    );
    if (!response.ok) {
      let errorMessage = 'נכשל בהתחברות';
      try {
        const body = (await response.json()) as SessionResponse & { error?: string };
        const backendMessage = String(body.message ?? body.error ?? '').trim();
        if (response.status === 400) {
          errorMessage = 'מספר טלפון לא תקין';
        } else if (response.status === 403) {
          errorMessage = 'המשתמש אינו מורשה';
        } else if (response.status === 429 && body.retryAfterSeconds) {
          errorMessage = `יותר מדי ניסיונות. נסה שוב בעוד ${body.retryAfterSeconds} שניות`;
        } else if (backendMessage) {
          errorMessage = backendMessage;
        }
      } catch {
        // Keep fallback message.
      }
      throw new Error(errorMessage);
    }

    const body = (await response.json()) as SessionResponse;
    this.csrfToken = String(body.csrfToken ?? '').trim() || null;
    const sessionUser = String(body.user ?? '').trim().toLowerCase();
    if (!body.authenticated || !sessionUser) {
      this.csrfToken = null;
      throw new Error('נכשל בהתחברות');
    }
    return sessionUser;
  }

  async requestSessionCode(user: string): Promise<{ expiresInSeconds: number }> {
    const normalized = String(user || '').trim().toLowerCase();
    if (!normalized) {
      throw new Error('מספר טלפון לא תקין');
    }

    const response = await this.fetchWithRetry(
      `${this.notifyBaseUrl}/auth/session/request-code`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user: normalized })
      },
      { retries: 1, timeoutMs: 12000 }
    );
    if (!response.ok) {
      let errorMessage = 'שליחת קוד אימות נכשלה';
      try {
        const body = (await response.json()) as SessionResponse & { error?: string };
        const backendMessage = String(body.message ?? body.error ?? '').trim();
        if (response.status === 400) {
          errorMessage = 'מספר טלפון לא תקין';
        } else if (response.status === 403) {
          errorMessage = 'המשתמש אינו מורשה';
        } else if (response.status === 429 && body.retryAfterSeconds) {
          errorMessage = `יותר מדי ניסיונות. נסה שוב בעוד ${body.retryAfterSeconds} שניות`;
        } else if (backendMessage) {
          errorMessage = backendMessage;
        }
      } catch {
        // Keep fallback message.
      }
      throw new Error(errorMessage);
    }

    const body = (await response.json()) as SessionResponse;
    const expiresInSeconds = Number(body.expiresInSeconds ?? 0);
    return {
      expiresInSeconds: Number.isFinite(expiresInSeconds) && expiresInSeconds > 0
        ? Math.floor(expiresInSeconds)
        : 300
    };
  }

  async verifySessionCode(user: string, code: string): Promise<string> {
    const normalized = String(user || '').trim().toLowerCase();
    const normalizedCode = String(code || '').trim();
    if (!normalized) {
      throw new Error('מספר טלפון לא תקין');
    }
    if (!/^\d{6}$/.test(normalizedCode)) {
      throw new Error('יש להזין קוד אימות בן 6 ספרות');
    }

    const response = await this.fetchWithRetry(
      `${this.notifyBaseUrl}/auth/session/verify-code`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user: normalized, code: normalizedCode })
      },
      { retries: 1, timeoutMs: 12000 }
    );
    if (!response.ok) {
      let errorMessage = 'אימות הקוד נכשל';
      try {
        const body = (await response.json()) as SessionResponse & { error?: string };
        const backendMessage = String(body.message ?? body.error ?? '').trim();
        if (response.status === 400) {
          errorMessage = 'קוד אימות לא תקין';
        } else if (response.status === 401) {
          errorMessage = 'קוד האימות שגוי או פג תוקף';
        } else if (response.status === 403) {
          errorMessage = 'המשתמש אינו מורשה';
        } else if (response.status === 429 && body.retryAfterSeconds) {
          errorMessage = `יותר מדי ניסיונות. נסה שוב בעוד ${body.retryAfterSeconds} שניות`;
        } else if (backendMessage) {
          errorMessage = backendMessage;
        }
      } catch {
        // Keep fallback message.
      }
      throw new Error(errorMessage);
    }

    const body = (await response.json()) as SessionResponse;
    this.csrfToken = String(body.csrfToken ?? '').trim() || null;
    const sessionUser = String(body.user ?? '').trim().toLowerCase();
    if (!body.authenticated || !sessionUser) {
      this.csrfToken = null;
      throw new Error('אימות הקוד נכשל');
    }
    return sessionUser;
  }

  async clearSession(): Promise<void> {
    await this.fetchWithRetry(
      `${this.notifyBaseUrl}/auth/session`,
      { method: 'DELETE' },
      { retries: 0, timeoutMs: 8000 }
    );
    this.csrfToken = null;
  }

  async sendClientLog(event: string, payload: Record<string, unknown>, user?: string): Promise<void> {
    const safeEvent = String(event || '').trim();
    if (!safeEvent) {
      return;
    }
    const body: ClientLogPayload = {
      event: safeEvent,
      payload: payload && typeof payload === 'object' ? payload : {},
      user: String(user || '').trim() || undefined,
      timestamp: Date.now()
    };
    const response = await this.fetchWithRetry(
      `${this.notifyBaseUrl}/log`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      },
      { retries: 1, timeoutMs: 8000, backoffMs: 400 }
    );
    if (!response.ok) {
      throw new Error(`Client log failed with ${response.status}`);
    }
  }

  async getContacts(user?: string): Promise<Contact[]> {
    const normalizedUser = String(user || '').trim();
    const candidateUrls = [`${this.notifyBaseUrl}/contacts`];
    if (normalizedUser) {
      const encodedUser = encodeURIComponent(normalizedUser);
      candidateUrls.push(
        `${this.notifyBaseUrl}/contacts?user=${encodedUser}`,
        `${this.notifyBaseUrl}/contacts/${encodedUser}`
      );
    }

    let response: Response | null = null;
    let lastStatus = 0;
    for (const url of candidateUrls) {
      try {
        const candidateResponse = await this.fetchWithRetry(url, {}, { retries: 1, timeoutMs: 10000 });
        if (candidateResponse.ok) {
          response = candidateResponse;
          break;
        }
        lastStatus = candidateResponse.status;
      } catch {
        // Try the next compatible URL variant.
      }
    }
    if (!response) {
      throw new Error(`Contacts request failed with ${lastStatus || 0}`);
    }

    const body = (await response.json()) as ContactResponse;
    const seen = new Set<string>();

    return (body.users ?? [])
      .map((contact) => {
        const record = contact as Record<string, unknown>;
        const hasFullNameField = (
          Object.prototype.hasOwnProperty.call(contact, 'fullName') ||
          Object.prototype.hasOwnProperty.call(contact, 'full_name')
        );
        const username = String(contact.username ?? '').trim();
        const fullNameRaw = String(contact.fullName ?? contact.full_name ?? '').trim();
        const displayNameRaw = String(contact.displayName ?? '').trim();
        const fullNameParsed = this.parseNameAndInfo(fullNameRaw);
        const displayNameParsed = this.parseNameAndInfo(displayNameRaw);
        const fullName = fullNameParsed.name;
        const displayName = fullNameParsed.name || displayNameParsed.name;
        const info = fullNameParsed.info || displayNameParsed.info;
        const phone = String(contact.phone ?? '').trim();
        const upic = String(contact.upic ?? '').trim();
        const status = this.parseContactStatus(
          record['status'] ?? record['accessStatus'] ?? record['userStatus']
        );

        return {
          username,
          displayName,
          info,
          phone: phone || undefined,
          upic: upic || undefined,
          status,
          hasFullNameField,
          fullName
        };
      })
      .filter((contact) => {
        if (contact.hasFullNameField && !contact.fullName) {
          return false;
        }
        return Boolean(contact.username && contact.displayName);
      })
      .map((contact) => {
        return {
          username: contact.username,
          displayName: contact.displayName,
          info: contact.info,
          phone: contact.phone,
          upic: contact.upic,
          status: contact.status
        } satisfies Contact;
      })
      .filter((contact) => {
        const key = contact.username.toLowerCase();
        if (!key || seen.has(key)) {
          return false;
        }
        seen.add(key);
        return true;
      });
  }

  createContactsResource(user: Signal<string | null | undefined>): ResourceRef<Contact[]> {
    return resource({
      params: () => String(user() || '').trim().toLowerCase(),
      loader: async ({ params }) => this.getContacts(params || undefined),
      defaultValue: []
    });
  }

  private parseNameAndInfo(value: string): { name: string; info?: string } {
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

    const cleanedName = withoutParentheses.replace(/\s+/g, ' ').trim();
    const mergedInfo = infoParts.length ? infoParts.join(' | ') : undefined;
    return {
      name: cleanedName,
      info: mergedInfo
    };
  }

  private parseContactStatus(value: unknown): number | undefined {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return Math.trunc(value);
    }
    const normalized = String(value ?? '').trim();
    if (!normalized) return undefined;
    const parsed = Number.parseInt(normalized, 10);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  async getGroups(user?: string): Promise<ChatGroup[]> {
    const normalizedUser = String(user || '').trim().toLowerCase();
    const candidateUrls = [this.config.groupsUrl];
    if (normalizedUser) {
      candidateUrls.push(`${this.config.groupsUrl}?user=${encodeURIComponent(normalizedUser)}`);
    }

    let response: Response | null = null;
    let lastStatus = 0;
    for (const url of candidateUrls) {
      const candidateResponse = await this.fetchWithRetry(url, {}, { retries: 1, timeoutMs: 10000 });
      if (candidateResponse.ok) {
        response = candidateResponse;
        break;
      }
      lastStatus = candidateResponse.status;
    }
    if (!response) {
      throw new Error(`Groups request failed with ${lastStatus || 0}`);
    }

    const body = (await response.json()) as GroupsResponse;
    return (body.groups ?? [])
      .map((group) => {
        const id = String(group.id ?? group.groupID ?? group.groupId ?? '').trim();
        const name = String(group.name ?? group.title ?? group.groupName ?? '').trim();
        const members = (group.members ?? group.memberList ?? group.groupMembers ?? []).map((member) =>
          String(member).trim()
        ).filter(Boolean);
        const admins = (group.admins ?? group.groupAdmins ?? []).map((admin) =>
          String(admin).trim()
        ).filter(Boolean);
        const createdBy = String(group.createdBy ?? group.groupCreatedBy ?? '').trim();
        const updatedAt = Number(group.updatedAt ?? group.groupUpdatedAt ?? Date.now());
        const type = group.type === 'community' || group.groupType === 'community'
          ? 'community'
          : 'group';

        return {
          id,
          name,
          members,
          admins,
          createdBy: createdBy || admins[0] || normalizedUser,
          updatedAt,
          type
        } satisfies ChatGroup;
      })
      .filter((group) => Boolean(group.id && group.name));
  }

  createGroupsResource(user: Signal<string | null | undefined>): ResourceRef<ChatGroup[]> {
    return resource({
      params: () => String(user() || '').trim().toLowerCase(),
      loader: async ({ params }) => this.getGroups(params || undefined),
      defaultValue: []
    });
  }

  async getCommunityGroupConfigs(): Promise<CommunityGroupConfig[]> {
    try {
      const response = await this.fetchWithRetry(
        this.config.communityGroupConfigsUrl,
        {},
        { retries: 1, timeoutMs: 10000 }
      );
      if (!response.ok) return [];
      const body = (await response.json()) as { configs?: Array<{
        id?: string;
        name?: string;
        staticMembers?: string[];
        allowedWriters?: string[];
      }> };
      return (body.configs ?? [])
        .map((cfg) => ({
          id: String(cfg.id ?? '').trim(),
          name: String(cfg.name ?? '').trim(),
          staticMembers: Array.isArray(cfg.staticMembers) && cfg.staticMembers.length > 0
            ? cfg.staticMembers.map((m) => String(m).trim()).filter(Boolean)
            : undefined,
          allowedWriters: (cfg.allowedWriters ?? []).map((w) => String(w).trim()).filter(Boolean)
        }))
        .filter((cfg) => Boolean(cfg.id && cfg.name));
    } catch {
      return [];
    }
  }

  async getUserChatGroups(): Promise<ChatGroup[]> {
    try {
      const response = await this.fetchWithRetry(
        this.config.userChatGroupsUrl,
        {},
        { retries: 1, timeoutMs: 10000 }
      );
      if (!response.ok) return [];
      const body = (await response.json()) as { groups?: Array<{
        id?: string;
        name?: string;
        members?: string[];
        admins?: string[];
        createdBy?: string;
        type?: string;
        createdAt?: number;
        updatedAt?: number;
      }> };
      return (body.groups ?? [])
        .map((g) => ({
          id: String(g.id ?? '').trim(),
          name: String(g.name ?? '').trim(),
          members: Array.isArray(g.members) ? g.members.map((m) => String(m).trim()).filter(Boolean) : [],
          admins: Array.isArray(g.admins) ? g.admins.map((a) => String(a).trim()).filter(Boolean) : [],
          createdBy: String(g.createdBy ?? '').trim(),
          type: (g.type === 'community' ? 'community' : 'group') as ChatGroup['type'],
          updatedAt: Number(g.updatedAt) || 0
        }))
        .filter((g) => Boolean(g.id && g.name));
    } catch {
      return [];
    }
  }

  async pollMessages(user?: string): Promise<IncomingServerMessage[]> {
    const normalizedUser = String(user || '').trim().toLowerCase();
    const candidateUrls = normalizedUser
      ? [`${this.messagesUrlBase}?user=${encodeURIComponent(normalizedUser)}`, this.messagesUrlBase]
      : [this.messagesUrlBase];

    let response: Response | null = null;
    let lastStatus = 0;
    for (const url of candidateUrls) {
      const candidateResponse = await this.fetchWithRetry(url, {}, { retries: 1, timeoutMs: 10000 });
      if (candidateResponse.ok) {
        response = candidateResponse;
        break;
      }
      lastStatus = candidateResponse.status;
    }
    if (!response) {
      throw new Error(`Messages request failed with ${lastStatus || 0}`);
    }

    const body = (await response.json()) as PollResponse;
    return Array.isArray(body.messages) ? body.messages : [];
  }

  async getMessagesFromLogs(user?: string, limit = 1000, offset = 0, since = 0): Promise<IncomingServerMessage[]> {
    const normalizedUser = String(user || '').trim().toLowerCase();
    if (!normalizedUser) return [];
  
    const safeLimit = Math.min(200000, Math.max(1, Math.floor(limit)));
    const safeOffset = Math.max(0, Math.floor(offset));
    
    // Append &since=${since} to the URL
    const url = `${this.notifyBaseUrl}/messages/logs?user=${encodeURIComponent(normalizedUser)}&excludeSystem=1&limit=${safeLimit}&offset=${safeOffset}&since=${since}&_ts=${Date.now()}`;
    
    const response = await this.fetchWithRetry(
      url,
      { cache: 'no-store' },
      { retries: 1, timeoutMs: 20000, backoffMs: 500 }
    );
    
    if (!response.ok) throw new Error(`Logs request failed: ${response.status}`);
    const body = (await response.json()) as { messages?: IncomingServerMessage[] };
    return Array.isArray(body.messages) ? body.messages : [];
  }

  async reportMessageReceived(msgId: string, receivedAt: number): Promise<void> {
    const safeMsgId = String(msgId || '').trim();
    if (!safeMsgId || !Number.isFinite(receivedAt) || receivedAt <= 0) return;
    const response = await this.fetchWithRetry(
      `${this.notifyBaseUrl}/messages/received`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ msgId: safeMsgId, receivedAt })
      },
      { retries: 1, timeoutMs: 10000, backoffMs: 500 }
    );
    if (!response.ok) {
      throw new Error(`reportMessageReceived failed with ${response.status}`);
    }
  }

  async reportMessagesReceivedBatch(entries: Array<{ msgId: string; receivedAt: number }>): Promise<void> {
    const validEntries = (entries || [])
      .map((e) => ({
        msgId: String(e.msgId || '').trim(),
        receivedAt: e.receivedAt
      }))
      .filter((e) => e.msgId && Number.isFinite(e.receivedAt) && e.receivedAt > 0);
    if (!validEntries.length) return;
    const response = await this.fetchWithRetry(
      `${this.notifyBaseUrl}/messages/received-batch`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entries: validEntries })
      },
      { retries: 1, timeoutMs: 15000, backoffMs: 500 }
    );
    if (!response.ok) {
      throw new Error(`reportMessagesReceivedBatch failed with ${response.status}`);
    }
  }

  createMessagesResource(user: Signal<string | null | undefined>): ResourceRef<IncomingServerMessage[]> {
    return resource({
      params: () => String(user() || '').trim().toLowerCase(),
      loader: async ({ params }) => this.pollMessages(params || undefined),
      defaultValue: []
    });
  }

  createMessageStream(user?: string): EventSource {
    const normalizedUser = String(user || '').trim().toLowerCase();
    const url = normalizedUser
      ? `${this.streamUrlBase}?user=${encodeURIComponent(normalizedUser)}`
      : this.streamUrlBase;
    return new EventSource(url);
  }

  async createRealtimeSocket(user?: string): Promise<RealtimeSocket> {
    const normalizedUser = String(user || '').trim().toLowerCase();
    let socketServerBase = this.notifyBaseUrl;
    try {
      const urlBase = typeof window !== 'undefined' ? window.location.origin : 'http://localhost';
      const parsed = new URL(this.notifyBaseUrl, urlBase);
      socketServerBase = parsed.origin;
    } catch {
      socketServerBase = this.notifyBaseUrl;
    }
    const { io } = await import('socket.io-client');
    const socket = io(socketServerBase, {
      path: '/notify/socket.io',
      transports: ['polling', 'websocket'],
      reconnection: false,
      withCredentials: true,
      autoConnect: false,
      auth: normalizedUser ? { user: normalizedUser } : {},
      query: normalizedUser ? { user: normalizedUser } : {}
    });
    return socket as unknown as RealtimeSocket;
  }

  async sendDirectMessage(payload: ReplyPayload): Promise<void> {
    const response = await this.fetchWithRetry(
      this.config.notifyReplyUrl,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      },
      { retries: 2, timeoutMs: 10000 }
    );

    if (!response.ok) {
      throw new Error(`Message send failed with ${response.status}`);
    }
  }

  async sendGroupUpdate(payload: GroupUpdatePayload): Promise<void> {
    const response = await this.fetchWithRetry(
      this.config.groupUpdateUrl,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      },
      { retries: 2, timeoutMs: 10000 }
    );

    if (!response.ok) {
      throw new Error(`Group update failed with ${response.status}`);
    }
  }

  async sendReaction(payload: ReactionPayload): Promise<void> {
    const response = await this.fetchWithRetry(
      this.config.reactionUrl,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      },
      { retries: 2, timeoutMs: 10000 }
    );

    if (!response.ok) {
      throw new Error(`Reaction update failed with ${response.status}`);
    }
  }

  async sendTypingState(payload: TypingPayload): Promise<void> {
    const response = await this.fetchWithRetry(
      `${this.notifyBaseUrl}/typing`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      },
      { retries: 1, timeoutMs: 4000, backoffMs: 300 }
    );

    if (!response.ok) {
      throw new Error(`Typing update failed with ${response.status}`);
    }
  }

  async sendReadReceipt(payload: ReadReceiptPayload): Promise<void> {
    const response = await this.fetchWithRetry(
      `${this.notifyBaseUrl}/read`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      },
      { retries: 2, timeoutMs: 10000 }
    );

    if (!response.ok) {
      throw new Error(`Read receipt failed with ${response.status}`);
    }
  }

  async editMessageForEveryone(payload: EditMessagePayload): Promise<void> {
    const response = await this.fetchWithRetry(
      `${this.notifyBaseUrl}/edit`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      },
      { retries: 2, timeoutMs: 10000 }
    );

    if (!response.ok) {
      throw new Error(`Edit message failed with ${response.status}`);
    }
  }

  async deleteMessageForEveryone(payload: DeleteMessagePayload): Promise<void> {
    const response = await this.fetchWithRetry(
      `${this.notifyBaseUrl}/delete`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      },
      { retries: 2, timeoutMs: 10000 }
    );

    if (!response.ok) {
      throw new Error(`Delete message failed with ${response.status}`);
    }
  }

  async resetServerBadge(user: string): Promise<void> {
    const normalized = String(user || '').trim().toLowerCase();
    if (!normalized) return;

    const response = await this.fetchWithRetry(
      `${this.notifyBaseUrl}/reset-badge`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user: normalized })
      },
      { retries: 1, timeoutMs: 8000 }
    );

    if (!response.ok) {
      throw new Error(`Reset badge failed with ${response.status}`);
    }
  }

  async resetAllServerBadges(user?: string): Promise<{ clearedKeys: number }> {
    const normalized = String(user || '').trim().toLowerCase();
    const response = await this.fetchWithRetry(
      `${this.notifyBaseUrl}/reset-badge`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          all: true,
          user: normalized || undefined
        })
      },
      { retries: 1, timeoutMs: 8000 }
    );

    const body = (await response.json().catch(() => ({}))) as ResetBadgeResponse;
    if (!response.ok || String(body?.status || '').trim().toLowerCase() !== 'success') {
      throw new Error(String(body?.message || '').trim() || `Reset all badges failed with ${response.status}`);
    }

    return {
      clearedKeys: Number.isFinite(Number(body?.clearedKeys)) ? Math.max(0, Math.floor(Number(body?.clearedKeys))) : 0
    };
  }

  async broadcastVersionUpdate(user?: string): Promise<{ notifiedUsers: number }> {
    const normalized = String(user || '').trim().toLowerCase();
    const response = await this.fetchWithRetry(
      `${this.notifyBaseUrl}/broadcast-version-update`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          user: normalized || undefined
        })
      },
      { retries: 1, timeoutMs: 30000 }
    );

    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok || String(body?.['status'] || '').trim().toLowerCase() !== 'success') {
      throw new Error(String(body?.['message'] || '').trim() || `Broadcast version update failed with ${response.status}`);
    }

    return {
      notifiedUsers: Number.isFinite(Number(body?.['notifiedUsers'])) ? Math.max(0, Math.floor(Number(body?.['notifiedUsers']))) : 0
    };
  }

  async markMessagesSeen(user: string, chatId: string): Promise<{ marked: number }> {
    const normalized = String(user || '').trim().toLowerCase();
    const response = await this.fetchWithRetry(
      `${this.notifyBaseUrl}/mark-seen`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          user: normalized || undefined,
          chatId: String(chatId || '').trim().toLowerCase()
        })
      },
      { retries: 1, timeoutMs: 8000 }
    );
    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    return { marked: Number(body?.['marked']) || 0 };
  }

  async backupAllGroupsToDb(user: string): Promise<{ backedUp: number; total: number }> {
    const normalized = String(user || '').trim().toLowerCase();
    const response = await this.fetchWithRetry(
      `${this.notifyBaseUrl}/backup-all-groups-to-db`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user: normalized || undefined })
      },
      { retries: 1, timeoutMs: 30000 }
    );
    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok || String(body?.['status'] || '').trim().toLowerCase() !== 'success') {
      throw new Error(String(body?.['message'] || '').trim() || `Backup groups failed with ${response.status}`);
    }
    return {
      backedUp: Number(body?.['backedUp']) || 0,
      total: Number(body?.['total']) || 0
    };
  }

  async uploadFile(file: File, thumbnail?: File | null): Promise<UploadResponse> {
    const formData = new FormData();
    formData.append('file', file, file.name);
    if (thumbnail) {
      formData.append('thumbnail', thumbnail, thumbnail.name);
    }

    const response = await this.fetchWithRetry(
      this.config.uploadUrl,
      { method: 'POST', body: formData },
      { retries: 2, timeoutMs: 30000 }
    );

    if (!response.ok) {
      throw new Error(`Upload failed with ${response.status}`);
    }

    return (await response.json()) as UploadResponse;
  }

  async registerDevice(user: string, subscription: PushSubscription | null, action?: string): Promise<void> {
    const deviceType = this.detectDeviceType();
    const platform = this.detectPlatform();
    const payload: {
      username: string;
      subscription: PushSubscription | null;
      deviceType: 'Mobile' | 'PC';
      action?: string;
      subscriptionPC?: PushSubscription | null;
      subscriptionMobile?: PushSubscription | null;
      platform?: 'iOS' | 'Android' | 'Desktop';
      userAgent?: string;
    } = {
      username: user.toLowerCase(),
      subscription,
      deviceType,
      action: action || 'subscribe',
      platform,
      userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : ''
    };

    if (deviceType === 'PC') {
      payload.subscriptionPC = subscription;
    } else {
      payload.subscriptionMobile = subscription;
    }

    const backendRegistration = this.fetchWithRetry(
      `${this.notifyBaseUrl}/register-device`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      },
      { retries: 2, timeoutMs: 12000, backoffMs: 500 }
    );
    await backendRegistration;
  }

  async getVersion(): Promise<{ version: string; notes: string[] }> {
    const response = await this.fetchWithRetry(
      `${this.config.versionUrl}?t=${Date.now()}`,
      {},
      { retries: 1, timeoutMs: 8000 }
    );

    if (!response.ok) {
      throw new Error(`Version check failed with ${response.status}`);
    }

    const body = (await response.json()) as VersionResponse;
    return {
      version: String(body.version ?? ''),
      notes: Array.isArray(body.notes)
        ? body.notes
        : Array.isArray(body.releaseNotes)
          ? body.releaseNotes
          : []
    };
  }

  async getHrSteps(): Promise<HrStepOption[]> {
    const url = `${this.notifyBaseUrl}/hr/steps?_ts=${Date.now()}`;
    const response = await this.fetchWithRetry(url, {}, { retries: 2, timeoutMs: 10000 });
    if (!response.ok) {
      throw new Error(`HR steps request failed with ${response.status}`);
    }

    const body = (await response.json()) as HrStepsResponse;
    if (body.result !== 'success' || !Array.isArray(body.data)) {
      return [];
    }

    return body.data
      .map((item) => ({
        id: String(item.id ?? '').trim(),
        name: String(item.name ?? '').trim(),
        subject: String(item.subject ?? '').trim(),
        showToAllUsers: this.parseBooleanLike(item.showToAllUsers ?? item.show_to_all_users)
      }))
      .filter((item) => Boolean(item.id && item.name));
  }

  async getHrActions(serviceId: string): Promise<HrActionOption[]> {
    const normalized = String(serviceId || '').trim();
    if (!normalized) return [];

    const url = `${this.notifyBaseUrl}/hr/actions?serviceId=${encodeURIComponent(normalized)}&_ts=${Date.now()}`;
    const response = await this.fetchWithRetry(url, {}, { retries: 2, timeoutMs: 10000 });
    if (!response.ok) {
      throw new Error(`HR actions request failed with ${response.status}`);
    }

    const body = (await response.json()) as HrActionsResponse;
    if (body.result !== 'success' || !Array.isArray(body.data)) {
      return [];
    }

    return body.data
      .map((item) => ({
        stepName: String(item.stepName ?? '').trim(),
        returnValue: String(item.returnValue ?? '').trim()
      }))
      .filter((item) => Boolean(item.stepName || item.returnValue));
  }

  async getShuttleEmployees(): Promise<string[]> {
    const response = await this.fetchWithRetry(
      `${this.notifyBaseUrl}/shuttle/employees?_ts=${Date.now()}`,
      {},
      { retries: 2, timeoutMs: 12000 }
    );
    if (!response.ok) {
      throw new Error(`Shuttle employees request failed with ${response.status}`);
    }
    const body = (await response.json()) as { result?: string; data?: unknown; message?: string };
    const result = String(body?.result ?? '').trim().toLowerCase();
    if (result && result !== 'success') {
      throw new Error(String(body?.message ?? 'Failed to load shuttle employees'));
    }
    return Array.isArray(body?.data)
      ? body.data.map((item) => String(item ?? '').trim()).filter(Boolean)
      : [];
  }

  async getShuttleStations(): Promise<string[]> {
    const response = await this.fetchWithRetry(
      `${this.notifyBaseUrl}/shuttle/stations?_ts=${Date.now()}`,
      {},
      { retries: 2, timeoutMs: 12000 }
    );
    if (!response.ok) {
      throw new Error(`Shuttle stations request failed with ${response.status}`);
    }
    const body = (await response.json()) as { result?: string; data?: unknown; message?: string };
    const result = String(body?.result ?? '').trim().toLowerCase();
    if (result && result !== 'success') {
      throw new Error(String(body?.message ?? 'Failed to load shuttle stations'));
    }
    return Array.isArray(body?.data)
      ? body.data.map((item) => String(item ?? '').trim()).filter(Boolean)
      : [];
  }

  async submitShuttleOrder(payload: ShuttleOrderSubmitPayload): Promise<void> {
    const employee = String(payload.employee || '').trim();
    const date = String(payload.date || '').trim();
    const dateAlt = String(payload.dateAlt || '').trim();
    const shift = String(payload.shift || '').trim();
    const station = String(payload.station || '').trim();
    const status = String(payload.status || '').trim();

    if (!employee || !date || !dateAlt || !shift || !station || !status) {
      throw new Error('Shuttle payload is missing required fields');
    }

    const response = await this.fetchWithRetry(
      `${this.notifyBaseUrl}/shuttle/orders`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ employee, date, dateAlt, shift, station, status }),
        cache: 'no-store'
      },
      { retries: 2, timeoutMs: 12000 }
    );
    if (!response.ok) {
      throw new Error(`Shuttle submit failed with ${response.status}`);
    }

    // Apps Script should return a small success payload/text.
    // If we receive an HTML/login page with 200, treat it as failure
    // so UI does not optimistically persist a non-written order.
    const bodyText = String(await response.text()).trim();
    const normalized = bodyText.toLowerCase();
    if (!bodyText) {
      throw new Error('Shuttle submit returned empty response');
    }
    if (
      normalized === 'success' ||
      normalized === '"success"' ||
      normalized === 'ok' ||
      normalized === '"ok"' ||
      normalized.startsWith('updated-existing-')
    ) {
      return;
    }

    let parsed: {
      result?: string;
      status?: string;
      action?: string;
      success?: boolean;
      message?: string;
      error?: string;
    } | null = null;
    try {
      parsed = JSON.parse(bodyText) as {
        result?: string;
        status?: string;
        action?: string;
        success?: boolean;
        message?: string;
        error?: string;
      };
    } catch {
      parsed = null;
    }
    if (parsed) {
      const result = String(parsed.result ?? parsed.status ?? parsed.action ?? '').trim().toLowerCase();
      if (
        parsed.success === true ||
        result === 'success' ||
        result === 'ok' ||
        result === 'insert' ||
        result === 'inserted' ||
        result === 'updated' ||
        result.startsWith('updated-existing-')
      ) {
        return;
      }
      const backendMessage = String(parsed.message ?? parsed.error ?? '').trim();
      if (backendMessage) {
        throw new Error(backendMessage);
      }
    }

    if (/<html[\s>]/i.test(bodyText) || /accounts\.google\.com/i.test(bodyText)) {
      throw new Error('Shuttle submit was not authorized by Apps Script deployment');
    }
    throw new Error('Shuttle submit returned unexpected response');
  }

  async getShuttleUserOrders(user: string): Promise<ShuttleUserOrderPayload[]> {
    const normalizedUser = String(user || '').trim();
    if (!normalizedUser) {
      return [];
    }

    const url = `${this.notifyBaseUrl}/shuttle/orders/user?user=${encodeURIComponent(normalizedUser)}&force=1&_ts=${Date.now()}&ngsw-bypass=1`;
    const response = await this.fetchWithRetry(
      url,
      { cache: 'no-store', headers: { 'ngsw-bypass': 'true' } },
      { retries: 1, timeoutMs: 65000 }
    );
    if (!response.ok) {
      throw new Error(`Shuttle user orders request failed with ${response.status}`);
    }
    const body = String(await response.text() || '');
    return this.parseShuttleUserOrders(body);
  }

  async getShuttleOperationsOrders(
    fromDateIso?: string,
    options: { force?: boolean } = {}
  ): Promise<ShuttleUserOrderPayload[]> {
    const fromDate = String(fromDateIso || this.resolveTodayIsoDate()).trim();
    const force = options.force === true ? '1' : '0';
    const url = `${this.notifyBaseUrl}/shuttle/orders/operations?fromDate=${encodeURIComponent(fromDate)}&force=${force}&_ts=${Date.now()}&ngsw-bypass=1`;
    const response = await this.fetchWithRetry(
      url,
      { cache: 'no-store', headers: { 'ngsw-bypass': 'true' } },
      { retries: 1, timeoutMs: 65000 }
    );
    const body = String(await response.text() || '');
    if (!response.ok) {
      let parsedError: { message?: string; error?: string } | null = null;
      try {
        parsedError = JSON.parse(body) as { message?: string; error?: string };
      } catch {
        parsedError = null;
      }
      const message = String(parsedError?.message ?? parsedError?.error ?? '').trim();
      throw new Error(message || `Shuttle operations orders request failed with ${response.status}`);
    }
    return this.parseShuttleUserOrders(body);
  }

  async getUserPushSubscriptions(user: string): Promise<UserPushSubscriptionPayload[]> {
    const normalizedUser = String(user || '').trim();
    if (!normalizedUser) {
      return [];
    }

    const url = `${this.notifyBaseUrl}/subscriptions?username=${encodeURIComponent(normalizedUser)}&_ts=${Date.now()}`;
    const response = await this.fetchWithRetry(url, {}, { retries: 1, timeoutMs: 12000 });
    if (!response.ok) {
      throw new Error(`User subscriptions request failed with ${response.status}`);
    }

    const body = await response.json() as {
      result?: string;
      subscriptions?: unknown;
      message?: string;
    };
    const result = String(body?.result ?? '').trim().toLowerCase();
    if (result && result !== 'success') {
      throw new Error(String(body?.message ?? 'Failed to fetch user subscriptions'));
    }

    const rawSubscriptions = Array.isArray(body?.subscriptions) ? body.subscriptions : [];
    return rawSubscriptions
      .filter((item) => item && typeof item === 'object')
      .map((item) => item as UserPushSubscriptionPayload);
  }

  private detectDeviceType(): 'Mobile' | 'PC' {
    if (typeof navigator === 'undefined') {
      return 'PC';
    }

    const ua = navigator.userAgent;
    const isMobile = /Mobile|Android|iP(hone|od)|IEMobile|BlackBerry|Kindle|Opera M(obi|ini)/.test(
      ua
    );
    return isMobile ? 'Mobile' : 'PC';
  }

  private detectPlatform(): 'iOS' | 'Android' | 'Desktop' {
    if (typeof navigator === 'undefined') {
      return 'Desktop';
    }

    const ua = navigator.userAgent;
    if (/iP(hone|ad|od)/i.test(ua)) {
      return 'iOS';
    }
    if (/Android/i.test(ua)) {
      return 'Android';
    }
    return 'Desktop';
  }

  private async fetchWithRetry(
    input: RequestInfo | URL,
    init: RequestInit,
    options: FetchRetryOptions = {}
  ): Promise<Response> {
    const retries = options.retries ?? 1;
    const timeoutMs = options.timeoutMs ?? 10000;
    const backoffMs = options.backoffMs ?? 450;

    let lastError: unknown;

    for (let attempt = 0; attempt <= retries; attempt += 1) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const method = String(init.method || 'GET').trim().toUpperCase();
        const headers = new Headers(init.headers || undefined);
        const shouldAttachCsrf =
          method !== 'GET' &&
          method !== 'HEAD' &&
          init.mode !== 'no-cors' &&
          Boolean(this.csrfToken) &&
          !headers.has('X-CSRF-Token');
        if (shouldAttachCsrf) {
          headers.set('X-CSRF-Token', String(this.csrfToken));
        }

        const response = await fetch(input, {
          ...init,
          headers,
          credentials: init.credentials ?? 'same-origin',
          signal: controller.signal
        });

        if (
          !response.ok &&
          attempt < retries &&
          (response.status >= 500 || response.status === 429)
        ) {
          await this.sleep(backoffMs * Math.pow(2, attempt));
          continue;
        }

        return response;
      } catch (error) {
        lastError = error;
        if (attempt < retries) {
          await this.sleep(backoffMs * Math.pow(2, attempt));
          continue;
        }
      } finally {
        clearTimeout(timeoutId);
      }
    }

    throw lastError instanceof Error ? lastError : new Error('Network request failed');
  }

  private parseBooleanLike(value: unknown): boolean {
    if (typeof value === 'boolean') {
      return value;
    }
    if (typeof value === 'number') {
      return Number.isFinite(value) && value === 1;
    }
    const normalized = String(value ?? '').trim().toLowerCase();
    return normalized === '1' || normalized === 'true';
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private parseShuttleUserOrders(payloadText: string): ShuttleUserOrderPayload[] {
    let parsed: unknown;
    try {
      parsed = JSON.parse(payloadText);
    } catch {
      if (this.isLikelyHtmlPayload(payloadText)) {
        throw new Error('Shuttle orders endpoint returned HTML instead of JSON');
      }
      throw new Error('Invalid shuttle orders payload');
    }

    let rows: unknown[] = [];
    if (Array.isArray(parsed)) {
      rows = parsed;
    } else if (parsed && typeof parsed === 'object') {
      const root = parsed as Record<string, unknown>;
      const result = String(root['result'] ?? '').trim().toLowerCase();
      if (result && result !== 'success') {
        throw new Error(String(root['message'] ?? 'Failed to load shuttle orders'));
      }

      if (Array.isArray(root['orders'])) {
        rows = root['orders'];
      } else if (Array.isArray(root['data'])) {
        rows = root['data'];
      }
    }

    return rows
      .filter((item) => item && typeof item === 'object')
      .map((item) => item as ShuttleUserOrderPayload);
  }

  async createHelpdeskTicket(payload: HelpdeskTicketPayload): Promise<HelpdeskTicket> {
    const url = `${this.notifyBaseUrl}/helpdesk/tickets`;
    const response = await this.fetchWithRetry(
      url,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        cache: 'no-store'
      },
      { retries: 1, timeoutMs: 15000 }
    );
    const body = await response.json() as { result?: string; message?: string; ticket?: HelpdeskTicket };
    if (!response.ok || body.result !== 'success') {
      throw new Error(String(body.message || 'שגיאה ביצירת הקריאה'));
    }
    if (!body.ticket) {
      throw new Error('שגיאה בטעינת פרטי הקריאה החדשה');
    }
    return body.ticket;
  }

  async getHelpdeskUserDashboard(): Promise<HelpdeskDashboard> {
    const url = `${this.notifyBaseUrl}/helpdesk/tickets/user?_ts=${Date.now()}&ngsw-bypass=1`;
    const response = await this.fetchWithRetry(
      url,
      { cache: 'no-store', headers: { 'ngsw-bypass': 'true' } },
      { retries: 1, timeoutMs: 15000 }
    );
    const body = await response.json() as {
      result?: string;
      message?: string;
      ongoing?: HelpdeskTicket[];
      past?: HelpdeskTicket[];
      assigned?: HelpdeskTicket[];
      myRole?: HelpdeskMyRole | null;
      editorTickets?: HelpdeskTicket[] | null;
      handlers?: HelpdeskManagedUser[] | null;
    };
    if (!response.ok || body.result !== 'success') {
      throw new Error(String(body.message || 'שגיאה בטעינת הקריאות'));
    }
    return {
      ongoing: Array.isArray(body.ongoing) ? body.ongoing : [],
      past: Array.isArray(body.past) ? body.past : [],
      assigned: Array.isArray(body.assigned) ? body.assigned : [],
      myRole: body.myRole ?? null,
      editorTickets: Array.isArray(body.editorTickets) ? body.editorTickets : null,
      handlers: Array.isArray(body.handlers) ? body.handlers : null
    };
  }

  async assignHelpdeskHandler(ticketId: number, handlerUsername: string | null): Promise<void> {
    const url = `${this.notifyBaseUrl}/helpdesk/tickets/${encodeURIComponent(String(ticketId))}/handler`;
    const response = await this.fetchWithRetry(
      url,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ handler_username: handlerUsername }),
        cache: 'no-store'
      },
      { retries: 1, timeoutMs: 10000 }
    );
    const body = await response.json() as { result?: string; message?: string };
    if (!response.ok || body.result !== 'success') {
      throw new Error(String(body.message || 'שגיאה בשיוך מטפל'));
    }
  }

  async updateHelpdeskTicketStatus(id: number, status: string): Promise<void> {
    const url = `${this.notifyBaseUrl}/helpdesk/tickets/${encodeURIComponent(String(id))}/status`;
    const response = await this.fetchWithRetry(
      url,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
        cache: 'no-store'
      },
      { retries: 1, timeoutMs: 10000 }
    );
    const body = await response.json() as { result?: string; message?: string };
    if (!response.ok || body.result !== 'success') {
      throw new Error(String(body.message || 'שגיאה בעדכון הסטטוס'));
    }
  }

  async getHelpdeskTicketNotes(ticketId: number): Promise<HelpdeskNote[]> {
    const url = `${this.notifyBaseUrl}/helpdesk/tickets/${encodeURIComponent(String(ticketId))}/notes?_ts=${Date.now()}&ngsw-bypass=1`;
    const response = await this.fetchWithRetry(
      url,
      { cache: 'no-store', headers: { 'ngsw-bypass': 'true' } },
      { retries: 1, timeoutMs: 10000 }
    );
    const body = await response.json() as { result?: string; message?: string; notes?: HelpdeskNote[] };
    if (!response.ok || body.result !== 'success') {
      throw new Error(String(body.message || 'שגיאה בטעינת ההערות'));
    }
    return Array.isArray(body.notes) ? body.notes : [];
  }

  async addHelpdeskNote(ticketId: number, noteText: string, attachmentUrl?: string | null): Promise<number> {
    const url = `${this.notifyBaseUrl}/helpdesk/tickets/${encodeURIComponent(String(ticketId))}/notes`;
    const payload: { note_text: string; attachment_url?: string } = { note_text: noteText };
    if (attachmentUrl) {
      payload.attachment_url = attachmentUrl;
    }
    const response = await this.fetchWithRetry(
      url,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        cache: 'no-store'
      },
      { retries: 1, timeoutMs: 10000 }
    );
    const body = await response.json() as { result?: string; message?: string; noteId?: number };
    if (!response.ok || body.result !== 'success') {
      throw new Error(String(body.message || 'שגיאה בהוספת ההערה'));
    }
    return body.noteId ?? 0;
  }

  async getHelpdeskTicketHistory(ticketId: number): Promise<HelpdeskStatusHistoryEntry[]> {
    const url = `${this.notifyBaseUrl}/helpdesk/tickets/${encodeURIComponent(String(ticketId))}/history?_ts=${Date.now()}&ngsw-bypass=1`;
    const response = await this.fetchWithRetry(
      url,
      { cache: 'no-store', headers: { 'ngsw-bypass': 'true' } },
      { retries: 1, timeoutMs: 10000 }
    );
    const body = await response.json() as { result?: string; message?: string; history?: HelpdeskStatusHistoryEntry[] };
    if (!response.ok || body.result !== 'success') {
      throw new Error(String(body.message || 'שגיאה בטעינת ההיסטוריה'));
    }
    return Array.isArray(body.history) ? body.history : [];
  }

  async getHelpdeskLocations(): Promise<string[]> {
    const url = `${this.notifyBaseUrl}/helpdesk/locations?_ts=${Date.now()}&ngsw-bypass=1`;
    const response = await this.fetchWithRetry(url, { cache: 'no-store' }, { retries: 1, timeoutMs: 10000 });
    const body = await response.json() as { result?: string; message?: string; locations?: string[] };
    if (!response.ok || body.result !== 'success') {
      throw new Error(String(body.message || 'שגיאה בטעינת המיקומים'));
    }
    return Array.isArray(body.locations) ? body.locations : [];
  }

  private isLikelyHtmlPayload(payloadText: string): boolean {
    return /<html[\s>]/i.test(payloadText) || /<body[\s>]/i.test(payloadText);
  }

  private resolveTodayIsoDate(): string {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }
}
