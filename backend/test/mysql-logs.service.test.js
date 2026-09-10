const test = require('node:test');
const assert = require('node:assert/strict');

const { MysqlLogsService } = require('../dist/services/mysql-logs.service');

function createService({ queryImpl, executeImpl } = {}) {
  const service = Object.create(MysqlLogsService.prototype);
  service.pool = {
    query: queryImpl || (async () => [[], undefined]),
    execute: executeImpl || (async () => [{ affectedRows: 1 }, undefined]),
  };
  service.ensureSubscribeTable = async () => {};
  return service;
}

test('updateSubscribeUserProfilePicture resolves Subscribe rows by user aliases and updates Upic', async () => {
  let queryCall = null;
  let executeCall = null;
  const service = createService({
    queryImpl: async (sql, params) => {
      queryCall = { sql, params };
      return [[{ User: '0546799693' }], undefined];
    },
    executeImpl: async (sql, params) => {
      executeCall = { sql, params };
      return [{ affectedRows: 1 }, undefined];
    },
  });

  const result = await service.updateSubscribeUserProfilePicture(
    ['Runner.User', 'runner.user', '546799693'],
    '/notify/uploads/users/avatar.jpg'
  );

  assert.deepEqual(result, {
    user: '0546799693',
    upic: '/notify/uploads/users/avatar.jpg',
  });
  assert.match(queryCall.sql, /`UserName` IN/);
  assert.ok(queryCall.params.includes('Runner.User'));
  assert.ok(queryCall.params.includes('runner.user'));
  assert.ok(queryCall.params.includes('546799693'));
  assert.ok(queryCall.params.includes('0546799693'));
  assert.deepEqual(executeCall, {
    sql: 'UPDATE `Subscribe` SET `Upic` = ? WHERE `User` = ?',
    params: ['/notify/uploads/users/avatar.jpg', '0546799693'],
  });
});

test('updateSubscribeUserProfilePicture returns null when no Subscribe row matches', async () => {
  const service = createService();

  const result = await service.updateSubscribeUserProfilePicture(
    ['missing-user'],
    '/notify/uploads/users/avatar.jpg'
  );

  assert.equal(result, null);
});

test('markMessagesDelivered stamps receiveDateTime only for undelivered messages in the chat', async () => {
  const executeCalls = [];
  const service = createService({
    executeImpl: async (sql, params) => {
      executeCalls.push({ sql, params });
      return [{ affectedRows: 3 }, undefined];
    },
  });
  service.tableName = 'Logs';
  service.lifecycleTimestampColumnsReady = true;

  const affected = await service.markMessagesDelivered(' 0546799693 ', '0501234567');

  assert.equal(affected, 3);
  const updateCall = executeCalls.find((call) => /UPDATE `Logs`/.test(call.sql));
  assert.ok(updateCall, 'expected an UPDATE statement');
  assert.match(updateCall.sql, /`receiveDateTime` = COALESCE\(`receiveDateTime`, NOW\(3\)\)/);
  assert.match(updateCall.sql, /`receiveDateTime` IS NULL/);
  assert.deepEqual(updateCall.params, [
    '0501234567', '0546799693',
    '0546799693', '0501234567',
  ]);
});

test('markMessagesDelivered returns 0 for blank recipient or chat', async () => {
  const service = createService();
  service.tableName = 'Logs';
  service.lifecycleTimestampColumnsReady = true;

  assert.equal(await service.markMessagesDelivered('', 'someone'), 0);
  assert.equal(await service.markMessagesDelivered('someone', '  '), 0);
});

test('markActivitiesDelivered batch-updates receiveDateTime via indexed MessageId IN (...)', async () => {
  const executeCalls = [];
  const service = createService({
    executeImpl: async (sql, params) => {
      executeCalls.push({ sql, params });
      return [{ affectedRows: 2 }, undefined];
    },
  });
  service.messageActivitiesTableReady = true;
  service.messageActivitiesLifecycleReady = true;

  const affected = await service.markActivitiesDelivered(' 0546799693 ', ['msg-1', ' msg-2 ', 'msg-1', '']);

  assert.equal(affected, 2);
  const updateCall = executeCalls.find((call) => /UPDATE `MessageActivities`/.test(call.sql));
  assert.ok(updateCall, 'expected an UPDATE statement');
  assert.match(updateCall.sql, /`receiveDateTime` = COALESCE\(`receiveDateTime`, NOW\(3\)\)/);
  assert.match(updateCall.sql, /`MessageId` IN \(\?, \?\)/);
  assert.match(updateCall.sql, /`receiveDateTime` IS NULL/);
  assert.ok(!/readDateTime` =/.test(updateCall.sql), 'must not touch readDateTime');
  assert.ok(!/sentDateTime` =/.test(updateCall.sql), 'must never mutate the sort key');
  assert.ok(!/ActionTimestamp` =/.test(updateCall.sql), 'must never mutate the sort key');
  assert.deepEqual(updateCall.params, ['msg-1', 'msg-2', '0546799693']);
});

test('markActivitiesDelivered returns 0 for blank recipient or empty messageIds', async () => {
  const service = createService();
  service.messageActivitiesTableReady = true;
  service.messageActivitiesLifecycleReady = true;

  assert.equal(await service.markActivitiesDelivered('', ['msg-1']), 0);
  assert.equal(await service.markActivitiesDelivered('0546799693', []), 0);
});

test('markActivitiesRead watermark-updates read and receive times in one query', async () => {
  const executeCalls = [];
  const service = createService({
    executeImpl: async (sql, params) => {
      executeCalls.push({ sql, params });
      return [{ affectedRows: 5 }, undefined];
    },
  });
  service.messageActivitiesTableReady = true;
  service.messageActivitiesLifecycleReady = true;

  const affected = await service.markActivitiesRead(' 0546799693 ', '0501234567');

  assert.equal(affected, 5);
  const updateCall = executeCalls.find((call) => /UPDATE `MessageActivities`/.test(call.sql));
  assert.ok(updateCall, 'expected an UPDATE statement');
  assert.match(updateCall.sql, /`readDateTime` = COALESCE\(`readDateTime`, NOW\(3\)\)/);
  assert.match(updateCall.sql, /`receiveDateTime` = COALESCE\(`receiveDateTime`, NOW\(3\)\)/);
  assert.match(updateCall.sql, /`readDateTime` IS NULL/);
  assert.ok(!/sentDateTime` =/.test(updateCall.sql), 'must never mutate the sort key');
  assert.ok(!/ActionTimestamp` =/.test(updateCall.sql), 'must never mutate the sort key');
  assert.deepEqual(updateCall.params, [
    '0546799693',
    '0501234567',
    '0501234567', '0546799693', '%0546799693%',
  ]);
});

test('markActivitiesRead returns 0 for blank reader or chat', async () => {
  const service = createService();
  service.messageActivitiesTableReady = true;
  service.messageActivitiesLifecycleReady = true;

  assert.equal(await service.markActivitiesRead('', '0501234567'), 0);
  assert.equal(await service.markActivitiesRead('0546799693', '  '), 0);
});

test('setAuthCode stores TTL-bound code in the Subscribe 2FA column', async () => {
  const executeCalls = [];
  const service = createService({
    executeImpl: async (sql, params) => {
      executeCalls.push({ sql, params });
      return [{ affectedRows: 1 }, undefined];
    },
  });

  const before = Date.now();
  const ok = await service.setAuthCode('0546799693', '123456', 300);
  const after = Date.now();

  assert.equal(ok, true);
  const updateCall = executeCalls.find((call) => /UPDATE `Subscribe` SET `2FA` = \?/.test(call.sql));
  assert.ok(updateCall, 'expected an UPDATE on Subscribe.2FA');
  const stored = String(updateCall.params[0]);
  const [code, expiresRaw] = stored.split('|');
  assert.equal(code, '123456');
  const expiresAt = Number(expiresRaw);
  assert.ok(expiresAt >= before + 300 * 1000 && expiresAt <= after + 300 * 1000, 'expiry must be ~TTL from now');
  assert.ok(updateCall.params.includes('0546799693'));
});

test('setAuthCode returns false when no Subscribe row matches', async () => {
  const service = createService({
    executeImpl: async () => [{ affectedRows: 0 }, undefined],
  });
  assert.equal(await service.setAuthCode('0500000000', '123456', 300), false);
});

test('verifyAuthCode verifies an unexpired code and clears it (single-use)', async () => {
  const executeCalls = [];
  const futureExpiry = Date.now() + 60_000;
  const service = createService({
    queryImpl: async () => [[{ User: '0546799693', twoFA: `123456|${futureExpiry}` }], undefined],
    executeImpl: async (sql, params) => {
      executeCalls.push({ sql, params });
      return [{ affectedRows: 1 }, undefined];
    },
  });

  assert.equal(await service.verifyAuthCode('0546799693', '123456'), 'verified');
  const clearCall = executeCalls.find((call) => /SET `2FA` = NULL/.test(call.sql));
  assert.ok(clearCall, 'expected the 2FA column to be cleared after verification');
  assert.deepEqual(clearCall.params, ['0546799693']);
});

test('verifyAuthCode accepts a bare code without expiry (external writer)', async () => {
  const service = createService({
    queryImpl: async () => [[{ User: '0546799693', twoFA: '654321' }], undefined],
  });
  assert.equal(await service.verifyAuthCode('0546799693', '654321'), 'verified');
});

test('verifyAuthCode rejects expired and mismatched codes', async () => {
  const pastExpiry = Date.now() - 1000;
  const serviceExpired = createService({
    queryImpl: async () => [[{ User: '0546799693', twoFA: `123456|${pastExpiry}` }], undefined],
  });
  assert.equal(await serviceExpired.verifyAuthCode('0546799693', '123456'), 'mismatch');

  const serviceWrong = createService({
    queryImpl: async () => [[{ User: '0546799693', twoFA: `123456|${Date.now() + 60_000}` }], undefined],
  });
  assert.equal(await serviceWrong.verifyAuthCode('0546799693', '999999'), 'mismatch');
});

test('verifyAuthCode returns unavailable when no Subscribe row or DB error', async () => {
  const serviceNoRow = createService({
    queryImpl: async () => [[], undefined],
  });
  assert.equal(await serviceNoRow.verifyAuthCode('0500000000', '123456'), 'unavailable');

  const serviceError = createService({
    queryImpl: async () => { throw new Error('connection lost'); },
  });
  assert.equal(await serviceError.verifyAuthCode('0546799693', '123456'), 'unavailable');
});
