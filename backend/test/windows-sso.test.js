const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DEFAULT_SSO_USER_HEADER,
  DEFAULT_SSO_SIGNATURE_HEADER,
  normalizeWindowsPrincipal,
  signWindowsPrincipal,
  resolveWindowsSsoConfig,
  resolveWindowsSsoUser,
} = require('../services/windows-sso');

test('normalizeWindowsPrincipal strips the DOMAIN prefix and lowercases', () => {
  assert.equal(normalizeWindowsPrincipal('TZMC\\JMassalha'), 'jmassalha');
  assert.equal(normalizeWindowsPrincipal('  tzmc\\jmassalha  '), 'jmassalha');
});

test('normalizeWindowsPrincipal strips the UPN suffix and lowercases', () => {
  assert.equal(normalizeWindowsPrincipal('JMassalha@tzmc.co.il'), 'jmassalha');
});

test('normalizeWindowsPrincipal accepts a bare account name', () => {
  assert.equal(normalizeWindowsPrincipal('JMassalha'), 'jmassalha');
});

test('normalizeWindowsPrincipal rejects empty and non-string input', () => {
  for (const value of ['', '   ', null, undefined, {}, [], '\\', 'DOMAIN\\', '@tzmc.co.il']) {
    assert.equal(normalizeWindowsPrincipal(value), '');
  }
});

test('normalizeWindowsPrincipal rejects malformed and hostile values', () => {
  // Both a domain prefix and a UPN suffix is malformed, not something to clean up.
  assert.equal(normalizeWindowsPrincipal('TZMC\\jmassalha@tzmc.co.il'), '');
  // Multiple separators could hide a second identity.
  assert.equal(normalizeWindowsPrincipal('A\\B\\c'), '');
  assert.equal(normalizeWindowsPrincipal('a@b@c'), '');
  // Header smuggling / injection vehicles.
  assert.equal(normalizeWindowsPrincipal('jmassalha\r\nX-Other: 1'), '');
  assert.equal(normalizeWindowsPrincipal('jmassalha\u0000'), '');
  assert.equal(normalizeWindowsPrincipal("jmassalha' OR 1=1"), '');
  assert.equal(normalizeWindowsPrincipal('jmassalha with spaces'), '');
  // Absurdly long values never reach the lookup.
  assert.equal(normalizeWindowsPrincipal('a'.repeat(300)), '');
});

test('resolveWindowsSsoConfig defaults to disabled', () => {
  const config = resolveWindowsSsoConfig({});
  assert.equal(config.enabled, false);
  assert.equal(config.userHeader, DEFAULT_SSO_USER_HEADER);
  assert.equal(config.signatureHeader, DEFAULT_SSO_SIGNATURE_HEADER);
  assert.equal(config.signatureSecret, '');
});

test('resolveWindowsSsoConfig reads flags, header names and secret', () => {
  const config = resolveWindowsSsoConfig({
    WINDOWS_SSO_ENABLED: 'true',
    WINDOWS_SSO_USER_HEADER: 'X-Iis-Remote-User',
    WINDOWS_SSO_SIGNATURE_HEADER: 'X-Iis-Signature',
    WINDOWS_SSO_SIGNATURE_SECRET: ' s3cret ',
  });
  assert.equal(config.enabled, true);
  // Header names are lowercased to match Node's normalized req.headers keys.
  assert.equal(config.userHeader, 'x-iis-remote-user');
  assert.equal(config.signatureHeader, 'x-iis-signature');
  assert.equal(config.signatureSecret, 's3cret');
});

test('resolveWindowsSsoUser ignores the header entirely when SSO is disabled', () => {
  // The critical guard: a deployment with no proxy in front must never trust a
  // client-supplied identity header.
  const config = resolveWindowsSsoConfig({});
  const result = resolveWindowsSsoUser({ 'x-remote-user': 'TZMC\\ceo_account' }, config);
  assert.equal(result.user, '');
  assert.equal(result.reason, 'disabled');
});

test('resolveWindowsSsoUser returns the normalized account when enabled', () => {
  const config = resolveWindowsSsoConfig({ WINDOWS_SSO_ENABLED: '1' });
  const result = resolveWindowsSsoUser({ 'x-remote-user': 'TZMC\\JMassalha' }, config);
  assert.equal(result.user, 'jmassalha');
  assert.equal(result.reason, 'ok');
});

test('resolveWindowsSsoUser refuses a duplicated identity header', () => {
  // Express surfaces a repeated header as an array; picking either element
  // would let a client append a value to whatever the proxy set.
  const config = resolveWindowsSsoConfig({ WINDOWS_SSO_ENABLED: '1' });
  const result = resolveWindowsSsoUser(
    { 'x-remote-user': ['TZMC\\jmassalha', 'TZMC\\ceo_account'] },
    config
  );
  assert.equal(result.user, '');
  assert.equal(result.reason, 'duplicate-header');
});

test('resolveWindowsSsoUser handles a missing header', () => {
  const config = resolveWindowsSsoConfig({ WINDOWS_SSO_ENABLED: '1' });
  assert.equal(resolveWindowsSsoUser({}, config).user, '');
  assert.equal(resolveWindowsSsoUser(null, config).user, '');
});

test('resolveWindowsSsoUser reads a custom header name', () => {
  const config = resolveWindowsSsoConfig({
    WINDOWS_SSO_ENABLED: '1',
    WINDOWS_SSO_USER_HEADER: 'X-Iis-Remote-User',
  });
  assert.equal(
    resolveWindowsSsoUser({ 'x-iis-remote-user': 'TZMC\\jmassalha' }, config).user,
    'jmassalha'
  );
  // The default header must not be honoured once a custom one is configured.
  assert.equal(resolveWindowsSsoUser({ 'x-remote-user': 'TZMC\\jmassalha' }, config).user, '');
});

test('resolveWindowsSsoUser requires a valid signature when a secret is set', () => {
  const env = {
    WINDOWS_SSO_ENABLED: '1',
    WINDOWS_SSO_SIGNATURE_SECRET: 'proxy-shared-secret',
  };
  const config = resolveWindowsSsoConfig(env);
  const signature = signWindowsPrincipal('TZMC\\JMassalha', 'proxy-shared-secret');
  assert.ok(signature);

  const ok = resolveWindowsSsoUser(
    { 'x-remote-user': 'TZMC\\JMassalha', 'x-remote-user-signature': signature },
    config
  );
  assert.equal(ok.user, 'jmassalha');

  const missing = resolveWindowsSsoUser({ 'x-remote-user': 'TZMC\\JMassalha' }, config);
  assert.equal(missing.user, '');
  assert.equal(missing.reason, 'missing-signature');

  const wrong = resolveWindowsSsoUser(
    { 'x-remote-user': 'TZMC\\JMassalha', 'x-remote-user-signature': 'deadbeef' },
    config
  );
  assert.equal(wrong.user, '');
  assert.equal(wrong.reason, 'invalid-signature');

  // A signature valid for one account must not authenticate another.
  const swapped = resolveWindowsSsoUser(
    { 'x-remote-user': 'TZMC\\ceo_account', 'x-remote-user-signature': signature },
    config
  );
  assert.equal(swapped.user, '');
  assert.equal(swapped.reason, 'invalid-signature');
});

test('signWindowsPrincipal is stable across equivalent principal spellings', () => {
  const secret = 'proxy-shared-secret';
  const expected = signWindowsPrincipal('jmassalha', secret);
  assert.equal(signWindowsPrincipal('TZMC\\JMassalha', secret), expected);
  assert.equal(signWindowsPrincipal('JMassalha@tzmc.co.il', secret), expected);
  assert.equal(signWindowsPrincipal('jmassalha', ''), '');
  assert.equal(signWindowsPrincipal('', secret), '');
});
