# TZMC Angular Modernization

This folder contains the new Angular-based frontend for the project, replacing the legacy vanilla JS UI with a modern, faster, progressive architecture.

## What was modernized

- Angular 21 standalone app with route-based structure
- Angular Material UI for modern, responsive interaction
- Signal-based state management (`ChatStoreService`) for fast rendering
- Realtime updates using SSE (`/notify/stream`) with polling fallback (`/notify/messages`)
- Offline outbox queue with automatic flush when network returns
- Group chat creation with regular/community group types
- Attachment uploads (image/document) through `/notify/upload`
- Progressive Web App setup (`@angular/pwa`) with Service Worker caching
- Runtime performance tuning with zone coalescing + lazy-loaded routes/components

## Main architecture

```
src/app/
  core/
    config/runtime-config.ts
    models/chat.models.ts
    services/chat-api.service.ts
    services/chat-store.service.ts
  features/
    setup/
    chat/
      dialogs/
```

## Run locally

```bash
cd frontend
npm install
npm run start
```

App runs at `http://localhost:4200`.

## Build for production

```bash
npm run build
```

Output is generated under:

```bash
frontend/dist/frontend
```

## Tests

```bash
npm run test -- --watch=false
```

## Notes

- The new frontend keeps compatibility with existing backend endpoints already used by the old app:
  - `.../notify/reply`
  - `.../notify/upload`
  - `.../notify/groups`
  - `.../notify/group-update`
  - `.../notify/stream`
  - `.../notify/messages`
- Runtime endpoint values are centralized in:
  - `src/app/core/config/runtime-config.ts`
