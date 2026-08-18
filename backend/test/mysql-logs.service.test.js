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
