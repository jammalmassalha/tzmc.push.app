/* global importScripts, self, clients */

importScripts('./ngsw-worker.js');

const FALLBACK_TITLE = 'TZMC';
const FALLBACK_BODY = 'התקבלה הודעה חדשה';

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

function normalizeBody(payload) {
  if (typeof payload.body === 'string') {
    return payload.body;
  }
  if (payload.body && typeof payload.body === 'object') {
    return payload.body.shortText || payload.body.longText || '';
  }
  return '';
}

function shouldShowNotification(payload) {
  const body = normalizeBody(payload);
  const title = typeof payload.title === 'string' ? payload.title : '';
  const type = typeof payload.type === 'string' ? payload.type : '';

  // Keep these events silent; app updates from message bus/polling.
  if (type === 'read-receipt' || type === 'group-update' || type === 'reaction') {
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

  const tasks = [broadcastPushPayload(payload)];
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

  if (data.action === 'set-app-badge-count') {
    event.waitUntil(setHomeScreenBadgeCount(Number(data.count)));
    return;
  }

  if (data.action === 'clear-app-badge') {
    event.waitUntil(clearHomeScreenBadgeCount());
  }
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const notificationData = event.notification && event.notification.data ? event.notification.data : {};
  const targetUrl = normalizeTargetUrl(
    typeof notificationData.url === 'string' && notificationData.url
      ? notificationData.url
      : new URL('./', self.registration.scope).toString()
  );

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      const target = new URL(targetUrl, self.registration.scope);

      for (const client of windowClients) {
        if ('focus' in client) {
          try {
            const clientUrl = new URL(client.url);
            if (clientUrl.origin === target.origin) {
              client.postMessage({ action: 'navigate-route', url: target.toString() });
              return client.focus();
            }
          } catch (_) {
            // Ignore malformed client URL and continue.
          }
        }
      }

      if (clients.openWindow) {
        return clients.openWindow(target.toString());
      }

      return undefined;
    })
  );
});
