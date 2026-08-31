'use strict';

/**
 * Realtime fan-out registry and helpers.
 *
 * Extracted from `server.js` so the multi-device delivery rules — every
 * active connection of a user receives each message, and the sender's own
 * other devices receive a self-echo tagged with the originating device — can
 * be unit tested without booting the whole HTTP server.
 */

/** Active SSE responses keyed by normalized username. */
const sseClients = new Map();

/** Active Socket.io sockets keyed by normalized username. */
const websocketClients = new Map();

function addWebsocketClient(username, socket) {
    if (!username || !socket) return;
    const existing = websocketClients.get(username) || new Set();
    existing.add(socket);
    websocketClients.set(username, existing);
}

function removeWebsocketClient(username, socket) {
    if (!username || !socket) return;
    const existing = websocketClients.get(username);
    if (!existing) return;
    existing.delete(socket);
    if (existing.size === 0) {
        websocketClients.delete(username);
    }
}

function notifySseClients(username, messageObj) {
    const clientSet = sseClients.get(username);
    if (!clientSet) return;
    const payload = `event: message\ndata: ${JSON.stringify(messageObj)}\n\n`;
    clientSet.forEach((res) => {
        try {
            res.write(payload);
        } catch (error) {
            // Ignore per-client write failures and continue.
        }
    });
}

function notifyWebsocketClients(username, messageObj) {
    const clientSet = websocketClients.get(username);
    if (!clientSet || !clientSet.size) return;
    clientSet.forEach((socket) => {
        try {
            socket.emit('chat:message', messageObj);
        } catch (error) {
            // Ignore per-socket emission failures and continue.
        }
    });
}

/**
 * Deliver `messageObj` to every active connection of `username`, across both
 * transports. Multi-device sync depends on this fanning out to *all*
 * connections rather than a single "primary" one.
 */
function notifyRealtimeClients(username, messageObj) {
    notifySseClients(username, messageObj);
    notifyWebsocketClients(username, messageObj);
}

/** Max stored length of a client-supplied device id. */
const DEVICE_ID_MAX_LENGTH = 120;

/**
 * Normalize a client-supplied device id to a bounded, trimmed string.
 * Returns '' for anything unusable so callers can treat it as "unknown".
 */
function normalizeDeviceId(value) {
    if (value === null || value === undefined) return '';
    if (typeof value === 'object') return '';
    return String(value).trim().slice(0, DEVICE_ID_MAX_LENGTH);
}

/**
 * Build the copy of an outbound message that is echoed back to the sender's
 * own other devices.
 *
 * For direct messages `toUser` is rewritten to the recipient so the echo
 * lands in the peer's chat as an outgoing bubble; for group messages it is
 * left unset because the group id already identifies the chat.
 *
 * `originDeviceId` lets the device that composed the message recognise its
 * own echo and skip re-applying it. Devices that don't send a device id, and
 * older clients that ignore the field, keep relying on `messageId` dedup.
 */
function buildSelfEchoMessage({
    pollingMessage,
    isGroup = false,
    recipientKey = '',
    originDeviceId = '',
} = {}) {
    const base = pollingMessage && typeof pollingMessage === 'object' ? pollingMessage : {};
    const normalizedRecipient = String(recipientKey || '').trim();
    const normalizedOrigin = normalizeDeviceId(originDeviceId);
    return {
        ...base,
        toUser: isGroup ? undefined : (normalizedRecipient || undefined),
        ...(normalizedOrigin ? { originDeviceId: normalizedOrigin } : {}),
    };
}

/**
 * Build the payload that tells a reader's *own* other devices that this user
 * has just read a chat, so they can clear their unread badge.
 *
 * The presence of `chatId` is what distinguishes this "self-read-clear" from
 * an ordinary read receipt (where the peer read *our* messages), which the
 * clients key off. `originDeviceId` lets the device that performed the read
 * recognise and drop its own echo; devices that send no device id keep
 * receiving the clear, which is idempotent.
 */
function buildSelfReadClearMessage({
    chatId,
    messageIds = [],
    readAt,
    sender = '',
    originDeviceId = '',
    timestamp,
} = {}) {
    const now = Date.now();
    const normalizedOrigin = normalizeDeviceId(originDeviceId);
    return {
        type: 'read-receipt',
        chatId: String(chatId || '').trim(),
        ...(Array.isArray(messageIds) && messageIds.length ? { messageIds } : {}),
        readAt: readAt === undefined ? now : readAt,
        ...(sender ? { sender: String(sender).trim() } : {}),
        timestamp: timestamp === undefined ? now : timestamp,
        ...(normalizedOrigin ? { originDeviceId: normalizedOrigin } : {}),
    };
}

module.exports = {
    sseClients,
    websocketClients,
    addWebsocketClient,
    removeWebsocketClient,
    notifySseClients,
    notifyWebsocketClients,
    notifyRealtimeClients,
    normalizeDeviceId,
    buildSelfEchoMessage,
    buildSelfReadClearMessage,
    DEVICE_ID_MAX_LENGTH,
};
