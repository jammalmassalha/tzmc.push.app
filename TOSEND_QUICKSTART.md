# ToSend Queue - Quick Start

## What's New?

The ToSend message queue now supports **MySQL database storage** in addition to Google Sheets. This provides:

✅ **Persistent message storage** - Messages survive server restarts  
✅ **API-based queueing** - Add messages programmatically  
✅ **Deduplication** - Automatically removes duplicate messages  
✅ **Backward compatible** - Google Sheets still works as before  

## Setup (5 minutes)

### 1. Initialize Database

```bash
node backend/utils/init-tosend-table.js
```

### 2. Restart Server

```bash
npm start
# or
node server.js
```

### 3. (Optional) Migrate Existing Messages

If you have messages in Google Sheets ToSend queue:

```bash
node backend/utils/sync-tosend-from-sheet.js
```

## Basic Usage

### Add a Message

```bash
curl -X POST http://localhost:3000/tosend/add \
  -H "Content-Type: application/json" \
  -d '{
    "recipient": "+1234567890",
    "sender": "MyApp",
    "message_content": "Hello!",
    "token": "your_token_here"
  }'
```

### Check Queue

```bash
curl "http://localhost:3000/tosend/stats?token=your_token_here"
```

### Get Messages for Recipient

```bash
curl "http://localhost:3000/tosend/get-messages?recipient=%2B1234567890&token=your_token_here"
```

## Key Files

| File | Purpose |
|------|---------|
| `backend/src/services/tosend-queue.service.ts` | Service logic (TypeScript) |
| `backend/dist/services/tosend-queue.service.js` | Service logic (compiled) |
| `backend/utils/init-tosend-table.js` | Initialize database table |
| `backend/utils/sync-tosend-from-sheet.js` | Sync from Google Sheets |
| `TOSEND_QUEUE_GUIDE.md` | Full documentation |

## Environment Variables

```env
# Database (uses LOGS_DB_* by default, or set separately)
LOGS_DB_HOST=localhost
LOGS_DB_PORT=3306
LOGS_DB_USER=root
LOGS_DB_PASSWORD=password
LOGS_DB_NAME=database_name

# Authentication token (defaults to CHECK_QUEUE_SERVER_TOKEN)
TOSEND_QUEUE_TOKEN=your_secret_token
```

## API Endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/tosend/add` | POST | Add single message |
| `/tosend/add-batch` | POST | Add multiple messages |
| `/tosend/get-messages` | GET/POST | Get pending messages |
| `/tosend/stats` | GET | Queue statistics |
| `/tosend/clear` | POST | Clear queue (admin) |

All endpoints require `token` parameter.

## How It Works

1. **Message Added** → Inserted into MySQL `ToSendQueue` table
2. **Queue Check** (every 10 seconds) → Server fetches pending messages
3. **Deduplication** → Duplicate messages removed
4. **Processing** → Messages sent to recipients
5. **Status Update** → Messages marked as "sent"
6. **Cleanup** → Old sent messages can be deleted

## Backward Compatibility

✅ Google Sheets "ToSend" sheet still works  
✅ Existing integrations continue to work  
✅ No breaking changes  
✅ Can run both simultaneously  

## Troubleshooting

### Issue: "Table doesn't exist"
```bash
node backend/utils/init-tosend-table.js
```

### Issue: "Unauthorized" error
Check your `token` parameter matches `TOSEND_QUEUE_TOKEN` or `CHECK_QUEUE_SERVER_TOKEN`

### Issue: Messages not being processed
```bash
# Check queue status
curl "http://localhost:3000/tosend/stats?token=YOUR_TOKEN"

# Check server logs for [TOSEND] entries
grep "TOSEND" logs/*.log
```

## Full Documentation

See `TOSEND_QUEUE_GUIDE.md` for:
- Detailed API reference
- Code examples (Node.js, Python, cURL)
- Database schema
- Advanced configuration
- Performance optimization

## Support

- Check logs for `[TOSEND]` entries
- Review `TOSEND_QUEUE_GUIDE.md`
- Verify database connectivity
- Ensure token authentication is correct
