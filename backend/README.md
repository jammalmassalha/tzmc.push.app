# Backend TypeScript Foundation

This directory contains the new TypeScript service layer used by the existing Node server.

## Build

```bash
npm run build:backend
```

## Services

- `sheet-integration.service.ts` – centralizes Google Apps Script URLs/tokens.
- `redis-state-store.service.ts` – Redis-backed state + queue persistence.
- `webhook-registry.service.ts` – dynamic message-type to webhook URL mapping.
- `session-token-jwe.service.ts` – JWE-style encrypted session token helper.

The legacy `server.js` now consumes compiled output under `backend/dist/services`.
