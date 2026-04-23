// ─── FCM Sender ──────────────────────────────────────────────────────────────
// Bridge between the existing web-push pipeline (which targets W3C
// `PushSubscription` records) and Firebase Cloud Messaging (FCM/APNs)
// device tokens registered by the Flutter mobile app.
//
// The notification.service.ts pipeline calls a single `sendNotification(sub,
// payload, options)` callback for every subscription. To deliver to mobile
// devices we route subscriptions whose `endpoint` starts with `fcm:` (or
// which carry an explicit `fcmToken`/`token` field) through the Firebase
// Admin SDK instead of `web-push`.
//
// Server credentials (separate from the client-side `google-services.json`)
// are loaded lazily from one of:
//   - FIREBASE_SERVICE_ACCOUNT_BASE64  (preferred — easy to set as a secret)
//   - FIREBASE_SERVICE_ACCOUNT_JSON    (raw JSON string)
//   - GOOGLE_APPLICATION_CREDENTIALS   (filesystem path; admin SDK default)
// If none of these are present, isFcmSenderConfigured() returns false and
// sendFcmNotification() throws a 503-shaped error so the caller logs the
// failure but keeps the (still-valid) subscription record around.
// ─────────────────────────────────────────────────────────────────────────────

let cachedAdmin = null;
let cachedApp = null;
let initWarned = false;

function loadServiceAccount() {
    const base64 = String(process.env.FIREBASE_SERVICE_ACCOUNT_BASE64 || '').trim();
    if (base64) {
        try {
            const decoded = Buffer.from(base64, 'base64').toString('utf8');
            return JSON.parse(decoded);
        } catch (error) {
            throw new Error(
                `FIREBASE_SERVICE_ACCOUNT_BASE64 is set but not valid base64-encoded JSON: ${error.message}`
            );
        }
    }
    const raw = String(process.env.FIREBASE_SERVICE_ACCOUNT_JSON || '').trim();
    if (raw) {
        try {
            return JSON.parse(raw);
        } catch (error) {
            throw new Error(
                `FIREBASE_SERVICE_ACCOUNT_JSON is set but not valid JSON: ${error.message}`
            );
        }
    }
    return null;
}

function ensureAdminInitialized() {
    if (cachedAdmin && cachedApp) return cachedAdmin;
    let admin;
    try {
        // eslint-disable-next-line global-require
        admin = require('firebase-admin');
    } catch (error) {
        throw new Error(
            `firebase-admin is not installed (run \`npm install\`): ${error.message}`
        );
    }

    if (admin.apps && admin.apps.length) {
        cachedAdmin = admin;
        cachedApp = admin.apps[0];
        return admin;
    }

    const serviceAccount = loadServiceAccount();
    const appOptions = {};
    if (serviceAccount) {
        appOptions.credential = admin.credential.cert(serviceAccount);
        if (serviceAccount.project_id) appOptions.projectId = serviceAccount.project_id;
    } else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
        // Falls back to applicationDefault() which respects
        // GOOGLE_APPLICATION_CREDENTIALS / metadata-server credentials.
        appOptions.credential = admin.credential.applicationDefault();
    } else {
        throw new Error(
            'Firebase Admin credentials are not configured. Set ' +
            'FIREBASE_SERVICE_ACCOUNT_BASE64, FIREBASE_SERVICE_ACCOUNT_JSON, ' +
            'or GOOGLE_APPLICATION_CREDENTIALS so the server can deliver ' +
            'FCM/APNs notifications.'
        );
    }

    cachedApp = admin.initializeApp(appOptions);
    cachedAdmin = admin;
    return admin;
}

function isFcmSenderConfigured() {
    return Boolean(
        String(process.env.FIREBASE_SERVICE_ACCOUNT_BASE64 || '').trim() ||
        String(process.env.FIREBASE_SERVICE_ACCOUNT_JSON || '').trim() ||
        String(process.env.GOOGLE_APPLICATION_CREDENTIALS || '').trim()
    );
}

function isFcmSubscription(subscription) {
    if (!subscription || typeof subscription !== 'object') return false;
    if (typeof subscription.fcmToken === 'string' && subscription.fcmToken.trim()) return true;
    const endpoint = typeof subscription.endpoint === 'string' ? subscription.endpoint.trim() : '';
    if (endpoint.startsWith('fcm:') || endpoint.startsWith('apns:')) return true;
    const type = typeof subscription.type === 'string' ? subscription.type.trim().toLowerCase() : '';
    return type === 'fcm' || type === 'apns';
}

function extractToken(subscription) {
    if (!subscription || typeof subscription !== 'object') return '';
    const direct = typeof subscription.fcmToken === 'string' ? subscription.fcmToken.trim() : '';
    if (direct) return direct;
    const alt = typeof subscription.token === 'string' ? subscription.token.trim() : '';
    if (alt) return alt;
    const endpoint = typeof subscription.endpoint === 'string' ? subscription.endpoint.trim() : '';
    if (endpoint.startsWith('fcm:')) return endpoint.slice(4);
    if (endpoint.startsWith('apns:')) return endpoint.slice(5);
    return '';
}

function isApnsSubscription(subscription) {
    if (!subscription || typeof subscription !== 'object') return false;
    const endpoint = typeof subscription.endpoint === 'string' ? subscription.endpoint.trim() : '';
    if (endpoint.startsWith('apns:')) return true;
    const type = typeof subscription.type === 'string' ? subscription.type.trim().toLowerCase() : '';
    if (type === 'apns') return true;
    const platform = typeof subscription.platform === 'string' ? subscription.platform.trim().toLowerCase() : '';
    return platform === 'ios';
}

// Maximum number of bytes FCM accepts in the data section of a v1 message.
// Slightly under the 4 KB documented limit to leave room for envelope keys.
const FCM_MAX_DATA_BYTES = 3500;

function dataSize(data) {
    let total = 0;
    for (const [k, v] of Object.entries(data)) {
        total += Buffer.byteLength(k, 'utf8') + Buffer.byteLength(v, 'utf8');
    }
    return total;
}

function coerceDataMap(rawData) {
    if (!rawData || typeof rawData !== 'object') return {};
    const out = {};
    Object.entries(rawData).forEach(([key, value]) => {
        if (value === undefined || value === null) return;
        // FCM data values must be strings.
        if (typeof value === 'string') {
            out[key] = value;
            return;
        }
        if (typeof value === 'number' || typeof value === 'boolean') {
            out[key] = String(value);
            return;
        }
        try {
            out[key] = JSON.stringify(value);
        } catch (_error) {
            // skip unserializable
        }
    });
    return out;
}

function trimDataMap(data) {
    if (dataSize(data) <= FCM_MAX_DATA_BYTES) return data;

    // Drop large/optional fields first.
    const dropOrder = [
        'groupMembers',
        'membersToNotify',
        'replyToBody',
        'replyToImageUrl',
        'forwardedFromName',
        'image',
        'icon',
        'badge'
    ];
    const trimmed = { ...data };
    for (const key of dropOrder) {
        if (trimmed[key] !== undefined) {
            delete trimmed[key];
            if (dataSize(trimmed) <= FCM_MAX_DATA_BYTES) return trimmed;
        }
    }
    // Final pass: hard-truncate the longest string values.
    const entries = Object.entries(trimmed)
        .map(([k, v]) => [k, v, Buffer.byteLength(v, 'utf8')])
        .sort((a, b) => b[2] - a[2]);
    for (const [key, value, size] of entries) {
        if (size <= 200) break;
        const target = Math.max(120, size - 400);
        trimmed[key] = String(value).slice(0, target);
        if (dataSize(trimmed) <= FCM_MAX_DATA_BYTES) break;
    }
    return trimmed;
}

function buildFcmMessage(token, parsedPayload, subscription) {
    const envelope = (parsedPayload && typeof parsedPayload === 'object') ? parsedPayload : {};
    const notification = (envelope.notification && typeof envelope.notification === 'object')
        ? envelope.notification
        : null;
    const dataSource = (envelope.data && typeof envelope.data === 'object') ? envelope.data : {};
    const data = trimDataMap(coerceDataMap(dataSource));

    const message = { token, data };

    if (notification) {
        const title = typeof notification.title === 'string' ? notification.title : 'Work Alert';
        const body = typeof notification.body === 'string' ? notification.body : 'New Notification';
        message.notification = { title, body };
        if (typeof notification.image === 'string' && notification.image.trim()) {
            message.notification.imageUrl = notification.image.trim();
        }
    }

    // Android-specific tuning: high priority + the chat_messages channel
    // declared in the Flutter AndroidManifest so the system POSTs the
    // notification correctly. tag = messageId for replace-on-update behaviour.
    const messageId = typeof data.messageId === 'string' ? data.messageId : undefined;
    message.android = {
        priority: 'high',
        ttl: 7 * 24 * 60 * 60 * 1000,
        collapseKey: messageId,
        notification: {
            channelId: 'chat_messages',
            tag: messageId
        }
    };

    if (isApnsSubscription(subscription)) {
        const badgeCount = Number(data.badgeCount);
        message.apns = {
            headers: { 'apns-priority': '10' },
            payload: {
                aps: {
                    sound: 'default',
                    badge: Number.isFinite(badgeCount) && badgeCount >= 0 ? badgeCount : undefined,
                    'mutable-content': 1,
                    'content-available': 1
                }
            }
        };
    }

    return message;
}

const TOKEN_NOT_REGISTERED_CODES = new Set([
    'messaging/registration-token-not-registered',
    'messaging/invalid-registration-token',
    'messaging/invalid-argument'
]);

async function sendFcmNotification(subscription, payloadString, _options) {
    const token = extractToken(subscription);
    if (!token) {
        const error = new Error('FCM subscription has no token');
        error.statusCode = 410;
        throw error;
    }

    if (!isFcmSenderConfigured()) {
        if (!initWarned) {
            initWarned = true;
            console.warn(
                '[FCM] Skipping FCM delivery — Firebase Admin credentials are ' +
                'not configured. Set FIREBASE_SERVICE_ACCOUNT_BASE64 to deliver ' +
                'mobile push notifications. (This warning is shown once.)'
            );
        }
        const error = new Error('FCM sender not configured (FIREBASE_SERVICE_ACCOUNT_BASE64 missing)');
        // Do NOT mark as 410 — the token may still be valid; we just can't
        // deliver right now. 503 means "service unavailable", so the
        // subscription is kept and a future request can succeed.
        error.statusCode = 503;
        throw error;
    }

    let parsed = {};
    if (typeof payloadString === 'string' && payloadString.length) {
        try {
            parsed = JSON.parse(payloadString);
        } catch (_error) {
            // Treat unparseable payloads as data-only.
            parsed = { data: { body: payloadString } };
        }
    }

    const admin = ensureAdminInitialized();
    const message = buildFcmMessage(token, parsed, subscription);

    try {
        const result = await admin.messaging().send(message);
        return result;
    } catch (error) {
        const code = String((error && error.code) || '').trim();
        const wrapped = new Error((error && error.message) || 'FCM send failed');
        wrapped.code = code;
        wrapped.cause = error;
        if (TOKEN_NOT_REGISTERED_CODES.has(code)) {
            wrapped.statusCode = 410;
        } else if (code === 'messaging/quota-exceeded' || code === 'messaging/server-unavailable') {
            wrapped.statusCode = 503;
        } else {
            wrapped.statusCode = 500;
        }
        throw wrapped;
    }
}

module.exports = {
    isFcmSubscription,
    isFcmSenderConfigured,
    sendFcmNotification,
    extractToken
};
