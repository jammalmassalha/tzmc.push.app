/* global importScripts, self, clients */

importScripts('./ngsw-worker.js');

const FALLBACK_TITLE = 'TZMC';
const FALLBACK_BODY = 'התקבלה הודעה חדשה';
const CLIENT_CONTEXT_TTL_MS = 10 * 60 * 1000;
const AUTH_REFRESH_PUSH_TYPE = 'subscription-auth-refresh';
const SW_SUBSCRIPTION_CONTEXT_CACHE = 'tzmc-sw-subscription-context-v6';
const SW_SUBSCRIPTION_CONTEXT_KEY = new URL('./__subscription_context__', self.registration.scope).toString();
const SW_OFFLINE_REPLY_CACHE = 'tzmc-sw-offline-replies-v1';
const SW_OFFLINE_REPLY_KEY = new URL('./__offline_replies__', self.registration.scope).toString();
const OFFLINE_REPLY_SYNC_TAG = 'tzmc-offline-reply-sync-v1';
const SW_PENDING_PUSH_CACHE = 'tzmc-sw-pending-push-v1';
const SW_PENDING_PUSH_KEY = new URL('./__pending_push__', self.registration.scope).toString();
const MAX_PENDING_PUSH_ITEMS = 500;
const clientContextById = new Map();

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function fetchWithRetry(url, options = {}, retryOptions = {}) {
  const retries = Number.isFinite(retryOptions.retries) ? retryOptions.retries : 2;
  const timeoutMs = Number.isFinite(retryOptions.timeoutMs) ? retryOptions.timeoutMs : 15000;
  const backoffMs = Number.isFinite(retryOptions.backoffMs) ? retryOptions.backoffMs : 700;
  let lastError = null;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timeoutId = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
    try {
      const response = await fetch(url, {
        ...options,
        signal: controller ? controller.signal : undefined
      });
      // no-cors POST returns opaque responses (status=0). Network success is enough here.
      return response;
    } catch (error) {
      lastError = error;
      if (attempt < retries) {
        await sleep(backoffMs * Math.pow(2, attempt));
        continue;
      }
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    }
  }

  throw lastError || new Error('Network request failed');
}

function isReplyMutationRequest(request) {
  if (!request || String(request.method || '').toUpperCase() !== 'POST') {
    return false;
  }
  try {
    const requestUrl = new URL(request.url, self.registration.scope);
    return /\/notify\/reply$/i.test(requestUrl.pathname) || /\/reply$/i.test(requestUrl.pathname);
  } catch (err) {
    console.warn('[SW] Failed to parse request URL for reply mutation detection:', err);
    return false;
  }
}

async function readOfflineReplyQueue() {
  try {
    const cache = await caches.open(SW_OFFLINE_REPLY_CACHE);
    const response = await cache.match(SW_OFFLINE_REPLY_KEY);
    if (!response) return [];
    const payload = await response.json();
    return Array.isArray(payload) ? payload : [];
  } catch (err) {
    console.warn('[SW] Failed to read offline reply queue:', err);
    return [];
  }
}

async function persistOfflineReplyQueue(items) {
  const queue = Array.isArray(items) ? items.slice(-120) : [];
  const cache = await caches.open(SW_OFFLINE_REPLY_CACHE);
  await cache.put(
    SW_OFFLINE_REPLY_KEY,
    new Response(JSON.stringify(queue), {
      headers: { 'Content-Type': 'application/json' }
    })
  );
}

async function registerOfflineReplySync() {
  if (!self.registration || !self.registration.sync || typeof self.registration.sync.register !== 'function') {
    return false;
  }
  try {
    await self.registration.sync.register(OFFLINE_REPLY_SYNC_TAG);
    return true;
  } catch (err) {
    console.warn('[SW] Failed to register background sync tag:', err);
    return false;
  }
}

async function enqueueOfflineReplyRequest(request) {
  try {
    const body = await request.clone().text();
    const queue = await readOfflineReplyQueue();
    queue.push({
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      url: request.url,
      method: 'POST',
      contentType: request.headers.get('Content-Type') || 'application/json',
      csrfToken: request.headers.get('X-CSRF-Token') || '',
      credentials: request.credentials || 'same-origin',
      body,
      queuedAt: Date.now()
    });
    await persistOfflineReplyQueue(queue);
    const syncRegistered = await registerOfflineReplySync();
    if (!syncRegistered) {
      // Browsers without SyncManager still get best-effort retry while SW is alive.
      setTimeout(() => {
        void flushOfflineReplyQueue();
      }, 3000);
    }
    return true;
  } catch (err) {
    console.warn('[SW] Failed to enqueue offline reply request:', err);
    return false;
  }
}

async function flushOfflineReplyQueue() {
  const queue = await readOfflineReplyQueue();
  if (!queue.length) {
    return { sent: 0, remaining: 0 };
  }

  const remaining = [];
  let sent = 0;
  for (const entry of queue) {
    try {
      const headers = { 'Content-Type': entry.contentType || 'application/json' };
      if (entry.csrfToken) {
        headers['X-CSRF-Token'] = entry.csrfToken;
      }
      const response = await fetchWithRetry(entry.url, {
        method: 'POST',
        headers,
        body: typeof entry.body === 'string' ? entry.body : '',
        credentials: entry.credentials || 'same-origin'
      }, { retries: 1, timeoutMs: 12000, backoffMs: 500 });
      if (response && response.ok) {
        sent += 1;
      } else {
        remaining.push(entry);
      }
    } catch (_) {
      remaining.push(entry);
    }
  }

  try {
    await persistOfflineReplyQueue(remaining);
  } catch (persistErr) {
    console.error('[SW] Failed to persist offline reply queue:', persistErr);
  }
  return { sent, remaining: remaining.length };
}

async function readPendingPushQueue() {
  try {
    const cache = await caches.open(SW_PENDING_PUSH_CACHE);
    const response = await cache.match(SW_PENDING_PUSH_KEY);
    if (!response) return [];
    const payload = await response.json();
    return Array.isArray(payload) ? payload : [];
  } catch (err) {
    console.warn('[SW] Failed to read pending push queue:', err);
    return [];
  }
}

async function persistPendingPushQueue(items) {
  const queue = Array.isArray(items) ? items.slice(-MAX_PENDING_PUSH_ITEMS) : [];
  const cache = await caches.open(SW_PENDING_PUSH_CACHE);
  await cache.put(
    SW_PENDING_PUSH_KEY,
    new Response(JSON.stringify(queue), {
      headers: { 'Content-Type': 'application/json' }
    })
  );
}

function buildPendingPushFingerprint(payload) {
  if (!payload || typeof payload !== 'object') {
    return '';
  }
  const messageId = String(payload.messageId || '').trim();
  if (messageId) {
    return `id:${messageId}`;
  }
  const type = String(payload.type || 'message').trim().toLowerCase();
  const sender = String(payload.sender || '').trim().toLowerCase();
  const groupId = String(payload.groupId || '').trim().toLowerCase();
  const messageText = String(
    payload.messageText ||
    payload.longText ||
    payload.shortText ||
    payload.body ||
    ''
  ).replace(/\s+/g, ' ').trim().toLowerCase();
  if (!sender && !groupId && !messageText) {
    return '';
  }
  return [type || 'message', sender || 'na', groupId || 'na', messageText || 'na'].join('|');
}

async function enqueuePendingPushPayload(payload) {
  if (!payload || typeof payload !== 'object') return;
  
  // Skip internal auth refresh types
  if (String(payload.type || '').trim().toLowerCase() === AUTH_REFRESH_PUSH_TYPE) return;

  const fingerprint = buildPendingPushFingerprint(payload);
  if (!fingerprint) return;

  const payloadReceivedAt = Number(payload.receivedAt) || Date.now();
  const queue = await readPendingPushQueue();
  
  // Dedup: remove any existing entry with the same fingerprint
  const filteredQueue = queue.filter((entry) => String(entry.fingerprint || '') !== fingerprint);
  
  filteredQueue.push({
    at: payloadReceivedAt,
    fingerprint,
    payload: { ...payload, receivedAt: payloadReceivedAt }
  });

  // Keep the most recent items up to the new limit
  await persistPendingPushQueue(filteredQueue.slice(-MAX_PENDING_PUSH_ITEMS));
}

async function drainPendingPushPayloadQueue() {
  const queue = await readPendingPushQueue();
  await persistPendingPushQueue([]);
  return queue
    .filter((entry) => entry && typeof entry === 'object')
    .map((entry) => {
      const payload = entry.payload && typeof entry.payload === 'object'
        ? entry.payload
        : null;
      if (!payload) {
        return null;
      }
      const entryReceivedAtRaw = Number(entry.at);
      const payloadReceivedAtRaw = Number(payload.receivedAt);
      const resolvedReceivedAt = Number.isFinite(payloadReceivedAtRaw) && payloadReceivedAtRaw > 0
        ? payloadReceivedAtRaw
        : (Number.isFinite(entryReceivedAtRaw) && entryReceivedAtRaw > 0 ? entryReceivedAtRaw : Date.now());
      return {
        ...payload,
        receivedAt: resolvedReceivedAt,
        _queuedAt: Number.isFinite(entryReceivedAtRaw) && entryReceivedAtRaw > 0 ? entryReceivedAtRaw : undefined
      };
    })
    .filter((payload) => payload && typeof payload === 'object');
}

function parsePushPayload(event) {
  if (!event.data) return {};

  try {
    const raw = event.data.json();
    if (raw && typeof raw === 'object') {
      const envelopeData = raw.data && typeof raw.data === 'object'
        ? raw.data
        : {};
      const basePayload = raw.notification && typeof raw.notification === 'object'
        ? raw.notification
        : raw;
      const baseDataPayload = basePayload.data && typeof basePayload.data === 'object'
        ? basePayload.data
        : {};
      const dataPayload = {
        ...baseDataPayload,
        ...envelopeData
      };
      const normalizedBody = typeof basePayload.body === 'string'
        ? basePayload.body
        : (
          basePayload.body && typeof basePayload.body === 'object'
            ? (basePayload.body.longText || basePayload.body.shortText || '')
            : ''
        );
      return {
        ...basePayload,
        ...dataPayload,
        messageText: normalizedBody || String(dataPayload.messageText || dataPayload.longText || dataPayload.shortText || '').trim(),
        image: typeof dataPayload.image === 'string' && dataPayload.image
          ? dataPayload.image
          : (typeof basePayload.image === 'string' && basePayload.image
          ? basePayload.image
          : undefined),
        _hasNotificationEnvelope: Boolean(raw.notification && typeof raw.notification === 'object')
      };
    }
  } catch (err) {
    console.warn('[SW] Failed to parse push payload as JSON, falling back to text:', err);
  }

  try {
    return { body: event.data.text() };
  } catch (err) {
    console.warn('[SW] Failed to parse push payload as text:', err);
    return {};
  }
}

function parseBadgeCount(payload) {
  if (!payload || typeof payload !== 'object') {
    return null;
  }

  const candidates = [
    payload.badgeCount,
    payload.badge_count,
    payload.unreadCount,
    payload.unread_count,
    payload.unread
  ];

  for (const candidate of candidates) {
    if (typeof candidate === 'number' && Number.isFinite(candidate)) {
      return Math.max(0, Math.floor(candidate));
    }
    if (typeof candidate === 'string' && /^\d+$/.test(candidate.trim())) {
      return Math.max(0, Number.parseInt(candidate.trim(), 10));
    }
  }

  if (typeof payload.badge === 'number' && Number.isFinite(payload.badge)) {
    return Math.max(0, Math.floor(payload.badge));
  }
  if (typeof payload.badge === 'string' && /^\d+$/.test(payload.badge.trim())) {
    return Math.max(0, Number.parseInt(payload.badge.trim(), 10));
  }

  return null;
}

function setHomeScreenBadgeCount(count) {
  const normalized = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : Number.NaN;
  if (!Number.isFinite(normalized)) {
    return Promise.resolve();
  }

  if (self.navigator && typeof self.navigator.setAppBadge === 'function') {
    return self.navigator.setAppBadge(normalized).catch(() => undefined);
  }
  if (self.registration && typeof self.registration.setAppBadge === 'function') {
    return self.registration.setAppBadge(normalized).catch(() => undefined);
  }
  if (self.registration && typeof self.registration.setBadge === 'function') {
    return self.registration.setBadge(normalized).catch(() => undefined);
  }

  return Promise.resolve();
}

function clearHomeScreenBadgeCount() {
  if (self.navigator && typeof self.navigator.clearAppBadge === 'function') {
    return self.navigator.clearAppBadge().catch(() => undefined);
  }
  if (self.navigator && typeof self.navigator.setAppBadge === 'function') {
    return self.navigator.setAppBadge(0).catch(() => undefined);
  }
  if (self.registration && typeof self.registration.clearAppBadge === 'function') {
    return self.registration.clearAppBadge().catch(() => undefined);
  }
  if (self.registration && typeof self.registration.clearBadge === 'function') {
    return self.registration.clearBadge().catch(() => undefined);
  }
  if (self.registration && typeof self.registration.setAppBadge === 'function') {
    return self.registration.setAppBadge(0).catch(() => undefined);
  }
  if (self.registration && typeof self.registration.setBadge === 'function') {
    return self.registration.setBadge(0).catch(() => undefined);
  }

  return Promise.resolve();
}

function clearVisibleNotifications() {
  return self.registration.getNotifications().then((items) => {
    items.forEach((notification) => notification.close());
  }).catch(() => undefined);
}

function normalizeBody(payload) {
  if (typeof payload.body === 'string') {
    return payload.body;
  }
  if (payload.body && typeof payload.body === 'object') {
    return payload.body.shortText || payload.body.longText || '';
  }
  return '';
}

function hasValidSubscriptionKeys(subscription) {
  if (!subscription || typeof subscription.toJSON !== 'function') return false;
  const json = subscription.toJSON();
  const keys = json && json.keys ? json.keys : null;
  return Boolean(keys && keys.p256dh && keys.auth);
}

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = self.atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; i += 1) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

function detectWorkerDeviceType() {
  const ua = (self.navigator && self.navigator.userAgent) ? self.navigator.userAgent : '';
  const isMobile = /Mobile|Android|iP(hone|od)|IEMobile|BlackBerry|Kindle|Opera M(obi|ini)/i.test(ua);
  return isMobile ? 'Mobile' : 'PC';
}

function resolveNotifyRegisterDeviceUrl() {
  try {
    return new URL('../notify/register-device', self.registration.scope).toString();
  } catch (_) {
    return `${self.location.origin}/notify/register-device`;
  }
}

async function postRegistrationPayloadToNotifyBackend(registerPayload) {
  try {
    await fetchWithRetry(resolveNotifyRegisterDeviceUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(registerPayload)
    }, { timeoutMs: 12000, retries: 2, backoffMs: 500 });
    return true;
  } catch (err) {
    console.warn('[SW] Failed to post registration payload to notify backend:', err);
    return false;
  }
}

function normalizeUsername(value) {
  return String(value || '').trim().toLowerCase();
}

async function readSubscriptionContext() {
  try {
    const cache = await caches.open(SW_SUBSCRIPTION_CONTEXT_CACHE);
    const response = await cache.match(SW_SUBSCRIPTION_CONTEXT_KEY);
    if (!response) return {};
    const payload = await response.json();
    if (!payload || typeof payload !== 'object') return {};
    return payload;
  } catch (err) {
    console.warn('[SW] Failed to read subscription context from cache:', err);
    return {};
  }
}

async function persistSubscriptionContext(partial = {}) {
  const username = normalizeUsername(partial.username);
  const subscriptionUrl = typeof partial.subscriptionUrl === 'string' ? partial.subscriptionUrl.trim() : '';
  const vapidPublicKey = typeof partial.vapidPublicKey === 'string' ? partial.vapidPublicKey.trim() : '';

  if (!username && !subscriptionUrl && !vapidPublicKey) {
    return false;
  }

  try {
    const previous = await readSubscriptionContext();
    const next = {
      ...previous,
      at: Date.now()
    };
    if (username) {
      next.username = username;
    }
    if (subscriptionUrl) {
      next.subscriptionUrl = subscriptionUrl;
    }
    if (vapidPublicKey) {
      next.vapidPublicKey = vapidPublicKey;
    }

    const cache = await caches.open(SW_SUBSCRIPTION_CONTEXT_CACHE);
    await cache.put(
      SW_SUBSCRIPTION_CONTEXT_KEY,
      new Response(JSON.stringify(next), {
        headers: { 'Content-Type': 'application/json' }
      })
    );
    return true;
  } catch (err) {
    console.warn('[SW] Failed to persist subscription context:', err);
    return false;
  }
}

async function registerSubscriptionFromStoredContext(newSubscription = null, reason = 'pushsubscriptionchange') {
  const context = await readSubscriptionContext();
  const username = normalizeUsername(context.username);
  const subscriptionUrl = typeof context.subscriptionUrl === 'string' ? context.subscriptionUrl.trim() : '';
  const vapidPublicKey = typeof context.vapidPublicKey === 'string' ? context.vapidPublicKey.trim() : '';
  if (!username || !subscriptionUrl || !vapidPublicKey) {
    return false;
  }

  try {
    let subscription = newSubscription;
    if (!subscription || !hasValidSubscriptionKeys(subscription)) {
      subscription = await self.registration.pushManager.getSubscription();
    }
    if (!subscription || !hasValidSubscriptionKeys(subscription)) {
      subscription = await self.registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapidPublicKey)
      });
    }
    if (!subscription) {
      return false;
    }

    const deviceType = detectWorkerDeviceType();
    const registerPayload = {
      username,
      subscription,
      action: 'reactivate_silent',
      reason,
      deviceType
    };
    if (deviceType === 'PC') {
      registerPayload.subscriptionPC = subscription;
    } else {
      registerPayload.subscriptionMobile = subscription;
    }

    await Promise.allSettled([
      fetchWithRetry(subscriptionUrl, {
        method: 'POST',
        mode: 'no-cors',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(registerPayload)
      }, { timeoutMs: 15000, retries: 2, backoffMs: 700 }),
      postRegistrationPayloadToNotifyBackend(registerPayload)
    ]);

    await persistSubscriptionContext({
      username,
      subscriptionUrl,
      vapidPublicKey
    });
    return true;
  } catch (err) {
    console.warn('[SW] Failed to register subscription from stored context:', err);
    return false;
  }
}

async function refreshSubscriptionAuthInBackground(payload) {
  const username = typeof payload.user === 'string' ? payload.user.trim().toLowerCase() : '';
  const subscriptionUrl = typeof payload.subscriptionUrl === 'string' ? payload.subscriptionUrl.trim() : '';
  const vapidPublicKey = typeof payload.vapidPublicKey === 'string' ? payload.vapidPublicKey.trim() : '';
  if (!username || !subscriptionUrl || !vapidPublicKey) {
    return false;
  }

  try {
    await persistSubscriptionContext({
      username,
      subscriptionUrl,
      vapidPublicKey
    });
    let subscription = await self.registration.pushManager.getSubscription();
    const forceResubscribe = Boolean(payload.forceResubscribe);
    const needsResubscribe = forceResubscribe || !subscription || !hasValidSubscriptionKeys(subscription);
    if (needsResubscribe && subscription) {
      try {
        await subscription.unsubscribe();
      } catch (err) {
        console.warn('[SW] Failed to unsubscribe existing push subscription:', err);
      }
      subscription = null;
    }

    if (!subscription) {
      subscription = await self.registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapidPublicKey)
      });
    }
    if (!subscription) {
      return false;
    }

    const deviceType = detectWorkerDeviceType();
    const registerPayload = {
      username,
      subscription,
      action: 'reactivate_silent',
      reason: 'subscription-auth-refresh',
      deviceType
    };
    if (deviceType === 'PC') {
      registerPayload.subscriptionPC = subscription;
    } else {
      registerPayload.subscriptionMobile = subscription;
    }

    await Promise.allSettled([
      fetchWithRetry(subscriptionUrl, {
        method: 'POST',
        mode: 'no-cors',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(registerPayload)
      }, { timeoutMs: 15000, retries: 2, backoffMs: 700 }),
      postRegistrationPayloadToNotifyBackend(registerPayload)
    ]);
    return true;
  } catch (err) {
    console.warn('[SW] Failed to refresh subscription auth in background:', err);
    return false;
  }
}

function shouldShowNotification(payload) {
  const body = normalizeBody(payload);
  const title = typeof payload.title === 'string' ? payload.title : '';
  const type = typeof payload.type === 'string' ? payload.type : '';
  const skipNotification = Boolean(payload && payload.skipNotification);

  if (skipNotification) {
    return false;
  }

  // Keep these events silent; app updates from message bus/polling.
  if (
    type === 'read-receipt' ||
    type === 'group-update' ||
    type === 'delete-action' ||
    type === 'edit-action' ||
    type === AUTH_REFRESH_PUSH_TYPE
  ) {
    return false;
  }

  return Boolean(title || body || payload.image);
}

function buildIconUrl(payload) {
  if (typeof payload.icon === 'string' && payload.icon) {
    return payload.icon;
  }
  if (typeof payload.badge === 'string' && payload.badge) {
    return payload.badge;
  }
  return new URL('icons/icon-192x192.png', self.registration.scope).toString();
}

function normalizeTargetUrl(rawUrl) {
  try {
    const target = new URL(rawUrl, self.registration.scope);
    /*if (target.origin === self.location.origin && target.pathname.startsWith('/subscribes/')) {
      target.pathname = target.pathname.replace('/subscribes/', '/subscribesin/');
    }*/
    return target.toString();
  } catch (_) {
    return new URL('./', self.registration.scope).toString();
  }
}

function buildAppScopedOpenUrl(rawUrl) {
  try {
    const scopeUrl = new URL(self.registration.scope);
    const targetUrl = new URL(rawUrl, scopeUrl);
    const scopePath = scopeUrl.pathname.endsWith('/') ? scopeUrl.pathname : `${scopeUrl.pathname}/`;

    if (targetUrl.origin !== scopeUrl.origin) {
      return scopePath;
    }

    if (!targetUrl.pathname.startsWith(scopePath) && targetUrl.pathname !== scopeUrl.pathname) {
      return scopePath;
    }

    return `${targetUrl.pathname}${targetUrl.search}${targetUrl.hash}`;
  } catch (_) {
    return new URL('./', self.registration.scope).pathname;
  }
}

function pruneClientContextMap(windowClients) {
  const now = Date.now();
  const activeIds = new Set(windowClients.map((client) => client.id));
  for (const [clientId, context] of clientContextById.entries()) {
    if (!activeIds.has(clientId) || now - Number(context?.at || 0) > CLIENT_CONTEXT_TTL_MS) {
      clientContextById.delete(clientId);
    }
  }
}

function isStandaloneClient(client) {
  const context = clientContextById.get(client.id);
  return Boolean(context && context.standalone);
}

function pickPreferredClient(windowClients, target) {
  const sameOrigin = windowClients.filter((client) => {
    try {
      return new URL(client.url).origin === target.origin;
    } catch (_) {
      return false;
    }
  });
  if (!sameOrigin.length) {
    return null;
  }

  const standaloneMatch = sameOrigin.find((client) => isStandaloneClient(client));
  if (standaloneMatch) {
    return standaloneMatch;
  }

  return null;
}

function hasVisibleWindowClient(windowClients) {
  return Array.isArray(windowClients) && windowClients.some((client) => {
    if (!client) return false;
    if (client.focused === true) return true;
    if (client.visibilityState === 'visible') return true;
    return false;
  });
}

function broadcastPushPayload(payload) {
  return clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
    windowClients.forEach((client) => {
      client.postMessage({ action: 'push-payload', payload });
    });
  });
}

function showDedupedNotification(title, options = {}) {
  const tag = typeof options.tag === 'string' ? options.tag.trim() : '';
  const closeDuplicatesTask = tag
    ? self.registration.getNotifications({ tag })
      .then((items) => {
        items.forEach((item) => item.close());
      })
      .catch(() => undefined)
    : Promise.resolve();
  return closeDuplicatesTask.then(() => self.registration.showNotification(title, options));
}

self.addEventListener('push', (event) => {
  const payload = parsePushPayload(event);
  const receivedAt = Date.now();
  const payloadWithReceivedAt = {
    ...payload,
    receivedAt
  };
  const icon = buildIconUrl(payloadWithReceivedAt);
  const badgeCount = parseBadgeCount(payloadWithReceivedAt);
  const title = typeof payloadWithReceivedAt.title === 'string' && payloadWithReceivedAt.title ? payloadWithReceivedAt.title : FALLBACK_TITLE;
  const body = normalizeBody(payloadWithReceivedAt) || FALLBACK_BODY;
  const url = normalizeTargetUrl(
    typeof payloadWithReceivedAt.url === 'string' && payloadWithReceivedAt.url
      ? payloadWithReceivedAt.url
      : new URL('./', self.registration.scope).toString()
  );

  void persistSubscriptionContext({
    username: payloadWithReceivedAt.user || payloadWithReceivedAt.username || '',
    subscriptionUrl: payloadWithReceivedAt.subscriptionUrl || '',
    vapidPublicKey: payloadWithReceivedAt.vapidPublicKey || ''
  });

  const tasks = [broadcastPushPayload(payloadWithReceivedAt)];
  if (String(payloadWithReceivedAt.type || '').toLowerCase() === AUTH_REFRESH_PUSH_TYPE) {
    tasks.push(refreshSubscriptionAuthInBackground(payloadWithReceivedAt));
  }
  if (badgeCount !== null) {
    tasks.push(setHomeScreenBadgeCount(badgeCount));
  }
  tasks.push((async () => {
    if (!shouldShowNotification(payloadWithReceivedAt)) {
      // Still enqueue for offline recovery even if notification is silent.
      await enqueuePendingPushPayload(payloadWithReceivedAt);
      return;
    }
    const windowClients = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (hasVisibleWindowClient(windowClients)) {
      // App is open and visible — the broadcast already delivered the payload.
      // Skip enqueue to avoid processing the same message twice on drain.
      return;
    }
    // App is not visible — enqueue for later drain and show notification.
    await enqueuePendingPushPayload(payloadWithReceivedAt);
    await showDedupedNotification(title, {
      body,
      icon,
      badge: icon,
      image: typeof payloadWithReceivedAt.image === 'string' ? payloadWithReceivedAt.image : undefined,
      requireInteraction: Boolean(payloadWithReceivedAt.requireInteraction),
      tag: String(payloadWithReceivedAt.messageId || '').trim() || undefined,
      data: {
        ...payloadWithReceivedAt,
        url
      }
    });
  })());

  event.waitUntil(Promise.all(tasks));
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (!isReplyMutationRequest(request)) {
    return;
  }

  event.respondWith((async () => {
    try {
      return await fetch(request.clone());
    } catch (_) {
      const queued = await enqueueOfflineReplyRequest(request);
      return new Response(
        JSON.stringify({
          status: queued ? 'queued-offline' : 'offline-failed'
        }),
        {
          status: queued ? 202 : 503,
          headers: { 'Content-Type': 'application/json' }
        }
      );
    }
  })());
});

self.addEventListener('sync', (event) => {
  if (!event || event.tag !== OFFLINE_REPLY_SYNC_TAG) {
    return;
  }
  event.waitUntil(
    flushOfflineReplyQueue().catch((err) => {
      console.error('[SW] Background sync flushOfflineReplyQueue failed:', err);
    })
  );
});

self.addEventListener('message', (event) => {
  const data = event.data && typeof event.data === 'object' ? event.data : null;
  if (!data) {
    return;
  }

  if (data.action === 'register-window-context') {
    const source = event.source;
    const sourceId = source && typeof source === 'object' && 'id' in source ? String(source.id || '') : '';
    if (sourceId) {
      clientContextById.set(sourceId, {
        standalone: Boolean(data.standalone),
        at: Date.now()
      });
    }
    const persistPromise = persistSubscriptionContext({
      username: data.username || data.user || '',
      subscriptionUrl: data.subscriptionUrl || '',
      vapidPublicKey: data.vapidPublicKey || ''
    });
    if (typeof event.waitUntil === 'function') {
      event.waitUntil(persistPromise);
    }
    return;
  }

  if (data.action === 'set-app-badge-count') {
    event.waitUntil(setHomeScreenBadgeCount(Number(data.count)));
    return;
  }

  if (data.action === 'clear-app-badge') {
    event.waitUntil(clearHomeScreenBadgeCount());
    return;
  }

  if (data.action === 'clear-device-attention') {
    event.waitUntil(
      Promise.all([
        clearHomeScreenBadgeCount(),
        clearVisibleNotifications()
      ])
    );
    return;
  }

  if (data.action === 'flush-offline-replies') {
    event.waitUntil(flushOfflineReplyQueue());
    return;
  }

  if (data.action === 'drain-pending-push-payloads') {
    const replyPort = event.ports && event.ports[0] ? event.ports[0] : null;
    const drainTask = drainPendingPushPayloadQueue()
      .then((payloads) => {
        if (replyPort && typeof replyPort.postMessage === 'function') {
          replyPort.postMessage({ ok: true, payloads });
        }
      })
      .catch(() => {
        if (replyPort && typeof replyPort.postMessage === 'function') {
          replyPort.postMessage({ ok: false, payloads: [] });
        }
      });
    if (typeof event.waitUntil === 'function') {
      event.waitUntil(drainTask);
    }
  }
});

self.addEventListener('pushsubscriptionchange', (event) => {
  const nextSubscription = event && event.newSubscription ? event.newSubscription : null;
  event.waitUntil(registerSubscriptionFromStoredContext(nextSubscription, 'pushsubscriptionchange'));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const notificationData = event.notification && event.notification.data ? event.notification.data : {};
  const targetUrl = normalizeTargetUrl(
    typeof notificationData.url === 'string' && notificationData.url
      ? notificationData.url
      : new URL('./', self.registration.scope).toString()
  );

  event.waitUntil((async () => {
    const windowClients = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    pruneClientContextMap(windowClients);
    const target = new URL(targetUrl, self.registration.scope);
    const appScopedOpenUrl = buildAppScopedOpenUrl(target.toString());
    const chatHint = String(
      target.searchParams.get('chat') ||
      notificationData.chat ||
      notificationData.groupId ||
      notificationData.sender ||
      ''
    ).trim();
    const clickMessage = {
      action: 'notification-clicked',
      url: target.toString(),
      chat: chatHint || null,
      payload: notificationData
    };

    const preferredClient = pickPreferredClient(windowClients, target);
    if (preferredClient) {
      preferredClient.postMessage(clickMessage);

      if (typeof preferredClient.navigate === 'function') {
        await preferredClient.navigate(target.toString());
      }
      return preferredClient.focus();
    }

    if (clients.openWindow) {
      const openedClient = await clients.openWindow(appScopedOpenUrl);
      if (openedClient) {
        try {
          openedClient.postMessage(clickMessage);
          if (typeof openedClient.focus === 'function') {
            await openedClient.focus();
          }
        } catch (err) {
          console.warn('[SW] Failed to post notification-click message to opened client:', err);
        }
      }

      // Cold starts can race with app/bootstrap. Retry delivery a few times.
      // Break early once a same-origin client acknowledges or becomes visible.
      const retryDelaysMs = [450, 1200, 2600];
      for (const delayMs of retryDelaysMs) {
        await sleep(delayMs);
        const retryClients = await clients.matchAll({ type: 'window', includeUncontrolled: true });
        const sameOriginClients = retryClients.filter((client) => {
          try {
            return new URL(client.url, self.registration.scope).origin === target.origin;
          } catch (_) {
            return false;
          }
        });
        if (!sameOriginClients.length) continue;
        sameOriginClients.forEach((client) => {
          try {
            client.postMessage(clickMessage);
          } catch (err) {
            console.warn('[SW] Failed to post retry notification-click message to client:', err);
          }
        });
        // Stop retrying if any client is now visible/focused — it has received the message.
        if (sameOriginClients.some((client) => client?.focused || client?.visibilityState === 'visible')) {
          break;
        }
      }
      return openedClient;
    }

    return undefined;
  })());
});
