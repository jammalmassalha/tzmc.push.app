const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const {
  fetchRemoteUserDetails,
  syncRemoteUserIntoSubscribeTable,
} = require('../dist/services/remote-employee-sync.service');

test('fetchRemoteUserDetails resolves remote employee rows by phone candidate', async () => {
  let seenCandidates = [];
  const remotePool = {
    request() {
      let candidate = '';
      return {
        input(_name, _type, value) {
          candidate = String(value || '');
          seenCandidates.push(candidate);
          return this;
        },
        async query() {
          if (candidate === '546799693') {
            return {
              recordset: [{
                BaseFullName: 'Jane Doe',
                ProfilePicture: '/remote/pictures/jane.png',
                EmployeeSektorDescription: 'Operations',
                FunctionDescription: 'Coordinator',
                UserName: 'jane.doe',
                YearOfBirth: '1990',
              }],
            };
          }
          return { recordset: [] };
        },
      };
    },
  };

  const result = await fetchRemoteUserDetails(remotePool, '0546799693');

  assert.equal(result.fullName, 'Jane Doe (Operations  -  Coordinator)');
  assert.equal(result.profilePicturePath, '/remote/pictures/jane.png');
  assert.equal(result.yearOfBirth, '1990');
  assert.equal(result.userName, 'jane.doe');
  assert.ok(seenCandidates.includes('0546799693'));
  assert.ok(seenCandidates.includes('546799693'));
});

test('syncRemoteUserIntoSubscribeTable downloads profile pictures and inserts Subscribe rows', async () => {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'remote-sync-'));
  const uploadsDir = path.join(tempRoot, 'uploads');
  const remotePicture = path.join(tempRoot, 'profile.png');
  await fsp.writeFile(remotePicture, Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x00
  ]));

  const executeCalls = [];
  const mysqlPool = {
    async query(sql, params) {
      if (/SELECT `User` FROM `Subscribe`/.test(sql)) {
        return [[], undefined];
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
    async execute(sql, params) {
      executeCalls.push({ sql, params });
      return [{ affectedRows: 1 }, undefined];
    },
  };

  const remotePool = {
    request() {
      return {
        input() {
          return this;
        },
        async query() {
          return {
            recordset: [{
              BaseFullName: 'Jane Doe',
              ProfilePicture: remotePicture,
              EmployeeSektorDescription: 'Operations',
              FunctionDescription: 'Coordinator',
              UserName: 'jane.doe',
              YearOfBirth: '1990',
            }],
          };
        },
      };
    },
  };

  const result = await syncRemoteUserIntoSubscribeTable({
    mysqlPool,
    remotePool,
    usernameOrPhone: '0546799693',
    uploadDir: uploadsDir,
    publicUploadBasePath: '/notify/uploads/users',
  });

  assert.equal(result.user, '0546799693');
  assert.equal(result.fullName, 'Jane Doe (Operations  -  Coordinator)');
  assert.equal(result.userName, 'jane.doe');
  assert.match(result.upic, /^\/notify\/uploads\/users\/\d+-[a-f0-9]+-0546799693\.png$/);
  assert.ok(fs.existsSync(path.join(uploadsDir, 'users')), 'users upload directory should exist');
  assert.equal(executeCalls.length, 1);
  assert.match(executeCalls[0].sql, /INSERT INTO `Subscribe`/);
  assert.deepEqual(executeCalls[0].params, [
    '0546799693',
    'Jane Doe (Operations  -  Coordinator)',
    result.upic,
    '1990',
    'jane.doe',
  ]);
});

test('RemoteEmployeeSyncService.checkConnection reports remote db health', async () => {
  const { RemoteEmployeeSyncService } = require('../dist/services/remote-employee-sync.service');
  let queryCount = 0;
  const service = new RemoteEmployeeSyncService({
    mysqlPool: {
      query: async () => [[], undefined],
      execute: async () => [{ affectedRows: 1 }, undefined],
    },
    server: 'SRV-APPDB.poria.health.gov.il',
    user: 'hrd',
    password: 'secret',
    database: 'msdb',
    uploadDir: os.tmpdir(),
  });

  service.remotePoolPromise = Promise.resolve({
    request() {
      return {
        input() {
          return this;
        },
        async query(sql) {
          queryCount += 1;
          assert.match(sql, /SELECT 1 AS ok/);
          return { recordset: [{ ok: 1 }] };
        },
      };
    },
  });

  const result = await service.checkConnection();

  assert.equal(result.ok, true);
  assert.equal(result.message, 'Remote database connection is healthy');
  assert.equal(queryCount, 1);
});
