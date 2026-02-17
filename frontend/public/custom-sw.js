/* global importScripts, self, clients */

importScripts('./ngsw-worker.js');

const FALLBACK_TITLE = 'TZMC';
const FALLBACK_BODY = 'התקבלה הודעה חדשה';
const CLIENT_CONTEXT_TTL_MS = 10 * 60 * 1000;
const AUTH_REFRESH_PUSH_TYPE = 'subscription-auth-refresh';
const SW_SUBSCRIPTION_CONTEXT_CACHE = 'tzmc-sw-subscription-context-v6';
const SW_SUBSCRIPTION_CONTEXT_KEY = new URL('./__subscription_context__', self.registration.scope).toString();
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

function parsePushPayload(event) {
  if (!event.data) return {};

  try {
    const raw = event.data.json();
    if (raw && typeof raw === 'object') {
      if (raw.data && typeof raw.data === 'object') {
        return raw.data;
      }
      if (raw.notification && typeof raw.notification === 'object') {
        return raw.notification;
      }
      return raw;
    }
  } catch (_) {
    // Fallback to text payload below.
  }

  try {
    return { body: event.data.text() };
  } catch (_) {
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
  } catch (_) {
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
  } catch (_) {
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

    await fetchWithRetry(subscriptionUrl, {
      method: 'POST',
      mode: 'no-cors',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(registerPayload)
    }, { timeoutMs: 15000, retries: 2, backoffMs: 700 });

    await persistSubscriptionContext({
      username,
      subscriptionUrl,
      vapidPublicKey
    });
    return true;
  } catch (_) {
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
      } catch (_) {
        // Continue with fresh subscribe attempt.
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

    await fetchWithRetry(subscriptionUrl, {
      method: 'POST',
      mode: 'no-cors',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(registerPayload)
    }, { timeoutMs: 15000, retries: 2, backoffMs: 700 });
    return true;
  } catch (_) {
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

function broadcastPushPayload(payload) {
  return clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
    windowClients.forEach((client) => {
      client.postMessage({ action: 'push-payload', payload });
    });
  });
}

self.addEventListener('push', (event) => {
  const payload = parsePushPayload(event);
  const icon = buildIconUrl(payload);
  const badgeCount = parseBadgeCount(payload);
  const title = typeof payload.title === 'string' && payload.title ? payload.title : FALLBACK_TITLE;
  const body = normalizeBody(payload) || FALLBACK_BODY;
  const url = normalizeTargetUrl(
    typeof payload.url === 'string' && payload.url ? payload.url : new URL('./', self.registration.scope).toString()
  );

  void persistSubscriptionContext({
    username: payload.user || payload.username || '',
    subscriptionUrl: payload.subscriptionUrl || '',
    vapidPublicKey: payload.vapidPublicKey || ''
  });

  const tasks = [broadcastPushPayload(payload)];
  if (String(payload.type || '').toLowerCase() === AUTH_REFRESH_PUSH_TYPE) {
    tasks.push(refreshSubscriptionAuthInBackground(payload));
  }
  if (badgeCount !== null) {
    tasks.push(setHomeScreenBadgeCount(badgeCount));
  }
  if (shouldShowNotification(payload)) {
    tasks.push(
      self.registration.showNotification(title, {
        body,
        icon,
        badge: icon,
        image: typeof payload.image === 'string' ? payload.image : undefined,
        requireInteraction: Boolean(payload.requireInteraction),
        data: {
          ...payload,
          url
        }
      })
    );
  }

  event.waitUntil(Promise.all(tasks));
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

    const preferredClient = pickPreferredClient(windowClients, target);
    if (preferredClient) {
      preferredClient.postMessage({
        action: 'notification-clicked',
        url: target.toString(),
        chat: chatHint || null,
        payload: notificationData
      });

      if (typeof preferredClient.navigate === 'function') {
        await preferredClient.navigate(target.toString());
      }
      return preferredClient.focus();
    }

    if (clients.openWindow) {
      return clients.openWindow(appScopedOpenUrl);
    }

    return undefined;
  })());
});
