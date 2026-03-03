import { Injectable } from '@angular/core';
import { getNotifyBaseUrl, runtimeConfig } from '../config/runtime-config';
import {
  ChatGroup,
  Contact,
  DeleteMessagePayload,
  EditMessagePayload,
  GroupUpdatePayload,
  IncomingServerMessage,
  ReadReceiptPayload,
  ReactionPayload,
  ReplyPayload
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
    groupId?: string;
    name?: string;
    groupName?: string;
    members?: string[];
    groupMembers?: string[];
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

interface UploadResponse {
  status?: string;
  url?: string;
  thumbUrl?: string | null;
  type?: string;
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

export interface HrStepOption {
  id: string;
  name: string;
  subject: string;
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

const SHUTTLE_SHEET_URL =
  'https://script.google.com/macros/s/AKfycbwhLs1qeoTqJrN5t_FteAclD-mz7utpgvAfAYPbvv5jx-PFpFLCcsCmCz1Wj3GSZfUi/exec';
const SHUTTLE_USER_ORDERS_URL =
  'https://script.google.com/macros/s/AKfycbwhLs1qeoTqJrN5t_FteAclD-mz7utpgvAfAYPbvv5jx-PFpFLCcsCmCz1Wj3GSZfUi/exec';

const SHUTTLE_ENTRY_EMPLOYEE = 'entry.1035269960';
const SHUTTLE_ENTRY_DATE = 'entry.794242217';
const SHUTTLE_ENTRY_DATE_ALT = 'entry.794242217_22';
const SHUTTLE_ENTRY_SHIFT = 'entry.1992732561';
const SHUTTLE_ENTRY_STATION = 'entry.1096369604';
const SHUTTLE_ENTRY_STATUS = 'entry.798637322';

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
        const id = String(group.id ?? group.groupId ?? '').trim();
        const name = String(group.name ?? group.groupName ?? '').trim();
        const members = (group.members ?? group.groupMembers ?? []).map((member) =>
          String(member).trim()
        );
        const createdBy = String(group.createdBy ?? group.groupCreatedBy ?? '').trim();
        const updatedAt = Number(group.updatedAt ?? group.groupUpdatedAt ?? Date.now());
        const type = group.type === 'community' || group.groupType === 'community'
          ? 'community'
          : 'group';

        return {
          id,
          name,
          members,
          createdBy: createdBy || normalizedUser,
          updatedAt,
          type
        } satisfies ChatGroup;
      })
      .filter((group) => Boolean(group.id && group.name));
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

  createMessageStream(user?: string): EventSource {
    const normalizedUser = String(user || '').trim().toLowerCase();
    const url = normalizedUser
      ? `${this.streamUrlBase}?user=${encodeURIComponent(normalizedUser)}`
      : this.streamUrlBase;
    return new EventSource(url);
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

    const sheetRegistration = this.fetchWithRetry(
      this.config.subscriptionUrl,
      {
        method: 'POST',
        mode: 'no-cors',
        body: JSON.stringify(payload)
      },
      { retries: 2, timeoutMs: 15000, backoffMs: 700 }
    );
    const backendRegistration = this.fetchWithRetry(
      `${this.notifyBaseUrl}/register-device`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      },
      { retries: 2, timeoutMs: 12000, backoffMs: 500 }
    );

    await Promise.allSettled([sheetRegistration, backendRegistration]);
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
    const url = `${this.config.subscriptionUrl}?action=get_hr_steps`;
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
        subject: String(item.subject ?? '').trim()
      }))
      .filter((item) => Boolean(item.id && item.name));
  }

  async getHrActions(serviceId: string): Promise<HrActionOption[]> {
    const normalized = String(serviceId || '').trim();
    if (!normalized) return [];

    const url = `${this.config.subscriptionUrl}?action=get_hr_steps_action&serviceId=${encodeURIComponent(normalized)}`;
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
      `${SHUTTLE_SHEET_URL}?emp=test`,
      {},
      { retries: 2, timeoutMs: 12000 }
    );
    if (!response.ok) {
      throw new Error(`Shuttle employees request failed with ${response.status}`);
    }
    const body = await response.text();
    return this.parseJsonStringArray(body);
  }

  async getShuttleStations(): Promise<string[]> {
    const response = await this.fetchWithRetry(
      `${SHUTTLE_SHEET_URL}?park=test`,
      {},
      { retries: 2, timeoutMs: 12000 }
    );
    if (!response.ok) {
      throw new Error(`Shuttle stations request failed with ${response.status}`);
    }
    const body = await response.text();
    return this.parseJsonStringArray(body);
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

    const params = new URLSearchParams();
    params.set(SHUTTLE_ENTRY_EMPLOYEE, employee);
    params.set(SHUTTLE_ENTRY_DATE, date);
    params.set(SHUTTLE_ENTRY_DATE_ALT, dateAlt);
    params.set(SHUTTLE_ENTRY_SHIFT, shift);
    params.set(SHUTTLE_ENTRY_STATION, station);
    params.set(SHUTTLE_ENTRY_STATUS, status);

    const response = await this.fetchWithRetry(
      `${SHUTTLE_SHEET_URL}?${params.toString()}`,
      {},
      { retries: 2, timeoutMs: 12000 }
    );
    if (!response.ok) {
      throw new Error(`Shuttle submit failed with ${response.status}`);
    }
  }

  async getShuttleUserOrders(user: string): Promise<ShuttleUserOrderPayload[]> {
    const normalizedUser = String(user || '').trim();
    if (!normalizedUser) {
      return [];
    }

    const url = `${SHUTTLE_USER_ORDERS_URL}?action=get_user_orders&user=${encodeURIComponent(normalizedUser)}`;
    // Apps Script often responds with an initial 302 redirect and can be slow on cold start.
    // Use a longer timeout and avoid multi-retry bursts to prevent repeated duplicate requests.
    const response = await this.fetchWithRetry(url, {}, { retries: 0, timeoutMs: 30000 });
    if (!response.ok) {
      throw new Error(`Shuttle user orders request failed with ${response.status}`);
    }
    const body = await response.text();
    return this.parseShuttleUserOrders(body);
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

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private parseJsonStringArray(payloadText: string): string[] {
    try {
      const parsed = JSON.parse(payloadText);
      if (!Array.isArray(parsed)) {
        return [];
      }
      return parsed
        .map((item) => String(item ?? '').trim())
        .filter(Boolean);
    } catch {
      return [];
    }
  }

  private parseShuttleUserOrders(payloadText: string): ShuttleUserOrderPayload[] {
    let parsed: unknown;
    try {
      parsed = JSON.parse(payloadText);
    } catch {
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
}
