# TZMC Push App - API Documentation

This document describes the backend API endpoints used by the Flutter mobile client. The endpoints are derived from the existing Angular frontend's `ChatApiService` and `RealtimeTransportService`.

## Base URL

- **Production:** `https://www.tzmc.co.il/notify`

## Authentication

### Session Management

All authenticated endpoints use cookie-based session management with CSRF protection.

#### Check Session
```
GET /auth/session
```

**Response:**
```json
{
  "authenticated": true,
  "user": "0501234567",
  "csrfToken": "abc123..."
}
```

#### Create Session (Login)
```
POST /auth/session
Content-Type: application/json
```

**Request:**
```json
{
  "user": "0501234567"
}
```

**Response (Success - Direct Auth):**
```json
{
  "authenticated": true,
  "user": "0501234567",
  "csrfToken": "abc123..."
}
```

**Response (SMS Verification Required):**
```json
{
  "verificationRequired": true,
  "expiresInSeconds": 300
}
```

#### Request SMS Code
```
POST /auth/session/request-code
Content-Type: application/json
```

**Request:**
```json
{
  "user": "0501234567"
}
```

**Response:**
```json
{
  "codeSent": true,
  "expiresInSeconds": 300
}
```

#### Verify SMS Code
```
POST /auth/session/verify-code
Content-Type: application/json
```

**Request:**
```json
{
  "user": "0501234567",
  "code": "123456"
}
```

**Response:**
```json
{
  "authenticated": true,
  "user": "0501234567",
  "csrfToken": "abc123..."
}
```

#### Clear Session (Logout)
```
DELETE /auth/session
```

---

## Contacts & Groups

### Get Contacts
```
GET /contacts?user={username}
```

**Response:**
```json
{
  "users": [
    {
      "username": "user1",
      "fullName": "John Doe",
      "phone": "0501234567",
      "upic": "https://...",
      "status": 1
    }
  ]
}
```

### Get Groups
```
GET /groups?user={username}
```

**Response:**
```json
{
  "groups": [
    {
      "id": "group-123",
      "name": "Team Chat",
      "members": ["user1", "user2"],
      "admins": ["user1"],
      "createdBy": "user1",
      "updatedAt": 1699999999999,
      "type": "group"
    }
  ]
}
```

### Get User Chat Groups
```
GET /user-chat-groups
```

### Get Community Group Configs
```
GET /community-group-configs
```

---

## Messages

### Poll Messages
```
GET /messages?user={username}
```

**Response:**
```json
{
  "messages": [
    {
      "messageId": "msg-123",
      "sender": "user1",
      "body": "Hello!",
      "timestamp": 1699999999999,
      "groupId": null
    }
  ]
}
```

### Get Messages from Logs (History Sync)
```
GET /messages/logs?user={username}&excludeSystem=1&limit=1000&offset=0&since=0
```

### Report Message Received
```
POST /messages/received
Content-Type: application/json
```

**Request:**
```json
{
  "msgId": "msg-123",
  "receivedAt": 1699999999999
}
```

### Report Messages Received (Batch)
```
POST /messages/received-batch
Content-Type: application/json
```

**Request:**
```json
{
  "entries": [
    { "msgId": "msg-123", "receivedAt": 1699999999999 },
    { "msgId": "msg-124", "receivedAt": 1699999999999 }
  ]
}
```

---

## Message Actions

### Send Direct Message
```
POST /reply
Content-Type: application/json
X-CSRF-Token: {csrfToken}
```

**Request:**
```json
{
  "user": "recipient",
  "senderName": "John Doe",
  "reply": "Hello!",
  "imageUrl": null,
  "fileUrl": null,
  "originalSender": "sender",
  "messageId": "msg-uuid"
}
```

### Send Group Message
```
POST /reply
Content-Type: application/json
X-CSRF-Token: {csrfToken}
```

**Request:**
```json
{
  "user": "recipient",
  "senderName": "John Doe",
  "reply": "Hello group!",
  "messageId": "msg-uuid",
  "groupId": "group-123",
  "groupName": "Team Chat",
  "groupMembers": ["user1", "user2"],
  "groupCreatedBy": "user1",
  "membersToNotify": ["user2"]
}
```

### Send Group Update
```
POST /group-update
Content-Type: application/json
X-CSRF-Token: {csrfToken}
```

**Request:**
```json
{
  "groupId": "group-123",
  "groupName": "New Name",
  "groupMembers": ["user1", "user2", "user3"],
  "groupCreatedBy": "user1",
  "groupAdmins": ["user1"],
  "groupUpdatedAt": 1699999999999,
  "groupType": "group",
  "membersToNotify": ["user2", "user3"]
}
```

### Send Reaction
```
POST /reaction
Content-Type: application/json
X-CSRF-Token: {csrfToken}
```

**Request:**
```json
{
  "targetMessageId": "msg-123",
  "emoji": "👍",
  "reactor": "user1",
  "reactorName": "John Doe",
  "targetUser": "user2"
}
```

### Send Typing State
```
POST /typing
Content-Type: application/json
```

**Request:**
```json
{
  "user": "user1",
  "isTyping": true,
  "targetUser": "user2"
}
```

### Send Read Receipt
```
POST /read
Content-Type: application/json
X-CSRF-Token: {csrfToken}
```

**Request:**
```json
{
  "reader": "user1",
  "sender": "user2",
  "messageIds": ["msg-123", "msg-124"],
  "readAt": 1699999999999
}
```

### Edit Message
```
POST /edit
Content-Type: application/json
X-CSRF-Token: {csrfToken}
```

**Request:**
```json
{
  "sender": "user1",
  "messageId": "msg-123",
  "body": "Edited message",
  "editedAt": 1699999999999,
  "recipient": "user2"
}
```

### Delete Message
```
POST /delete
Content-Type: application/json
X-CSRF-Token: {csrfToken}
```

**Request:**
```json
{
  "sender": "user1",
  "messageId": "msg-123",
  "deletedAt": 1699999999999,
  "recipient": "user2"
}
```

### Mark Messages Seen
```
POST /mark-seen
Content-Type: application/json
```

**Request:**
```json
{
  "user": "user1",
  "chatId": "user2"
}
```

---

## File Upload

### Upload File
```
POST /upload
Content-Type: multipart/form-data
```

**Form Fields:**
- `file` - Main file to upload
- `thumbnail` - Optional thumbnail for images

**Response:**
```json
{
  "status": "success",
  "url": "https://...",
  "thumbUrl": "https://...",
  "type": "image"
}
```

---

## Device Registration

### Register Device
```
POST /register-device
Content-Type: application/json
```

**Request (Web Push):**
```json
{
  "username": "user1",
  "subscription": { "endpoint": "...", "keys": {...} },
  "deviceType": "Mobile",
  "platform": "Android",
  "action": "subscribe"
}
```

**Request (FCM - Mobile):**
```json
{
  "username": "user1",
  "fcmToken": "fcm-token-string",
  "deviceType": "Mobile",
  "platform": "Android",
  "action": "subscribe"
}
```

### Reset Badge
```
POST /reset-badge
Content-Type: application/json
```

**Request:**
```json
{
  "user": "user1"
}
```

---

## Realtime Transport

### SSE Stream
```
GET /stream?user={username}
Accept: text/event-stream
```

**Events:**
```
event: connected
data: {}

event: message
data: {"messageId":"msg-123","sender":"user1",...}
```

### Socket.IO
```
Server: wss://www.tzmc.co.il
Path: /notify/socket.io
Transports: [polling, websocket]
```

**Auth:**
```json
{
  "user": "username"
}
```

**Events Received:**
- `connect` - Connection established
- `chat:connected` - Chat service ready
- `chat:message` - Incoming message

**Events Sent:**
- Standard socket.io events with ack support

---

## Shuttle

### Get Employees
```
GET /shuttle/employees
```

### Get Stations
```
GET /shuttle/stations
```

### Submit Order
```
POST /shuttle/orders
Content-Type: application/json
```

**Request:**
```json
{
  "employee": "John Doe",
  "date": "01/01/2024",
  "dateAlt": "2024-01-01",
  "shift": "בוקר",
  "station": "Station A",
  "status": "הזמנה"
}
```

### Get User Orders
```
GET /shuttle/orders/user?user={username}&force=1
```

### Get Operations Orders
```
GET /shuttle/orders/operations?fromDate=2024-01-01&force=1
```

---

## Helpdesk

### Get Dashboard
```
GET /helpdesk/dashboard
```

**Response:**
```json
{
  "ongoing": [...],
  "past": [...],
  "assigned": [...],
  "myRole": { "role": "Editor", "department": "IT" },
  "editorTickets": [...],
  "handlers": [...]
}
```

### Create Ticket
```
POST /helpdesk/tickets
Content-Type: application/json
```

**Request:**
```json
{
  "department": "מערכות מידע",
  "title": "Issue title",
  "description": "Issue description"
}
```

### Update Ticket Status
```
PUT /helpdesk/tickets/{id}/status
Content-Type: application/json
```

**Request:**
```json
{
  "status": "in_progress"
}
```

### Get Ticket History
```
GET /helpdesk/tickets/{id}/history
```

### Get Ticket Notes
```
GET /helpdesk/tickets/{id}/notes
```

### Add Ticket Note
```
POST /helpdesk/tickets/{id}/notes
Content-Type: application/json
```

**Request:**
```json
{
  "noteText": "Note content"
}
```

---

## Utilities

### Get Version
```
GET /version
```

**Response:**
```json
{
  "version": "1.74",
  "notes": ["Bug fixes", "New features"]
}
```

### Client Log
```
POST /log
Content-Type: application/json
```

**Request:**
```json
{
  "event": "app_open",
  "payload": { "platform": "android" },
  "user": "user1",
  "timestamp": 1699999999999
}
```

---

## Error Responses

All endpoints may return error responses:

**400 Bad Request:**
```json
{
  "message": "מספר טלפון לא תקין"
}
```

**401 Unauthorized:**
```json
{
  "message": "קוד האימות שגוי או פג תוקף"
}
```

**403 Forbidden:**
```json
{
  "message": "המשתמש אינו מורשה"
}
```

**429 Too Many Requests:**
```json
{
  "message": "יותר מדי ניסיונות",
  "retryAfterSeconds": 60
}
```

**500 Internal Server Error:**
```json
{
  "message": "שגיאת שרת"
}
```
