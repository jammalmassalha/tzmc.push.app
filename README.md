# tzmc.push.app

A lightweight **web push notification** application built with Node.js, Express, and the [Web Push](https://www.npmjs.com/package/web-push) library (VAPID protocol).

## Features

- Subscribe / unsubscribe browsers to push notifications
- Send notifications to all active subscribers from the web UI
- Service worker handles incoming push events and notification clicks

## Getting Started

### 1. Install dependencies

```bash
npm install
```

### 2. Generate VAPID keys

VAPID (Voluntary Application Server Identification) keys are required to send push notifications. Run the helper script once and save the output:

```bash
npm run generate-keys
```

### 3. Configure environment variables

Create a `.env` file in the project root (it is git-ignored):

```env
VAPID_PUBLIC_KEY=<your-public-key>
VAPID_PRIVATE_KEY=<your-private-key>
VAPID_SUBJECT=mailto:you@example.com
PORT=3000
```

### 4. Start the server

```bash
npm start
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

## Project Structure

```
.
├── public/
│   ├── index.html        # Frontend UI
│   ├── app.js            # Client-side subscription logic
│   └── service-worker.js # Handles incoming push events
├── scripts/
│   └── generate-vapid-keys.js
├── server.js             # Express API server
├── package.json
└── .env                  # (not committed) VAPID keys & config
```

## API Endpoints

| Method | Path               | Description                          |
|--------|--------------------|--------------------------------------|
| GET    | `/vapid-public-key`| Returns the VAPID public key         |
| POST   | `/subscribe`       | Save a new push subscription         |
| POST   | `/unsubscribe`     | Remove an existing subscription      |
| POST   | `/notify`          | Send a push notification to all subs |

### `POST /notify` body

```json
{
  "title": "Hello!",
  "body": "This is a push notification.",
  "url": "https://example.com"
}
```

## Notes

- Subscriptions are stored **in memory** by default. For production use, replace the in-memory array in `server.js` with a persistent database.
- Push notifications require HTTPS in production. Use a reverse proxy (e.g., nginx) or a service like [ngrok](https://ngrok.com) for local HTTPS testing.

## License

MIT
