const test = require('node:test');
const assert = require('node:assert/strict');

const { SessionService } = require('../dist/services/session.service');

function createSessionService(cookieTtlMs = 60 * 60 * 1000) {
  return new SessionService(
    {
      signingSecret: 'test-signing-secret',
      cookieName: 'tzmc_session',
      cookieTtlMs,
      cookieSameSite: 'Lax',
      cookieSecure: false,
    },
    {
      normalizeUserCandidate: (value) => String(value || '').trim().toLowerCase(),
      activeSessionIdsByUser: new Map(),
    }
  );
}

test('renewed session tokens can preserve csrf token and session id', () => {
  const service = createSessionService();
  const original = service.createSessionToken('0546799693');

  assert.ok(original);

  const renewed = service.createSessionToken('0546799693', {
    csrfToken: original.csrfToken,
    sessionId: original.sessionId,
  });

  assert.ok(renewed);
  assert.equal(renewed.csrfToken, original.csrfToken);
  assert.equal(renewed.sessionId, original.sessionId);

  const parsed = service.getSessionFromToken(renewed.token);
  assert.ok(parsed);
  assert.equal(parsed.csrfToken, original.csrfToken);
  assert.equal(parsed.sessionId, original.sessionId);
});

test('rolling back a consumed rate-limit entry removes the latest attempt', () => {
  const service = createSessionService();
  const store = new Map();

  const beforeRollback = service.consumeRateLimitEntry(store, '0546799693', 2, 60_000);
  assert.equal(beforeRollback.allowed, true);
  assert.equal(store.get('0546799693').length, 1);

  service.rollbackRateLimitEntry(store, '0546799693');
  assert.equal(store.has('0546799693'), false);
});

// ─── Cookie attributes ──────────────────────────────────────────────────────

function createCookieService(overrides = {}) {
  return new SessionService(
    {
      signingSecret: 'test-signing-secret',
      cookieName: 'tzmc_session',
      cookieTtlMs: 30 * 24 * 60 * 60 * 1000,
      cookieSameSite: 'Lax',
      cookieSecure: true,
      ...overrides,
    },
    {
      normalizeUserCandidate: (value) => String(value || '').trim().toLowerCase(),
      activeSessionIdsByUser: new Map(),
    }
  );
}

function captureCookie(service, host, action = 'set') {
  let cookie = '';
  const res = { setHeader: (_name, value) => { cookie = value; } };
  const req = { headers: { host } };
  if (action === 'set') {
    service.setSessionCookie(res, req, 'token-value', Date.now() + 30 * 24 * 60 * 60 * 1000);
  } else {
    service.clearSessionCookie(res, req);
  }
  return cookie;
}

test('session cookie is persistent so the login survives a browser restart', () => {
  const cookie = captureCookie(createCookieService(), 'www.tzmc.co.il');
  // Max-Age is what makes this a "remember me" cookie rather than a
  // session cookie that dies when the browser closes.
  assert.match(cookie, /Max-Age=\d+/);
  const maxAge = Number(cookie.match(/Max-Age=(\d+)/)[1]);
  assert.ok(maxAge > 29 * 24 * 60 * 60, `expected ~30 days, got ${maxAge}s`);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Secure/);
  assert.match(cookie, /SameSite=Lax/);
});

test('session cookie is host-only when no domain is configured', () => {
  const cookie = captureCookie(createCookieService(), 'www.tzmc.co.il');
  assert.doesNotMatch(cookie, /Domain=/);
});

test('configured cookie domain is shared across apex and www', () => {
  const service = createCookieService({ cookieDomain: 'tzmc.co.il' });
  assert.match(captureCookie(service, 'tzmc.co.il'), /Domain=tzmc\.co\.il/);
  assert.match(captureCookie(service, 'www.tzmc.co.il'), /Domain=tzmc\.co\.il/);
  // Port and case in the Host header must not defeat the match.
  assert.match(captureCookie(service, 'WWW.TZMC.CO.IL:443'), /Domain=tzmc\.co\.il/);
});

test('a leading dot and stray whitespace in the configured domain are tolerated', () => {
  const service = createCookieService({ cookieDomain: ' .TZMC.co.il ' });
  assert.match(captureCookie(service, 'www.tzmc.co.il'), /Domain=tzmc\.co\.il/);
});

test('cookie domain is omitted when the request host is outside it', () => {
  const service = createCookieService({ cookieDomain: 'tzmc.co.il' });
  // Emitting a non-matching Domain would make the browser silently discard the
  // cookie, which looks like an endless login loop. Fall back to host-only.
  assert.doesNotMatch(captureCookie(service, 'localhost'), /Domain=/);
  assert.doesNotMatch(captureCookie(service, 'example.com'), /Domain=/);
  // A domain that merely ends with the same text is not a subdomain.
  assert.doesNotMatch(captureCookie(service, 'nottzmc.co.il'), /Domain=/);
  assert.doesNotMatch(captureCookie(service, ''), /Domain=/);
});

test('clearing the cookie mirrors the domain so logout actually removes it', () => {
  const service = createCookieService({ cookieDomain: 'tzmc.co.il' });
  const cleared = captureCookie(service, 'www.tzmc.co.il', 'clear');
  // A cookie is keyed by name+domain+path; clearing without the Domain would
  // leave the domain-scoped cookie in place and logout would appear to fail.
  assert.match(cleared, /Domain=tzmc\.co\.il/);
  assert.match(cleared, /Max-Age=0/);

  const hostOnly = captureCookie(createCookieService(), 'www.tzmc.co.il', 'clear');
  assert.doesNotMatch(hostOnly, /Domain=/);
});
