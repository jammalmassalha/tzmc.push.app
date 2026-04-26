// Firebase Cloud Messaging service worker for the Flutter web build.
//
// Required for FCM web to deliver notifications when the page is in the
// background. Must be served from the same scope as the app, with the
// exact filename `firebase-messaging-sw.js` (the FCM SDK looks it up by
// name unless you override it with `getToken({ serviceWorkerRegistration })`).
//
// We use the `compat` JS SDK so this file works without a bundler.
// Versions intentionally match the ones loaded in `index.html`.
importScripts('https://www.gstatic.com/firebasejs/10.13.2/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.13.2/firebase-messaging-compat.js');

// Public client config — same values as
// `lib/firebase_options.dart#DefaultFirebaseOptions.web`. These are NOT
// secrets (Google explicitly designs them to ship inside clients).
firebase.initializeApp({
  apiKey: 'AIzaSyByLOP_-v5oK-iiSEJ8ydXRpRko22-tRro',
  authDomain: 'tzmc-notifications.firebaseapp.com',
  projectId: 'tzmc-notifications',
  storageBucket: 'tzmc-notifications.firebasestorage.app',
  messagingSenderId: '917008922776',
  appId: '1:917008922776:web:f02334911e7180bcf0f8ed',
  measurementId: 'G-8FLBFBWH6Y',
});

const messaging = firebase.messaging();

// Background message handler. The browser auto-displays notifications
// for messages with a top-level `notification` block, so for those we
// do nothing extra. For data-only messages we still want to surface
// something to the user.
messaging.onBackgroundMessage((payload) => {
  // eslint-disable-next-line no-console
  console.log('[firebase-messaging-sw.js] Background message:', payload);

  if (payload.notification) {
    // The browser will display this automatically; nothing to do.
    return;
  }

  const data = payload.data || {};
  const title = data.title || 'הודעה חדשה';
  const options = {
    body: data.body || data.messageText || '',
    icon: '/icons/Icon-192.png',
    badge: '/icons/Icon-192.png',
    data,
    tag: data.chatId || data.groupId || 'tzmc-push',
  };
  self.registration.showNotification(title, options);
});

// Open / focus the app when the user taps a notification.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients
      .matchAll({ type: 'window', includeUncontrolled: true })
      .then((clientList) => {
        for (const client of clientList) {
          if ('focus' in client) {
            return client.focus();
          }
        }
        if (self.clients.openWindow) {
          return self.clients.openWindow('/');
        }
        return undefined;
      }),
  );
});
