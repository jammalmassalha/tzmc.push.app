import crypto from 'node:crypto';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface SessionPayload {
  user: string;
  expiresAt: number;
  sessionId: string;
  csrfToken: string;
}

/** Wire format stored in the JWT/cookie (uses short key `sid` for compactness). */
interface SessionWirePayload {
  user: string;
  expiresAt: number;
  sid: string;
  csrfToken: string;
}

export interface SessionToken {
  token: string;
  expiresAt: number;
  sessionId: string;
  csrfToken: string;
}

export interface RateLimitResult {
  allowed: boolean;
  retryAfterSeconds: number;
  remaining: number;
}

/** Minimal JWE service interface (encrypt/decrypt) */
export interface JweService {
  encrypt(payload: object): string;
  decrypt(token: string): object | null;
}

export interface SessionServiceConfig {
  signingSecret: string;
  cookieName: string;
  cookieTtlMs: number;
  cookieSameSite: string;
  cookieSecure: boolean;
  jweService?: JweService | null;
  looksLikeJweCompactToken?: (token: string) => boolean;
}

export interface SessionServiceDeps {
  /** Normalize a user identifier to canonical form */
  normalizeUserCandidate: (value: unknown) => string;
  /** In-memory session store: user → Set<sessionId> */
  activeSessionIdsByUser: Map<string, Set<string>>;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function normalizeHostValue(rawValue: unknown): string {
  const value = String(rawValue || '').trim().toLowerCase();
  if (!value) return '';
  const primaryValue = value.split(',')[0].trim();
  if (!primaryValue) return '';
  const candidate = primaryValue.includes('://') ? primaryValue : `http://${primaryValue}`;
  try {
    const parsed = new URL(candidate);
    return String(parsed.hostname || '').trim().toLowerCase().replace(/\.+$/, '');
  } catch {
    return primaryValue.replace(/^\[|\]$/g, '').replace(/:\d+$/, '').replace(/\.+$/, '').trim().toLowerCase();
  }
}

// ─── Service ────────────────────────────────────────────────────────────────

export class SessionService {
  private readonly signingSecret: string;
  private readonly cookieName: string;
  private readonly cookieTtlMs: number;
  private readonly cookieSameSite: string;
  private readonly cookieSecure: boolean;
  private readonly jweService: JweService | null;
  private readonly looksLikeJweCompactToken: (token: string) => boolean;
  private readonly deps: SessionServiceDeps;

  constructor(config: SessionServiceConfig, deps: SessionServiceDeps) {
    this.signingSecret = config.signingSecret;
    this.cookieName = config.cookieName || 'tzmc_session';
    this.cookieTtlMs = Math.max(5 * 60 * 1000, config.cookieTtlMs);
    this.cookieSameSite = config.cookieSameSite || 'Lax';
    this.cookieSecure = config.cookieSecure !== false;
    this.jweService = config.jweService ?? null;
    this.looksLikeJweCompactToken = config.looksLikeJweCompactToken ?? (() => false);
    this.deps = deps;
  }

  get renewalThresholdMs(): number {
    return Math.floor(this.cookieTtlMs / 2);
  }

  // ── Encoding ────────────────────────────────────────────────────────────

  encodeBase64Url(input: string): string {
    return Buffer.from(String(input || ''), 'utf8')
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/g, '');
  }

  decodeBase64Url(input: string): string {
    const normalized = String(input || '').replace(/-/g, '+').replace(/_/g, '/');
    const remainder = normalized.length % 4;
    const padding = remainder === 0 ? '' : '='.repeat(4 - remainder);
    return Buffer.from(normalized + padding, 'base64').toString('utf8');
  }

  // ── Token signing ─────────────────────────────────────────────────────

  signSessionPayload(payload: string): string {
    if (!this.signingSecret) return '';
    return crypto
      .createHmac('sha256', this.signingSecret)
      .update(String(payload || ''))
      .digest('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/g, '');
  }

  safeTimingCompare(leftValue: string, rightValue: string): boolean {
    const leftBuffer = Buffer.from(String(leftValue || ''), 'utf8');
    const rightBuffer = Buffer.from(String(rightValue || ''), 'utf8');
    if (leftBuffer.length !== rightBuffer.length) return false;
    return crypto.timingSafeEqual(leftBuffer, rightBuffer);
  }

  generateRandomToken(byteLength = 24): string {
    return crypto
      .randomBytes(byteLength)
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/g, '');
  }

  // ── Token creation & validation ───────────────────────────────────────

  createSessionToken(user: unknown): SessionToken | null {
    const normalizedUser = this.deps.normalizeUserCandidate(user);
    if (!normalizedUser || (!this.signingSecret && !this.jweService)) return null;
    const sessionId = this.generateRandomToken(18);
    const csrfToken = this.generateRandomToken(24);
    const expiresAt = Date.now() + this.cookieTtlMs;

    if (!this.deps.activeSessionIdsByUser.has(normalizedUser)) {
      this.deps.activeSessionIdsByUser.set(normalizedUser, new Set());
    }
    this.deps.activeSessionIdsByUser.get(normalizedUser)!.add(sessionId);

    const payloadObject: SessionWirePayload = { user: normalizedUser, expiresAt, sid: sessionId, csrfToken };
    const jweToken = this.jweService ? this.jweService.encrypt(payloadObject) : '';
    if (jweToken) return { token: jweToken, expiresAt, sessionId, csrfToken };

    const payload = this.encodeBase64Url(JSON.stringify(payloadObject));
    const signature = this.signSessionPayload(payload);
    if (!signature) {
      const userSessions = this.deps.activeSessionIdsByUser.get(normalizedUser);
      if (userSessions) {
        userSessions.delete(sessionId);
        if (userSessions.size === 0) this.deps.activeSessionIdsByUser.delete(normalizedUser);
      }
      return null;
    }
    return { token: `${payload}.${signature}`, expiresAt, sessionId, csrfToken };
  }

  getSessionFromToken(rawToken: unknown): SessionPayload | null {
    const token = String(rawToken || '').trim();
    if (!token) return null;

    let parsed: Record<string, unknown> | null = null;
    if (this.jweService && this.looksLikeJweCompactToken(token)) {
      parsed = this.jweService.decrypt(token) as Record<string, unknown> | null;
    } else if (this.signingSecret) {
      const parts = token.split('.');
      if (parts.length !== 2) return null;
      const payloadEncoded = parts[0];
      const providedSignature = parts[1];
      const expectedSignature = this.signSessionPayload(payloadEncoded);
      if (!expectedSignature || !this.safeTimingCompare(providedSignature, expectedSignature)) return null;
      try {
        parsed = JSON.parse(this.decodeBase64Url(payloadEncoded)) as Record<string, unknown>;
      } catch {
        parsed = null;
      }
    }
    if (!parsed || typeof parsed !== 'object') return null;

    try {
      const user = this.deps.normalizeUserCandidate(parsed.user);
      const expiresAt = Number(parsed.expiresAt);
      const sessionId = String(parsed.sid || '').trim();
      const csrfToken = String(parsed.csrfToken || '').trim();
      if (!user || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) return null;
      if (!sessionId || !csrfToken) return null;

      // Always accept a cryptographically valid token and track its sessionId.
      if (!this.deps.activeSessionIdsByUser.has(user)) {
        this.deps.activeSessionIdsByUser.set(user, new Set());
      }
      this.deps.activeSessionIdsByUser.get(user)!.add(sessionId);
      return { user, expiresAt, sessionId, csrfToken };
    } catch {
      return null;
    }
  }

  // ── Cookie management ─────────────────────────────────────────────────

  parseCookiesFromHeader(cookieHeader: unknown): Record<string, string> {
    const result: Record<string, string> = {};
    String(cookieHeader || '')
      .split(';')
      .forEach((entry) => {
        const trimmed = String(entry || '').trim();
        if (!trimmed) return;
        const separatorIndex = trimmed.indexOf('=');
        if (separatorIndex <= 0) return;
        const key = trimmed.slice(0, separatorIndex).trim();
        if (!key) return;
        const value = trimmed.slice(separatorIndex + 1).trim();
        try {
          result[key] = decodeURIComponent(value);
        } catch {
          result[key] = value;
        }
      });
    return result;
  }

  private normalizeSameSiteValue(): string {
    const normalized = String(this.cookieSameSite || '').trim().toLowerCase();
    if (normalized === 'none') return 'None';
    if (normalized === 'strict') return 'Strict';
    return 'Lax';
  }

  private normalizeCookieHost(rawHost: unknown): string {
    return normalizeHostValue(rawHost || '').replace(/\.+$/, '');
  }

  private shouldUseSecureCookie(req: { headers?: { host?: string } }): boolean {
    if (!this.cookieSecure) return false;
    const hostHeader = req?.headers?.host || '';
    const hostname = this.normalizeCookieHost(hostHeader);
    if (!hostname) return true;
    return !['localhost', '127.0.0.1', '::1'].includes(hostname);
  }

  setSessionCookie(res: { setHeader(name: string, value: string): void }, req: { headers?: { host?: string } }, tokenValue: string, expiresAt: number): void {
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
    if (secure) cookieParts.push('Secure');
    res.setHeader('Set-Cookie', cookieParts.join('; '));
  }

  clearSessionCookie(res: { setHeader(name: string, value: string): void }, req: { headers?: { host?: string } }): void {
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
    if (secure) cookieParts.push('Secure');
    res.setHeader('Set-Cookie', cookieParts.join('; '));
  }

  extractSessionFromRequest(req: { headers?: { cookie?: string; host?: string } }): SessionPayload | null {
    const cookieMap = this.parseCookiesFromHeader(req?.headers?.cookie || '');
    return this.getSessionFromToken(cookieMap[this.cookieName]);
  }

  extractSessionUserFromRequest(req: { headers?: { cookie?: string; host?: string } }): string {
    const session = this.extractSessionFromRequest(req);
    return session?.user || '';
  }

  // ── Rate limiting ─────────────────────────────────────────────────────

  consumeRateLimitEntry(
    store: Map<string, number[]>,
    key: string,
    maxAttempts: number,
    windowMs: number
  ): RateLimitResult {
    const now = Date.now();
    const normalizedKey = String(key || '').trim().toLowerCase();
    if (!normalizedKey) return { allowed: true, retryAfterSeconds: 0, remaining: maxAttempts };

    const existing = Array.isArray(store.get(normalizedKey)) ? store.get(normalizedKey)! : [];
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
