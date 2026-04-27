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

Optional variables: `REDIS_URL`, `LOGS_BACKUP_SHEET_URL`, `SHUTTLE_USER_ORDERS_URL`, `WEBHOOK_REGISTRY_JSON`.

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
