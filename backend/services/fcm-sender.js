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
//   - FIREBASE_SERVICE_ACCOUNT_BASE64  (preferred for secrets — env var)
//   - FIREBASE_SERVICE_ACCOUNT_JSON    (raw JSON string in env)
//   - FIREBASE_CREDENTIAL_FILE         (path to a service-account JSON file)
//   - GOOGLE_APPLICATION_CREDENTIALS   (filesystem path; admin SDK default)
//   - <repo-root>/tzmc-notifications-firebase-adminsdk-fbsvc-bb92594301.json
//     (default file-based fallback, matches scripts/test-fcm-send.js so the
//     production server picks up the same credential the diagnostic script
//     uses without requiring any env-var configuration)
// If none of these are present, isFcmSenderConfigured() returns false and
// sendFcmNotification() throws a 503-shaped error so the caller logs the
// failure but keeps the (still-valid) subscription record around.
// ─────────────────────────────────────────────────────────────────────────────

const fs = require('fs');
const path = require('path');

let cachedAdmin = null;
let cachedApp = null;
let initWarned = false;

// Default credential filename, kept in sync with scripts/test-fcm-send.js.
// The file is expected to live next to server.js (project root).
const DEFAULT_CRED_FILENAME =
    'tzmc-notifications-firebase-adminsdk-fbsvc-bb92594301.json';
const DEFAULT_CRED_PATH = path.resolve(__dirname, '..', '..', DEFAULT_CRED_FILENAME);

function readJsonFile(filePath, envLabel) {
    let text;
    try {
        text = fs.readFileSync(filePath, 'utf8');
    } catch (error) {
        throw new Error(
            `${envLabel} points to ${filePath} but the file cannot be read: ${error.message}`
        );
    }
    try {
        return JSON.parse(text);
    } catch (error) {
        throw new Error(
            `${envLabel} points to ${filePath} but it is not valid JSON: ${error.message}`
        );
    }
}

function resolveCredentialFilePath() {
    const explicit = String(process.env.FIREBASE_CREDENTIAL_FILE || '').trim();
    if (explicit) {
        return { path: path.resolve(explicit), source: 'FIREBASE_CREDENTIAL_FILE' };
    }
    if (fs.existsSync(DEFAULT_CRED_PATH)) {
        return { path: DEFAULT_CRED_PATH, source: 'DEFAULT_CRED_FILE' };
    }
    return null;
}

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
    const fileResolution = resolveCredentialFilePath();
    if (fileResolution) {
        return readJsonFile(fileResolution.path, fileResolution.source);
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
            'FIREBASE_CREDENTIAL_FILE, or GOOGLE_APPLICATION_CREDENTIALS — ' +
            `or place ${DEFAULT_CRED_FILENAME} next to server.js — so the ` +
            'server can deliver FCM/APNs notifications.'
        );
    }

    cachedApp = admin.initializeApp(appOptions);
    cachedAdmin = admin;
    return admin;
}

function isFcmSenderConfigured() {
    if (
        String(process.env.FIREBASE_SERVICE_ACCOUNT_BASE64 || '').trim() ||
        String(process.env.FIREBASE_SERVICE_ACCOUNT_JSON || '').trim() ||
        String(process.env.GOOGLE_APPLICATION_CREDENTIALS || '').trim()
    ) {
        return true;
    }
    return Boolean(resolveCredentialFilePath());
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

    // Android-specific tuning: high priority + the chat_messages channel.
    // Only include `android.notification` when there is a visible notification
    // to display; omitting it for data-only messages avoids OEM-specific
    // quirks where `android.notification.channelId` alone can trigger a
    // phantom notification on certain Android builds.
    const messageId = typeof data.messageId === 'string' ? data.messageId : undefined;
    message.android = {
        priority: 'high',
        ttl: 7 * 24 * 60 * 60 * 1000,
        collapseKey: messageId,
        ...(notification ? { notification: { channelId: 'chat_messages', tag: messageId } } : {})
    };

    if (isApnsSubscription(subscription)) {
        const badgeCount = Number(data.badgeCount);
        const aps = {
            badge: Number.isFinite(badgeCount) && badgeCount >= 0 ? badgeCount : undefined,
            'content-available': 1
        };

        if (notification) {
            const title = typeof notification.title === 'string' ? notification.title : 'Work Alert';
            const body = typeof notification.body === 'string' ? notification.body : 'New Notification';
            aps.alert = { title, body };
            aps.sound = 'default';
            aps['mutable-content'] = 1;
        }

        message.apns = {
            headers: notification
                ? { 'apns-priority': '10', 'apns-push-type': 'alert' }
                : { 'apns-priority': '5', 'apns-push-type': 'background' },
            payload: {
                aps
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
                'not configured. Set FIREBASE_SERVICE_ACCOUNT_BASE64 (or ' +
                'FIREBASE_CREDENTIAL_FILE) — or place ' +
                `${DEFAULT_CRED_FILENAME} next to server.js — to deliver ` +
                'mobile push notifications. (This warning is shown once.)'
            );
        }
        const error = new Error('FCM sender not configured (no Firebase Admin credentials available)');
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

// ─── Diagnostics ────────────────────────────────────────────────────────────
// Used by the /fcm-status admin route so operators can verify that the
// service-account credential they provisioned is parseable, that
// firebase-admin can initialize with it, and that Google's token endpoint
// accepts it. NEVER includes the private key in the response.
async function getDiagnostics({ probe = false } = {}) {
    let envSource = null;
    let credentialFilePath = null;
    if (String(process.env.FIREBASE_SERVICE_ACCOUNT_BASE64 || '').trim()) {
        envSource = 'FIREBASE_SERVICE_ACCOUNT_BASE64';
    } else if (String(process.env.FIREBASE_SERVICE_ACCOUNT_JSON || '').trim()) {
        envSource = 'FIREBASE_SERVICE_ACCOUNT_JSON';
    } else if (String(process.env.GOOGLE_APPLICATION_CREDENTIALS || '').trim()) {
        envSource = 'GOOGLE_APPLICATION_CREDENTIALS';
    } else {
        const fileResolution = resolveCredentialFilePath();
        if (fileResolution) {
            envSource = fileResolution.source;
            credentialFilePath = fileResolution.path;
        }
    }

    const result = {
        configured: Boolean(envSource),
        envSource,
        credentialFilePath,
        serviceAccount: null,
        firebaseAdmin: { installed: false, initialized: false, error: null },
        accessTokenProbe: probe ? { ok: false, error: null, tokenPreview: null } : null
    };

    if (!envSource) {
        result.firebaseAdmin.error =
            'No Firebase Admin credentials configured. Set ' +
            'FIREBASE_SERVICE_ACCOUNT_BASE64 (preferred) to a base64-encoded ' +
            `service-account JSON, or place ${DEFAULT_CRED_FILENAME} next to ` +
            'server.js.';
        return result;
    }

    let parsed = null;
    try {
        parsed = loadServiceAccount();
    } catch (error) {
        result.firebaseAdmin.error = error.message;
        return result;
    }
    if (parsed && typeof parsed === 'object') {
        result.serviceAccount = {
            type: parsed.type || null,
            project_id: parsed.project_id || null,
            client_email: parsed.client_email || null,
            private_key_id: parsed.private_key_id || null,
            client_id: parsed.client_id || null,
            // Only expose whether the private key looks well-formed — never
            // the key itself.
            private_key_present: typeof parsed.private_key === 'string' &&
                parsed.private_key.includes('BEGIN PRIVATE KEY')
        };
    }

    try {
        // eslint-disable-next-line global-require
        require('firebase-admin');
        result.firebaseAdmin.installed = true;
    } catch (error) {
        result.firebaseAdmin.error = `firebase-admin not installed: ${error.message}`;
        return result;
    }

    let admin;
    try {
        admin = ensureAdminInitialized();
        result.firebaseAdmin.initialized = true;
    } catch (error) {
        result.firebaseAdmin.error = error.message;
        return result;
    }

    if (probe) {
        // Ask Google for an OAuth access token using the service-account
        // credential. If the key is wrong / revoked / clock-skewed Google
        // returns invalid_grant and we surface that here.
        try {
            const credential = admin.app().options && admin.app().options.credential;
            if (!credential || typeof credential.getAccessToken !== 'function') {
                throw new Error('Firebase Admin app has no credential.getAccessToken()');
            }
            const tokenResult = await credential.getAccessToken();
            const accessToken = tokenResult && tokenResult.access_token;
            result.accessTokenProbe.ok = Boolean(accessToken);
            if (accessToken) {
                // Only expose the first 12 chars so operators can verify a
                // token came back without leaking it into logs.
                result.accessTokenProbe.tokenPreview = `${String(accessToken).slice(0, 12)}…`;
                result.accessTokenProbe.expiresInSeconds = tokenResult.expires_in || null;
            } else {
                result.accessTokenProbe.error = 'No access_token returned by credential.getAccessToken()';
            }
        } catch (error) {
            result.accessTokenProbe.ok = false;
            result.accessTokenProbe.error = error && error.message ? error.message : String(error);
        }
    }

    return result;
}

module.exports = {
    isFcmSubscription,
    isFcmSenderConfigured,
    sendFcmNotification,
    extractToken,
    getDiagnostics
};
