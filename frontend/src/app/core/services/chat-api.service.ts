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

export interface HrStepOption {
  id: string;
  name: string;
  subject: string;
}

export interface HrActionOption {
  stepName: string;
  returnValue: string;
}

@Injectable({ providedIn: 'root' })
export class ChatApiService {
  private readonly config = runtimeConfig;
  private readonly notifyBaseUrl = getNotifyBaseUrl(this.config.notifyReplyUrl);

  get streamUrlBase(): string {
    return `${this.notifyBaseUrl}/stream`;
  }

  get messagesUrlBase(): string {
    return `${this.notifyBaseUrl}/messages`;
  }

  get vapidPublicKey(): string {
    return this.config.vapidPublicKey;
  }

  async getContacts(user: string): Promise<Contact[]> {
    const url = `${this.config.subscriptionUrl}?action=get_contacts&user=${encodeURIComponent(user)}`;
    const response = await this.fetchWithRetry(url, {}, { retries: 2, timeoutMs: 10000 });
    if (!response.ok) {
      throw new Error(`Contacts request failed with ${response.status}`);
    }

    const body = (await response.json()) as ContactResponse;
    const seen = new Set<string>();

    return (body.users ?? [])
      .map((contact) => {
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

        return {
          username,
          displayName,
          info,
          phone: phone || undefined,
          upic: upic || undefined,
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
          upic: contact.upic
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

  async getGroups(user: string): Promise<ChatGroup[]> {
    const url = `${this.config.groupsUrl}?user=${encodeURIComponent(user)}`;
    const response = await this.fetchWithRetry(url, {}, { retries: 2, timeoutMs: 10000 });
    if (!response.ok) {
      throw new Error(`Groups request failed with ${response.status}`);
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
          createdBy: createdBy || user,
          updatedAt,
          type
        } satisfies ChatGroup;
      })
      .filter((group) => Boolean(group.id && group.name));
  }

  async pollMessages(user: string): Promise<IncomingServerMessage[]> {
    const url = `${this.messagesUrlBase}?user=${encodeURIComponent(user)}`;
    const response = await this.fetchWithRetry(url, {}, { retries: 1, timeoutMs: 10000 });
    if (!response.ok) {
      throw new Error(`Messages request failed with ${response.status}`);
    }

    const body = (await response.json()) as PollResponse;
    return Array.isArray(body.messages) ? body.messages : [];
  }

  createMessageStream(user: string): EventSource {
    const url = `${this.streamUrlBase}?user=${encodeURIComponent(user)}`;
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
        const response = await fetch(input, {
          ...init,
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
}
