// sw.js - FIXED BADGE VERSION

// --- 1. CONFIGURATION ---
const DB_NAME = 'PushNotificationsDB';
const STORE_NAME = 'history';
const DB_VERSION = 2;



const ASSETS_TO_CACHE = [
  './assets/icon-192.png'
];



function openDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onerror = (event) => reject('DB Error: ' + event.target.error);
    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id', autoIncrement: true });
      }
    };
    request.onsuccess = (event) => resolve(event.target.result);
  });
}

async function saveNotificationExplicit(record) {
  try {
    const db = await openDB();
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    store.add(record);
    return tx.complete;
  } catch (err) {
    console.error('[SW] Failed to save notification:', err);
  }
}

function saveReplyToHistory(originalTimestamp, replyText) {
  return new Promise((resolve, reject) => {
    openDB().then(db => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        const request = store.openCursor();

        request.onsuccess = (event) => {
            const cursor = event.target.result;
            if (cursor) {
                if (Math.abs(Number(cursor.value.timestamp) - Number(originalTimestamp)) < 100) {
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

// --- 3. LIFECYCLE ---
console.log('Service Worker: Loaded (Badge Fix).');

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open('static-assets-v1')
      .then(cache => cache.addAll(ASSETS_TO_CACHE))
      .catch(err => console.warn("[SW] Cache warning:", err))
  );
  self.skipWaiting();
});

self.addEventListener('activate', event => event.waitUntil(clients.claim()));

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
      const deletePromise = new Promise((resolve, reject) => {
          openDB().then(db => {
              const tx = db.transaction(STORE_NAME, 'readwrite');
              const store = tx.objectStore(STORE_NAME);
              const request = store.getAll();
              request.onsuccess = () => {
                  const records = request.result;
                  const msg = records.find(r => r.timestamp == targetTimestamp);
                  if (msg) {
                      msg.body = "🚫 This message was deleted";
                      msg.image = null; 
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
        badgeCount: badgeNum
    },
    actions: [
      { action: 'reply-action', title: 'Reply', type: 'text', placeholder: 'Type reply...' },
      { action: 'open-action', title: 'Open App' }
    ]
  };

  const recordToSave = { 
      title, body, url, image: imageUrl, 
      user: user, sender: payload.sender, 
      timestamp: sharedTimestamp, 
      dateString: new Date(sharedTimestamp).toLocaleString() 
  };

  // 🔥 PARALLEL EXECUTION ---
  const notificationPromise = self.registration.showNotification(title, options);
  const savePromise = saveNotificationExplicit(recordToSave);

     event.waitUntil(
        Promise.all([
            badgePromise,
            notificationPromise,
            savePromise,
            logPromise
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
      const replyText = event.reply;
      const logReplyPromise = Promise.resolve();;
      const localDbPromise = saveReplyToHistory(data.timestamp, replyText);
      
      const serverPromise = fetch('https://www.tzmc.co.il/notify/reply', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
              user: user,         
              reply: replyText,               
              originalSender: data.sender,
              senderName: data.senderName 
          })
      }).catch(err => console.error('[SW] Reply failed:', err));

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
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});