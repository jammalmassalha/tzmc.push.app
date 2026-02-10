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
  const title = typeof payload.title === 'string' && payload.title ? payload.title : FALLBACK_TITLE;
  const body = normalizeBody(payload) || FALLBACK_BODY;
  const url = normalizeTargetUrl(
    typeof payload.url === 'string' && payload.url ? payload.url : new URL('./', self.registration.scope).toString()
  );

  const tasks = [broadcastPushPayload(payload)];
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
