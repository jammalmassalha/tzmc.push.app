// sw.js - FIXED BADGE VERSION
importScripts('./js/shared-config.js');

// --- 1. CONFIGURATION ---
const config = self.APP_CONFIG || {};
const DB_NAME = config.DB_NAME || 'PushNotificationsDB';
const STORE_NAME = config.STORE_NAME || 'history';
const OUTBOX_STORE = config.OUTBOX_STORE || 'outbox';
const DB_VERSION = config.DB_VERSION || 3;
const CACHE_NAME = config.CACHE_NAME || 'static-assets-v2';

const ASSETS_TO_CACHE = [
  './',
  './index.html',
  './offline.html',
  './css/style.css',
  './css/style.css?v=29.0',
  './js/shared-config.js',
  './js/shared-config.js?v=1.0',
  './js/i18n.js',
  './js/i18n.js?v=1.0',
  './js/network.js',
  './js/network.js?v=1.0',
  './js/app.js',
  './js/app.js?v=33.0',
  './js/bot.js',
  './js/bot.js?v=4.0',
  './manifest.webmanifest',
  './favicon.ico',
  './assets/icon-128.png',
  './assets/icon-192.png',
  './assets/icon.png'
];



function openDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onerror = (event) => reject('DB Error: ' + event.target.error);
    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      let store;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        store = db.createObjectStore(STORE_NAME, { keyPath: 'id', autoIncrement: true });
      } else {
        store = event.target.transaction.objectStore(STORE_NAME);
      }
      if (store && !store.indexNames.contains('messageId')) {
        store.createIndex('messageId', 'messageId', { unique: false });
      }
      if (!db.objectStoreNames.contains(OUTBOX_STORE)) {
        db.createObjectStore(OUTBOX_STORE, { keyPath: 'id', autoIncrement: true });
      }
    };
    request.onsuccess = (event) => resolve(event.target.result);
  });
}

function generateMessageId() {
  if (self.crypto && typeof self.crypto.randomUUID === 'function') {
    return self.crypto.randomUUID();
  }
  return `sw_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const fetchWithRetry = async (url, options = {}, retryOptions = {}) => {
  const {
    retries = 1,
    timeoutMs = 10000,
    backoffMs = 500
  } = retryOptions;

  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = self.AbortController ? new AbortController() : null;
    const timeoutId = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
    try {
      const response = await fetch(url, {
        ...options,
        signal: controller ? controller.signal : undefined
      });
      if (!response.ok && attempt < retries && (response.status >= 500 || response.status === 429)) {
        await sleep(backoffMs * Math.pow(2, attempt));
        continue;
      }
      return response;
    } catch (err) {
      lastError = err;
      if (attempt < retries) {
        await sleep(backoffMs * Math.pow(2, attempt));
        continue;
      }
      throw err;
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }
  }
  throw lastError;
};

async function saveNotificationExplicit(record) {
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      store.add(record);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (err) {
    console.error('[SW] Failed to save notification:', err);
  }
}

function saveReplyToHistory(originalTimestamp, replyText, messageId = null) {
  return new Promise((resolve, reject) => {
    openDB().then(db => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        const request = store.openCursor();

        request.onsuccess = (event) => {
            const cursor = event.target.result;
            if (cursor) {
                const matchesMessage = messageId ? cursor.value.messageId === messageId : Math.abs(Number(cursor.value.timestamp) - Number(originalTimestamp)) < 100;
                if (matchesMessage) {
                    const updateData = cursor.value;
                    updateData.reply = replyText; 
                    updateData.repliedAt = new Date().toISOString(); 
                    cursor.update(updateData);
                    resolve(); 
                } else {
                    cursor.continue(); 
                }
            } else {
                resolve();
            }
        };
        request.onerror = (e) => reject(e);
    });
  });
}

async function updateMessageStatus(messageId, status) {
  if (!messageId) return;
  const db = await openDB();
  return new Promise((resolve) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    let request;
    if (store.indexNames.contains('messageId')) {
      request = store.index('messageId').get(messageId);
    } else {
      request = store.get(messageId);
    }
    request.onsuccess = () => {
      const record = request.result;
      if (record) {
        record.deliveryStatus = status;
        store.put(record);
      }
      tx.oncomplete = () => resolve();
    };
    request.onerror = () => resolve();
  });
}

async function flushOutbox() {
  const db = await openDB();
  if (!db.objectStoreNames.contains(OUTBOX_STORE)) {
    return;
  }
  const tx = db.transaction(OUTBOX_STORE, 'readwrite');
  const store = tx.objectStore(OUTBOX_STORE);
  const records = await new Promise((resolve, reject) => {
    const request = store.getAll();
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
  });
  if (!records.length) return;
  for (const record of records) {
    try {
      const response = await fetchWithRetry(record.url, {
        method: 'POST',
        headers: record.headers || { 'Content-Type': 'application/json' },
        body: JSON.stringify(record.payload || {})
      }, { timeoutMs: 12000, retries: 2 });
      if (!response.ok) {
        throw new Error(`Send failed ${response.status}`);
      }
      store.delete(record.id);
      await updateMessageStatus(record.messageId, 'sent');
    } catch (err) {
      const attempts = (record.attempts || 0) + 1;
      record.attempts = attempts;
      store.put(record);
      await updateMessageStatus(record.messageId, attempts >= 3 ? 'failed' : 'queued');
    }
  }
  const clientsList = await self.clients.matchAll();
  clientsList.forEach(client => client.postMessage({ action: 'outbox-updated' }));
}

self.addEventListener('sync', event => {
  if (event.tag === 'outbox-sync') {
    event.waitUntil(flushOutbox());
  }
});

// --- 3. LIFECYCLE ---
console.log('Service Worker: Loaded (Badge Fix).');

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(ASSETS_TO_CACHE))
      .catch(err => console.warn("[SW] Cache warning:", err))
  );
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key)));
    await clients.claim();
  })());
});

async function cacheFirst(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response && response.ok) {
    cache.put(request, response.clone());
  }
  return response;
}

async function networkFirst(request) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const response = await fetch(request);
    if (response && response.ok) {
      cache.put(request, response.clone());
    }
    return response;
  } catch (e) {
    const cached = await cache.match(request);
    return cached || cache.match('./offline.html');
  }
}

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (event.request.mode === 'navigate') {
    event.respondWith(networkFirst(event.request));
    return;
  }
  if (url.origin === self.location.origin) {
    event.respondWith(cacheFirst(event.request));
  }
});

// --- 4. PUSH LISTENER ---
self.addEventListener('push', event => {
  console.log('[Service Worker] Push Received.');
  
  let rawData = {};
  try {
    if (event.data) rawData = event.data.json();
  } catch (e) {
    rawData = { data: { title: 'Message', body: event.data ? event.data.text() : '' } };
  }

  // Normalize Payload
  const payload = rawData.data || rawData; 
  const user = payload.user || rawData.notification?.username || 'Unknown';
  const messageId = payload.messageId || payload.message_id || payload.id || generateMessageId();

  // --- 🔥 FIX 1: SET BADGE IMMEDIATELY 🔥 ---
  // We do this first to ensure iOS catches it
  const badgeNum = parseInt(payload.badgeCount || payload.badge, 10);
    let badgePromise = Promise.resolve();
    
    if (!isNaN(badgeNum) && self.registration.setBadge) {
        badgePromise = (async () => {
            await self.registration.setBadge(badgeNum);
            if (self.registration.sync) {
                await self.registration.sync.register('badge-sync');
            }
        })();
    }
  // ------------------------------------------

  // Start Logging
  const logPromise = Promise.resolve();

  // Handle Delete
  if (payload.type === 'delete-action') {
      const targetTimestamp = payload.timestamp;
      const targetMessageId = payload.messageId || payload.message_id || null;
      const deletePromise = new Promise((resolve, reject) => {
          openDB().then(db => {
              const tx = db.transaction(STORE_NAME, 'readwrite');
              const store = tx.objectStore(STORE_NAME);
              const request = store.getAll();
              request.onsuccess = () => {
                  const records = request.result;
                  const msg = records.find(r => targetMessageId ? r.messageId === targetMessageId : r.timestamp == targetTimestamp);
                  if (msg) {
                      msg.body = "🚫 הודעה זו נמחקה";
                      msg.image = null; 
                      msg.thumbnail = null;
                      store.put(msg);
                      self.clients.matchAll().then(clients => {
                          clients.forEach(client => client.postMessage({ action: 'refresh' }));
                          resolve(); 
                      });
                  } else { resolve(); }
              };
              request.onerror = (e) => reject(e);
          }).catch(reject);
      });
      event.waitUntil(Promise.all([deletePromise, logPromise]));
      return; 
  }

  // Notification Options
  const title = payload.title || 'New Notification';
  const body = payload.body || 'You have a new message.';
  const url = payload.url || '/';
  const imageUrl = payload.image || null;
  const sharedTimestamp = Date.now(); 

  const visualIcon = payload.icon || 'https://www.tzmc.co.il/subscribes/assets/icon-192.png';
  const visualBadge = (typeof payload.badgeIcon === 'string') ? payload.badgeIcon : 'https://www.tzmc.co.il/subscribes/assets/icon-192.png';

  const options = {
    body: body,
    icon: visualIcon,
    badge: visualBadge, 
    image: imageUrl, 
    data: { 
        url: url,
        user: user, 
        sender: payload.sender, 
        senderName: payload.sender, 
        image: imageUrl, 
        timestamp: sharedTimestamp,
        badgeCount: badgeNum,
        messageId: messageId
    },
    actions: [
      { action: 'reply-action', title: 'Reply', type: 'text', placeholder: 'Type reply...' },
      { action: 'open-action', title: 'Open App' }
    ]
  };

  const recordToSave = { 
      messageId,
      title, body, url, image: imageUrl, 
      user: user, sender: payload.sender, 
      timestamp: sharedTimestamp, 
      dateString: new Date(sharedTimestamp).toLocaleString() 
  };

  // 🔥 PARALLEL EXECUTION ---
  const notificationPromise = self.registration.showNotification(title, options);
  const savePromise = saveNotificationExplicit(recordToSave);
  const refreshPromise = savePromise.then(() =>
      self.clients.matchAll().then(clients => {
          clients.forEach(client => client.postMessage({ action: 'refresh' }));
      })
  );

     event.waitUntil(
        Promise.all([
            badgePromise,
            notificationPromise,
            savePromise,
            logPromise,
            refreshPromise
        ])
    );
});

// --- 5. CLICK LISTENER ---
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const data = event.notification.data || {};
  const urlToOpen = data.url || 'https://www.tzmc.co.il/subscribes/';
  const user = data.user || 'Unknown';

  // Clear Badge on Click (Optional - good for UX)
     if (self.registration.clearBadge) {
        event.waitUntil(
            self.registration.clearBadge().catch(() => {})
        );
    }

  if (event.action === 'reply-action') {
      const replyText = typeof event.reply === 'string' ? event.reply : '';
      const logReplyPromise = Promise.resolve();;
      if (!replyText) {
          event.waitUntil(clients.openWindow(urlToOpen));
          return;
      }
      const localDbPromise = saveReplyToHistory(data.timestamp, replyText, data.messageId);
      
      const serverPromise = fetchWithRetry('https://www.tzmc.co.il/notify/reply', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
              user: user,         
              reply: replyText,               
              originalSender: data.sender,
              senderName: data.senderName 
          })
      }, { timeoutMs: 10000, retries: 1 }).catch(err => console.error('[SW] Reply failed:', err));

      const updateNotifPromise = Promise.all([localDbPromise, serverPromise]).then(() => {
          return self.registration.showNotification("Reply Sent ✓", {
              body: `You: "${replyText}"`, 
              icon: 'https://www.tzmc.co.il/subscribes/assets/icon-192.png',
              data: data, 
              tag: 'reply-confirmation' 
          });
      });
      event.waitUntil(Promise.all([logReplyPromise, updateNotifPromise]));
      return; 
  }

  const logClickPromise = Promise.resolve();;
  const openAppPromise = clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientList => {
      for (const client of clientList) {
          if (client.url.indexOf('tzmc.co.il/subscribes') > -1 && 'focus' in client) {
              return client.focus().then(focusedClient => {
                  if (focusedClient) focusedClient.postMessage({ action: 'navigate-route', url: urlToOpen });
              });
          }
      }
      if (clients.openWindow) return clients.openWindow(urlToOpen);
  });

  event.waitUntil(Promise.all([logClickPromise, openAppPromise]));
});

self.addEventListener('message', (event) => {
  if (!event.data) return;
  if (event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
  if (event.data.action === 'flush-outbox') {
    event.waitUntil(flushOutbox());
  }
});