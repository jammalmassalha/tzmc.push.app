"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.WebhookRegistryService = void 0;
exports.createWebhookRegistryFromEnv = createWebhookRegistryFromEnv;
function normalizeKey(value) {
    return String(value ?? '').trim().toLowerCase();
}
function normalizeUrl(value) {
    const candidate = String(value ?? '').trim();
    if (!candidate)
        return '';
    try {
        return new URL(candidate).toString();
    }
    catch {
        return '';
    }
}
class WebhookRegistryService {
    urlsByType = new Map();
    constructor(initialRegistry = {}) {
        Object.entries(initialRegistry).forEach(([type, url]) => {
            this.register(type, url);
        });
    }
    register(type, url) {
        const normalizedType = normalizeKey(type);
        const normalizedUrl = normalizeUrl(url);
        if (!normalizedType || !normalizedUrl) {
            return;
        }
        this.urlsByType.set(normalizedType, normalizedUrl);
    }
    resolve(type) {
        const normalizedType = normalizeKey(type);
        if (!normalizedType)
            return '';
        return this.urlsByType.get(normalizedType) || '';
    }
    resolveFromMessage(payload) {
        if (!payload || typeof payload !== 'object') {
            return '';
        }
        const record = payload;
        const candidates = [
            record.webhookType,
            record.type,
            record.recordType,
            record.messageType
        ];
        for (const candidate of candidates) {
            const resolved = this.resolve(String(candidate ?? ''));
            if (resolved)
                return resolved;
        }
        return '';
    }
    list() {
        const result = {};
        for (const [key, value] of this.urlsByType.entries()) {
            result[key] = value;
        }
        return result;
    }
}
exports.WebhookRegistryService = WebhookRegistryService;
function createWebhookRegistryFromEnv(env = process.env) {
    const byJson = String(env.WEBHOOK_REGISTRY_JSON ?? env.WEBHOOK_REGISTRY ?? '').trim();
    let fromJson = {};
    if (byJson) {
        try {
            const parsed = JSON.parse(byJson);
            if (parsed && typeof parsed === 'object') {
                fromJson = Object.entries(parsed)
                    .reduce((acc, [key, value]) => {
                    acc[key] = String(value ?? '');
                    return acc;
                }, {});
            }
        }
        catch {
            // Ignore malformed env and continue with prefixed variables.
        }
    }
    const fromPrefixed = {};
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
