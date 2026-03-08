export type WebhookRegistryRecord = Record<string, string>;

function normalizeKey(value: unknown): string {
  return String(value ?? '').trim().toLowerCase();
}

function normalizeUrl(value: unknown): string {
  const candidate = String(value ?? '').trim();
  if (!candidate) return '';
  try {
    return new URL(candidate).toString();
  } catch {
    return '';
  }
}

export class WebhookRegistryService {
  private readonly urlsByType = new Map<string, string>();

  constructor(initialRegistry: WebhookRegistryRecord = {}) {
    Object.entries(initialRegistry).forEach(([type, url]) => {
      this.register(type, url);
    });
  }

  register(type: string, url: string): void {
    const normalizedType = normalizeKey(type);
    const normalizedUrl = normalizeUrl(url);
    if (!normalizedType || !normalizedUrl) {
      return;
    }
    this.urlsByType.set(normalizedType, normalizedUrl);
  }

  resolve(type: string): string {
    const normalizedType = normalizeKey(type);
    if (!normalizedType) return '';
    return this.urlsByType.get(normalizedType) || '';
  }

  resolveFromMessage(payload: unknown): string {
    if (!payload || typeof payload !== 'object') {
      return '';
    }
    const record = payload as Record<string, unknown>;
    const candidates = [
      record.webhookType,
      record.type,
      record.recordType,
      record.messageType
    ];
    for (const candidate of candidates) {
      const resolved = this.resolve(String(candidate ?? ''));
      if (resolved) return resolved;
    }
    return '';
  }

  list(): WebhookRegistryRecord {
    const result: WebhookRegistryRecord = {};
    for (const [key, value] of this.urlsByType.entries()) {
      result[key] = value;
    }
    return result;
  }
}

export function createWebhookRegistryFromEnv(env: NodeJS.ProcessEnv = process.env): WebhookRegistryService {
  const byJson = String(env.WEBHOOK_REGISTRY_JSON ?? env.WEBHOOK_REGISTRY ?? '').trim();
  let fromJson: WebhookRegistryRecord = {};
  if (byJson) {
    try {
      const parsed = JSON.parse(byJson);
      if (parsed && typeof parsed === 'object') {
        fromJson = Object.entries(parsed as Record<string, unknown>)
          .reduce<WebhookRegistryRecord>((acc, [key, value]) => {
            acc[key] = String(value ?? '');
            return acc;
          }, {});
      }
    } catch {
      // Ignore malformed env and continue with prefixed variables.
    }
  }

  const fromPrefixed: WebhookRegistryRecord = {};
  Object.entries(env).forEach(([rawKey, rawValue]) => {
    const key = String(rawKey || '').trim();
    if (!key.startsWith('WEBHOOK_URL_')) {
      return;
    }
    const type = key.replace('WEBHOOK_URL_', '').toLowerCase().replace(/__/g, '-').replace(/_/g, '.');
    fromPrefixed[type] = String(rawValue ?? '');
  });

  return new WebhookRegistryService({
    ...fromJson,
    ...fromPrefixed
  });
}
