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
