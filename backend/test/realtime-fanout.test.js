const test = require('node:test');
const assert = require('node:assert/strict');

const {
  sseClients,
  websocketClients,
  addWebsocketClient,
  removeWebsocketClient,
  notifyRealtimeClients,
  normalizeDeviceId,
  buildSelfEchoMessage,
  buildSelfReadClearMessage,
  DEVICE_ID_MAX_LENGTH,
} = require('../services/realtime-fanout');

function createFakeSocket() {
  const received = [];
  return {
    received,
    emit(event, payload) {
      received.push({ event, payload });
    },
  };
}

function createFakeSseClient() {
  const written = [];
  return {
    written,
    write(chunk) {
      written.push(chunk);
    },
  };
}

function resetRegistries() {
  sseClients.clear();
  websocketClients.clear();
}

test('a message reaches every active socket of the target user', () => {
  resetRegistries();
  const web = createFakeSocket();
  const mobile = createFakeSocket();
  addWebsocketClient('alice', web);
  addWebsocketClient('alice', mobile);

  notifyRealtimeClients('alice', { messageId: 'm1', body: 'hello' });

  assert.equal(web.received.length, 1);
  assert.equal(mobile.received.length, 1);
  assert.equal(web.received[0].event, 'chat:message');
  assert.equal(mobile.received[0].payload.messageId, 'm1');
});

test('the sender self-echo reaches a second sender connection with originDeviceId', () => {
  resetRegistries();
  // Alice is logged in on web (which sends the message) and on mobile.
  const aliceWeb = createFakeSocket();
  const aliceMobile = createFakeSocket();
  addWebsocketClient('alice', aliceWeb);
  addWebsocketClient('alice', aliceMobile);

  const pollingMessage = { messageId: 'm1', sender: 'alice', body: 'hi bob' };
  const selfEcho = buildSelfEchoMessage({
    pollingMessage,
    isGroup: false,
    recipientKey: 'bob',
    originDeviceId: 'dev-web',
  });

  notifyRealtimeClients('alice', selfEcho);

  for (const socket of [aliceWeb, aliceMobile]) {
    assert.equal(socket.received.length, 1);
    const payload = socket.received[0].payload;
    // The echo is addressed to the peer so it lands in bob's chat as outgoing.
    assert.equal(payload.toUser, 'bob');
    assert.equal(payload.sender, 'alice');
    // The originating device can recognise — and skip — its own echo.
    assert.equal(payload.originDeviceId, 'dev-web');
  }
});

test('the group self-echo leaves toUser unset so the group id identifies the chat', () => {
  const selfEcho = buildSelfEchoMessage({
    pollingMessage: { messageId: 'm2', groupId: 'group:g1', toUser: 'stale' },
    isGroup: true,
    recipientKey: 'bob',
    originDeviceId: 'dev-mobile',
  });

  assert.equal(selfEcho.toUser, undefined);
  assert.equal(selfEcho.groupId, 'group:g1');
  assert.equal(selfEcho.originDeviceId, 'dev-mobile');
});

test('the self-echo omits originDeviceId when the client sent none', () => {
  const selfEcho = buildSelfEchoMessage({
    pollingMessage: { messageId: 'm3' },
    isGroup: false,
    recipientKey: 'bob',
  });

  assert.equal('originDeviceId' in selfEcho, false);
  assert.equal(selfEcho.toUser, 'bob');
});

test('SSE clients receive the same payload as sockets', () => {
  resetRegistries();
  const socket = createFakeSocket();
  const sse = createFakeSseClient();
  addWebsocketClient('alice', socket);
  sseClients.set('alice', new Set([sse]));

  notifyRealtimeClients('alice', { messageId: 'm4', originDeviceId: 'dev-web' });

  assert.equal(socket.received.length, 1);
  assert.equal(sse.written.length, 1);
  assert.match(sse.written[0], /^event: message\ndata: /);
  const decoded = JSON.parse(sse.written[0].slice('event: message\ndata: '.length));
  assert.equal(decoded.messageId, 'm4');
  assert.equal(decoded.originDeviceId, 'dev-web');
});

test('a failing connection does not stop delivery to the others', () => {
  resetRegistries();
  const broken = {
    emit() {
      throw new Error('socket closed');
    },
  };
  const healthy = createFakeSocket();
  addWebsocketClient('alice', broken);
  addWebsocketClient('alice', healthy);

  notifyRealtimeClients('alice', { messageId: 'm5' });

  assert.equal(healthy.received.length, 1);
});

test('removing the last connection drops the user entry', () => {
  resetRegistries();
  const socket = createFakeSocket();
  addWebsocketClient('alice', socket);
  assert.equal(websocketClients.has('alice'), true);

  removeWebsocketClient('alice', socket);
  assert.equal(websocketClients.has('alice'), false);

  // Delivering to a user with no connections is a no-op, not a throw.
  notifyRealtimeClients('alice', { messageId: 'm6' });
});

test('device ids are trimmed and bounded', () => {
  assert.equal(normalizeDeviceId('  dev-web  '), 'dev-web');
  assert.equal(normalizeDeviceId(null), '');
  assert.equal(normalizeDeviceId(undefined), '');
  assert.equal(normalizeDeviceId({ evil: true }), '');
  assert.equal(normalizeDeviceId('x'.repeat(500)).length, DEVICE_ID_MAX_LENGTH);
});

test('self-read-clear carries the chat id so clients distinguish it from a peer receipt', () => {
  const clear = buildSelfReadClearMessage({
    chatId: 'group-42',
    messageIds: ['m1', 'm2'],
    readAt: 1000,
    sender: 'group-42',
    timestamp: 2000,
  });

  assert.equal(clear.type, 'read-receipt');
  assert.equal(clear.chatId, 'group-42');
  assert.deepEqual(clear.messageIds, ['m1', 'm2']);
  assert.equal(clear.readAt, 1000);
  assert.equal(clear.timestamp, 2000);
});

test('self-read-clear propagates a normalized originDeviceId', () => {
  const clear = buildSelfReadClearMessage({
    chatId: 'alice',
    originDeviceId: '  dev-web  ',
  });

  assert.equal(clear.originDeviceId, 'dev-web');
});

test('self-read-clear omits originDeviceId when the reader sent none', () => {
  const clear = buildSelfReadClearMessage({ chatId: 'alice' });

  assert.equal('originDeviceId' in clear, false);
  assert.equal('messageIds' in clear, false);
});

test('self-read-clear reaches every other session of the reader', () => {
  resetRegistries();
  const web = createFakeSocket();
  const mobile = createFakeSocket();
  addWebsocketClient('alice', web);
  addWebsocketClient('alice', mobile);

  notifyRealtimeClients('alice', buildSelfReadClearMessage({
    chatId: 'bob',
    originDeviceId: 'dev-web',
  }));

  for (const socket of [web, mobile]) {
    assert.equal(socket.received.length, 1);
    assert.equal(socket.received[0].payload.chatId, 'bob');
    assert.equal(socket.received[0].payload.originDeviceId, 'dev-web');
  }
});
