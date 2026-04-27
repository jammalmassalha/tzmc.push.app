'use strict';

const statusEl = document.getElementById('status');
const btnSubscribe = document.getElementById('btn-subscribe');
const btnUnsubscribe = document.getElementById('btn-unsubscribe');
const btnNotify = document.getElementById('btn-notify');

function setStatus(message, type = 'info') {
  statusEl.textContent = message;
  statusEl.className = 'status' + (type !== 'info' ? ' ' + type : '');
}

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  return Uint8Array.from([...rawData].map((c) => c.charCodeAt(0)));
}

async function getVapidPublicKey() {
  const res = await fetch('/vapid-public-key');
  const { publicKey } = await res.json();
  return publicKey;
}

async function init() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    setStatus('Push notifications are not supported in this browser.', 'error');
    return;
  }

  const registration = await navigator.serviceWorker.register('/service-worker.js');
  const existingSubscription = await registration.pushManager.getSubscription();

  if (existingSubscription) {
    setStatus('You are subscribed to push notifications.', 'success');
    btnSubscribe.disabled = true;
    btnUnsubscribe.disabled = false;
  } else {
    setStatus('You are not subscribed. Click Subscribe to enable notifications.');
    btnSubscribe.disabled = false;
    btnUnsubscribe.disabled = true;
  }

  btnSubscribe.addEventListener('click', async () => {
    try {
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        setStatus('Notification permission denied.', 'error');
        return;
      }

      const publicKey = await getVapidPublicKey();
      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey),
      });

      await fetch('/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(subscription),
      });

      setStatus('Successfully subscribed to push notifications!', 'success');
      btnSubscribe.disabled = true;
      btnUnsubscribe.disabled = false;
    } catch (err) {
      setStatus('Subscription failed: ' + err.message, 'error');
    }
  });

  btnUnsubscribe.addEventListener('click', async () => {
    try {
      const subscription = await registration.pushManager.getSubscription();
      if (!subscription) {
        setStatus('No active subscription found.');
        return;
      }

      await fetch('/unsubscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ endpoint: subscription.endpoint }),
      });

      await subscription.unsubscribe();

      setStatus('You have unsubscribed from push notifications.');
      btnSubscribe.disabled = false;
      btnUnsubscribe.disabled = true;
    } catch (err) {
      setStatus('Unsubscribe failed: ' + err.message, 'error');
    }
  });

  btnNotify.addEventListener('click', async () => {
    const title = document.getElementById('notif-title').value.trim();
    const body = document.getElementById('notif-body').value.trim();
    const url = document.getElementById('notif-url').value.trim();

    if (!title || !body) {
      setStatus('Title and message are required.', 'error');
      return;
    }

    try {
      const res = await fetch('/notify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, body, url: url || undefined }),
      });

      const data = await res.json();
      if (res.ok) {
        setStatus(data.message, 'success');
      } else {
        setStatus('Error: ' + data.error, 'error');
      }
    } catch (err) {
      setStatus('Failed to send notification: ' + err.message, 'error');
    }
  });
}

init();
