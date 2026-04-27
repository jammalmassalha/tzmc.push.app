require('dotenv').config();
const express = require('express');
const webpush = require('web-push');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// VAPID keys must be set in environment variables or .env file.
// Run `npm run generate-keys` to generate a new key pair.
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:admin@example.com';

if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
  console.error(
    'ERROR: VAPID keys are not set.\n' +
      'Run `npm run generate-keys` to generate keys, then set them in your .env file.'
  );
  process.exit(1);
}

webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname, 'public')));

// In-memory subscription store (replace with a database in production)
const subscriptions = [];

// Expose VAPID public key to the client
app.get('/vapid-public-key', (req, res) => {
  res.json({ publicKey: VAPID_PUBLIC_KEY });
});

// Store a new push subscription
app.post('/subscribe', (req, res) => {
  const subscription = req.body;

  if (!subscription || !subscription.endpoint) {
    return res.status(400).json({ error: 'Invalid subscription object' });
  }

  const alreadySubscribed = subscriptions.some(
    (s) => s.endpoint === subscription.endpoint
  );

  if (!alreadySubscribed) {
    subscriptions.push(subscription);
  }

  res.status(201).json({ message: 'Subscription saved' });
});

// Remove a push subscription
app.post('/unsubscribe', (req, res) => {
  const { endpoint } = req.body;

  if (!endpoint) {
    return res.status(400).json({ error: 'Endpoint is required' });
  }

  const index = subscriptions.findIndex((s) => s.endpoint === endpoint);
  if (index !== -1) {
    subscriptions.splice(index, 1);
  }

  res.json({ message: 'Unsubscribed successfully' });
});

// Send a push notification to all subscribers
app.post('/notify', (req, res) => {
  const { title, body, icon, url } = req.body;

  if (!title || !body) {
    return res.status(400).json({ error: 'title and body are required' });
  }

  const payload = JSON.stringify({ title, body, icon, url });

  const notifications = subscriptions.map((subscription) =>
    webpush
      .sendNotification(subscription, payload)
      .catch((err) => {
        console.error('Failed to send notification to', subscription.endpoint, err.statusCode);
        // Remove subscriptions that are no longer valid (410 Gone, 404 Not Found)
        if (err.statusCode === 410 || err.statusCode === 404) {
          const idx = subscriptions.indexOf(subscription);
          if (idx !== -1) {
            subscriptions.splice(idx, 1);
          }
        }
      })
  );

  Promise.allSettled(notifications).then(() => {
    res.json({ message: `Notification sent to ${subscriptions.length} subscriber(s)` });
  });
});

app.listen(PORT, () => {
  console.log(`Push notification server running on http://localhost:${PORT}`);
});
