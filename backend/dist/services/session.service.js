"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.SessionService = void 0;
const node_crypto_1 = __importDefault(require("node:crypto"));
// ─── Helpers ────────────────────────────────────────────────────────────────
function normalizeHostValue(rawValue) {
    const value = String(rawValue || '').trim().toLowerCase();
    if (!value)
        return '';
    const primaryValue = value.split(',')[0].trim();
    if (!primaryValue)
        return '';
    const candidate = primaryValue.includes('://') ? primaryValue : `http://${primaryValue}`;
    try {
        const parsed = new URL(candidate);
        return String(parsed.hostname || '').trim().toLowerCase().replace(/\.+$/, '');
    }
    catch {
        return primaryValue.replace(/^\[|\]$/g, '').replace(/:\d+$/, '').replace(/\.+$/, '').trim().toLowerCase();
    }
}
// ─── Service ────────────────────────────────────────────────────────────────
class SessionService {
    signingSecret;
    cookieName;
    cookieTtlMs;
    cookieSameSite;
    cookieSecure;
    jweService;
    looksLikeJweCompactToken;
    deps;
    constructor(config, deps) {
        this.signingSecret = config.signingSecret;
        this.cookieName = config.cookieName || 'tzmc_session';
        this.cookieTtlMs = Math.max(5 * 60 * 1000, config.cookieTtlMs);
        this.cookieSameSite = config.cookieSameSite || 'Lax';
        this.cookieSecure = config.cookieSecure !== false;
        this.jweService = config.jweService ?? null;
        this.looksLikeJweCompactToken = config.looksLikeJweCompactToken ?? (() => false);
        this.deps = deps;
    }
    get renewalThresholdMs() {
        return Math.floor(this.cookieTtlMs / 2);
    }
    // ── Encoding ────────────────────────────────────────────────────────────
    encodeBase64Url(input) {
        return Buffer.from(String(input || ''), 'utf8')
            .toString('base64')
            .replace(/\+/g, '-')
            .replace(/\//g, '_')
            .replace(/=+$/g, '');
    }
    decodeBase64Url(input) {
        const normalized = String(input || '').replace(/-/g, '+').replace(/_/g, '/');
        const remainder = normalized.length % 4;
        const padding = remainder === 0 ? '' : '='.repeat(4 - remainder);
        return Buffer.from(normalized + padding, 'base64').toString('utf8');
    }
    // ── Token signing ─────────────────────────────────────────────────────
    signSessionPayload(payload) {
        if (!this.signingSecret)
            return '';
        return node_crypto_1.default
            .createHmac('sha256', this.signingSecret)
            .update(String(payload || ''))
            .digest('base64')
            .replace(/\+/g, '-')
            .replace(/\//g, '_')
            .replace(/=+$/g, '');
    }
    safeTimingCompare(leftValue, rightValue) {
        const leftBuffer = Buffer.from(String(leftValue || ''), 'utf8');
        const rightBuffer = Buffer.from(String(rightValue || ''), 'utf8');
        if (leftBuffer.length !== rightBuffer.length)
            return false;
        return node_crypto_1.default.timingSafeEqual(leftBuffer, rightBuffer);
    }
    generateRandomToken(byteLength = 24) {
        return node_crypto_1.default
            .randomBytes(byteLength)
            .toString('base64')
            .replace(/\+/g, '-')
            .replace(/\//g, '_')
            .replace(/=+$/g, '');
    }
    // ── Token creation & validation ───────────────────────────────────────
    createSessionToken(user) {
        const normalizedUser = this.deps.normalizeUserCandidate(user);
        if (!normalizedUser || (!this.signingSecret && !this.jweService))
            return null;
        const sessionId = this.generateRandomToken(18);
        const csrfToken = this.generateRandomToken(24);
        const expiresAt = Date.now() + this.cookieTtlMs;
        if (!this.deps.activeSessionIdsByUser.has(normalizedUser)) {
            this.deps.activeSessionIdsByUser.set(normalizedUser, new Set());
        }
        this.deps.activeSessionIdsByUser.get(normalizedUser).add(sessionId);
        const payloadObject = { user: normalizedUser, expiresAt, sid: sessionId, csrfToken };
        const jweToken = this.jweService ? this.jweService.encrypt(payloadObject) : '';
        if (jweToken)
            return { token: jweToken, expiresAt, sessionId, csrfToken };
        const payload = this.encodeBase64Url(JSON.stringify(payloadObject));
        const signature = this.signSessionPayload(payload);
        if (!signature) {
            const userSessions = this.deps.activeSessionIdsByUser.get(normalizedUser);
            if (userSessions) {
                userSessions.delete(sessionId);
                if (userSessions.size === 0)
                    this.deps.activeSessionIdsByUser.delete(normalizedUser);
            }
            return null;
        }
        return { token: `${payload}.${signature}`, expiresAt, sessionId, csrfToken };
    }
    getSessionFromToken(rawToken) {
        const token = String(rawToken || '').trim();
        if (!token)
            return null;
        let parsed = null;
        if (this.jweService && this.looksLikeJweCompactToken(token)) {
            parsed = this.jweService.decrypt(token);
        }
        else if (this.signingSecret) {
            const parts = token.split('.');
            if (parts.length !== 2)
                return null;
            const payloadEncoded = parts[0];
            const providedSignature = parts[1];
            const expectedSignature = this.signSessionPayload(payloadEncoded);
            if (!expectedSignature || !this.safeTimingCompare(providedSignature, expectedSignature))
                return null;
            try {
                parsed = JSON.parse(this.decodeBase64Url(payloadEncoded));
            }
            catch {
                parsed = null;
            }
        }
        if (!parsed || typeof parsed !== 'object')
            return null;
        try {
            const user = this.deps.normalizeUserCandidate(parsed.user);
            const expiresAt = Number(parsed.expiresAt);
            const sessionId = String(parsed.sid || '').trim();
            const csrfToken = String(parsed.csrfToken || '').trim();
            if (!user || !Number.isFinite(expiresAt) || expiresAt <= Date.now())
                return null;
            if (!sessionId || !csrfToken)
                return null;
            // Always accept a cryptographically valid token and track its sessionId.
            if (!this.deps.activeSessionIdsByUser.has(user)) {
                this.deps.activeSessionIdsByUser.set(user, new Set());
            }
            this.deps.activeSessionIdsByUser.get(user).add(sessionId);
            return { user, expiresAt, sessionId, csrfToken };
        }
        catch {
            return null;
        }
    }
    // ── Cookie management ─────────────────────────────────────────────────
    parseCookiesFromHeader(cookieHeader) {
        const result = {};
        String(cookieHeader || '')
            .split(';')
            .forEach((entry) => {
            const trimmed = String(entry || '').trim();
            if (!trimmed)
                return;
            const separatorIndex = trimmed.indexOf('=');
            if (separatorIndex <= 0)
                return;
            const key = trimmed.slice(0, separatorIndex).trim();
            if (!key)
                return;
            const value = trimmed.slice(separatorIndex + 1).trim();
            try {
                result[key] = decodeURIComponent(value);
            }
            catch {
                result[key] = value;
            }
        });
        return result;
    }
    normalizeSameSiteValue() {
        const normalized = String(this.cookieSameSite || '').trim().toLowerCase();
        if (normalized === 'none')
            return 'None';
        if (normalized === 'strict')
            return 'Strict';
        return 'Lax';
    }
    normalizeCookieHost(rawHost) {
        return normalizeHostValue(rawHost || '').replace(/\.+$/, '');
    }
    shouldUseSecureCookie(req) {
        if (!this.cookieSecure)
            return false;
        const hostHeader = req?.headers?.host || '';
        const hostname = this.normalizeCookieHost(hostHeader);
        if (!hostname)
            return true;
        return !['localhost', '127.0.0.1', '::1'].includes(hostname);
    }
    setSessionCookie(res, req, tokenValue, expiresAt) {
        const sameSite = this.normalizeSameSiteValue();
        const secure = this.shouldUseSecureCookie(req);
        const maxAgeSeconds = Math.max(1, Math.floor((Number(expiresAt) - Date.now()) / 1000));
        const cookieParts = [
            `${this.cookieName}=${encodeURIComponent(String(tokenValue || ''))}`,
            'Path=/',
            'HttpOnly',
            `SameSite=${sameSite}`,
            `Max-Age=${maxAgeSeconds}`,
            `Expires=${new Date(Date.now() + maxAgeSeconds * 1000).toUTCString()}`
        ];
        if (secure)
            cookieParts.push('Secure');
        res.setHeader('Set-Cookie', cookieParts.join('; '));
    }
    clearSessionCookie(res, req) {
        const sameSite = this.normalizeSameSiteValue();
        const secure = this.shouldUseSecureCookie(req);
        const cookieParts = [
            `${this.cookieName}=`,
            'Path=/',
            'HttpOnly',
            `SameSite=${sameSite}`,
            'Max-Age=0',
            'Expires=Thu, 01 Jan 1970 00:00:00 GMT'
        ];
        if (secure)
            cookieParts.push('Secure');
        res.setHeader('Set-Cookie', cookieParts.join('; '));
    }
    extractSessionFromRequest(req) {
        const cookieMap = this.parseCookiesFromHeader(req?.headers?.cookie || '');
        return this.getSessionFromToken(cookieMap[this.cookieName]);
    }
    extractSessionUserFromRequest(req) {
        const session = this.extractSessionFromRequest(req);
        return session?.user || '';
    }
    // ── Rate limiting ─────────────────────────────────────────────────────
    consumeRateLimitEntry(store, key, maxAttempts, windowMs) {
        const now = Date.now();
        const normalizedKey = String(key || '').trim().toLowerCase();
        if (!normalizedKey)
            return { allowed: true, retryAfterSeconds: 0, remaining: maxAttempts };
        const existing = Array.isArray(store.get(normalizedKey)) ? store.get(normalizedKey) : [];
        const threshold = now - windowMs;
        const recent = existing.filter((ts) => Number.isFinite(ts) && ts > threshold);
        if (recent.length >= maxAttempts) {
            const oldestActive = recent[0] || now;
            const retryAfterMs = Math.max(1000, windowMs - Math.max(0, now - oldestActive));
            store.set(normalizedKey, recent);
            return { allowed: false, retryAfterSeconds: Math.ceil(retryAfterMs / 1000), remaining: 0 };
        }
        recent.push(now);
        store.set(normalizedKey, recent);
        return { allowed: true, retryAfterSeconds: 0, remaining: Math.max(0, maxAttempts - recent.length) };
    }
}
exports.SessionService = SessionService;
