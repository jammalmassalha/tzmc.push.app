# ToSend Queue - MySQL Implementation Guide

## Overview

The ToSend Queue has been enhanced to support MySQL database storage in addition to the Google Sheets "ToSend" sheet. This allows for:

- **Persistent storage** of outgoing messages in MySQL
- **API-based message queueing** without needing Google Sheets access
- **Deduplication** of identical messages
- **Status tracking** (pending/sent)
- **Backward compatibility** with existing Google Sheets workflow

## Database Table Structure

The `ToSendQueue` table has the following schema:

```sql
CREATE TABLE IF NOT EXISTS `ToSendQueue` (
  `Id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `Recipient` VARCHAR(50) NOT NULL,
  `Sender` VARCHAR(255) NOT NULL,
  `MessageContent` LONGTEXT NOT NULL,
  `CreatedAt` DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3),
  `Status` VARCHAR(20) DEFAULT 'pending',
  PRIMARY KEY (`Id`),
  INDEX `idx_tosend_recipient` (`Recipient`),
  INDEX `idx_tosend_status` (`Status`),
  INDEX `idx_tosend_created_at` (`CreatedAt`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
```

### Columns

- **Id**: Auto-increment primary key
- **Recipient**: Phone number or username (normalized)
- **Sender**: Name/ID of the sender (defaults to "System")
- **MessageContent**: The message text to send
- **CreatedAt**: Timestamp when message was added to queue
- **Status**: Message status - `pending` (new message) or `sent` (processed)

## Setup & Initialization

### 1. Initialize the Table

Run the initialization script to create the ToSendQueue table:

```bash
node backend/utils/init-tosend-table.js
```

This will:
- Connect to your MySQL database using environment variables
- Create the `ToSendQueue` table if it doesn't exist
- Display queue statistics

### 2. Environment Variables

Add these to your `.env` file:

```env
# Database Configuration (if different from LOGS_DB_*)
LOGS_DB_HOST=localhost
LOGS_DB_PORT=3306
LOGS_DB_USER=root
LOGS_DB_PASSWORD=your_password
LOGS_DB_NAME=your_database

# ToSend Queue Authentication (optional, defaults to CHECK_QUEUE_SERVER_TOKEN)
TOSEND_QUEUE_TOKEN=your_secret_token_here
```

### 3. Migrate Existing Data (Optional)

If you have existing messages in the Google Sheets "ToSend" queue, migrate them to MySQL:

```bash
node backend/utils/sync-tosend-from-sheet.js
```

This will:
- Fetch all pending messages from Google Sheets
- Insert them into the MySQL ToSendQueue table
- Delete them from Google Sheets (handled by the check_queue call)

## API Endpoints

All endpoints support token-based authentication via `token` query parameter or request body.

### 1. Add Single Message to Queue

**POST** `/tosend/add` or `/notify/tosend/add`

Add a single message to the queue.

**Request Body:**
```json
{
  "recipient": "+1234567890",
  "sender": "John Doe",
  "message_content": "Hello, this is a test message",
  "token": "your_secret_token"
}
```

**Response:**
```json
{
  "status": "success",
  "messageId": 123,
  "message": "Message added to queue"
}
```

### 2. Add Multiple Messages (Bulk)

**POST** `/tosend/add-batch` or `/notify/tosend/add-batch`

Add multiple messages to the queue in one request.

**Request Body:**
```json
{
  "messages": [
    {
      "recipient": "+1234567890",
      "sender": "System",
      "message_content": "Message 1"
    },
    {
      "recipient": "+0987654321",
      "sender": "John",
      "message_content": "Message 2"
    }
  ],
  "token": "your_secret_token"
}
```

**Response:**
```json
{
  "status": "success",
  "count": 2,
  "message": "2 messages added to queue"
}
```

### 3. Get Pending Messages

**GET** `/tosend/get-messages` or **POST** `/tosend/get-messages`

Retrieve pending messages from the queue. Messages are automatically deduped and marked as sent.

**Query/Body Parameters:**
```
recipient: (optional) Filter by specific recipient
token: (required) Authentication token
```

**GET Example:**
```
GET /tosend/get-messages?token=your_secret_token
GET /tosend/get-messages?recipient=+1234567890&token=your_secret_token
```

**POST Example:**
```json
{
  "recipient": "+1234567890",
  "token": "your_secret_token"
}
```

**Response:**
```json
{
  "status": "success",
  "messages": [
    {
      "recipient": "+1234567890",
      "sender": "System",
      "content": "Your message here"
    }
  ]
}
```

### 4. Get Queue Statistics

**GET** `/tosend/stats` or `/notify/tosend/stats`

Get statistics about the queue.

**Query Parameters:**
```
token: (required) Authentication token
```

**Example:**
```
GET /tosend/stats?token=your_secret_token
```

**Response:**
```json
{
  "status": "success",
  "stats": {
    "pending": 5,
    "sent": 42,
    "total": 47
  }
}
```

### 5. Clear Queue (Admin Only)

**POST** `/tosend/clear` or `/notify/tosend/clear`

Completely clear the queue. Requires explicit confirmation.

**Request Body:**
```json
{
  "token": "your_secret_token",
  "confirm": true
}
```

**Response:**
```json
{
  "status": "success",
  "message": "Queue cleared"
}
```

## How It Works

### Message Processing Flow

1. **Add to Queue**: Messages are added via API or imported from Google Sheets
2. **Queue Polling**: Every 10 seconds, the server checks both MySQL and Google Sheets
3. **Get Pending**: Retrieves messages with `status='pending'`
4. **Deduplication**: Identical messages in the batch are deduplicated
5. **Process**: Messages are sent to recipients
6. **Mark Sent**: Messages are marked with `status='sent'`
7. **Cleanup**: Sent messages can be deleted with `deleteSentMessages()`

### Deduplication Logic

Messages are deduplicated using a composite key:
```
dedupKey = recipient.toLowerCase() + "|" + sender.toLowerCase() + "|" + normalizedContent
```

Within a single batch retrieval, identical messages are deduplicated - only the first one is returned, rest are marked as sent.

### Authentication

By default, the API uses the `CHECK_QUEUE_SERVER_TOKEN` environment variable for authentication. You can optionally configure a separate `TOSEND_QUEUE_TOKEN`.

Token must be provided as:
- Query parameter: `?token=your_token`
- Request body: `{ token: "your_token" }`

## Usage Examples

### Node.js / JavaScript

```javascript
const fetch = require('node-fetch');

async function addMessageToQueue() {
  const response = await fetch('http://localhost:3000/tosend/add', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      recipient: '+1234567890',
      sender: 'MyApp',
      message_content: 'Hello from Node.js!',
      token: 'your_secret_token'
    })
  });
  
  const result = await response.json();
  console.log(result);
}

addMessageToQueue();
```

### cURL

```bash
# Add single message
curl -X POST http://localhost:3000/tosend/add \
  -H "Content-Type: application/json" \
  -d '{
    "recipient": "+1234567890",
    "sender": "System",
    "message_content": "Test message",
    "token": "your_secret_token"
  }'

# Get messages
curl "http://localhost:3000/tosend/get-messages?token=your_secret_token"

# Get stats
curl "http://localhost:3000/tosend/stats?token=your_secret_token"

# Add batch
curl -X POST http://localhost:3000/tosend/add-batch \
  -H "Content-Type: application/json" \
  -d '{
    "messages": [
      {"recipient": "+1111111111", "sender": "System", "message_content": "Msg 1"},
      {"recipient": "+2222222222", "sender": "System", "message_content": "Msg 2"}
    ],
    "token": "your_secret_token"
  }'
```

### Python

```python
import requests
import json

base_url = "http://localhost:3000"
token = "your_secret_token"

# Add message
response = requests.post(f"{base_url}/tosend/add", json={
    "recipient": "+1234567890",
    "sender": "PythonApp",
    "message_content": "Hello from Python!",
    "token": token
})
print(response.json())

# Get messages
response = requests.post(f"{base_url}/tosend/get-messages", json={"token": token})
print(response.json())

# Get stats
response = requests.get(f"{base_url}/tosend/stats", params={"token": token})
print(response.json())
```

## Backward Compatibility

The system maintains full backward compatibility with the existing Google Sheets workflow:

1. **Google Sheets ToSend sheet** still works as before
2. **check_queue** endpoint in Google Apps Script continues to function
3. **Server checks both sources**: Every polling cycle checks MySQL database first, then Google Sheets as fallback
4. Messages from both sources are processed in the same queue logic

### Migration Strategy

**Recommended approach:**

1. Deploy the new code with MySQL support enabled
2. Start adding new messages via API to the MySQL database
3. Existing Google Sheets messages continue to be processed
4. Gradually migrate your integrations from Google Sheets to API
5. Eventually deprecate Google Sheets (after confirming all messages are processed)

## Troubleshooting

### Table Not Created

If you see "Table doesn't exist" errors:

```bash
# Run initialization script
node backend/utils/init-tosend-table.js

# Or create manually in MySQL:
mysql -u root -p your_database < init-tosend-table.sql
```

### Messages Not Being Processed

1. Check token authentication:
   ```bash
   curl "http://localhost:3000/tosend/stats?token=your_token"
   ```

2. Check queue status:
   ```bash
   curl "http://localhost:3000/tosend/stats?token=your_token"
   ```

3. Verify server logs for errors:
   ```bash
   grep "TOSEND" app.log
   ```

### Performance Issues

If the queue gets very large:

1. Check message volume:
   ```bash
   SELECT COUNT(*) FROM `ToSendQueue` WHERE `Status` = 'pending';
   ```

2. Check for stuck messages:
   ```bash
   SELECT COUNT(*) FROM `ToSendQueue` WHERE `Status` = 'sent' AND `CreatedAt` < DATE_SUB(NOW(), INTERVAL 1 DAY);
   ```

3. Clean up old sent messages:
   ```javascript
   // Via API endpoint (requires token)
   POST /tosend/clear with confirm: true
   
   // Or manually in MySQL:
   DELETE FROM `ToSendQueue` WHERE `Status` = 'sent' AND `CreatedAt` < DATE_SUB(NOW(), INTERVAL 7 DAYS);
   ```

## Related Files

- Service: `backend/src/services/tosend-queue.service.ts`
- Compiled: `backend/dist/services/tosend-queue.service.js`
- Init Script: `backend/utils/init-tosend-table.js`
- Sync Script: `backend/utils/sync-tosend-from-sheet.js`
- Server Routes: `server.js` (search for `/tosend/`)

## Support

For issues or questions:

1. Check application logs for `[TOSEND]` entries
2. Verify database connectivity
3. Ensure environment variables are set correctly
4. Check API token configuration
