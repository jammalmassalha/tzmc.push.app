const test = require('node:test');
const assert = require('node:assert/strict');

const { extractUsersUploadIdentityCandidatesFromFiles } = require('../utils/users-upload-identity');

test('extractUsersUploadIdentityCandidatesFromFiles returns filename stems for uploaded files', () => {
  const result = extractUsersUploadIdentityCandidatesFromFiles([
    { originalname: '0546799693.jpg', filename: '0546799693.jpg' },
    { originalname: 'runner.user.png', filename: 'runner.user.png' },
  ]);

  assert.deepEqual(result, ['0546799693', 'runner.user']);
});

test('extractUsersUploadIdentityCandidatesFromFiles ignores empty and invalid names', () => {
  const result = extractUsersUploadIdentityCandidatesFromFiles([
    { originalname: '', filename: '' },
    { originalname: '../avatar.jpg', filename: '..' },
    null,
  ]);

  assert.deepEqual(result, ['avatar']);
});
