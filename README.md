# TZMC Push App

Real-time push notification and messaging platform for the TZMC community. Built with a Node.js/Express backend, Angular 21 frontend, MySQL for persistence, and Redis for message queuing.

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│  Frontend (Angular 21 PWA)                              │
│  • Signal-based state management (ChatStoreService)     │
│  • Realtime: WebSocket → SSE → Polling fallback         │
│  • IndexedDB persistence (Dexie.js)                     │
│  • Angular Material + Tailwind CSS                      │
└────────────────────┬────────────────────────────────────┘
                     │  HTTP / WebSocket / SSE
┌────────────────────▼────────────────────────────────────┐
│  Backend (Node.js + Express)                            │
│  server.js ── Controllers ── TypeScript Services        │
│  • Auth, Message, Shuttle, Helpdesk controllers         │
│  • Session (JWE tokens), Notification (web-push)        │
│  • Upload security (worker-thread scanning)             │
└────┬───────────────────────────────────┬────────────────┘
     │                                   │
┌────▼─────┐                      ┌──────▼──────┐
│  MySQL   │                      │   Redis     │
│  Logs,   │                      │  Message    │
│  State,  │                      │  queues,    │
│  Helpdesk│                      │  pub/sub    │
└──────────┘                      └─────────────┘
```

## Prerequisites

- **Node.js** 20+
- **MySQL** 8.0+
- **Redis** 7+ (optional – app degrades gracefully without it)

Or simply use **Docker** (see below).

## Quick Start

### 1. Clone and install

```bash
git clone https://github.com/jmassalha/tzmc.push.app.git
cd tzmc.push.app

# Root dependencies (backend runtime)
npm install

# Frontend dependencies
cd frontend && npm install && cd ..
```

### 2. Configure environment

```bash
cp backend/.env.example .env
# Edit .env and fill in all required values
```

See [Environment Variables](#environment-variables) for details.

### 3. Build

```bash
# Backend TypeScript services
npm run build:backend

# Frontend production build
cd frontend && npx ng build --configuration production && cd ..
```

### 4. Run

```bash
npm start
# Server runs on http://localhost:3000
```

## Docker (Recommended for Local Dev)

```bash
# Copy and edit your .env
cp backend/.env.example .env

# Start MySQL, Redis, and the app
docker compose up -d

# View logs
docker compose logs -f app
```

## Scripts

| Command | Description |
|---------|-------------|
| `npm start` | Start the backend server |
| `npm run build:backend` | Compile backend TypeScript to `backend/dist/` |
| `cd frontend && npm start` | Angular dev server at `localhost:4200` |
| `cd frontend && npx ng build` | Production frontend build |
| `cd frontend && npx ng test --watch=false` | Run frontend unit tests (vitest) |

## Environment Variables

Copy `backend/.env.example` to `.env` in the project root. Required variables:

| Variable | Description |
|----------|-------------|
| `GOOGLE_SHEET_URL` | Google Apps Script endpoint for contacts |
| `APP_SERVER_TOKEN` | Shared secret for server-to-server auth |
| `CHECK_QUEUE_SERVER_TOKEN` | Token for queue-check endpoint |
| `LOGS_DB_HOST` | MySQL host |
| `LOGS_DB_PORT` | MySQL port (default `3306`) |
| `LOGS_DB_USER` | MySQL user |
| `LOGS_DB_PASSWORD` | MySQL password |
| `LOGS_DB_NAME` | MySQL database name |
| `SESSION_SIGNING_SECRET` | Secret for session token signing |
| `SESSION_JWE_SECRET` | Secret for session token encryption |
| `VAPID_PUBLIC_KEY` | VAPID public key for web push |
| `VAPID_PRIVATE_KEY` | VAPID private key for web push |
| `INFORU_USERNAME` | InforU SMS gateway username (auth codes) |
| `INFORU_API_TOKEN` | InforU SMS gateway API token |

Optional variables: `REDIS_URL`, `LOGS_BACKUP_SHEET_URL`, `SHUTTLE_USER_ORDERS_URL`, `WEBHOOK_REGISTRY_JSON`.

`LOGS_DB_USER`, `LOGS_DB_PASSWORD` and `LOGS_DB_NAME` have **no defaults** — the
server throws a clear error at startup if they are missing, rather than silently
falling back to stale credentials.

## Deploying to AWS EC2

Example configuration files live in [`deploy/`](deploy/):

| File | Purpose |
|------|---------|
| `deploy/tzmc-push.service` | systemd unit (`/etc/systemd/system/tzmc-push.service`) |
| `deploy/nginx-tzmc-push.conf` | nginx site with TLS, WebSocket and SSE proxying |

### 1. Instance and packages

Ubuntu 22.04/24.04, `t3.small` minimum (`t3.medium` if you build the Angular and
Flutter web bundles on the box). Security group: inbound 22 (your IP only), 80
and 443 — **do not** expose 3306 or 3000. Install Node.js 20 LTS, MySQL 8.0,
nginx, certbot, and (recommended) Redis 7.

### 2. Database

Set `bind-address = 127.0.0.1` in `mysqld.cnf` and keep MySQL on localhost.
Create the schema as `utf8mb4` / `utf8mb4_unicode_ci` — the app stores Hebrew
text and emoji, and the wrong charset corrupts it silently. Grant the app user
`SELECT, INSERT, UPDATE, DELETE, CREATE, INDEX, ALTER, REFERENCES`: `CREATE` and
`ALTER` are required because the service creates and migrates its tables with
`CREATE TABLE IF NOT EXISTS` on boot.

Migrating from cPanel: export with
`mysqldump --single-transaction --routines --triggers --events --default-character-set=utf8mb4`
(the phpMyAdmin web export truncates on large tables), copy the dump over `scp`,
import, then compare row counts per table and spot-check Hebrew strings for
mojibake. Do **not** expose phpMyAdmin publicly — reach the database with
Workbench/DBeaver through an SSH tunnel (`ssh -L 3306:127.0.0.1:3306 ...`).

### 3. Application

Deploy to `/opt/tzmc-push` owned by a non-login `tzmc` user, with a `0600` `.env`
file. Beyond the table above, an EC2 deployment needs:

| Variable | Value | Why |
|----------|-------|-----|
| `PORT` | `3000` | Matches the nginx upstream |
| `LOGS_DB_HOST` | `127.0.0.1` | MySQL is local-only |
| `REDIS_URL` | `redis://127.0.0.1:6379` | Optional; app degrades gracefully |
| `TRUST_PROXY` | `1` | Required behind nginx so `req.ip` and per-user rate limits see the real client IP |
| `ALLOWED_HOSTS` | your domain(s) | The host guard defaults to `tzmc.co.il`, `www.tzmc.co.il`, `*.tzmc.co.il` and localhost — add the EC2 DNS name or a staging subdomain while testing, or requests are rejected |
| `SESSION_COOKIE_SECURE` | `true` | Once HTTPS is live |

When migrating an existing install, carry `VAPID_PUBLIC_KEY` /
`VAPID_PRIVATE_KEY` over **unchanged** — regenerating them invalidates every
stored web-push subscription in the `Subscribe` table.
`scripts/generate-vapid-keys.js` is for fresh installs only. Likewise, rotating
`SESSION_SIGNING_SECRET` / `SESSION_JWE_SECRET` logs every user out. Also copy
the `uploads/` directory and the Firebase service-account JSON across; never
commit `.env`, that JSON, or database dumps.

Build everything before starting the service — `server.js` serves pre-built
assets and will 404 without them:

```bash
npm ci && npm run build:backend                              # backend/dist/
cd frontend && npm ci && npx ng build --configuration production && cd ..   # frontend/dist/
cd flutter_app && ./build_all.sh && cd ..                    # dist/web/ (served at /fluttertest)
```

Verify in the foreground once, then hand over to systemd:

```bash
node server.js
curl 127.0.0.1:3000/notify/version
```

Run exactly **one** instance. `server.js` starts in-process schedulers (shuttle
reminders, auth refresh) that would double-fire if the process were clustered.

### 4. nginx

Proxy **all** paths to `http://127.0.0.1:3000` **without rewriting the path** —
every route is registered twice in `server.js`, at `/x` and at `/notify/x`, so
the app owns the `/notify` prefix itself. Socket.IO lives at
`/notify/socket.io` and needs `proxy_http_version 1.1` plus the
`Upgrade`/`Connection` headers and a long `proxy_read_timeout`; the SSE fallback
at `/notify/stream` needs `proxy_buffering off`. Keep nginx's
`keepalive_timeout` **below** the app's `HTTP_KEEP_ALIVE_TIMEOUT_MS` (default
65000ms) to avoid ECONNRESET races, and set `client_max_body_size` to match the
app's 350mb body limit. Finish with
`sudo certbot --nginx -d tzmc.co.il -d www.tzmc.co.il` — web push and service
workers require valid HTTPS.

### 5. Flutter app

The backend origin is configurable at build time and defaults to
`https://www.tzmc.co.il`. If you keep the same domain and only repoint DNS, no
Flutter change is needed. For a different host, rebuild with:

```bash
flutter build web --release --base-href "/fluttertest/" --pwa-strategy=none \
  --dart-define=BACKEND_ORIGIN=https://your-host
```

`BACKEND_ORIGIN` must be an origin only (scheme + host, no trailing slash and no
path); `/notify` is appended automatically. Copy the resulting `build/web` to
`dist/web/` on the server. Android/iOS builds only need re-releasing if the host
changed, and `--dart-define=WINDOWS_APP_SERVER_TOKEN=...` must match the
server's `APP_SERVER_TOKEN` for the Windows SSO path. Android blocks cleartext
traffic by default — test against HTTPS rather than relaxing that.

### 6. Cutover checks

Dry-run against a temporary subdomain (added to `ALLOWED_HOSTS`) first, lower
the DNS TTL a day ahead, and take a final delta dump during a short freeze
window so no messages are lost. After cutover verify: `/notify/version`, SMS
login, a Socket.IO connection (not the polling fallback), web push to an
existing subscription, upload + `/notify/uploads` retrieval, `/fluttertest`, and
the shuttle reminder scheduler logs. Keep the cPanel instance intact for a
rollback window.

## Project Structure

```
.
├── server.js                   # Main backend entry point
├── backend/
│   ├── controllers/            # Express route handlers (JS)
│   ├── middleware/              # Express middleware (JS)
│   └── src/services/           # TypeScript service layer
├── frontend/                   # Angular 21 standalone app
│   └── src/app/
│       ├── core/services/      # ChatStoreService, API, transport
│       └── features/chat/      # Chat UI components & dialogs
├── deploy/                     # systemd unit + nginx site config for EC2
├── .github/workflows/ci.yml   # CI pipeline
├── Dockerfile                  # Container build
└── docker-compose.yml          # Local dev stack
```

## CI / CD

GitHub Actions runs on every PR and push to `main`:
- **Backend**: TypeScript compilation check
- **Frontend**: Type-check → Production build → Unit tests

## License

ISC
