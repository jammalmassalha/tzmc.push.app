const vapidKeys = {
    publicKey: process.env.VAPID_PUBLIC_KEY || "BNgK2Le8hUyXIrFeuHJJsHwjOUkK5y5bf46QH80Ybd1AoQFfQDEanVCfjo9HwqdJwWoD2-2pxxgTRdTasf9YYMk",
    privateKey: process.env.VAPID_PRIVATE_KEY || "fMQqCaakMboV7LEV57wJhxPAdyppOBRDBjRDVQBxg1s"
};
const express = require('express');
const http = require('http');
const webpush = require('web-push');
const bodyParser = require('body-parser');
const multer = require('multer'); 
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const crypto = require('crypto');
const { Server: SocketIOServer } = require('socket.io');
const { Worker } = require('node:worker_threads');
const { createAuthorizedUserMiddleware } = require('./backend/middleware/authorized-user.middleware');
const { registerAuthController } = require('./backend/controllers/auth.controller');
const fcmSender = require('./backend/services/fcm-sender');
const { createFlutterPushService } = require('./backend/services/flutter-push-service');
const { registerFlutterPushRoutes } = require('./backend/routes/flutter-push.routes');
const { registerMessageController } = require('./backend/controllers/message.controller');
const { registerShuttleController } = require('./backend/controllers/shuttle.controller');
const { registerHelpdeskController } = require('./backend/controllers/helpdesk.controller');
const {
    createSheetIntegrationServiceFromEnv,
    createMysqlLogsServiceFromEnv,
    createWebhookRegistryFromEnv,
    createRedisStateStoreFromEnv,
    SessionTokenJweService,
    looksLikeJweCompactToken,
    UploadSecurityService,
    NotificationService,
    SessionService
} = require('./backend/dist/services');

const fetch = (...args) => {
    if (typeof globalThis.fetch === 'function') {
        return globalThis.fetch(...args);
    }
    return import('node-fetch').then((module) => module.default(...args));
};

const sheetIntegrationService = createSheetIntegrationServiceFromEnv(process.env);
const mysqlLogsService = createMysqlLogsServiceFromEnv(process.env);
const webhookRegistryService = createWebhookRegistryFromEnv(process.env);
const GOOGLE_SHEET_URL = sheetIntegrationService.googleSheetUrl;
const redisStateStorePromise = createRedisStateStoreFromEnv(process.env)
    .then((store) => {
        if (store && store.isEnabled) {
            console.log('[REDIS] Connected state store.');
        }
        return store;
    })
    .catch((error) => {
        console.warn('[REDIS] Running without Redis:', error && error.message ? error.message : error);
        return null;
    });

// --- 1. SETUP UPLOADS FOLDER ---
const uploadDir = path.join(__dirname, 'uploads');
const uploadSecurityWorkerPath = path.join(__dirname, 'backend', 'dist', 'services', 'upload-security-worker.js');
const uploadSecurityService = new UploadSecurityService({
    uploadDir,
    workerPath: uploadSecurityWorkerPath
});
const app = express();
const httpServer = http.createServer(app);
app.disable('x-powered-by');

const DEFAULT_ALLOWED_HOSTS = ['tzmc.co.il', 'www.tzmc.co.il', '*.tzmc.co.il', 'localhost', '127.0.0.1', '::1'];
// Auto-detect the server's own hostname and IP addresses so requests arriving
// via the machine's public/private IPs are not rejected by the host-header guard.
(() => {
    try {
        const os = require('os');
        const hostname = os.hostname();
        if (hostname) DEFAULT_ALLOWED_HOSTS.push(hostname);
        const ifaces = os.networkInterfaces();
        for (const addrs of Object.values(ifaces)) {
            for (const addr of addrs) {
                if (addr.address && !DEFAULT_ALLOWED_HOSTS.includes(addr.address)) {
                    DEFAULT_ALLOWED_HOSTS.push(addr.address);
                }
            }
        }
    } catch (_) { /* ignore – os module unavailable */ }
})();
const ALLOWED_HOSTS = buildHostAllowlist(
    String(process.env.ALLOWED_HOSTS || DEFAULT_ALLOWED_HOSTS.join(','))
);
if (!ALLOWED_HOSTS.allowAny) {
    console.log(`[HOST-GUARD] Allowed exact hosts: ${[...ALLOWED_HOSTS.exactHosts].join(', ') || '(none)'}`);
    if (ALLOWED_HOSTS.wildcardSuffixes.length) {
        console.log(`[HOST-GUARD] Allowed wildcard suffixes: ${ALLOWED_HOSTS.wildcardSuffixes.map(s => `*.${s}`).join(', ')}`);
    }
    console.log('[HOST-GUARD] Set ALLOWED_HOSTS=* environment variable to allow all hosts');
}

const CONTENT_SECURITY_POLICY = [
    "default-src 'self' https: data: blob:",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "img-src 'self' https: data: blob:",
    "font-src 'self' https: data:",
    "style-src 'self' https: 'unsafe-inline'",
    "script-src 'self' https: 'unsafe-inline' 'unsafe-eval'",
    "connect-src 'self' https: wss:",
    "worker-src 'self' blob:",
    "media-src 'self' https: data: blob:",
    "form-action 'self'",
    "manifest-src 'self'",
    'upgrade-insecure-requests'
].join('; ');

function normalizeHostValue(rawValue) {
    const value = String(rawValue || '').trim().toLowerCase();
    if (!value) {
        return '';
    }
    const primaryValue = value.split(',')[0].trim();
    if (!primaryValue) {
        return '';
    }
    const candidate = primaryValue.includes('://')
        ? primaryValue
        : `http://${primaryValue}`;
    try {
        const parsed = new URL(candidate);
        return String(parsed.hostname || '').trim().toLowerCase().replace(/\.+$/, '');
    } catch (error) {
        return primaryValue
            .replace(/^\[|\]$/g, '')
            .replace(/:\d+$/, '')
            .replace(/\.+$/, '')
            .trim()
            .toLowerCase();
    }
}

function buildHostAllowlist(rawValue) {
    const exactHosts = new Set();
    const wildcardSuffixes = [];
    let allowAny = false;
    const parts = String(rawValue || '')
        .split(',')
        .map((entry) => String(entry || '').trim())
        .filter(Boolean);

    for (const part of parts) {
        const normalizedPart = part.toLowerCase();
        if (normalizedPart === '*') {
            allowAny = true;
            continue;
        }
        const hasWildcardPrefix = normalizedPart.startsWith('*.') || normalizedPart.startsWith('.');
        const candidate = hasWildcardPrefix
            ? normalizedPart.replace(/^\*\./, '').replace(/^\./, '')
            : normalizedPart;
        const normalizedHost = normalizeHostValue(candidate);
        if (!normalizedHost) {
            continue;
        }
        if (hasWildcardPrefix) {
            wildcardSuffixes.push(normalizedHost);
            continue;
        }
        exactHosts.add(normalizedHost);
    }

    return {
        allowAny,
        exactHosts,
        wildcardSuffixes
    };
}

function isAllowedHost(hostname) {
    if (ALLOWED_HOSTS.allowAny) {
        return true;
    }
    const normalizedHost = normalizeHostValue(hostname);
    if (!normalizedHost) {
        return false;
    }
    if (ALLOWED_HOSTS.exactHosts.has(normalizedHost)) {
        return true;
    }
    return ALLOWED_HOSTS.wildcardSuffixes.some((suffix) => {
        return normalizedHost === suffix || normalizedHost.endsWith(`.${suffix}`);
    });
}

function parseHostHeaderValues(rawValue) {
    return String(rawValue || '')
        .split(',')
        .map((entry) => normalizeHostValue(entry))
        .filter(Boolean);
}

app.use((req, res, next) => {
    const hostHeaderValue = req.headers.host || '';
    const requestHost = parseHostHeaderValues(hostHeaderValue)[0] || '';
    if (!isAllowedHost(requestHost)) {
        console.warn(`[SECURITY] Rejected request with invalid host header "${hostHeaderValue}" on ${req.originalUrl || req.url}`);
        return res.status(400).json({ error: 'Invalid Host header' });
    }

    const forwardedHostHeader = req.headers['x-forwarded-host'] || '';
    const forwardedHosts = parseHostHeaderValues(forwardedHostHeader);
    if (forwardedHosts.some((candidateHost) => !isAllowedHost(candidateHost))) {
        console.warn(`[SECURITY] Rejected request with invalid x-forwarded-host "${forwardedHostHeader}" on ${req.originalUrl || req.url}`);
        return res.status(400).json({ error: 'Invalid Host header' });
    }

    next();
});

app.use((req, res, next) => {
    const forwardedProto = String(req.headers['x-forwarded-proto'] || '').toLowerCase();
    const isHttpsRequest = req.secure || forwardedProto.includes('https');
    if (isHttpsRequest) {
        res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }
    res.setHeader('Content-Security-Policy', CONTENT_SECURITY_POLICY);
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
});

const SERVER_VERSION = '1.74'; // Modularize server.js into UploadSecurityService, NotificationService, SessionService
const SERVER_RELEASE_NOTES = [
    'All groups data now stored in MySQL database.',
    'Groups are loaded from DB on first open after update.',
    'Community groups now managed from database.',
    'Group data cleared and refreshed from DB on first load after update.',
    'Update available toast with reload button.',
    'Release notes modal for new versions.',
    'Create groups and send messages to group members.',
    'Group messages show group name for recipients.',
    'Group updates sync members and names.',
    'Group message body no longer duplicates sender name.',
    'Group list now fetches from server on refresh.',
    'Community groups are admin-only for sending.',
    'Community group reactions supported.',
    'Reaction updates persist per user.',
    'Reaction notifications for admins.',
    'Reactions update instantly with background submit.'
];

const fsp = fs.promises;
const stateDir = path.join(__dirname, 'data');
const stateFile = path.join(stateDir, 'state.json');
const groupsDbFile = path.join(stateDir, 'groups.db.json');
let stateSaveTimer = null;
let activeRedisStateStore = null;
let redisQueuePubSubActive = false;
let redisQueuePubSubStartPromise = null;
let mysqlStateEnabled = false; // Set to true on successful MySQL state load

let unreadCounts = {};
let groups = {};
let deviceSubscriptionsByUser = {};

function replaceObjectContents(target, source) {
    if (!target || typeof target !== 'object') {
        return;
    }
    Object.keys(target).forEach((key) => {
        delete target[key];
    });
    if (source && typeof source === 'object') {
        Object.assign(target, source);
    }
}



app.use((req, res, next) => {
    // If the file is HTML, JS, or CSS, tell browser not to cache it
    if (req.path.endsWith('.html') || req.path.endsWith('.js') || req.path.endsWith('.css')) {
        res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
        res.set('Pragma', 'no-cache');
        res.set('Expires', '0');
    }
    next();
});

app.use(express.static(path.join(__dirname, 'public')));
app.use('/notify', express.static(path.join(__dirname, 'public')));

const authenticatedUploadsStaticMiddleware = express.static(uploadDir, {
    fallthrough: true,
    redirect: false,
    dotfiles: 'deny',
    index: false,
    setHeaders: (res) => {
        res.setHeader('Cache-Control', 'private, max-age=300, must-revalidate');
        res.setHeader('X-Content-Type-Options', 'nosniff');
    }
});
app.use(['/uploads', '/notify/uploads'], (req, res, next) => {
    const session = extractSessionFromRequest(req);
    const sessionUser = normalizeUserCandidate(
        (session && session.user) || req.authUser
    );
    if (!sessionUser) {
        return res.status(401).json({ error: 'Authentication required' });
    }
    const requestPath = String(req.path || '').trim();
    if (!requestPath || requestPath === '/' || requestPath === '.') {
        return res.status(404).json({ error: 'File not found' });
    }
    req.authSession = req.authSession || session || null;
    req.authUser = sessionUser;
    return next();
}, authenticatedUploadsStaticMiddleware, (_req, res) => {
    return res.status(404).json({ error: 'File not found' });
});


app.use(bodyParser.json());
// --- CORS CONFIGURATION ---
// When the browser sends credentialed requests (withCredentials/credentials:'include'),
// the response must echo a specific origin – the wildcard '*' is not allowed. We
// reflect the request origin if it is allowed by the host allowlist (which already
// covers tzmc.co.il, www.tzmc.co.il, *.tzmc.co.il, localhost, etc.).
const corsOptions = {
    origin: (origin, callback) => {
        if (!origin) {
            // Same-origin / non-browser requests (curl, server-to-server) – allow.
            return callback(null, true);
        }
        let originHost = '';
        try {
            originHost = new URL(origin).hostname;
        } catch (_) {
            originHost = '';
        }
        if (!originHost) {
            return callback(null, false);
        }
        if (isAllowedHost(originHost)) {
            // Reflect the exact origin so credentialed requests pass the preflight.
            return callback(null, true);
        }
        return callback(null, false);
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
        'Content-Type',
        'Authorization',
        'Cache-Control',
        'Pragma',
        'Last-Event-ID',
        'X-Requested-With',
        'X-CSRF-Token'
    ]
};
app.use(cors(corsOptions));

app.options(/.*/, cors(corsOptions));

// [FIX] INCREASE LIMIT TO 50MB (Default is only 100kb)
app.use(bodyParser.json({ limit: '350mb' }));
app.use(bodyParser.urlencoded({ limit: '350mb', extended: true }));

if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir);
}

// ── Upload functions delegated to UploadSecurityService ──
function isImageUpload(file) { return uploadSecurityService.isImageUpload(file || {}); }
function isPdfUpload(file) { return uploadSecurityService.isPdfUpload(file || {}); }
function isAllowedMainUpload(file) { return uploadSecurityService.isAllowedMainUpload(file || {}); }
function isAllowedThumbnailUpload(file) { return uploadSecurityService.isAllowedThumbnailUpload(file || {}); }
function buildSafeUploadFilename(file) { return uploadSecurityService.buildSafeUploadFilename(file || {}); }
function safelyDeleteUploadedFile(file) { return uploadSecurityService.safelyDeleteUploadedFile(file); }
function validateUploadedFileSecurity(file, options) { return uploadSecurityService.validateUploadedFileSecurity(file || {}, options); }

// --- 2. STORAGE CONFIG ---
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    cb(null, buildSafeUploadFilename(file));
  }
});
const upload = multer({
    storage: storage,
    fileFilter: (req, file, cb) => {
        if (!file || !file.fieldname) {
            return cb(new Error('Invalid upload payload'));
        }
        if (file.fieldname === 'file') {
            if (isAllowedMainUpload(file)) {
                return cb(null, true);
            }
            return cb(new Error('Only image and PDF files are allowed'));
        }
        if (file.fieldname === 'thumbnail') {
            if (isAllowedThumbnailUpload(file)) {
                return cb(null, true);
            }
            return cb(new Error('Thumbnail must be an image file'));
        }
        return cb(new Error(`Unsupported upload field: ${file.fieldname}`));
    }
});
const uploadFields = upload.fields([{ name: 'file', maxCount: 1 }, { name: 'thumbnail', maxCount: 1 }]);
function uploadFieldsValidated(req, res, next) {
    uploadFields(req, res, (error) => {
        if (!error) {
            return next();
        }
        const message = error && error.message ? error.message : 'Invalid upload request';
        return res.status(400).json({ error: message });
    });
}

// --- 3. WEB PUSH CONFIG ---


webpush.setVapidDetails(
    'mailto:jmassalha@tzmc.gov.il',
    vapidKeys.publicKey,
    vapidKeys.privateKey
);



// ======================================================
// [NEW] 4. POLLING MAILBOX (REDIS STREAMS + FALLBACK MEMORY)
// ======================================================
let messageQueue = {}; 
const sseClients = new Map();
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
    clientSet.forEach(res => res.write(payload));
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

function notifyRealtimeClients(username, messageObj) {
    notifySseClients(username, messageObj);
    notifyWebsocketClients(username, messageObj);
}

function dispatchRegisteredWebhookAsync(messageObj) {
    const webhookUrl = webhookRegistryService.resolveFromMessage(messageObj);
    if (!webhookUrl) {
        return;
    }
    fetchWithRetry(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(messageObj || {})
    }, { timeoutMs: 10000, retries: 1, backoffMs: 400 }).catch((error) => {
        console.warn(
            `[WEBHOOK] Failed dispatch to ${webhookUrl}:`,
            error && error.message ? error.message : error
        );
    });
}

async function ensureRedisQueuePubSubBridge() {
    if (redisQueuePubSubActive) {
        return true;
    }
    if (redisQueuePubSubStartPromise) {
        return redisQueuePubSubStartPromise;
    }
    if (!activeRedisStateStore || !activeRedisStateStore.isEnabled || typeof activeRedisStateStore.subscribeToQueueEvents !== 'function') {
        return false;
    }

    redisQueuePubSubStartPromise = activeRedisStateStore.subscribeToQueueEvents((event) => {
        const sourceId = String(event && event.sourceId ? event.sourceId : '').trim();
        const localPublisherId = activeRedisStateStore && activeRedisStateStore.queuePublisherId
            ? String(activeRedisStateStore.queuePublisherId).trim()
            : '';
        if (sourceId && localPublisherId && sourceId === localPublisherId) {
            return;
        }

        const normalizedUser = normalizeUserCandidate(event && event.user);
        if (!normalizedUser) return;
        const messageObj = event && event.message && typeof event.message === 'object'
            ? event.message
            : null;
        if (!messageObj) return;
        notifyRealtimeClients(normalizedUser, messageObj);
    }).then((subscribed) => {
        redisQueuePubSubActive = Boolean(subscribed);
        return redisQueuePubSubActive;
    }).catch((error) => {
        console.warn('[REDIS] Queue pub/sub bridge failed:', error && error.message ? error.message : error);
        redisQueuePubSubActive = false;
        return false;
    }).finally(() => {
        redisQueuePubSubStartPromise = null;
    });

    return redisQueuePubSubStartPromise;
}

// Helper: Add message to queue (NORMALIZED TO LOWERCASE)
async function addToQueue(targetUser, messageObj) {
    const recipients = Array.isArray(targetUser) ? targetUser : [targetUser];
    const queueWriteTasks = [];
    const deliveries = [];

    recipients.forEach((user) => {
        const normalizedUser = normalizeUserCandidate(user);
        if (!normalizedUser) return;

        const queueEntry = (messageObj && typeof messageObj === 'object')
            ? { ...messageObj, recipient: normalizedUser }
            : {
                recipient: normalizedUser,
                body: String(messageObj || ''),
                timestamp: Date.now()
            };

        deliveries.push({ normalizedUser, queueEntry });
        const hasRedisQueue = Boolean(activeRedisStateStore && activeRedisStateStore.isEnabled);
        if (hasRedisQueue) {
            queueWriteTasks.push(
                activeRedisStateStore.enqueueMessages(normalizedUser, [queueEntry]).catch((error) => {
                    console.warn('[REDIS] enqueue failed:', error && error.message ? error.message : error);
                    if (!messageQueue[normalizedUser]) {
                        messageQueue[normalizedUser] = [];
                    }
                    messageQueue[normalizedUser].push(queueEntry);
                })
            );
            return;
        }

        if (!messageQueue[normalizedUser]) {
            messageQueue[normalizedUser] = [];
        }
        messageQueue[normalizedUser].push(queueEntry);
    });

    if (queueWriteTasks.length) {
        await Promise.allSettled(queueWriteTasks);
    }

    deliveries.forEach(({ normalizedUser, queueEntry }) => {
        dispatchRegisteredWebhookAsync(queueEntry);
        notifyRealtimeClients(normalizedUser, queueEntry);
    });
    scheduleStateSave();
}
// ======================================================

loadState().catch(err => console.warn('[STATE] Init failed:', err.message));

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const generateMessageId = () => {
    if (crypto.randomUUID) return crypto.randomUUID();
    return `srv_${Date.now()}_${Math.random().toString(16).slice(2)}`;
};

const fetchWithRetry = async (url, options = {}, retryOptions = {}) => {
    const { retries = 2, timeoutMs = 10000, backoffMs = 500 } = retryOptions;
    let lastError;
    for (let attempt = 0; attempt <= retries; attempt++) {
        const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
        const timeoutId = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
        try {
            const response = await fetch(url, {
                ...options,
                signal: controller ? controller.signal : undefined
            });
            if (!response.ok && attempt < retries && (response.status >= 500 || response.status === 429)) {
                await sleep(backoffMs * Math.pow(2, attempt));
                continue;
            }
            return response;
        } catch (err) {
            lastError = err;
            if (attempt < retries) {
                await sleep(backoffMs * Math.pow(2, attempt));
                continue;
            }
            throw err;
        } finally {
            if (timeoutId) clearTimeout(timeoutId);
        }
    }
    throw lastError;
};

const normalizeUserKey = (value) => String(value || '').trim().toLowerCase();
const normalizeGroupType = (value) => (value === 'community' ? 'community' : 'group');

// ── Community Groups: loaded from DB, with hardcoded fallbacks for initial seed ──
const SEED_COMMUNITY_GROUPS = [
    {
        groupId: String(process.env.DOVRUT_GROUP_ID || 'דוברות').trim() || 'דוברות',
        groupName: String(process.env.DOVRUT_GROUP_ID || 'דוברות').trim() || 'דוברות',
        members: [],
        writers: parseUsernamesInput(process.env.DOVRUT_ALLOWED_WRITERS || '0506501040,0506267447,0543108095')
    },
    {
        groupId: String(process.env.DOVRUT_TEST_GROUP_ID || 'בדיקה - דוברות').trim() || 'בדיקה - דוברות',
        groupName: String(process.env.DOVRUT_TEST_GROUP_ID || 'בדיקה - דוברות').trim() || 'בדיקה - דוברות',
        members: parseUsernamesInput(process.env.DOVRUT_TEST_GROUP_MEMBERS || '0546799693,0550000001,0547997273,0505203520'),
        writers: parseUsernamesInput(process.env.DOVRUT_TEST_ALLOWED_WRITERS || '0546799693')
    }
];

const hardcodedCommunityGroupsByKey = new Map();
// Keep a list of community group IDs for passing to controllers (mutable, refreshed from DB).
let communityGroupIds = [];

function registerHardcodedCommunityGroup(groupKeys, writerSet, options = {}) {
    const keys = Array.isArray(groupKeys) ? groupKeys : [groupKeys];
    const normalizedKeys = Array.from(new Set(keys.map((value) => normalizeUserKey(value)).filter(Boolean)));
    if (!normalizedKeys.length) return;
    const normalizedWriters = new Set(
        Array.from(writerSet || []).map((value) => normalizeUserKey(value)).filter(Boolean)
    );
    const normalizedMembers = Array.isArray(options.members)
        ? Array.from(new Set(options.members.map((value) => normalizeUserKey(value)).filter(Boolean)))
        : [];
    const policy = {
        key: normalizedKeys[0],
        writers: normalizedWriters,
        members: normalizedMembers
    };
    normalizedKeys.forEach((key) => {
        hardcodedCommunityGroupsByKey.set(key, policy);
    });
}

function rebuildCommunityGroupsFromConfigs(configs) {
    hardcodedCommunityGroupsByKey.clear();
    const ids = [];
    for (const cfg of configs) {
        const gid = String(cfg.groupId || '').trim();
        if (!gid) continue;
        ids.push(gid);
        const writerSet = new Set(
            (cfg.writers || []).map((v) => normalizeUserKey(v)).filter(Boolean)
        );
        registerHardcodedCommunityGroup(gid, writerSet, {
            members: cfg.members || []
        });
    }
    communityGroupIds = ids;
    console.log(`[COMMUNITY-GROUPS] Loaded ${configs.length} community group(s) from DB: ${ids.join(', ')}`);
}

async function loadAndSeedCommunityGroups() {
    try {
        // Seed the DB with defaults if empty
        for (const seed of SEED_COMMUNITY_GROUPS) {
            await mysqlLogsService.seedCommunityGroupIfEmpty(seed);
        }
        // Load from DB
        const configs = await mysqlLogsService.loadCommunityGroups();
        if (configs.length > 0) {
            rebuildCommunityGroupsFromConfigs(configs);
            return;
        }
    } catch (err) {
        console.warn('[COMMUNITY-GROUPS] Failed to load from DB, using seed fallback:', err && err.message ? err.message : err);
    }
    // Fallback: use seed values directly
    rebuildCommunityGroupsFromConfigs(SEED_COMMUNITY_GROUPS);
}

// Initialize synchronously with seed values, then async-load from DB will override
rebuildCommunityGroupsFromConfigs(SEED_COMMUNITY_GROUPS);
const SUBSCRIPTION_LOOKUP_BATCH_SIZE = Math.max(
    10,
    Number(process.env.SUBSCRIPTION_LOOKUP_BATCH_SIZE || 40) || 40
);
const SUBSCRIPTION_CACHE_TTL_MS = 2 * 60 * 1000;
const subscriptionCache = new Map();
const AUTH_REFRESH_PUSH_TYPE = 'subscription-auth-refresh';
const AUTH_REFRESH_PUSH_URGENCY = 'high';
const AUTH_REFRESH_PUSH_TTL_SECONDS = 300;
const AUTH_REFRESH_MAX_DISCOVERY_USERS = 500;
const AUTH_REFRESH_CONTACT_DISCOVERY_CONCURRENCY = 8;
const AUTH_REFRESH_CONTACT_DISCOVERY_MAX_SEEDS = 120;
const AUTH_REFRESH_FAILURE_DETAILS_LIMIT = 80;
const AUTH_REFRESH_STALE_CLEANUP_BATCH_SIZE = 40;
const AUTH_REFRESH_SCHEDULER_ENABLED = String(process.env.AUTH_REFRESH_SCHEDULER_ENABLED || 'true').trim().toLowerCase() !== 'false';
const AUTH_REFRESH_SCHEDULER_DAILY_TIME = parseAuthRefreshSchedulerDailyTime(
    process.env.AUTH_REFRESH_SCHEDULER_DAILY_TIME || '00:01'
);
const AUTH_REFRESH_SCHEDULER_FORCE_RESUBSCRIBE = String(
    process.env.AUTH_REFRESH_SCHEDULER_FORCE_RESUBSCRIBE || ''
).trim().toLowerCase() === 'true';
const AUTH_REFRESH_SCHEDULER_DEVICE_TYPES = String(
    process.env.AUTH_REFRESH_SCHEDULER_DEVICE_TYPES || 'pc,mobile'
).trim();
const AUTH_REFRESH_SCHEDULER_EXCLUDE_IOS_ENDPOINTS = String(
    process.env.AUTH_REFRESH_SCHEDULER_EXCLUDE_IOS_ENDPOINTS || 'true'
).trim().toLowerCase() !== 'false';
const APP_SERVER_TOKEN = String(
    process.env.APP_SERVER_TOKEN ||
    process.env.GOOGLE_SHEET_APP_SERVER_TOKEN ||
    ''
).trim();
const CHECK_QUEUE_SERVER_TOKEN = String(
    process.env.CHECK_QUEUE_SERVER_TOKEN ||
    process.env.GOOGLE_SHEET_CHECK_QUEUE_TOKEN ||
    APP_SERVER_TOKEN
).trim();
const SESSION_COOKIE_NAME = String(process.env.SESSION_COOKIE_NAME || 'tzmc_session').trim() || 'tzmc_session';
const SESSION_COOKIE_TTL_MS = Math.max(
    5 * 60 * 1000,
    Number(process.env.SESSION_COOKIE_TTL_MS || 30 * 24 * 60 * 60 * 1000) || 30 * 24 * 60 * 60 * 1000
);
const SESSION_RENEWAL_THRESHOLD_MS = Math.floor(SESSION_COOKIE_TTL_MS / 2);
const SESSION_COOKIE_SAME_SITE = String(process.env.SESSION_COOKIE_SAMESITE || 'Lax').trim();
const SESSION_COOKIE_SECURE = String(process.env.SESSION_COOKIE_SECURE || 'true').trim().toLowerCase() !== 'false';
const SESSION_SIGNING_SECRET = String(
    process.env.SESSION_SIGNING_SECRET ||
    APP_SERVER_TOKEN ||
    CHECK_QUEUE_SERVER_TOKEN ||
    vapidKeys.privateKey ||
    ''
).trim();
const SESSION_JWE_SECRET = String(
    process.env.SESSION_JWE_SECRET ||
    SESSION_SIGNING_SECRET
).trim();
const sessionTokenJweService = SESSION_JWE_SECRET
    ? new SessionTokenJweService(SESSION_JWE_SECRET)
    : null;
// Declared here (before SessionService) so it is available during construction.
const activeSessionIdsByUser = new Map();
const sessionService = new SessionService(
    {
        signingSecret: SESSION_SIGNING_SECRET,
        cookieName: SESSION_COOKIE_NAME,
        cookieTtlMs: SESSION_COOKIE_TTL_MS,
        cookieSameSite: SESSION_COOKIE_SAME_SITE,
        cookieSecure: SESSION_COOKIE_SECURE,
        jweService: sessionTokenJweService,
        looksLikeJweCompactToken
    },
    {
        normalizeUserCandidate,
        activeSessionIdsByUser
    }
);
const SESSION_USER_PATTERN = /^0\d{9}$/;
const BADGE_RESET_ALL_ALLOWED_USERS = parseUsernamesInput(
    process.env.BADGE_RESET_ALL_ALLOWED_USERS || '0546799693'
);
const VERSION_UPDATE_BROADCAST_ALLOWED_USERS = parseUsernamesInput(
    process.env.VERSION_UPDATE_BROADCAST_ALLOWED_USERS || '0546799693'
);
const AUTH_SESSION_RATE_LIMIT_WINDOW_MS = Math.max(
    60 * 1000,
    Number(process.env.AUTH_SESSION_RATE_LIMIT_WINDOW_MS || 10 * 60 * 1000) || 10 * 60 * 1000
);
const AUTH_SESSION_RATE_LIMIT_MAX_PER_IP = Math.max(
    3,
    Number(process.env.AUTH_SESSION_RATE_LIMIT_MAX_PER_IP || 18) || 18
);
const AUTH_SESSION_RATE_LIMIT_MAX_PER_USER = Math.max(
    2,
    Number(process.env.AUTH_SESSION_RATE_LIMIT_MAX_PER_USER || 8) || 8
);
const AUTH_SESSION_REQUIRE_CONTACT_VERIFICATION = String(
    process.env.AUTH_SESSION_REQUIRE_CONTACT_VERIFICATION || 'false'
).trim().toLowerCase() === 'true';
const AUTH_CODE_DIGITS = 6;
const AUTH_CODE_PATTERN = new RegExp(`^\\d{${AUTH_CODE_DIGITS}}$`);
const AUTH_CODE_TTL_SECONDS = Math.max(
    60,
    Number(process.env.AUTH_CODE_TTL_SECONDS || 5 * 60) || 5 * 60
);
const AUTH_CODE_RATE_LIMIT_WINDOW_MS = Math.max(
    60 * 1000,
    Number(process.env.AUTH_CODE_RATE_LIMIT_WINDOW_MS || 10 * 60 * 1000) || 10 * 60 * 1000
);
const AUTH_CODE_REQUEST_RATE_LIMIT_MAX_PER_IP = Math.max(
    2,
    Number(process.env.AUTH_CODE_REQUEST_RATE_LIMIT_MAX_PER_IP || 12) || 12
);
const AUTH_CODE_REQUEST_RATE_LIMIT_MAX_PER_USER = Math.max(
    2,
    Number(process.env.AUTH_CODE_REQUEST_RATE_LIMIT_MAX_PER_USER || 6) || 6
);
const AUTH_CODE_VERIFY_RATE_LIMIT_MAX_PER_IP = Math.max(
    3,
    Number(process.env.AUTH_CODE_VERIFY_RATE_LIMIT_MAX_PER_IP || 24) || 24
);
const AUTH_CODE_VERIFY_RATE_LIMIT_MAX_PER_USER = Math.max(
    3,
    Number(process.env.AUTH_CODE_VERIFY_RATE_LIMIT_MAX_PER_USER || 12) || 12
);
const AUTH_CODE_REQUIRE_REGISTERED_USER = String(
    process.env.AUTH_CODE_REQUIRE_REGISTERED_USER || 'false'
).trim().toLowerCase() === 'true';
const INFORU_SMS_URL = String(process.env.INFORU_SMS_URL || 'https://uapi.inforu.co.il/SendMessageXml.ashx').trim();
const INFORU_USERNAME = String(process.env.INFORU_USERNAME || 'tzmcgovil').trim();
const INFORU_API_TOKEN = String(process.env.INFORU_API_TOKEN || '088a13e2-c2d9-4518-8c0c-2e531c3033de').trim();
const INFORU_SENDER = String(process.env.INFORU_SENDER || 'Tzafon').trim();
const AUTH_CODE_SMS_TEMPLATE = String(
    process.env.AUTH_CODE_SMS_TEMPLATE || 'קוד אימות לכניסה לאפליקציה: {{code}}'
).trim();
const AUTH_CODE_SMS_DESTINATION_OVERRIDES = new Map([
    ['0550000001', '0546799693']
]);
const AUTH_CODE_SHEET_TOKEN = String(
    process.env.AUTH_CODE_SHEET_TOKEN ||
    APP_SERVER_TOKEN ||
    CHECK_QUEUE_SERVER_TOKEN ||
    ''
).trim();
const CSRF_PROTECTION_ENABLED = String('false').trim().toLowerCase() === 'true';
const CSRF_HEADER_NAME = 'x-csrf-token';
const DELIVERY_TELEMETRY_RETENTION_MS = Math.max(
    60 * 60 * 1000,
    Number(7 * 24 * 60 * 60 * 1000) || 7 * 24 * 60 * 60 * 1000
);
const DELIVERY_TELEMETRY_MAX_DEVICES = Math.max(
    100,
    Number(process.env.DELIVERY_TELEMETRY_MAX_DEVICES || 2000) || 2000
);
const MOBILE_REREGISTER_PUSH_TYPE = 'mobile-re-register-prompt';
const MOBILE_REREGISTER_DEFAULT_CAMPAIGN_ID = 'mobile-reregister-temp-v1';
const MOBILE_REREGISTER_DEFAULT_TITLE = 'Reconnect notifications';
const MOBILE_REREGISTER_DEFAULT_BODY = 'Open TZMC once to restore notifications on this device.';
const MOBILE_REREGISTER_DEFAULT_URL = '/subscribes/';
const MOBILE_REREGISTER_PUSH_URGENCY = 'high';
const MOBILE_REREGISTER_PUSH_TTL_SECONDS = 24 * 60 * 60;
const MOBILE_REREGISTER_SEND_CONCURRENCY = 20;
const MOBILE_REREGISTER_MAX_TRACKED_CAMPAIGNS = 20;
const SHUTTLE_CHAT_NAME = 'הזמנת הסעה';
const SHUTTLE_USER_ORDERS_URL = sheetIntegrationService.shuttleUserOrdersUrl;
const SHUTTLE_REMINDER_ENABLED = false; String(process.env.SHUTTLE_REMINDER_ENABLED || 'true').trim().toLowerCase() !== 'false';
const SHUTTLE_REMINDER_INTERVAL_MS = Math.max(
    15 * 1000,
    Number(process.env.SHUTTLE_REMINDER_INTERVAL_MS || 60 * 1000) || 60 * 1000
);
const SHUTTLE_REMINDER_USER_REFRESH_MS = Math.max(
    30 * 1000,
    Number(process.env.SHUTTLE_REMINDER_USER_REFRESH_MS || 2 * 60 * 1000) || 2 * 60 * 1000
);
const SHUTTLE_REMINDER_USERS_DISCOVERY_REFRESH_MS = Math.max(
    60 * 1000,
    Number(process.env.SHUTTLE_REMINDER_USERS_DISCOVERY_REFRESH_MS || 10 * 60 * 1000) || 10 * 60 * 1000
);
const SHUTTLE_REMINDER_FETCH_TIMEOUT_MS = Math.max(
    8 * 1000,
    Number(process.env.SHUTTLE_REMINDER_FETCH_TIMEOUT_MS || 30 * 1000) || 30 * 1000
);
const SHUTTLE_REMINDER_FETCH_RETRIES = Math.max(
    0,
    Number(process.env.SHUTTLE_REMINDER_FETCH_RETRIES || 0) || 0
);
const SHUTTLE_REMINDER_LEAD_MS = 15 * 60 * 1000;
const SHUTTLE_REMINDER_SENT_TTL_MS = Math.max(
    24 * 60 * 60 * 1000,
    Number(process.env.SHUTTLE_REMINDER_SENT_TTL_MS || 14 * 24 * 60 * 60 * 1000) || 14 * 24 * 60 * 60 * 1000
);
const SHUTTLE_REMINDER_MAX_SENT_RECORDS = Math.max(
    500,
    Number(process.env.SHUTTLE_REMINDER_MAX_SENT_RECORDS || 5000) || 5000
);
const SHUTTLE_REMINDER_USER_PROCESS_BATCH = Math.max(
    1,
    Number(process.env.SHUTTLE_REMINDER_USER_PROCESS_BATCH || 6) || 6
);
const SHUTTLE_REMINDER_TIMEZONE = String(
    process.env.SHUTTLE_REMINDER_TIMEZONE || 'Asia/Jerusalem'
).trim() || 'Asia/Jerusalem';
const SHUTTLE_REMINDER_TITLE = String(
    process.env.SHUTTLE_REMINDER_TITLE || 'תזכורת להסעה בעוד 15 דקות'
).trim() || 'תזכורת להסעה בעוד 15 דקות';
const SHUTTLE_REMINDER_BODY_PREFIX = String(
    process.env.SHUTTLE_REMINDER_BODY_PREFIX || 'נותרו כ-15 דקות להסעה שלך'
).trim() || 'נותרו כ-15 דקות להסעה שלך';
const SHUTTLE_REMINDER_TYPE = 'shuttle-reminder-15m';
let subscriptionAuthRefreshState = {
    running: false,
    lastRunAt: 0,
    lastResult: null
};
let authRefreshSchedulerStarted = false;
let shuttleReminderSchedulerStarted = false;
let shuttleReminderSchedulerTimer = null;
let shuttleReminderState = {
    running: false,
    lastRunAt: 0,
    lastResult: null,
    lastTickTrigger: null
};
let shuttleReminderSentAtByKey = {};
const shuttleReminderKnownUsersCache = { at: 0, users: [] };
const shuttleReminderOrdersCacheByUser = {};
// activeSessionIdsByUser is declared earlier (before SessionService instantiation).
const authSessionRateLimitByIp = new Map();
const authSessionRateLimitByUser = new Map();
const authCodeRequestRateLimitByIp = new Map();
const authCodeRequestRateLimitByUser = new Map();
const authCodeVerifyRateLimitByIp = new Map();
const authCodeVerifyRateLimitByUser = new Map();
const deliveryTelemetryByDevice = new Map();
const RECENT_REPLY_MESSAGE_TTL_MS = Math.max(
    60 * 1000,
    Number(process.env.RECENT_REPLY_MESSAGE_TTL_MS || 10 * 60 * 1000) || 10 * 60 * 1000
);
const recentProcessedReplyMessages = new Map();
const RECENT_QUEUE_MESSAGE_TTL_MS = Math.max(
    30 * 1000,
    Number(process.env.RECENT_QUEUE_MESSAGE_TTL_MS || 3 * 60 * 1000) || 3 * 60 * 1000
);
const recentProcessedQueueMessages = new Map();
let mobileReregisterCampaignState = {
    running: false,
    lastRunAt: 0,
    lastResult: null,
    sentTargetsByCampaign: new Map()
};

function pruneRecentProcessedReplyMessages(nowTs = Date.now()) {
    for (const [messageId, processedAt] of recentProcessedReplyMessages.entries()) {
        if (!messageId) continue;
        if (!Number.isFinite(Number(processedAt)) || nowTs - Number(processedAt) > RECENT_REPLY_MESSAGE_TTL_MS) {
            recentProcessedReplyMessages.delete(messageId);
        }
    }
}

function pruneRecentProcessedQueueMessages(nowTs = Date.now()) {
    for (const [dedupKey, processedAt] of recentProcessedQueueMessages.entries()) {
        if (!dedupKey) continue;
        if (!Number.isFinite(Number(processedAt)) || nowTs - Number(processedAt) > RECENT_QUEUE_MESSAGE_TTL_MS) {
            recentProcessedQueueMessages.delete(dedupKey);
        }
    }
}

function hashStringToShortId(value = '') {
    const text = String(value || '');
    let hash = 0;
    for (let index = 0; index < text.length; index += 1) {
        hash = ((hash << 5) - hash + text.charCodeAt(index)) | 0;
    }
    return Math.abs(hash).toString(36);
}

function normalizeQueueTextForDedup(value = '') {
    return String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function buildSubscriptionCacheKey(usernames) {
    const values = Array.isArray(usernames) ? usernames : [usernames];
    const normalized = Array.from(
        new Set(values.map(normalizeUserKey).filter(Boolean))
    ).sort();
    return normalized.join(',');
}

function pruneSubscriptionCacheEndpoint(endpointToRemove) {
    if (!endpointToRemove) return;
    for (const [cacheKey, cacheEntry] of subscriptionCache.entries()) {
        const filtered = (cacheEntry.subscriptions || []).filter(
            (subscription) => subscription && subscription.endpoint !== endpointToRemove
        );
        if (filtered.length !== (cacheEntry.subscriptions || []).length) {
            subscriptionCache.set(cacheKey, {
                at: cacheEntry.at,
                subscriptions: filtered
            });
        }
    }
    if (removeLocalDeviceSubscriptionEndpoint(endpointToRemove)) {
        scheduleStateSave();
    }
}

function normalizeSubscriptionType(rawValue) {
    const normalized = String(rawValue || '').trim().toLowerCase();
    if (!normalized) return '';
    if (normalized === 'pc' || normalized === 'desktop' || normalized === 'web') return 'pc';
    if (normalized === 'mobile' || normalized === 'ios' || normalized === 'android') return 'mobile';
    return '';
}

function parseSubscriptionDeviceTypesInput(rawValue) {
    const values = [];
    if (Array.isArray(rawValue)) {
        values.push(...rawValue);
    } else if (typeof rawValue === 'string') {
        values.push(...rawValue.split(','));
    }
    const allowed = new Set();
    values.forEach((value) => {
        const normalizedText = String(value || '').trim().toLowerCase();
        if (normalizedText === 'all' || normalizedText === '*' || normalizedText === '%') {
            allowed.add('mobile');
            allowed.add('pc');
            return;
        }
        const normalized = normalizeSubscriptionType(value);
        if (normalized) {
            allowed.add(normalized);
        }
    });
    return Array.from(allowed);
}

function parseAuthRefreshSchedulerDailyTime(rawValue) {
    const fallback = {
        hour: 0,
        minute: 1,
        second: 0,
        label: '00:01'
    };
    const source = String(rawValue || '').trim();
    if (!source) return fallback;

    const match = source.match(/^(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?$/);
    if (!match) return fallback;

    const hour = Number(match[1]);
    const minute = Number(match[2]);
    const second = match[3] === undefined ? 0 : Number(match[3]);
    if (
        !Number.isInteger(hour) || hour < 0 || hour > 23 ||
        !Number.isInteger(minute) || minute < 0 || minute > 59 ||
        !Number.isInteger(second) || second < 0 || second > 59
    ) {
        return fallback;
    }

    const label = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}` +
        (second ? `:${String(second).padStart(2, '0')}` : '');
    return { hour, minute, second, label };
}

function isAppleWebPushEndpoint(endpointValue) {
    const endpoint = String(endpointValue || '').trim().toLowerCase();
    if (!endpoint) return false;
    return endpoint.includes('push.apple.com');
}

function sanitizeCampaignId(rawValue) {
    const source = String(rawValue || '').trim().toLowerCase();
    if (!source) {
        return MOBILE_REREGISTER_DEFAULT_CAMPAIGN_ID;
    }
    const normalized = source
        .replace(/[^a-z0-9._:-]+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 80);
    return normalized || MOBILE_REREGISTER_DEFAULT_CAMPAIGN_ID;
}

function parseBooleanInput(rawValue, defaultValue = false) {
    if (typeof rawValue === 'boolean') return rawValue;
    if (typeof rawValue === 'number') return rawValue !== 0;
    if (typeof rawValue !== 'string') return defaultValue;
    const normalized = rawValue.trim().toLowerCase();
    if (!normalized) return defaultValue;
    if (normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'y') return true;
    if (normalized === 'false' || normalized === '0' || normalized === 'no' || normalized === 'n') return false;
    return defaultValue;
}

function parsePositiveInteger(rawValue, fallbackValue = 0) {
    const parsed = Number(rawValue);
    if (!Number.isFinite(parsed) || parsed <= 0) return fallbackValue;
    return Math.floor(parsed);
}

function isValidTimeZoneName(timeZone) {
    try {
        Intl.DateTimeFormat('en-US', { timeZone }).format(new Date());
        return true;
    } catch (error) {
        return false;
    }
}

function getShuttleReminderEffectiveTimeZone() {
    return isValidTimeZoneName(SHUTTLE_REMINDER_TIMEZONE) ? SHUTTLE_REMINDER_TIMEZONE : 'UTC';
}

function normalizeShuttleReminderText(value) {
    return String(value || '')
        .trim()
        .toLowerCase()
        .replace(/\s+/g, ' ');
}

function normalizeShuttleReminderDateIso(value) {
    const source = String(value || '').trim();
    if (!source) return '';
    if (/^\d{4}-\d{2}-\d{2}$/.test(source)) {
        return source;
    }
    const slashMatch = source.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (slashMatch) {
        const month = String(Number(slashMatch[1])).padStart(2, '0');
        const day = String(Number(slashMatch[2])).padStart(2, '0');
        const year = String(slashMatch[3]).trim();
        return `${year}-${month}-${day}`;
    }
    return '';
}

function normalizeShuttleReminderShiftLabel(value) {
    const cleaned = String(value || '').trim().replace(/^'+/, '');
    if (!cleaned) return '';
    const directMatch = cleaned.match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
    if (directMatch) {
        return `${String(Number(directMatch[1])).padStart(2, '0')}:${directMatch[2]}`;
    }
    const embedded = cleaned.match(/(\d{1,2}):(\d{2})(?::\d{2})?/);
    if (embedded) {
        return `${String(Number(embedded[1])).padStart(2, '0')}:${embedded[2]}`;
    }
    return '';
}

function parseShuttleReminderShiftMinutes(shiftLabel) {
    const match = String(shiftLabel || '').trim().match(/^(\d{2}):(\d{2})$/);
    if (!match) return -1;
    const hh = Number(match[1]);
    const mm = Number(match[2]);
    if (!Number.isFinite(hh) || !Number.isFinite(mm) || hh < 0 || hh > 23 || mm < 0 || mm > 59) {
        return -1;
    }
    return (hh * 60) + mm;
}

function getTimeZoneOffsetMsForDate(date, timeZone) {
    const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
    });
    const parts = formatter.formatToParts(date);
    const values = {};
    parts.forEach((part) => {
        if (part.type !== 'literal') {
            values[part.type] = part.value;
        }
    });
    const asUtc = Date.UTC(
        Number(values.year || 0),
        Math.max(0, Number(values.month || 1) - 1),
        Number(values.day || 1),
        Number(values.hour || 0),
        Number(values.minute || 0),
        Number(values.second || 0)
    );
    return asUtc - date.getTime();
}

function getUtcTimestampForTimeZoneDateTime(dateIso, shiftLabel, timeZone) {
    const dateMatch = String(dateIso || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
    const timeMatch = String(shiftLabel || '').trim().match(/^(\d{2}):(\d{2})$/);
    if (!dateMatch || !timeMatch) return null;

    const year = Number(dateMatch[1]);
    const month = Number(dateMatch[2]);
    const day = Number(dateMatch[3]);
    const hour = Number(timeMatch[1]);
    const minute = Number(timeMatch[2]);
    if (
        !Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day) ||
        !Number.isFinite(hour) || !Number.isFinite(minute)
    ) {
        return null;
    }

    const baseUtc = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
    let guess = baseUtc;
    for (let i = 0; i < 3; i += 1) {
        const offsetMs = getTimeZoneOffsetMsForDate(new Date(guess), timeZone);
        const adjusted = baseUtc - offsetMs;
        if (Math.abs(adjusted - guess) < 1000) {
            guess = adjusted;
            break;
        }
        guess = adjusted;
    }
    return guess;
}

function resolveShuttleReminderTripTimestamp(dateIso, shiftLabel) {
    const normalizedDateIso = normalizeShuttleReminderDateIso(dateIso);
    const normalizedShift = normalizeShuttleReminderShiftLabel(shiftLabel);
    if (!normalizedDateIso || !normalizedShift) return null;
    const effectiveTimeZone = getShuttleReminderEffectiveTimeZone();
    if (effectiveTimeZone) {
        const utcTs = getUtcTimestampForTimeZoneDateTime(
            normalizedDateIso,
            normalizedShift,
            effectiveTimeZone
        );
        if (Number.isFinite(utcTs) && utcTs > 0) {
            return utcTs;
        }
    }
    const localTs = new Date(`${normalizedDateIso}T${normalizedShift}:00`).getTime();
    return Number.isFinite(localTs) && localTs > 0 ? localTs : null;
}

function isShuttleReminderCancelledStatus(value) {
    const normalized = normalizeShuttleReminderText(value);
    if (!normalized) return false;
    return (
        normalized.includes('ביטול') ||
        normalized.includes('בוטל') ||
        normalized.includes('отмена') ||
        normalized.includes('отмен') ||
        normalized.includes('cancel')
    );
}

function buildShuttleReminderOrderKey(order) {
    if (!order || typeof order !== 'object') return '';
    const dateIso = normalizeShuttleReminderDateIso(order.dateIso || order.date || '');
    const shiftLabel = normalizeShuttleReminderShiftLabel(
        order.shift || order.shiftLabel || order.shiftValue || ''
    );
    const station = normalizeShuttleReminderText(order.station || '');
    if (!dateIso || !shiftLabel || !station) return '';
    return `${dateIso}|${shiftLabel}|${station}`;
}

function buildShuttleReminderSentKey(user, orderKey) {
    const normalizedUser = normalizeUserKey(user);
    const normalizedOrderKey = String(orderKey || '').trim();
    if (!normalizedUser || !normalizedOrderKey) return '';
    return `${normalizedUser}|${normalizedOrderKey}`;
}

function normalizeShuttleReminderSentState(rawState) {
    if (!rawState || typeof rawState !== 'object') {
        return {};
    }
    const now = Date.now();
    const entries = Object.entries(rawState)
        .map(([key, value]) => {
            const sentKey = String(key || '').trim();
            const sentAt = Number(value || 0);
            if (!sentKey || !Number.isFinite(sentAt) || sentAt <= 0) {
                return null;
            }
            if (now - sentAt > SHUTTLE_REMINDER_SENT_TTL_MS) {
                return null;
            }
            return [sentKey, sentAt];
        })
        .filter(Boolean)
        .sort((a, b) => Number(b[1]) - Number(a[1]))
        .slice(0, SHUTTLE_REMINDER_MAX_SENT_RECORDS);
    return Object.fromEntries(entries);
}

function pruneShuttleReminderSentState() {
    shuttleReminderSentAtByKey = normalizeShuttleReminderSentState(shuttleReminderSentAtByKey);
}

function hasShuttleReminderBeenSentForOrder(user, orderKey) {
    const sentKey = buildShuttleReminderSentKey(user, orderKey);
    if (!sentKey) return false;
    const sentAt = Number(shuttleReminderSentAtByKey[sentKey] || 0);
    if (!Number.isFinite(sentAt) || sentAt <= 0) {
        return false;
    }
    if (Date.now() - sentAt > SHUTTLE_REMINDER_SENT_TTL_MS) {
        delete shuttleReminderSentAtByKey[sentKey];
        return false;
    }
    return true;
}

function markShuttleReminderSentForOrder(user, orderKey, sentAt = Date.now()) {
    const sentKey = buildShuttleReminderSentKey(user, orderKey);
    if (!sentKey) return;
    shuttleReminderSentAtByKey[sentKey] = Number(sentAt) || Date.now();
}

function parseShuttleReminderOrdersPayload(payloadText) {
    let root;
    try {
        root = JSON.parse(payloadText);
    } catch (error) {
        throw new Error('Invalid shuttle reminder payload');
    }

    const rows = [];
    const collectRows = (value) => {
        if (!Array.isArray(value)) return;
        value.forEach((item) => {
            if (item && typeof item === 'object') {
                rows.push(item);
            }
        });
    };

    if (Array.isArray(root)) {
        collectRows(root);
    } else if (root && typeof root === 'object') {
        const payload = root;
        const result = String(payload.result || '').trim().toLowerCase();
        if (result && result !== 'success') {
            const reason = String(payload.message || 'Failed to fetch shuttle orders').trim();
            throw new Error(reason || 'Failed to fetch shuttle orders');
        }
        collectRows(payload.orders);
        collectRows(payload.data);
        collectRows(payload.ongoing);
        collectRows(payload.past);
    }

    return rows;
}

function mapShuttleReminderOrder(rawOrder, user, sourceIndex = 0) {
    const dateIso = normalizeShuttleReminderDateIso(rawOrder && (rawOrder.dateIso || rawOrder.date));
    const shiftLabel = normalizeShuttleReminderShiftLabel(
        rawOrder && (rawOrder.shift || rawOrder.shiftLabel || rawOrder.shiftValue)
    );
    const station = String((rawOrder && rawOrder.station) || '').trim();
    const statusValue = String(
        (rawOrder && (rawOrder.statusValue || rawOrder.status || '')) || ''
    ).trim();
    const isCancelled = rawOrder && rawOrder.isCancelled === true
        ? true
        : isShuttleReminderCancelledStatus(statusValue);
    if (!dateIso || !shiftLabel || !station || isCancelled) {
        return null;
    }
    const orderKey = buildShuttleReminderOrderKey({ dateIso, shiftLabel, station });
    if (!orderKey) {
        return null;
    }
    const tripAt = resolveShuttleReminderTripTimestamp(dateIso, shiftLabel);
    if (!Number.isFinite(tripAt) || tripAt <= 0) {
        return null;
    }
    return {
        user,
        dateIso,
        shiftLabel,
        station,
        statusValue,
        isCancelled,
        orderKey,
        tripAt,
        sourceIndex: Number.isFinite(Number(sourceIndex)) ? Number(sourceIndex) : 0
    };
}

function getCampaignSentTargetsSet(campaignId) {
    const safeCampaignId = sanitizeCampaignId(campaignId);
    const stateMap = mobileReregisterCampaignState.sentTargetsByCampaign;
    if (!stateMap.has(safeCampaignId)) {
        stateMap.set(safeCampaignId, new Set());
    }
    while (stateMap.size > MOBILE_REREGISTER_MAX_TRACKED_CAMPAIGNS) {
        const oldestKey = stateMap.keys().next().value;
        if (!oldestKey) break;
        stateMap.delete(oldestKey);
    }
    return stateMap.get(safeCampaignId);
}

function getCampaignSentCount(campaignId) {
    const safeCampaignId = sanitizeCampaignId(campaignId);
    const sentSet = mobileReregisterCampaignState.sentTargetsByCampaign.get(safeCampaignId);
    return sentSet ? sentSet.size : 0;
}

function listTrackedCampaigns(limit = 20) {
    return Array.from(mobileReregisterCampaignState.sentTargetsByCampaign.keys()).slice(-limit);
}

function normalizeSubscriptionRecord(rawSubscription, usernameHint = '', subscriptionTypeHint = '') {
    if (!rawSubscription || typeof rawSubscription !== 'object') return null;
    const endpoint = typeof rawSubscription.endpoint === 'string' ? rawSubscription.endpoint.trim() : '';
    const keys = (rawSubscription.keys && typeof rawSubscription.keys === 'object') ? rawSubscription.keys : null;
    const p256dh = keys && typeof keys.p256dh === 'string' ? keys.p256dh.trim() : '';
    const auth = keys && typeof keys.auth === 'string' ? keys.auth.trim() : '';
    if (!endpoint || !p256dh || !auth) return null;
    const username = normalizeUserKey(
        rawSubscription.username || rawSubscription.user || usernameHint
    );
    const type = normalizeSubscriptionType(
        rawSubscription.type || rawSubscription.deviceType || subscriptionTypeHint
    );
    return {
        endpoint,
        expirationTime: rawSubscription.expirationTime || null,
        keys: { p256dh, auth },
        username: username || undefined,
        type: type || undefined
    };
}

function collectSubscriptionsFromValue(value, sink, usernameHint = '', subscriptionTypeHint = '') {
    if (!value) return;
    if (Array.isArray(value)) {
        value.forEach((item) => collectSubscriptionsFromValue(item, sink, usernameHint, subscriptionTypeHint));
        return;
    }
    if (typeof value !== 'object') return;

    const nextUsernameHint = normalizeUserKey(value.username || value.user || usernameHint);
    const nextTypeHint = normalizeSubscriptionType(value.type || value.deviceType || subscriptionTypeHint);
    const normalizedRecord = normalizeSubscriptionRecord(value, nextUsernameHint, nextTypeHint);
    if (normalizedRecord) {
        sink.push(normalizedRecord);
    }

    ['subscription', 'subscriptionPC', 'subscriptionMobile', 'pushSubscription'].forEach((nestedKey) => {
        if (value[nestedKey]) {
            let nestedTypeHint = nextTypeHint;
            if (nestedKey === 'subscriptionPC') {
                nestedTypeHint = 'pc';
            } else if (nestedKey === 'subscriptionMobile') {
                nestedTypeHint = 'mobile';
            }
            collectSubscriptionsFromValue(value[nestedKey], sink, nextUsernameHint, nestedTypeHint);
        }
    });

    ['subscriptions', 'devices', 'rows', 'items', 'data', 'users'].forEach((nestedArrayKey) => {
        if (Array.isArray(value[nestedArrayKey])) {
            collectSubscriptionsFromValue(value[nestedArrayKey], sink, nextUsernameHint, nextTypeHint);
        }
    });
}

function dedupeSubscriptionsByEndpoint(rawSubscriptions = []) {
    const byEndpoint = new Map();
    rawSubscriptions.forEach((rawSubscription) => {
        const normalized = normalizeSubscriptionRecord(
            rawSubscription,
            rawSubscription && rawSubscription.username,
            rawSubscription && rawSubscription.type
        );
        if (!normalized) return;
        const existing = byEndpoint.get(normalized.endpoint);
        if (!existing || (!existing.username && normalized.username) || (!existing.type && normalized.type)) {
            byEndpoint.set(normalized.endpoint, normalized);
        }
    });
    return Array.from(byEndpoint.values());
}

function normalizeLocalDeviceSubscriptionsRegistry(rawRegistry = {}) {
    const normalizedRegistry = {};
    if (!rawRegistry || typeof rawRegistry !== 'object') {
        return normalizedRegistry;
    }

    Object.keys(rawRegistry).forEach((rawUserKey) => {
        const userKey = normalizeUserKey(rawUserKey);
        const rawSubscriptions = rawRegistry[rawUserKey];
        if (!userKey || !Array.isArray(rawSubscriptions)) return;

        const normalizedSubscriptions = dedupeSubscriptionsByEndpoint(
            rawSubscriptions
                .map((subscription) =>
                    normalizeSubscriptionRecord(
                        subscription,
                        userKey,
                        subscription && subscription.type
                    )
                )
                .filter(Boolean)
        )
            .map((subscription) => ({
                ...subscription,
                username: userKey
            }));

        if (normalizedSubscriptions.length) {
            normalizedRegistry[userKey] = normalizedSubscriptions;
        }
    });

    return normalizedRegistry;
}

function getLocalDeviceSubscriptionsForUsers(usernames = []) {
    const requestedUsers = parseUsernamesInput(usernames);
    if (!requestedUsers.length) return [];

    const aliasToCanonical = buildUserAliasLookupMap(requestedUsers);
    const keyCandidates = new Set([
        ...requestedUsers.map((value) => normalizeUserKey(value)).filter(Boolean),
        ...aliasToCanonical.keys()
    ]);
    const collected = [];
    keyCandidates.forEach((lookupKey) => {
        const userSubscriptions = Array.isArray(deviceSubscriptionsByUser[lookupKey])
            ? deviceSubscriptionsByUser[lookupKey]
            : [];
        const canonicalUser = resolveCanonicalUserFromLookup(lookupKey, aliasToCanonical) || normalizeUserKey(lookupKey);
        if (!canonicalUser) return;
        userSubscriptions.forEach((subscription) => {
            const normalized = normalizeSubscriptionRecord(
                subscription,
                canonicalUser,
                subscription && subscription.type
            );
            if (normalized) {
                normalized.username = canonicalUser;
                collected.push(normalized);
            }
        });
    });
    return dedupeSubscriptionsByEndpoint(collected);
}

function upsertLocalDeviceSubscriptionsFromRegistration(payload = {}) {
    const username = normalizeUserKey(payload.username || payload.user);
    if (!username) return 0;

    const defaultTypeHint = normalizeSubscriptionType(
        payload.deviceType || payload.type || payload.platform
    );
    const collected = [];
    collectSubscriptionsFromValue(payload.subscription, collected, username, defaultTypeHint);
    collectSubscriptionsFromValue(payload.subscriptionMobile, collected, username, 'mobile');
    collectSubscriptionsFromValue(payload.subscriptionPC, collected, username, 'pc');
    if (!collected.length) return 0;

    const existing = Array.isArray(deviceSubscriptionsByUser[username])
        ? deviceSubscriptionsByUser[username]
        : [];
    const merged = dedupeSubscriptionsByEndpoint([...existing, ...collected])
        .map((subscription) =>
            normalizeSubscriptionRecord(
                subscription,
                username,
                subscription && subscription.type
            )
        )
        .filter(Boolean)
        .map((subscription) => ({
            ...subscription,
            username
        }));

    if (!merged.length) return 0;
    deviceSubscriptionsByUser[username] = merged;
    return merged.length;
}

function removeLocalDeviceSubscriptionEndpoint(endpointToRemove) {
    const normalizedEndpoint = String(endpointToRemove || '').trim();
    if (!normalizedEndpoint) return false;

    let changed = false;
    Object.keys(deviceSubscriptionsByUser).forEach((userKey) => {
        const existing = Array.isArray(deviceSubscriptionsByUser[userKey])
            ? deviceSubscriptionsByUser[userKey]
            : [];
        const filtered = existing.filter(
            (subscription) => String((subscription && subscription.endpoint) || '').trim() !== normalizedEndpoint
        );
        if (filtered.length !== existing.length) {
            changed = true;
            if (filtered.length) {
                deviceSubscriptionsByUser[userKey] = filtered;
            } else {
                delete deviceSubscriptionsByUser[userKey];
            }
        }
    });

    return changed;
}

function extractSubscriptionsFromSheetResponse(sheetResponseBody) {
    const collected = [];
    collectSubscriptionsFromValue(sheetResponseBody, collected);
    return dedupeSubscriptionsByEndpoint(collected);
}

function normalizeUserCandidate(rawValue) {
    const normalized = normalizeUserKey(rawValue);
    if (!normalized) return '';
    if (normalized.length > 64) return '';
    return normalized;
}

function buildUserLookupAliases(rawValue) {
    const normalized = normalizeUserKey(rawValue);
    if (!normalized) return [];
    const aliases = new Set([normalized]);
    const digits = normalized.replace(/\D/g, '');
    if (digits) {
        aliases.add(digits);
        if (digits.length === 9) {
            aliases.add(`0${digits}`);
        }
        if (digits.length === 10 && digits.startsWith('0')) {
            aliases.add(digits.slice(1));
        }
        if (digits.length === 12 && digits.startsWith('972')) {
            aliases.add(`0${digits.slice(3)}`);
        }
        if (digits.length === 13 && digits.startsWith('00972')) {
            aliases.add(`0${digits.slice(5)}`);
        }
    }
    return Array.from(aliases).filter(Boolean);
}

function buildUserAliasLookupMap(rawUsers) {
    const values = Array.isArray(rawUsers) ? rawUsers : [rawUsers];
    const aliasToCanonical = new Map();
    values.forEach((value) => {
        const canonical = normalizeUserKey(value);
        if (!canonical) return;
        const aliases = buildUserLookupAliases(canonical);
        aliases.forEach((alias) => {
            if (!aliasToCanonical.has(alias)) {
                aliasToCanonical.set(alias, canonical);
            }
        });
    });
    return aliasToCanonical;
}

function resolveCanonicalUserFromLookup(rawValue, aliasToCanonical) {
    const aliases = buildUserLookupAliases(rawValue);
    for (const alias of aliases) {
        if (aliasToCanonical.has(alias)) {
            return aliasToCanonical.get(alias);
        }
    }
    return '';
}

function addUserToSet(targetSet, rawValue) {
    if (!targetSet) return;
    if (rawValue === null || rawValue === undefined) return;
    if (
        typeof rawValue !== 'string' &&
        typeof rawValue !== 'number' &&
        typeof rawValue !== 'bigint'
    ) {
        return;
    }
    const normalized = normalizeUserCandidate(String(rawValue));
    if (normalized) {
        targetSet.add(normalized);
    }
}

function collectUsernamesFromUnknown(targetSet, rawValue, depth = 0) {
    if (!targetSet || rawValue === null || rawValue === undefined || depth > 4) {
        return;
    }

    if (
        typeof rawValue === 'string' ||
        typeof rawValue === 'number' ||
        typeof rawValue === 'bigint'
    ) {
        const source = String(rawValue);
        source.split(',').forEach((token) => addUserToSet(targetSet, token));
        return;
    }

    if (Array.isArray(rawValue)) {
        rawValue.forEach((entry) => collectUsernamesFromUnknown(targetSet, entry, depth + 1));
        return;
    }

    if (typeof rawValue !== 'object') {
        return;
    }

    const value = rawValue;
    ['username', 'user', 'phone', 'id', 'value'].forEach((field) => {
        if (Object.prototype.hasOwnProperty.call(value, field)) {
            collectUsernamesFromUnknown(targetSet, value[field], depth + 1);
        }
    });
    ['users', 'usernames', 'members', 'groupMembers', 'recipients', 'targets'].forEach((field) => {
        if (Object.prototype.hasOwnProperty.call(value, field)) {
            collectUsernamesFromUnknown(targetSet, value[field], depth + 1);
        }
    });
}

function parseUsernamesInput(rawValue) {
    const normalized = new Set();
    collectUsernamesFromUnknown(normalized, rawValue);
    return Array.from(normalized);
}

function resolveHardcodedCommunityPolicy(groupRecord, groupId, groupName) {
    const candidates = [
        groupRecord && groupRecord.id,
        groupRecord && groupRecord.name,
        groupId,
        groupName
    ];
    for (const candidate of candidates) {
        const key = normalizeUserKey(candidate);
        if (!key) continue;
        const policy = hardcodedCommunityGroupsByKey.get(key);
        if (policy) {
            return policy;
        }
    }
    return null;
}

function canSendToCommunityGroup(sender, groupRecord, groupId, groupName) {
    if (!groupRecord || groupRecord.type !== 'community') {
        return true;
    }

    const senderKey = normalizeUserKey(sender);
    if (!senderKey) {
        return false;
    }

    const groupAdmins = parseUsernamesInput(groupRecord.admins || groupRecord.groupAdmins);
    if (groupAdmins.includes(senderKey)) {
        return true;
    }

    const creatorKey = normalizeUserKey(groupRecord.createdBy);
    if (creatorKey && senderKey === creatorKey) {
        return true;
    }

    const hardcodedPolicy = resolveHardcodedCommunityPolicy(groupRecord, groupId, groupName);
    if (hardcodedPolicy && hardcodedPolicy.writers) {
        return hardcodedPolicy.writers.has(senderKey);
    }

    // Legacy behavior: community groups without creator remain sendable.
    return !creatorKey;
}

function isGroupAdminUser(userKey, groupRecord = null) {
    const normalizedUser = normalizeUserKey(userKey);
    if (!normalizedUser || !groupRecord || typeof groupRecord !== 'object') {
        return false;
    }
    const admins = parseUsernamesInput(groupRecord.admins || groupRecord.groupAdmins);
    if (admins.includes(normalizedUser)) {
        return true;
    }
    const createdBy = normalizeUserKey(groupRecord.createdBy || groupRecord.groupCreatedBy || '');
    return Boolean(createdBy && createdBy === normalizedUser);
}

function canManageGroupUpdate(actorUser, existingGroup, incomingPayload = {}) {
    const normalizedActor = normalizeUserKey(actorUser);
    if (!normalizedActor) return false;

    const incomingGroupId = String(incomingPayload.groupId || '').trim();
    const incomingGroupName = String(incomingPayload.groupName || '').trim();

    if (existingGroup && typeof existingGroup === 'object') {
        if (isGroupAdminUser(normalizedActor, existingGroup)) {
            return true;
        }
        if (existingGroup.type === 'community') {
            return canSendToCommunityGroup(normalizedActor, existingGroup, incomingGroupId, incomingGroupName);
        }
        return false;
    }

    const incomingAdmins = parseUsernamesInput(incomingPayload.groupAdmins || incomingPayload.admins);
    if (incomingAdmins.includes(normalizedActor)) {
        return true;
    }
    const incomingCreator = normalizeUserKey(incomingPayload.groupCreatedBy || incomingPayload.createdBy || '');
    if (incomingCreator && incomingCreator === normalizedActor) {
        return true;
    }
    const hardcodedPolicy = resolveHardcodedCommunityPolicy(null, incomingGroupId, incomingGroupName);
    if (hardcodedPolicy && hardcodedPolicy.writers && hardcodedPolicy.writers.has(normalizedActor)) {
        return true;
    }
    return false;
}

function getClientIpAddress(req) {
    const forwardedFor = String((req && req.headers && req.headers['x-forwarded-for']) || '').trim();
    if (forwardedFor) {
        const first = forwardedFor.split(',')[0].trim();
        if (first) return first;
    }
    return String(
        (req && req.ip) ||
        (req && req.socket && req.socket.remoteAddress) ||
        ''
    ).trim() || 'unknown';
}

// ── Session functions delegated to SessionService ──
function consumeRateLimitEntry(store, key, maxAttempts, windowMs) {
    return sessionService.consumeRateLimitEntry(store, key, maxAttempts, windowMs);
}
function parseCookiesFromHeader(cookieHeader) { return sessionService.parseCookiesFromHeader(cookieHeader); }
function encodeBase64Url(input) { return sessionService.encodeBase64Url(input); }
function decodeBase64Url(input) { return sessionService.decodeBase64Url(input); }
function generateRandomToken(byteLength) { return sessionService.generateRandomToken(byteLength); }
function createSessionToken(user) { return sessionService.createSessionToken(user); }
function getSessionFromToken(rawToken) { return sessionService.getSessionFromToken(rawToken); }
function setSessionCookie(res, req, tokenValue, expiresAt) { return sessionService.setSessionCookie(res, req, tokenValue, expiresAt); }
function clearSessionCookie(res, req) { return sessionService.clearSessionCookie(res, req); }
function extractSessionFromRequest(req) { return sessionService.extractSessionFromRequest(req); }
function extractSessionUserFromRequest(req) { return sessionService.extractSessionUserFromRequest(req); }

function resolveAuthorizedUser(req, candidateUser, options = {}) {
    const required = options.required !== false;
    const sessionUser = normalizeUserCandidate(req && req.authUser);
    const requestedUser = normalizeUserCandidate(candidateUser);

    if (sessionUser) {
        if (requestedUser && requestedUser !== sessionUser) {
            return {
                user: '',
                error: 'User mismatch',
                status: 403
            };
        }
        return { user: sessionUser, error: '', status: 200 };
    }

    if (!requestedUser && required) {
        return {
            user: '',
            error: 'Missing user',
            status: 400
        };
    }

    return { user: requestedUser, error: '', status: 200 };
}

const authorizedUserMiddleware = createAuthorizedUserMiddleware({
    resolveAuthorizedUser,
    normalizeUserCandidate,
    defaultCandidateKeys: ['user', 'username', 'phone', 'sender', 'reader', 'reactor']
});
const attachResolvedUser = authorizedUserMiddleware.attachResolvedUser;
const requireAuthorizedUser = authorizedUserMiddleware.requireAuthorizedUser;

function createHttpError(status, message) {
    const error = new Error(String(message || 'Request failed'));
    error.status = Number(status) || 500;
    return error;
}

function resolveSocketAuthorizedUser(socket) {
    const handshake = socket && socket.handshake ? socket.handshake : {};
    const headers = handshake && handshake.headers ? handshake.headers : {};
    const cookieMap = parseCookiesFromHeader(headers.cookie || '');
    const session = getSessionFromToken(cookieMap[SESSION_COOKIE_NAME]);
    const sessionUser = normalizeUserCandidate(session && session.user);
    const handshakeAuth = handshake && handshake.auth && typeof handshake.auth === 'object'
        ? handshake.auth
        : {};
    const handshakeQuery = handshake && handshake.query && typeof handshake.query === 'object'
        ? handshake.query
        : {};
    const requestedUser = normalizeUserCandidate(
        handshakeAuth.user ||
        handshakeQuery.user ||
        ''
    );
    const resolution = resolveAuthorizedUser(
        { authUser: sessionUser },
        requestedUser,
        { required: true }
    );
    if (resolution && resolution.error) {
        throw createHttpError(resolution.status || 401, resolution.error);
    }
    return normalizeUserCandidate(resolution && resolution.user);
}

function resolveTypingRecipients(payload = {}, senderUser = '') {
    const sender = normalizeUserKey(senderUser);
    const groupId = String(payload.groupId || '').trim();
    let recipients = [];

    if (groupId) {
        const groupRecord = groups[groupId] && typeof groups[groupId] === 'object'
            ? groups[groupId]
            : null;
        const payloadMembers = parseUsernamesInput(payload.groupMembers);
        const groupMembers = groupRecord ? parseUsernamesInput(groupRecord.members) : [];
        recipients = payloadMembers.length ? payloadMembers : groupMembers;
    } else {
        recipients = parseUsernamesInput(
            payload.targetUser ||
            payload.originalSender ||
            payload.chatId ||
            payload.recipient ||
            payload.recipients
        );
    }

    return Array.from(new Set(recipients))
        .filter((userKey) => userKey && userKey !== sender);
}

function emitTypingSignalToRecipients(payload = {}, senderUser = '') {
    const sender = normalizeUserKey(senderUser);
    if (!sender) {
        throw createHttpError(400, 'Missing sender');
    }
    const isTyping = parseBooleanInput(payload.isTyping, true);
    const groupId = String(payload.groupId || '').trim();
    const groupName = String(payload.groupName || '').trim();
    const recipients = resolveTypingRecipients(payload, sender);
    if (!recipients.length) {
        return { status: 'success', deliveredTo: 0 };
    }

    const realtimePayload = {
        type: 'typing',
        sender,
        isTyping,
        chatId: groupId || sender,
        groupId: groupId || undefined,
        groupName: groupName || undefined,
        timestamp: Date.now()
    };
    recipients.forEach((recipientUser) => notifyRealtimeClients(recipientUser, realtimePayload));
    return { status: 'success', deliveredTo: recipients.length };
}

async function processReplyPayload(rawPayload = {}, resolvedUser = '') {
    const {
        reply,
        originalSender,
        imageUrl,
        fileUrl,
        senderName,
        messageId: clientMessageId,
        groupId,
        groupName,
        groupMembers,
        groupCreatedBy,
        groupAdmins,
        groupUpdatedAt,
        groupType,
        groupSenderName,
        membersToNotify,
        replyToMessageId,
        replyToSender,
        replyToSenderName,
        replyToBody,
        replyToImageUrl,
        forwarded,
        forwardedFrom,
        forwardedFromName
    } = rawPayload || {};
    const user = normalizeUserKey(resolvedUser || rawPayload.user || '');
    if (!user) {
        throw createHttpError(400, 'Missing user');
    }
    const messageId = String(clientMessageId || generateMessageId()).trim() || generateMessageId();
    console.log(`[REPLY] From: ${user} | To: ${originalSender}`);

    let groupRecord = null;
    if (groupId) {
        groupRecord = upsertGroup({
            groupId,
            groupName,
            groupMembers,
            groupCreatedBy,
            groupAdmins,
            groupUpdatedAt,
            groupType
        });
        if (!canSendToCommunityGroup(user, groupRecord, groupId, groupName)) {
            throw createHttpError(403, 'Only admins can send to this group');
        }
    }

    const senderUserKey = normalizeUserKey(user);
    let targetToNotify = [];
    const hardcodedCommunityPolicy = groupId
        ? resolveHardcodedCommunityPolicy(groupRecord, groupId, groupName)
        : null;
    const requestedMembersToNotify = parseUsernamesInput(membersToNotify);
    if (hardcodedCommunityPolicy && Array.isArray(hardcodedCommunityPolicy.members) && hardcodedCommunityPolicy.members.length) {
        targetToNotify = hardcodedCommunityPolicy.members;
    } else if (requestedMembersToNotify.length) {
        targetToNotify = requestedMembersToNotify;
    } else if (groupId) {
        const groupList = groupRecord && Array.isArray(groupRecord.members) ? groupRecord.members : groupMembers;
        targetToNotify = parseUsernamesInput(groupList);
    } else if (originalSender && originalSender !== 'System') {
        targetToNotify = parseUsernamesInput([originalSender]);
    } else {
        console.warn('[REPLY] No valid recipients resolved – skipping push notification');
        targetToNotify = [];
    }

    targetToNotify = parseUsernamesInput(targetToNotify)
        .filter((memberKey) => memberKey && memberKey !== senderUserKey);
    if (!targetToNotify.length && groupId) {
        const fallbackGroupMembers = groupRecord && Array.isArray(groupRecord.members)
            ? groupRecord.members
            : groupMembers;
        targetToNotify = parseUsernamesInput(fallbackGroupMembers)
            .filter((memberKey) => memberKey && memberKey !== senderUserKey);
    }
    if (Array.isArray(targetToNotify) && targetToNotify.length === 0) {
        return { status: 'success', details: { success: 0, failed: 0 } };
    }

    pruneRecentProcessedReplyMessages();
    if (recentProcessedReplyMessages.has(messageId)) {
        return {
            status: 'success',
            details: {
                success: 0,
                failed: 0,
                deduped: true
            }
        };
    }
    recentProcessedReplyMessages.set(messageId, Date.now());

    try {
        let messageContent = reply;
        if (!messageContent && imageUrl) {
            messageContent = `[Image Sent]: ${imageUrl}`;
        }
        const normalizedReplyToMessageId = String(replyToMessageId || '').trim();
        const normalizedReplyToSender = normalizeUserKey(replyToSender || '');
        const normalizedReplyToSenderName = String(replyToSenderName || '').trim();
        const normalizedReplyToBody = typeof replyToBody === 'string' ? replyToBody : '';
        const normalizedReplyToImageUrl = String(replyToImageUrl || '').trim();
        const hasReplyContext = Boolean(
            normalizedReplyToMessageId &&
            normalizedReplyToSender &&
            (normalizedReplyToBody.trim() || normalizedReplyToImageUrl)
        );
        const normalizedForwarded = parseBooleanInput(forwarded, false);
        const normalizedForwardedFrom = normalizeUserKey(forwardedFrom || '');
        const normalizedForwardedFromName = String(forwardedFromName || '').trim();
        const messageMetadata = {};
        if (hasReplyContext) {
            messageMetadata.replyToMessageId = normalizedReplyToMessageId;
            messageMetadata.replyToSender = normalizedReplyToSender;
            messageMetadata.replyToBody = normalizedReplyToBody;
            messageMetadata.replyToImageUrl = normalizedReplyToImageUrl || null;
            if (normalizedReplyToSenderName) {
                messageMetadata.replyToSenderName = normalizedReplyToSenderName;
            }
        }
        if (normalizedForwarded) {
            messageMetadata.forwarded = true;
            if (normalizedForwardedFrom) {
                messageMetadata.forwardedFrom = normalizedForwardedFrom;
            }
            if (normalizedForwardedFromName) {
                messageMetadata.forwardedFromName = normalizedForwardedFromName;
            }
        }

        fetchWithRetry(GOOGLE_SHEET_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                action: 'save_reply',
                fromUser: user,
                toUser: groupId ? groupId : (originalSender || 'System'),
                message: messageContent
            })
        }, { timeoutMs: 10000, retries: 2 }).catch(err => console.error('[SHEET ERROR] Failed to save reply:', err.message));

        const isGroup = Boolean(groupId);
        const senderLabel = groupSenderName || senderName || user;
        const normalizedGroupName = (typeof groupName === 'string') ? groupName.trim() : groupName;
        const shortText = reply || (imageUrl ? 'Sent an image' : 'New Message');
        const normalizedGroupType = groupRecord ? groupRecord.type : normalizeGroupType(groupType || 'group');
        const notificationTitle = isGroup ? (normalizedGroupName || 'Group message') : `New message from ${senderLabel}`;
        const notificationExtraData = {
            ...(isGroup ? {
                groupId,
                groupName: normalizedGroupName,
                groupType: normalizedGroupType,
                groupMessageText: shortText,
                groupSenderName: senderLabel
            } : {}),
            ...(reply ? { messageText: reply } : {}),
            ...(fileUrl ? { fileUrl } : {}),
            ...messageMetadata
        };
        const notificationData = {
            messageId,
            title: notificationTitle,
            body: {
                shortText: isGroup ? `${senderLabel}: ${shortText}` : shortText,
                longText: reply
            },
            image: imageUrl,
            data: Object.keys(notificationExtraData).length ? notificationExtraData : undefined
        };

        const pollingMessage = {
            messageId,
            sender: isGroup ? groupId : user,
            body: reply,
            timestamp: Date.now(),
            imageUrl: imageUrl || null,
            fileUrl: fileUrl || null,
            groupId: groupId || null,
            groupName: groupName || null,
            groupMembers: groupMembers || null,
            groupCreatedBy: groupCreatedBy || null,
            groupAdmins: groupRecord && Array.isArray(groupRecord.admins) ? groupRecord.admins : undefined,
            groupUpdatedAt: groupUpdatedAt || null,
            groupType: normalizedGroupType,
            groupSenderName: senderLabel,
            ...messageMetadata
        };
        // Audit: log message creation to MessageActivities table (fire-and-forget).
        void mysqlLogsService.insertMessageActivity({
            actionType: 'message',
            messageId,
            sender: user,
            recipient: groupId || (originalSender || ''),
            groupId: groupId || null,
            body: reply || null,
            imageUrl: imageUrl || null,
            fileUrl: fileUrl || null,
            actionTimestamp: Date.now()
        }).catch(() => {});

        await addToQueue(targetToNotify, pollingMessage);

        const senderForPush = isGroup ? groupId : user;
        const result = await sendPushNotificationToUser(targetToNotify, notificationData, senderForPush, { messageId });
        recentProcessedReplyMessages.set(messageId, Date.now());

        // ── Self-echo: notify sender's other devices so sent messages appear in real time ──
        if (senderUserKey) {
            const selfEchoMessage = {
                ...pollingMessage,
                toUser: isGroup ? undefined : (normalizeUserKey(originalSender) || undefined)
            };
            void addToQueue(senderUserKey, selfEchoMessage).catch(() => {});

            const selfEchoNotification = {
                messageId,
                title: '',
                body: { shortText: '', longText: '' },
                image: imageUrl,
                data: {
                    ...(notificationExtraData || {}),
                    skipNotification: true,
                    toUser: isGroup ? undefined : (normalizeUserKey(originalSender) || undefined),
                    messageText: reply || null,
                    imageUrl: imageUrl || null,
                    fileUrl: fileUrl || null
                }
            };
            void sendPushNotificationToUser(senderUserKey, selfEchoNotification, senderForPush, {
                messageId,
                skipBadge: true
            }).catch(() => {});
        }

        return { status: 'success', details: result };
    } catch (error) {
        recentProcessedReplyMessages.delete(messageId);
        throw error;
    }
}

async function processReactionPayload(rawPayload = {}, resolvedUser = '') {
    const {
        groupId,
        groupName,
        groupMembers,
        groupCreatedBy,
        groupAdmins,
        groupUpdatedAt,
        groupType,
        targetMessageId,
        emoji,
        reactor,
        reactorName,
        targetUser,
        originalSender
    } = rawPayload || {};
    const normalizedTargetMessageId = String(targetMessageId || '').trim();
    const normalizedEmoji = String(emoji || '').trim();
    const normalizedReactor = normalizeUserKey(resolvedUser || reactor || '');
    const normalizedTargetUser = normalizeUserKey(targetUser || originalSender || '');
    
    if ((!groupId && !normalizedTargetUser) || !normalizedTargetMessageId || !normalizedEmoji) {
        throw createHttpError(400, 'Missing reaction fields');
    }
    if (!normalizedReactor) {
        throw createHttpError(400, 'Missing reaction user');
    }

    const reactionId = generateMessageId();
    const resolvedReactorName = String(reactorName || reactor || 'משתמש').trim();
    const reactionText = `${resolvedReactorName} הגיב/ה ${normalizedEmoji}`;

    let membersToNotify = [];
    let adminMembersToNotify = [];
    let reactionRecord = {
        messageId: reactionId,
        type: 'reaction',
        targetMessageId: normalizedTargetMessageId,
        emoji: normalizedEmoji,
        reactor: normalizedReactor || reactor,
        reactorName: resolvedReactorName,
        timestamp: Date.now()
    };
    let notificationData = {
        messageId: reactionId,
        body: {
            shortText: reactionText,
            longText: reactionText
        },
        data: {
            type: 'reaction',
            targetMessageId: normalizedTargetMessageId,
            emoji: normalizedEmoji,
            reactor: normalizedReactor || reactor,
            reactorName: resolvedReactorName
        }
    };

    if (groupId) {
        const groupRecord = upsertGroup({
            groupId, groupName, groupMembers, groupCreatedBy, groupAdmins, groupUpdatedAt, groupType
        });
        const storedMembers = groupRecord && Array.isArray(groupRecord.members) ? groupRecord.members : [];
        const providedMembers = Array.isArray(groupMembers) ? groupMembers : [];
        const recipientByKey = new Map();
        [...storedMembers, ...providedMembers].forEach(member => {
            const rawMember = String(member || '').trim();
            const memberKey = normalizeUserKey(rawMember);
            if (!memberKey || memberKey === normalizedReactor) return;
            if (!recipientByKey.has(memberKey)) {
                recipientByKey.set(memberKey, rawMember);
            }
        });
        membersToNotify = Array.from(recipientByKey.values());
        
        const adminByKey = new Map();
        const adminCandidates = [
            ...(groupRecord && Array.isArray(groupRecord.admins) ? groupRecord.admins : []),
            ...(Array.isArray(groupAdmins) ? groupAdmins : []),
            (groupRecord && groupRecord.createdBy) ? groupRecord.createdBy : '',
            groupCreatedBy || ''
        ];
        adminCandidates.forEach((candidate) => {
            const rawAdmin = String(candidate || '').trim();
            const adminKey = normalizeUserKey(rawAdmin);
            if (!adminKey || adminKey === normalizedReactor) return;
            if (!adminByKey.has(adminKey)) {
                adminByKey.set(adminKey, rawAdmin || adminKey);
            }
        });
        adminMembersToNotify = Array.from(adminByKey.values());

        const resolvedGroupName = (groupRecord && groupRecord.name) || String(groupName || '').trim() || 'קבוצה';
        const resolvedGroupMembers = groupRecord && Array.isArray(groupRecord.members) ? groupRecord.members : providedMembers;
        const resolvedGroupCreatedBy = (groupRecord && groupRecord.createdBy) || groupCreatedBy || null;
        const resolvedGroupUpdatedAt = (groupRecord && groupRecord.updatedAt) || groupUpdatedAt || Date.now();
        const resolvedGroupType = groupRecord ? groupRecord.type : normalizeGroupType(groupType || 'group');
        
        notificationData.title = resolvedGroupName || 'הודעה חדשה';
        Object.assign(notificationData.data, {
            groupId, groupName: resolvedGroupName, groupMembers: resolvedGroupMembers,
            groupCreatedBy: resolvedGroupCreatedBy, groupAdmins: groupRecord && Array.isArray(groupRecord.admins) ? groupRecord.admins : undefined,
            groupUpdatedAt: resolvedGroupUpdatedAt, groupType: resolvedGroupType
        });
        
        Object.assign(reactionRecord, {
            sender: groupId,
            groupId, groupName: resolvedGroupName, groupMembers: resolvedGroupMembers,
            groupCreatedBy: resolvedGroupCreatedBy, groupAdmins: groupRecord && Array.isArray(groupRecord.admins) ? groupRecord.admins : undefined,
            groupUpdatedAt: resolvedGroupUpdatedAt, groupType: resolvedGroupType
        });
    } else {
        if (normalizedTargetUser !== normalizedReactor) {
            membersToNotify = [normalizedTargetUser];
            adminMembersToNotify = [normalizedTargetUser];
        }
        reactionRecord.sender = normalizedReactor;
        notificationData.title = `תגובה מ-${resolvedReactorName}`;
    }

    if (!membersToNotify.length) {
        return { status: 'success', details: { success: 0, failed: 0 } };
    }

    // Audit: log reaction to MessageActivities table (fire-and-forget).
    void mysqlLogsService.insertMessageActivity({
        actionType: 'reaction',
        messageId: reactionId,
        sender: normalizedReactor,
        recipient: normalizedTargetUser || null,
        groupId: groupId || null,
        emoji: normalizedEmoji || null,
        targetMessageId: normalizedTargetMessageId || null,
        actionTimestamp: Date.now()
    }).catch(() => {});

    await addToQueue(membersToNotify, reactionRecord);
    const result = adminMembersToNotify.length
        ? await sendPushNotificationToUser(adminMembersToNotify, notificationData, groupId || normalizedReactor, {
            messageId: reactionId,
            skipBadge: true,
            singlePerUser: true,
            allowSecondAttempt: false
        })
        : { success: 0, failed: 0 };

    // ── Self-echo: notify reactor's other devices ──
    if (normalizedReactor) {
        void addToQueue(normalizedReactor, reactionRecord).catch(() => {});
        const selfEchoReactionNotification = {
            messageId: reactionId,
            title: '',
            body: { shortText: '', longText: '' },
            data: {
                ...reactionRecord,
                skipNotification: true
            }
        };
        void sendPushNotificationToUser(normalizedReactor, selfEchoReactionNotification, groupId || normalizedReactor, {
            messageId: reactionId,
            skipBadge: true,
            singlePerUser: true,
            allowSecondAttempt: false
        }).catch(() => {});
    }

    return { status: 'success', details: result };
}

function normalizeDeliveryTelemetryValue(rawValue) {
    const value = Number(rawValue);
    if (!Number.isFinite(value)) return 0;
    return Math.max(0, Math.floor(value));
}

function normalizeDeliveryTelemetryPayload(payload = {}) {
    const source = payload && typeof payload === 'object' ? payload : {};
    return {
        pushPayloadReceived: normalizeDeliveryTelemetryValue(source.pushPayloadReceived),
        pushImmediateMessageBuilt: normalizeDeliveryTelemetryValue(source.pushImmediateMessageBuilt),
        pushMessageApplied: normalizeDeliveryTelemetryValue(source.pushMessageApplied),
        pushMessageNoop: normalizeDeliveryTelemetryValue(source.pushMessageNoop),
        pushMissingMessageContext: normalizeDeliveryTelemetryValue(source.pushMissingMessageContext),
        pushRecoveryPullScheduled: normalizeDeliveryTelemetryValue(source.pushRecoveryPullScheduled),
        ssePayloadReceived: normalizeDeliveryTelemetryValue(source.ssePayloadReceived),
        sseMessageApplied: normalizeDeliveryTelemetryValue(source.sseMessageApplied),
        sseMessageNoop: normalizeDeliveryTelemetryValue(source.sseMessageNoop),
        pollMessagesFetched: normalizeDeliveryTelemetryValue(source.pollMessagesFetched),
        pollMessagesApplied: normalizeDeliveryTelemetryValue(source.pollMessagesApplied)
    };
}

function sumDeliveryTelemetryCounters(counters = {}) {
    return Object.values(counters).reduce((sum, value) => sum + normalizeDeliveryTelemetryValue(value), 0);
}

function pruneDeliveryTelemetryStore() {
    const now = Date.now();
    for (const [deviceId, entry] of deliveryTelemetryByDevice.entries()) {
        if (!entry || !entry.lastSeenAt || now - Number(entry.lastSeenAt) > DELIVERY_TELEMETRY_RETENTION_MS) {
            deliveryTelemetryByDevice.delete(deviceId);
        }
    }

    if (deliveryTelemetryByDevice.size <= DELIVERY_TELEMETRY_MAX_DEVICES) {
        return;
    }

    const sorted = Array.from(deliveryTelemetryByDevice.entries()).sort((a, b) => {
        const aSeen = Number(a[1] && a[1].lastSeenAt) || 0;
        const bSeen = Number(b[1] && b[1].lastSeenAt) || 0;
        return aSeen - bSeen;
    });
    const overflow = Math.max(0, sorted.length - DELIVERY_TELEMETRY_MAX_DEVICES);
    for (let index = 0; index < overflow; index += 1) {
        deliveryTelemetryByDevice.delete(sorted[index][0]);
    }
}

function recordDeliveryTelemetryLog({ user = '', payload = {}, timestamp = 0, req = null }) {
    const counters = normalizeDeliveryTelemetryPayload(payload);
    if (sumDeliveryTelemetryCounters(counters) <= 0) {
        return;
    }

    const normalizedUser = normalizeUserCandidate(user);
    const safePayload = payload && typeof payload === 'object' ? payload : {};
    const rawDeviceId = String(safePayload.deviceId || '').trim();
    if (!rawDeviceId) {
        return;
    }
    const deviceId = rawDeviceId.slice(0, 120);
    const entryAt = Number(timestamp) || Date.now();
    const existing = deliveryTelemetryByDevice.get(deviceId) || {
        deviceId,
        user: normalizedUser || null,
        firstSeenAt: entryAt,
        lastSeenAt: entryAt,
        flushCount: 0,
        counters: normalizeDeliveryTelemetryPayload({})
    };

    const mergedCounters = { ...existing.counters };
    Object.keys(counters).forEach((key) => {
        mergedCounters[key] = normalizeDeliveryTelemetryValue(mergedCounters[key]) + normalizeDeliveryTelemetryValue(counters[key]);
    });

    deliveryTelemetryByDevice.set(deviceId, {
        ...existing,
        user: normalizedUser || existing.user || null,
        activeChatId: typeof safePayload.activeChatId === 'string' ? safePayload.activeChatId : (existing.activeChatId || null),
        inForeground: Boolean(safePayload.inForeground),
        networkOnline: Boolean(safePayload.networkOnline),
        unreadTotal: normalizeDeliveryTelemetryValue(safePayload.unreadTotal),
        ip: getClientIpAddress(req),
        lastSeenAt: entryAt,
        flushCount: normalizeDeliveryTelemetryValue(existing.flushCount) + 1,
        counters: mergedCounters
    });
    pruneDeliveryTelemetryStore();
}

function buildGoogleSheetGetUrl(queryParams = {}, options = {}) {
    return sheetIntegrationService.buildGoogleSheetGetUrl(queryParams, {
        token: Object.prototype.hasOwnProperty.call(options, 'token')
            ? (options && options.token)
            : APP_SERVER_TOKEN
    });
}

function buildLogsBackupSheetGetUrl(queryParams = {}, options = {}) {
    return sheetIntegrationService.buildLogsBackupSheetGetUrl(queryParams, {
        token: Object.prototype.hasOwnProperty.call(options, 'token')
            ? (options && options.token)
            : APP_SERVER_TOKEN
    });
}

function normalizeAuthCode(value) {
    return String(value || '').replace(/\D/g, '').slice(0, AUTH_CODE_DIGITS);
}

function generateAuthCode() {
    const min = Math.pow(10, AUTH_CODE_DIGITS - 1);
    const max = Math.pow(10, AUTH_CODE_DIGITS) - 1;
    return String(min + Math.floor(Math.random() * (max - min + 1)));
}

function escapeXmlValue(value) {
    return String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

function formatAuthCodeSmsMessage(code) {
    const template = AUTH_CODE_SMS_TEMPLATE || 'קוד אימות לכניסה לאפליקציה: {{code}}';
    if (template.includes('{{code}}')) {
        return template.replace(/\{\{code\}\}/g, String(code || ''));
    }
    return `${template} ${code}`;
}

function extractInforuStatusCode(rawResponse) {
    const match = String(rawResponse || '').match(/<Status>\s*([^<\s]+)\s*<\/Status>/i);
    return match ? String(match[1] || '').trim() : '';
}

function extractInforuStatusDescription(rawResponse) {
    const source = String(rawResponse || '');
    const candidateTags = ['Description', 'StatusDescription', 'ErrorDescription', 'Error', 'Message'];
    for (const tag of candidateTags) {
        const expression = new RegExp(`<${tag}>\\s*([^<]+?)\\s*<\\/${tag}>`, 'i');
        const match = source.match(expression);
        if (match && String(match[1] || '').trim()) {
            return String(match[1] || '').trim();
        }
    }
    return '';
}

function buildInforuSmsXmlPayload({
    username,
    apiToken,
    message,
    phone,
    sender,
    includeSender
}) {
    const escapedUsername = escapeXmlValue(username);
    const escapedToken = escapeXmlValue(apiToken);
    const escapedMessage = escapeXmlValue(message);
    const escapedPhone = escapeXmlValue(phone);
    const escapedSender = escapeXmlValue(sender || '');
    const xmlParts = [
        '<?xml version="1.0" encoding="utf-8"?>',
        '<Inforu>',
        '<User>',
        `<Username>${escapedUsername}</Username>`,
        `<ApiToken>${escapedToken}</ApiToken>`,
        '</User>',
        '<Content Type="sms">',
        `<Message>${escapedMessage}</Message>`,
        '</Content>',
        '<Recipients>',
        `<PhoneNumber>${escapedPhone}</PhoneNumber>`,
        '</Recipients>',
        '<Settings>'
    ];
    if (includeSender && escapedSender) {
        xmlParts.push(`<Sender>${escapedSender}</Sender>`);
    }
    xmlParts.push(
        '<MessageInterval>0</MessageInterval>',
        '<TimeToSend></TimeToSend>',
        '</Settings>',
        '</Inforu>'
    );
    return xmlParts.join('');
}

async function postInforuSmsXml(xmlPayload) {
    const encodedPayload = new URLSearchParams({ InforuXML: xmlPayload }).toString();
    const response = await fetchWithRetry(
        INFORU_SMS_URL,
        {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8'
            },
            body: encodedPayload
        },
        { timeoutMs: 15000, retries: 1, backoffMs: 700 }
    );
    const rawResponse = await response.text();
    const statusCode = extractInforuStatusCode(rawResponse);
    const description = extractInforuStatusDescription(rawResponse);
    const ok = Boolean(response.ok && statusCode === '1');
    console.log(`[SMS] InforU response: HTTP ${response.status}, status=${statusCode}, ok=${ok}, desc="${description}", raw="${rawResponse.slice(0, 300)}"`);
    return {
        ok,
        statusCode,
        description,
        httpStatus: response.status
    };
}

function resolveAuthCodeSmsDestination(user) {
    const normalizedUser = normalizeUserCandidate(user);
    if (!normalizedUser) return '';
    return AUTH_CODE_SMS_DESTINATION_OVERRIDES.get(normalizedUser) || normalizedUser;
}

/**
 * Convert a local Israeli phone number (0XXXXXXXXX) to international format (972XXXXXXXXX)
 * for reliable SMS gateway delivery. Returns unchanged if already international or non-standard.
 */
function toInternationalPhoneFormat(phone) {
    const digits = String(phone || '').replace(/\D/g, '');
    if (/^0\d{9}$/.test(digits)) {
        return '972' + digits.slice(1);
    }
    return digits || String(phone || '');
}

async function sendAuthCodeSms(user, code) {
    if (!INFORU_USERNAME || !INFORU_API_TOKEN) {
        throw new Error('SMS gateway configuration missing (INFORU_USERNAME / INFORU_API_TOKEN)');
    }
    const normalizedUser = normalizeUserCandidate(user);
    const smsDestination = resolveAuthCodeSmsDestination(normalizedUser);
    const normalizedCode = normalizeAuthCode(code);
    if (!SESSION_USER_PATTERN.test(normalizedUser) || !SESSION_USER_PATTERN.test(smsDestination) || !AUTH_CODE_PATTERN.test(normalizedCode)) {
        throw new Error('Invalid SMS verification payload');
    }

    const internationalPhone = toInternationalPhoneFormat(smsDestination);
    console.log(`[SMS] Sending auth code to ${smsDestination} (intl: ${internationalPhone})`);

    const message = formatAuthCodeSmsMessage(normalizedCode);
    const primaryXmlPayload = buildInforuSmsXmlPayload({
        username: INFORU_USERNAME,
        apiToken: INFORU_API_TOKEN,
        message,
        phone: internationalPhone,
        sender: INFORU_SENDER,
        includeSender: true
    });
    let sendResult = await postInforuSmsXml(primaryXmlPayload);

    // Some InforU accounts reject a sender alias and accept account default.
    if (!sendResult.ok && sendResult.statusCode === '-17' && INFORU_SENDER) {
        console.log(`[SMS] Sender alias rejected, retrying without sender for ${internationalPhone}`);
        const fallbackXmlPayload = buildInforuSmsXmlPayload({
            username: INFORU_USERNAME,
            apiToken: INFORU_API_TOKEN,
            message,
            phone: internationalPhone,
            sender: '',
            includeSender: false
        });
        sendResult = await postInforuSmsXml(fallbackXmlPayload);
    }

    if (!sendResult.ok) {
        const statusPart = sendResult.statusCode || `HTTP-${sendResult.httpStatus || 'n/a'}`;
        const descriptionPart = sendResult.description ? `: ${sendResult.description}` : '';
        console.error(`[SMS] Failed to send auth code to ${internationalPhone}: ${statusPart}${descriptionPart}`);
        throw new Error(`SMS gateway rejected request (${statusPart}${descriptionPart})`);
    }

    console.log(`[SMS] Auth code sent successfully to ${internationalPhone}`);
}

async function setAuthCodeOnSubscribeSheet(user, code) {
    const normalizedUser = normalizeUserCandidate(user);
    const normalizedCode = normalizeAuthCode(code);
    if (!SESSION_USER_PATTERN.test(normalizedUser) || !AUTH_CODE_PATTERN.test(normalizedCode)) {
        throw new Error('Invalid verification code payload');
    }

    const response = await fetchWithRetry(
        GOOGLE_SHEET_URL,
        {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                action: 'set_login_code',
                user: normalizedUser,
                code: normalizedCode,
                ttlSeconds: AUTH_CODE_TTL_SECONDS,
                token: AUTH_CODE_SHEET_TOKEN
            })
        },
        { timeoutMs: 15000, retries: 2, backoffMs: 600 }
    );
    if (!response.ok) {
        throw new Error(`Failed to persist verification code (${response.status})`);
    }
    const payload = await response.json();
    if (!payload || payload.result !== 'success') {
        throw new Error(payload && payload.message ? payload.message : 'Sheet update failed');
    }
}

async function verifyAuthCodeFromSubscribeSheet(user, code) {
    const normalizedUser = normalizeUserCandidate(user);
    const normalizedCode = normalizeAuthCode(code);
    if (!SESSION_USER_PATTERN.test(normalizedUser) || !AUTH_CODE_PATTERN.test(normalizedCode)) {
        return false;
    }

    const response = await fetchWithRetry(
        GOOGLE_SHEET_URL,
        {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                action: 'verify_login_code',
                user: normalizedUser,
                code: normalizedCode,
                token: AUTH_CODE_SHEET_TOKEN
            })
        },
        { timeoutMs: 15000, retries: 1, backoffMs: 500 }
    );
    if (!response.ok) {
        throw new Error(`Failed to verify code (${response.status})`);
    }
    const payload = await response.json();
    return Boolean(payload && payload.result === 'success' && payload.verified === true);
}

async function ensureRequestedUserCanAuthenticate(requestedUser) {
    if (!AUTH_SESSION_REQUIRE_CONTACT_VERIFICATION) {
        return { ok: true, status: 200, message: '' };
    }
    const response = await fetchWithRetry(
        buildGoogleSheetGetUrl({ action: 'get_contacts', user: requestedUser }),
        {},
        { timeoutMs: 10000, retries: 1, backoffMs: 500 }
    );
    if (!response.ok) {
        return { ok: false, status: 502, message: 'Unable to verify user' };
    }
    const contactsPayload = await response.json();
    const users = Array.isArray(contactsPayload && contactsPayload.users) ? contactsPayload.users : [];
    if (!users.length) {
        return { ok: false, status: 403, message: 'Unauthorized user' };
    }
    return { ok: true, status: 200, message: '' };
}

function ensureRegistrationFlowOnly(req, requestedUser) {
    const sessionUser = normalizeUserCandidate(req && req.authUser);
    if (!sessionUser) {
        return { ok: true, status: 200, message: '' };
    }
    if (sessionUser === requestedUser) {
        return {
            ok: false,
            status: 403,
            message: 'Authenticated users cannot request registration SMS code'
        };
    }
    return {
        ok: false,
        status: 403,
        message: 'User mismatch'
    };
}

async function ensureRequestedUserIsRegistered(requestedUser) {
    const normalizedUser = normalizeUserCandidate(requestedUser);
    if (!SESSION_USER_PATTERN.test(normalizedUser)) {
        return { ok: false, status: 400, message: 'Invalid user' };
    }
    try {
        const response = await fetchWithRetry(
            buildGoogleSheetGetUrl({ action: 'check_auth', user: normalizedUser }),
            {},
            { timeoutMs: 10000, retries: 1, backoffMs: 500 }
        );
        if (!response.ok) {
            return { ok: false, status: 502, message: 'Unable to verify registered user' };
        }
        const payload = await response.json();
        const status = String(payload && payload.status ? payload.status : '').trim().toLowerCase();
        const isActive = payload && Object.prototype.hasOwnProperty.call(payload, 'isActive')
            ? Boolean(payload.isActive)
            : status === 'success';
        if (status === 'success' && isActive) {
            return { ok: true, status: 200, message: '' };
        }
        const backendMessage = String(payload && payload.message ? payload.message : '').trim();
        if (backendMessage && /inactive/i.test(backendMessage)) {
            return { ok: false, status: 403, message: 'User inactive' };
        }
        return { ok: false, status: 403, message: 'Unauthorized user' };
    } catch (error) {
        return { ok: false, status: 502, message: 'Unable to verify registered user' };
    }
}

function extractUsernamesFromContactsResponse(payload = {}) {
    const extracted = new Set();
    const candidateArrays = [];
    if (Array.isArray(payload.users)) candidateArrays.push(payload.users);
    if (Array.isArray(payload.contacts)) candidateArrays.push(payload.contacts);
    if (Array.isArray(payload.data)) candidateArrays.push(payload.data);

    candidateArrays.forEach((entries) => {
        entries.forEach((entry) => {
            if (!entry) return;
            if (typeof entry === 'string') {
                addUserToSet(extracted, entry);
                return;
            }
            if (typeof entry !== 'object') return;
            addUserToSet(extracted, entry.username);
            addUserToSet(extracted, entry.user);
            addUserToSet(extracted, entry.phone);
            addUserToSet(extracted, entry.id);
        });
    });

    return Array.from(extracted);
}

async function fetchContactUsernamesForUser(userKey) {
    if (!userKey) return [];
    try {
        const response = await fetchWithRetry(
            buildGoogleSheetGetUrl({ action: 'get_contacts', user: userKey }),
            {},
            { timeoutMs: 10000, retries: 1, backoffMs: 500 }
        );
        if (!response.ok) return [];
        const payload = await response.json();
        return extractUsernamesFromContactsResponse(payload);
    } catch (error) {
        return [];
    }
}

async function discoverAdditionalUsersFromContacts(seedUsersSet) {
    const discovered = new Set(Array.from(seedUsersSet || []).map(normalizeUserCandidate).filter(Boolean));
    const seedUsers = Array.from(discovered).slice(0, AUTH_REFRESH_CONTACT_DISCOVERY_MAX_SEEDS);
    for (let i = 0; i < seedUsers.length; i += AUTH_REFRESH_CONTACT_DISCOVERY_CONCURRENCY) {
        const batch = seedUsers.slice(i, i + AUTH_REFRESH_CONTACT_DISCOVERY_CONCURRENCY);
        const batchResults = await Promise.all(
            batch.map((userKey) => fetchContactUsernamesForUser(userKey))
        );
        batchResults.forEach((list) => {
            list.forEach((userKey) => {
                if (discovered.size >= AUTH_REFRESH_MAX_DISCOVERY_USERS) return;
                addUserToSet(discovered, userKey);
            });
        });
        if (discovered.size >= AUTH_REFRESH_MAX_DISCOVERY_USERS) break;
    }
    return discovered;
}

function collectKnownUserSeeds() {
    const users = new Set();

    Object.keys(unreadCounts || {}).forEach((userKey) => addUserToSet(users, userKey));
    Object.keys(messageQueue || {}).forEach((userKey) => addUserToSet(users, userKey));
    Object.values(messageQueue || {}).forEach((messages) => {
        if (!Array.isArray(messages)) return;
        messages.forEach((message) => {
            if (!message || typeof message !== 'object') return;
            addUserToSet(users, message.user);
            addUserToSet(users, message.sender);
            addUserToSet(users, message.recipient);
            if (Array.isArray(message.groupMembers)) {
                message.groupMembers.forEach((member) => addUserToSet(users, member));
            }
        });
    });

    Object.values(groups || {}).forEach((group) => {
        if (!group || typeof group !== 'object') return;
        addUserToSet(users, group.createdBy);
        if (Array.isArray(group.members)) {
            group.members.forEach((member) => addUserToSet(users, member));
        }
    });

    for (const cacheKey of subscriptionCache.keys()) {
        String(cacheKey || '')
            .split(',')
            .forEach((userKey) => addUserToSet(users, userKey));
    }
    for (const cacheEntry of subscriptionCache.values()) {
        if (!cacheEntry || !Array.isArray(cacheEntry.subscriptions)) continue;
        cacheEntry.subscriptions.forEach((subscription) => {
            if (!subscription || typeof subscription !== 'object') return;
            addUserToSet(users, subscription.username);
            addUserToSet(users, subscription.user);
        });
    }

    return users;
}

async function fetchSubscriptionsFromSheetUrl(url) {
    try {
        const response = await fetchWithRetry(
            url,
            {},
            { timeoutMs: 15000, retries: 2, backoffMs: 700 }
        );
        if (!response.ok) {
            return [];
        }
        const result = await response.json();
        return extractSubscriptionsFromSheetResponse(result);
    } catch (error) {
        console.warn('[AUTH REFRESH] Failed to load subscriptions from URL:', error.message);
        return [];
    }
}

function collectShuttleReminderUsersFromSubscriptions(subscriptions = [], targetSet = new Set()) {
    (Array.isArray(subscriptions) ? subscriptions : []).forEach((subscription) => {
        if (!subscription || typeof subscription !== 'object') return;
        addUserToSet(targetSet, subscription.username || subscription.user);
    });
    return targetSet;
}

function collectShuttleReminderCandidateUsersFromRuntime() {
    const users = new Set();
    Object.keys(deviceSubscriptionsByUser || {}).forEach((userKey) => addUserToSet(users, userKey));
    for (const cacheEntry of subscriptionCache.values()) {
        if (!cacheEntry || !Array.isArray(cacheEntry.subscriptions)) continue;
        collectShuttleReminderUsersFromSubscriptions(cacheEntry.subscriptions, users);
    }
    return Array.from(users).filter((userKey) => SESSION_USER_PATTERN.test(userKey));
}

async function refreshShuttleReminderKnownUsers(options = {}) {
    const force = Boolean(options.force);
    const now = Date.now();
    const users = new Set(collectShuttleReminderCandidateUsersFromRuntime());
    const hasFreshCache = shuttleReminderKnownUsersCache.at > 0 &&
        (now - shuttleReminderKnownUsersCache.at) < SHUTTLE_REMINDER_USERS_DISCOVERY_REFRESH_MS;

    if (!force && hasFreshCache && Array.isArray(shuttleReminderKnownUsersCache.users)) {
        shuttleReminderKnownUsersCache.users.forEach((userKey) => addUserToSet(users, userKey));
    } else {
        const discoveredFromSheet = new Set();
        const sheetUrls = [
            buildGoogleSheetGetUrl({ usernames: 'all' }),
            buildGoogleSheetGetUrl({ action: 'get_all_subscriptions' }),
            buildGoogleSheetGetUrl({ action: 'get_subscriptions' })
        ];
        for (const url of sheetUrls) {
            const subscriptions = await fetchSubscriptionsFromSheetUrl(url);
            collectShuttleReminderUsersFromSubscriptions(subscriptions, discoveredFromSheet);
        }
        shuttleReminderKnownUsersCache.at = now;
        shuttleReminderKnownUsersCache.users = Array.from(discoveredFromSheet)
            .filter((userKey) => SESSION_USER_PATTERN.test(userKey));
        shuttleReminderKnownUsersCache.users.forEach((userKey) => addUserToSet(users, userKey));
    }

    return Array.from(users).filter((userKey) => SESSION_USER_PATTERN.test(userKey));
}

function pruneShuttleReminderOrdersCache() {
    const now = Date.now();
    const maxAgeMs = Math.max(
        SHUTTLE_REMINDER_USER_REFRESH_MS * 4,
        5 * 60 * 1000
    );
    Object.keys(shuttleReminderOrdersCacheByUser).forEach((userKey) => {
        const entry = shuttleReminderOrdersCacheByUser[userKey];
        const entryAt = Number(entry && entry.at) || 0;
        if (!entryAt || now - entryAt > maxAgeMs) {
            delete shuttleReminderOrdersCacheByUser[userKey];
        }
    });
}

async function fetchShuttleReminderOrdersForUser(userKey) {
    if (!SHUTTLE_USER_ORDERS_URL) {
        return [];
    }
    const normalizedUser = normalizeUserCandidate(userKey);
    if (!normalizedUser || !SESSION_USER_PATTERN.test(normalizedUser)) {
        return [];
    }
    const requestUrl = sheetIntegrationService.buildShuttleUserOrdersUrl({
        action: 'get_user_orders',
        user: normalizedUser
    });

    const response = await fetchWithRetry(
        requestUrl,
        {},
        {
            timeoutMs: SHUTTLE_REMINDER_FETCH_TIMEOUT_MS,
            retries: SHUTTLE_REMINDER_FETCH_RETRIES,
            backoffMs: 700
        }
    );
    if (!response.ok) {
        throw new Error(`Shuttle orders fetch failed (${response.status})`);
    }
    const payloadText = await response.text();
    const rows = parseShuttleReminderOrdersPayload(payloadText);
    const mappedOrders = rows
        .map((row, index) => mapShuttleReminderOrder(row, normalizedUser, index))
        .filter(Boolean);
    const dedupedByOrderKey = new Map();
    mappedOrders.forEach((order) => {
        // Keep the latest row for the same order key (sheet append order wins).
        dedupedByOrderKey.set(order.orderKey, order);
    });
    return Array.from(dedupedByOrderKey.values()).filter((order) => !order.isCancelled);
}

async function loadShuttleReminderOrdersForUser(userKey, options = {}) {
    const normalizedUser = normalizeUserCandidate(userKey);
    if (!normalizedUser || !SESSION_USER_PATTERN.test(normalizedUser)) {
        return { orders: [], source: 'invalid-user' };
    }

    const forceRefresh = Boolean(options.forceRefresh);
    const now = Date.now();
    const cacheEntry = shuttleReminderOrdersCacheByUser[normalizedUser];
    const isCacheFresh = cacheEntry &&
        Number.isFinite(Number(cacheEntry.at)) &&
        (now - Number(cacheEntry.at) < SHUTTLE_REMINDER_USER_REFRESH_MS);

    if (!forceRefresh && isCacheFresh) {
        return {
            orders: Array.isArray(cacheEntry.orders) ? cacheEntry.orders : [],
            source: 'cache'
        };
    }

    try {
        const orders = await fetchShuttleReminderOrdersForUser(normalizedUser);
        shuttleReminderOrdersCacheByUser[normalizedUser] = {
            at: now,
            orders
        };
        return { orders, source: 'remote' };
    } catch (error) {
        if (cacheEntry && Array.isArray(cacheEntry.orders)) {
            return {
                orders: cacheEntry.orders,
                source: 'stale-cache'
            };
        }
        throw error;
    }
}

async function processShuttleReminderForUser(userKey, now, options = {}) {
    const normalizedUser = normalizeUserCandidate(userKey);
    const result = {
        user: normalizedUser,
        source: 'cache',
        fetched: false,
        orderCount: 0,
        dueCount: 0,
        sent: 0,
        failed: 0,
        noTarget: 0,
        skippedAlreadySent: 0,
        errors: []
    };
    if (!normalizedUser || !SESSION_USER_PATTERN.test(normalizedUser)) {
        result.source = 'invalid-user';
        return result;
    }

    try {
        const loaded = await loadShuttleReminderOrdersForUser(
            normalizedUser,
            { forceRefresh: Boolean(options.forceRefresh) }
        );
        result.source = loaded.source;
        result.fetched = loaded.source === 'remote';

        const activeOrders = (Array.isArray(loaded.orders) ? loaded.orders : [])
            .filter((order) => Number.isFinite(Number(order.tripAt || 0)))
            .filter((order) => Number(order.tripAt) > now);
        result.orderCount = activeOrders.length;

        let dueOrders = [];
        activeOrders.forEach((order) => {
            if (hasShuttleReminderBeenSentForOrder(normalizedUser, order.orderKey)) {
                result.skippedAlreadySent += 1;
                return;
            }
            const tripAt = Number(order.tripAt || 0);
            const reminderAt = tripAt - SHUTTLE_REMINDER_LEAD_MS;
            if (now < reminderAt || now >= tripAt) {
                return;
            }
            dueOrders.push(order);
        });

        // Safety guard: when due orders come from cache/stale-cache, re-check against fresh
        // sheet data before sending to avoid reminders for recently-cancelled rides.
        if (dueOrders.length > 0 && loaded.source !== 'remote') {
            const freshLoaded = await loadShuttleReminderOrdersForUser(normalizedUser, { forceRefresh: true });
            const freshByOrderKey = new Set(
                (Array.isArray(freshLoaded.orders) ? freshLoaded.orders : [])
                    .map((order) => String(order && order.orderKey || '').trim())
                    .filter(Boolean)
            );
            dueOrders = dueOrders.filter((order) => freshByOrderKey.has(String(order.orderKey || '').trim()));
            result.source = `${result.source}+fresh-check`;
        }
        result.dueCount = dueOrders.length;

        for (const order of dueOrders) {
            const orderSummary = `${order.dateIso} | ${order.shiftLabel} | ${order.station}`;
            const reminderText = `${SHUTTLE_REMINDER_BODY_PREFIX}: ${orderSummary}`;
            const messageId = `shuttle_reminder_${generateMessageId()}`;
            const pushPayload = {
                messageId,
                title: SHUTTLE_REMINDER_TITLE,
                body: {
                    shortText: reminderText,
                    longText: reminderText
                },
                data: {
                    type: SHUTTLE_REMINDER_TYPE,
                    sender: SHUTTLE_CHAT_NAME,
                    shuttleDate: order.dateIso,
                    shuttleShift: order.shiftLabel,
                    shuttleStation: order.station
                }
            };
            await addToQueue(normalizedUser, {
                messageId,
                sender: SHUTTLE_CHAT_NAME,
                body: reminderText,
                timestamp: Date.now(),
                type: SHUTTLE_REMINDER_TYPE,
                shuttleDate: order.dateIso,
                shuttleShift: order.shiftLabel,
                shuttleStation: order.station
            });
            const pushResult = await sendPushNotificationToUser(
                [normalizedUser],
                pushPayload,
                SHUTTLE_CHAT_NAME,
                {
                    messageId,
                    skipBadge: true,
                    allowSecondAttempt: true
                }
            );
            const successCount = Number((pushResult && pushResult.success) || 0);
            const failedCount = Number((pushResult && pushResult.failed) || 0);
            if (successCount > 0) {
                markShuttleReminderSentForOrder(normalizedUser, order.orderKey, now);
                result.sent += 1;
                continue;
            }
            if (failedCount === 0) {
                result.noTarget += 1;
                continue;
            }
            result.failed += 1;
            result.errors.push(`Push failed for ${orderSummary}`);
        }
    } catch (error) {
        result.failed += 1;
        result.errors.push(error && error.message ? error.message : 'Unknown user processing error');
    }

    if (result.errors.length > 8) {
        result.errors = result.errors.slice(0, 8);
    }
    return result;
}

async function getAllSubscriptionsForAuthRefresh(options = {}) {
    const collected = [];
    const discoveredUsers = new Set();
    const requestedUsers = parseUsernamesInput(options.usernames);
    requestedUsers.forEach((userKey) => addUserToSet(discoveredUsers, userKey));

    const sheetUrls = [
        buildGoogleSheetGetUrl({ usernames: 'all' }),
        buildGoogleSheetGetUrl({ action: 'get_all_subscriptions' }),
        buildGoogleSheetGetUrl({ action: 'get_subscriptions' })
    ];
    for (const url of sheetUrls) {
        const fromSheet = await fetchSubscriptionsFromSheetUrl(url);
        if (fromSheet.length) {
            collected.push(...fromSheet);
        }
    }

    for (const cacheEntry of subscriptionCache.values()) {
        if (!cacheEntry || !Array.isArray(cacheEntry.subscriptions)) continue;
        collectSubscriptionsFromValue(cacheEntry.subscriptions, collected);
    }
    for (const userSubscriptions of Object.values(deviceSubscriptionsByUser)) {
        if (!Array.isArray(userSubscriptions) || !userSubscriptions.length) continue;
        collectSubscriptionsFromValue(userSubscriptions, collected);
    }

    dedupeSubscriptionsByEndpoint(collected).forEach((subscription) => {
        addUserToSet(discoveredUsers, subscription.username);
    });

    if (requestedUsers.length === 0) {
        const localSeeds = collectKnownUserSeeds();
        localSeeds.forEach((userKey) => addUserToSet(discoveredUsers, userKey));

        if (discoveredUsers.size > 0) {
            const expandedUsers = await discoverAdditionalUsersFromContacts(discoveredUsers);
            expandedUsers.forEach((userKey) => addUserToSet(discoveredUsers, userKey));
        }
    }

    const cacheUsersList = Array.from(discoveredUsers).slice(0, AUTH_REFRESH_MAX_DISCOVERY_USERS);
    const batchSize = 40;
    for (let i = 0; i < cacheUsersList.length; i += batchSize) {
        const batch = cacheUsersList.slice(i, i + batchSize);
        if (!batch.length) continue;
        const batchSubscriptions = await getSubscriptionFromSheet(batch, { forceRefresh: true });
        collectSubscriptionsFromValue(batchSubscriptions, collected);
    }

    const subscriptions = dedupeSubscriptionsByEndpoint(collected);
    subscriptions.forEach((subscription) => {
        addUserToSet(discoveredUsers, subscription.username);
    });

    return {
        subscriptions,
        discoveredUsers: Array.from(discoveredUsers)
    };
}

async function removeStaleSubscriptionsFromSheet(staleEndpoints = []) {
    const uniqueEndpoints = Array.from(
        new Set(
            (Array.isArray(staleEndpoints) ? staleEndpoints : [])
                .map((endpoint) => String(endpoint || '').trim())
                .filter(Boolean)
        )
    );
    if (!uniqueEndpoints.length) {
        return {
            requestedEndpoints: 0,
            clearedSubscriptions: 0,
            rowsTouched: 0,
            failedBatches: 0
        };
    }

    let clearedSubscriptions = 0;
    let rowsTouched = 0;
    let failedBatches = 0;

    for (let i = 0; i < uniqueEndpoints.length; i += AUTH_REFRESH_STALE_CLEANUP_BATCH_SIZE) {
        const batch = uniqueEndpoints.slice(i, i + AUTH_REFRESH_STALE_CLEANUP_BATCH_SIZE);
        try {
            const response = await fetchWithRetry(
                GOOGLE_SHEET_URL,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        action: 'remove_subscriptions_by_endpoint',
                        endpoints: batch
                    })
                },
                { timeoutMs: 15000, retries: 2, backoffMs: 700 }
            );
            if (!response.ok) {
                failedBatches++;
                continue;
            }
            let payload = null;
            try {
                payload = await response.json();
            } catch (error) {
                payload = null;
            }
            if (payload && payload.result === 'success') {
                clearedSubscriptions += Number(payload.clearedSubscriptions || 0);
                rowsTouched += Number(payload.rowsTouched || 0);
            }
        } catch (error) {
            failedBatches++;
        }
    }

    return {
        requestedEndpoints: uniqueEndpoints.length,
        clearedSubscriptions,
        rowsTouched,
        failedBatches
    };
}

async function runSubscriptionAuthRefreshJob(jobContext = {}) {
    if (subscriptionAuthRefreshState.running) {
        return {
            status: 'running',
            message: 'Auth refresh is already running.'
        };
    }

    subscriptionAuthRefreshState.running = true;
    const startedAt = Date.now();
    const requestId = jobContext.requestId || generateMessageId();
    const forceResubscribe = jobContext.forceResubscribe !== false;
    const refreshReason = (typeof jobContext.reason === 'string' && jobContext.reason.trim()) || 'manual';
    const initiatedBy = (typeof jobContext.initiatedBy === 'string' && jobContext.initiatedBy.trim()) || 'api';
    const requestedUsers = parseUsernamesInput(jobContext.usernames);
    const requestedDeviceTypes = parseSubscriptionDeviceTypesInput(jobContext.deviceTypes || jobContext.deviceType);
    const excludeIosEndpoints = Boolean(jobContext.excludeIosEndpoints);
    const allowStaleCleanup = jobContext.allowStaleCleanup !== false;

    let resultSummary = {
        requestId,
        startedAt,
        finishedAt: startedAt,
        requestedBy: initiatedBy,
        reason: refreshReason,
        forceResubscribe,
        requestedUserCount: requestedUsers.length,
        requestedDeviceTypes,
        excludeIosEndpoints,
        discoveredUserCount: 0,
        targeted: 0,
        success: 0,
        failed: 0,
        failures: []
    };

    try {
        const discoveryResult = await getAllSubscriptionsForAuthRefresh({ usernames: requestedUsers });
        const allDiscoveredSubscriptions = Array.isArray(discoveryResult.subscriptions) ? discoveryResult.subscriptions : [];
        const subscriptionsByType = requestedDeviceTypes.length
            ? allDiscoveredSubscriptions.filter((subscription) =>
                requestedDeviceTypes.includes(normalizeSubscriptionType(subscription && subscription.type))
            )
            : allDiscoveredSubscriptions;
        const subscriptions = excludeIosEndpoints
            ? subscriptionsByType.filter((subscription) => !isAppleWebPushEndpoint(subscription && subscription.endpoint))
            : subscriptionsByType;
        const discoveredUsers = Array.isArray(discoveryResult.discoveredUsers) ? discoveryResult.discoveredUsers : [];
        resultSummary.discoveredUserCount = discoveredUsers.length;
        if (discoveredUsers.length) {
            resultSummary.discoveredUsersSample = discoveredUsers.slice(0, 60);
        }
        resultSummary.targeted = subscriptions.length;
        if (!subscriptions.length) {
            resultSummary.finishedAt = Date.now();
            resultSummary.warning = 'No subscriptions discovered for requested scope.';
            subscriptionAuthRefreshState.lastRunAt = resultSummary.finishedAt;
            subscriptionAuthRefreshState.lastResult = resultSummary;
            return resultSummary;
        }

        const authJsonByUser = buildMobileAuthJsonByUser(subscriptions);
        const sendResults = await Promise.all(subscriptions.map(async (subscription) => {
            const userKey = normalizeUserKey(subscription.username || subscription.user);
            const pushPayload = JSON.stringify({
                data: {
                    type: AUTH_REFRESH_PUSH_TYPE,
                    title: '',
                    body: '',
                    user: subscription.username || '',
                    url: '/subscribes/',
                    requireInteraction: false,
                    skipNotification: true,
                    forceResubscribe,
                    reason: refreshReason,
                    initiatedBy,
                    requestId,
                    subscriptionUrl: '/notify/register-device',
                    vapidPublicKey: vapidKeys.publicKey
                }
            });

            try {
                const sendCall = fcmSender.isFcmSubscription(subscription)
                    ? fcmSender.sendFcmNotification(subscription, pushPayload, {
                        TTL: AUTH_REFRESH_PUSH_TTL_SECONDS,
                        headers: { Urgency: AUTH_REFRESH_PUSH_URGENCY },
                        timeout: 15000
                    })
                    : webpush.sendNotification(
                        subscription,
                        pushPayload,
                        {
                            TTL: AUTH_REFRESH_PUSH_TTL_SECONDS,
                            headers: { Urgency: AUTH_REFRESH_PUSH_URGENCY },
                            timeout: 15000
                        }
                    );
                await sendCall;
                return {
                    ok: true,
                    username: subscription.username || userKey || null,
                    userKey: userKey || null,
                    endpoint: subscription.endpoint
                };
            } catch (error) {
                const statusCode = error && error.statusCode;
                if (allowStaleCleanup && (statusCode === 404 || statusCode === 410)) {
                    pruneSubscriptionCacheEndpoint(subscription.endpoint);
                }
                return {
                    ok: false,
                    username: subscription.username || userKey || null,
                    userKey: userKey || null,
                    statusCode,
                    endpoint: subscription.endpoint,
                    error: error && error.message ? error.message : 'Unknown push error'
                };
            }
        }));

        resultSummary.success = sendResults.filter((result) => result.ok).length;
        resultSummary.failed = sendResults.length - resultSummary.success;
        resultSummary.failures = sendResults
            .filter((result) => !result.ok)
            .slice(0, AUTH_REFRESH_FAILURE_DETAILS_LIMIT)
            .map((result) => ({
                username: result.username || null,
                statusCode: result.statusCode || null,
                endpoint: result.endpoint || null,
                error: result.error || 'Unknown'
            }));
        resultSummary.finishedAt = Date.now();

        const failedDevices = sendResults
            .filter((result) => !result.ok)
            .map((result) => `${result.statusCode || 'N/A'}:${result.endpoint || 'unknown-endpoint'}`);
        const failureByStatus = sendResults
            .filter((result) => !result.ok)
            .reduce((acc, result) => {
                const key = String(result.statusCode || 'N/A');
                acc[key] = (acc[key] || 0) + 1;
                return acc;
            }, {});
        resultSummary.failureByStatus = failureByStatus;

        const staleEndpoints = sendResults
            .filter((result) => !result.ok && (result.statusCode === 404 || result.statusCode === 410))
            .map((result) => result.endpoint)
            .filter(Boolean);
        if (allowStaleCleanup && staleEndpoints.length) {
            resultSummary.staleCleanup = await removeStaleSubscriptionsFromSheet(staleEndpoints);
        }

        const userSummaryByKey = new Map();
        sendResults.forEach((result) => {
            const userKey = normalizeUserKey(result.userKey || result.username);
            if (!userKey) return;
            if (!userSummaryByKey.has(userKey)) {
                userSummaryByKey.set(userKey, {
                    user: userKey,
                    targetedDevices: 0,
                    successDevices: 0,
                    failedDevices: 0,
                    failedStatusCodes: {},
                    failedEndpoints: []
                });
            }
            const userSummary = userSummaryByKey.get(userKey);
            userSummary.targetedDevices += 1;
            if (result.ok) {
                userSummary.successDevices += 1;
            } else {
                userSummary.failedDevices += 1;
                const failedCode = String(result.statusCode || 'N/A');
                userSummary.failedStatusCodes[failedCode] = (userSummary.failedStatusCodes[failedCode] || 0) + 1;
                if (result.endpoint) {
                    userSummary.failedEndpoints.push(result.endpoint);
                }
            }
        });

        const perUserLogEntries = [];
        const successfulUsersForTouch = [];
        const perUserLogResults = [];
        for (const [userKey, userSummary] of userSummaryByKey.entries()) {
            const userStatus = userSummary.failedDevices === 0
                ? 'Sent'
                : (userSummary.successDevices > 0 ? 'Partial' : 'Failed');
            const userDetails = [
                `requestId=${requestId}`,
                `reason=${refreshReason}`,
                `targetedDevices=${userSummary.targetedDevices}`,
                `successDevices=${userSummary.successDevices}`,
                `failedDevices=${userSummary.failedDevices}`,
                `failedStatus=${Object.keys(userSummary.failedStatusCodes).length ? JSON.stringify(userSummary.failedStatusCodes) : '{}'}`,
                userSummary.failedEndpoints.length
                    ? `failedEndpoints=${userSummary.failedEndpoints.join(',')}`
                    : 'failedEndpoints=none'
            ].join(' | ');
            const recipientAuthJson = authJsonByUser.get(userKey) || '';
            perUserLogEntries.push({
                recipient: userKey,
                status: userStatus,
                details: userDetails,
                recipientAuthJson
            });
            perUserLogResults.push({
                user: userKey,
                status: userStatus,
                targetedDevices: userSummary.targetedDevices,
                successDevices: userSummary.successDevices,
                failedDevices: userSummary.failedDevices
            });
            if (userSummary.successDevices > 0) {
                successfulUsersForTouch.push(userKey);
            }
        }

        for (let i = 0; i < perUserLogEntries.length; i += AUTH_REFRESH_CONTACT_DISCOVERY_CONCURRENCY) {
            const logBatch = perUserLogEntries.slice(i, i + AUTH_REFRESH_CONTACT_DISCOVERY_CONCURRENCY);
            await Promise.all(
                logBatch.map((entry) => logNotificationStatus(
                    'System',
                    entry.recipient,
                    'Subscription auth refresh',
                    entry.status,
                    entry.details,
                    entry.recipientAuthJson
                ))
            );
        }
        resultSummary.userResults = perUserLogResults.slice(0, AUTH_REFRESH_FAILURE_DETAILS_LIMIT);
        resultSummary.userResultCount = perUserLogResults.length;

        if (successfulUsersForTouch.length) {
            resultSummary.subscriptionDateTimeUpdate = await updateSubscriptionAuthRefreshDateTime(
                successfulUsersForTouch,
                requestId
            );
        } else {
            resultSummary.subscriptionDateTimeUpdate = {
                requestedUsers: 0,
                updatedRows: 0,
                missingUsers: []
            };
        }

        if (resultSummary.success === 0 && resultSummary.failed > 0) {
            const failedStatusCodes = Object.keys(failureByStatus);
            if (failedStatusCodes.every((code) => code === '404' || code === '410')) {
                resultSummary.hint = 'All targeted subscriptions are stale/unsubscribed. Users must open app once to re-register.';
            } else if (failedStatusCodes.every((code) => code === '401' || code === '403')) {
                resultSummary.hint = 'Push auth rejected. Check VAPID key consistency between backend and clients.';
            } else if (failedStatusCodes.includes('400')) {
                resultSummary.hint = 'Invalid subscription payloads detected. Auth JSON might be corrupted for those devices.';
            }
        }
        const statusText = resultSummary.success > 0 ? 'Sent' : 'Failed';
        const logDetails = [
            `requestId=${requestId}`,
            `reason=${refreshReason}`,
            `requestedBy=${initiatedBy}`,
            `discoveredUsers=${resultSummary.discoveredUserCount}`,
            `targeted=${resultSummary.targeted}`,
            `success=${resultSummary.success}`,
            `failed=${resultSummary.failed}`,
            `perUserLogs=${resultSummary.userResultCount || 0}`,
            resultSummary.subscriptionDateTimeUpdate
                ? `datetimeUpdated=${resultSummary.subscriptionDateTimeUpdate.updatedRows || 0}/${resultSummary.subscriptionDateTimeUpdate.requestedUsers || 0}`
                : 'datetimeUpdated=0/0',
            resultSummary.staleCleanup
                ? `staleCleanup=${resultSummary.staleCleanup.clearedSubscriptions}/${resultSummary.staleCleanup.requestedEndpoints}`
                : 'staleCleanup=none',
            failedDevices.length ? `failedEndpoints=${failedDevices.join(',')}` : 'failedEndpoints=none'
        ].join(' | ');
        logNotificationStatus(
            'System',
            'ALL',
            'Subscription auth refresh',
            statusText,
            logDetails
        );
    } catch (error) {
        resultSummary.finishedAt = Date.now();
        resultSummary.failed = resultSummary.targeted || resultSummary.failed || 1;
        resultSummary.error = error && error.message ? error.message : 'Unknown background refresh error';
        console.error('[AUTH REFRESH] Background refresh failed:', error.message);
    } finally {
        subscriptionAuthRefreshState.running = false;
        subscriptionAuthRefreshState.lastRunAt = Date.now();
        subscriptionAuthRefreshState.lastResult = resultSummary;
    }

    return resultSummary;
}

function getNextAuthRefreshSchedulerRunDate(baseDate = new Date()) {
    const now = baseDate instanceof Date ? baseDate : new Date();
    const nextRun = new Date(now.getTime());
    nextRun.setHours(
        AUTH_REFRESH_SCHEDULER_DAILY_TIME.hour,
        AUTH_REFRESH_SCHEDULER_DAILY_TIME.minute,
        AUTH_REFRESH_SCHEDULER_DAILY_TIME.second,
        0
    );
    if (nextRun.getTime() <= now.getTime()) {
        nextRun.setDate(nextRun.getDate() + 1);
    }
    return nextRun;
}

function startSubscriptionAuthRefreshScheduler() {
    if (authRefreshSchedulerStarted) {
        return;
    }
    authRefreshSchedulerStarted = true;

    if (!AUTH_REFRESH_SCHEDULER_ENABLED) {
        console.log('[AUTH REFRESH] Scheduler disabled by AUTH_REFRESH_SCHEDULER_ENABLED=false.');
        return;
    }

    const runScheduledRefresh = () => {
        runSubscriptionAuthRefreshJob({
            requestId: generateMessageId(),
            reason: 'scheduled-daily-keepalive',
            initiatedBy: 'scheduler',
            forceResubscribe: AUTH_REFRESH_SCHEDULER_FORCE_RESUBSCRIBE,
            deviceTypes: AUTH_REFRESH_SCHEDULER_DEVICE_TYPES,
            excludeIosEndpoints: AUTH_REFRESH_SCHEDULER_EXCLUDE_IOS_ENDPOINTS,
            allowStaleCleanup: false
        })
            .then((summary) => {
                if (!summary || summary.status === 'running') {
                    return;
                }
                console.log(
                    `[AUTH REFRESH] Scheduler run ${summary.requestId || 'n/a'} | targeted=${summary.targeted || 0} success=${summary.success || 0} failed=${summary.failed || 0}`
                );
            })
            .catch((error) => {
                console.error('[AUTH REFRESH] Scheduler run failed:', error && error.message ? error.message : error);
            });
    };

    const scheduleNextRun = () => {
        const now = new Date();
        const nextRun = getNextAuthRefreshSchedulerRunDate(now);
        const delayMs = Math.max(1000, nextRun.getTime() - now.getTime());
        setTimeout(() => {
            runScheduledRefresh();
            scheduleNextRun();
        }, delayMs);
        console.log(
            `[AUTH REFRESH] Next scheduler run at ${nextRun.toISOString()} (local ${AUTH_REFRESH_SCHEDULER_DAILY_TIME.label})`
        );
    };

    scheduleNextRun();
    console.log(
        `[AUTH REFRESH] Scheduler armed | dailyLocalTime=${AUTH_REFRESH_SCHEDULER_DAILY_TIME.label} | deviceTypes=${AUTH_REFRESH_SCHEDULER_DEVICE_TYPES || 'all'} | excludeIosEndpoints=${AUTH_REFRESH_SCHEDULER_EXCLUDE_IOS_ENDPOINTS} | forceResubscribe=${AUTH_REFRESH_SCHEDULER_FORCE_RESUBSCRIBE}`
    );
}

async function runShuttleReminderJob(jobContext = {}) {
    const trigger = (typeof jobContext.trigger === 'string' && jobContext.trigger.trim())
        ? jobContext.trigger.trim()
        : 'manual';
    if (!SHUTTLE_USER_ORDERS_URL) {
        return {
            status: 'disabled',
            reason: 'Missing SHUTTLE_USER_ORDERS_URL'
        };
    }
    if (!SHUTTLE_REMINDER_ENABLED && !parseBooleanInput(jobContext.allowWhenDisabled, false)) {
        return {
            status: 'disabled',
            reason: 'SHUTTLE_REMINDER_ENABLED=false'
        };
    }
    if (shuttleReminderState.running) {
        return {
            status: 'running',
            message: 'Shuttle reminder scheduler is already running.'
        };
    }

    shuttleReminderState.running = true;
    shuttleReminderState.lastTickTrigger = trigger;
    const startedAt = Date.now();
    const summary = {
        requestId: jobContext.requestId || generateMessageId(),
        trigger,
        startedAt,
        finishedAt: startedAt,
        candidateUsers: 0,
        processedUsers: 0,
        fetchedUsers: 0,
        dueOrders: 0,
        sent: 0,
        failed: 0,
        noTarget: 0,
        skippedAlreadySent: 0,
        sentStateCount: 0,
        userResultsSample: [],
        errors: []
    };
    const sentStateCountBefore = Object.keys(shuttleReminderSentAtByKey).length;

    try {
        pruneShuttleReminderSentState();
        pruneShuttleReminderOrdersCache();
        const users = await refreshShuttleReminderKnownUsers({
            force: parseBooleanInput(jobContext.forceUsersRefresh, false)
        });
        summary.candidateUsers = users.length;
        const tickNow = Date.now();

        for (let i = 0; i < users.length; i += SHUTTLE_REMINDER_USER_PROCESS_BATCH) {
            const batch = users.slice(i, i + SHUTTLE_REMINDER_USER_PROCESS_BATCH);
            const batchResults = await Promise.all(
                batch.map((userKey) =>
                    processShuttleReminderForUser(
                        userKey,
                        tickNow,
                        { forceRefresh: parseBooleanInput(jobContext.forceOrdersRefresh, false) }
                    )
                )
            );
            batchResults.forEach((result) => {
                summary.processedUsers += 1;
                if (result.fetched) summary.fetchedUsers += 1;
                summary.dueOrders += Number(result.dueCount || 0);
                summary.sent += Number(result.sent || 0);
                summary.failed += Number(result.failed || 0);
                summary.noTarget += Number(result.noTarget || 0);
                summary.skippedAlreadySent += Number(result.skippedAlreadySent || 0);
                if (summary.userResultsSample.length < 30) {
                    summary.userResultsSample.push({
                        user: result.user,
                        source: result.source,
                        dueCount: result.dueCount,
                        sent: result.sent,
                        failed: result.failed,
                        noTarget: result.noTarget
                    });
                }
                if (Array.isArray(result.errors) && result.errors.length && summary.errors.length < 80) {
                    result.errors.slice(0, 3).forEach((item) => {
                        if (summary.errors.length < 80) {
                            summary.errors.push(`[${result.user}] ${item}`);
                        }
                    });
                }
            });
        }

        pruneShuttleReminderSentState();
        summary.sentStateCount = Object.keys(shuttleReminderSentAtByKey).length;
        if (summary.sent > 0 || summary.sentStateCount !== sentStateCountBefore) {
            scheduleStateSave();
        }
    } catch (error) {
        summary.failed += 1;
        summary.errors.push(error && error.message ? error.message : 'Unknown shuttle reminder scheduler error');
    } finally {
        summary.finishedAt = Date.now();
        shuttleReminderState.running = false;
        shuttleReminderState.lastRunAt = summary.finishedAt;
        shuttleReminderState.lastResult = summary;
    }

    return summary;
}

function startShuttleReminderScheduler() {
    if (shuttleReminderSchedulerStarted) {
        return;
    }
    shuttleReminderSchedulerStarted = true;

    if (!SHUTTLE_REMINDER_ENABLED) {
        console.log('[SHUTTLE REMINDER] Scheduler disabled by SHUTTLE_REMINDER_ENABLED=false.');
        return;
    }
    if (!SHUTTLE_USER_ORDERS_URL) {
        console.log('[SHUTTLE REMINDER] Scheduler disabled because SHUTTLE_USER_ORDERS_URL is missing.');
        return;
    }

    const runTick = (trigger) => {
        runShuttleReminderJob({ trigger })
            .then((summary) => {
                if (!summary || summary.status === 'running' || summary.status === 'disabled') {
                    return;
                }
                if (summary.sent > 0 || summary.failed > 0 || summary.dueOrders > 0) {
                    console.log(
                        `[SHUTTLE REMINDER] ${summary.requestId} | trigger=${trigger} | users=${summary.candidateUsers} due=${summary.dueOrders} sent=${summary.sent} failed=${summary.failed} noTarget=${summary.noTarget}`
                    );
                }
            })
            .catch((error) => {
                console.error('[SHUTTLE REMINDER] Tick failed:', error && error.message ? error.message : error);
            });
    };

    shuttleReminderSchedulerTimer = setInterval(() => {
        runTick('interval');
    }, SHUTTLE_REMINDER_INTERVAL_MS);
    setTimeout(() => runTick('startup'), 4000);

    const effectiveTimeZone = getShuttleReminderEffectiveTimeZone();
    console.log(
        `[SHUTTLE REMINDER] Scheduler armed | intervalMs=${SHUTTLE_REMINDER_INTERVAL_MS} | leadMs=${SHUTTLE_REMINDER_LEAD_MS} | timezone=${effectiveTimeZone} | usersRefreshMs=${SHUTTLE_REMINDER_USERS_DISCOVERY_REFRESH_MS} | ordersRefreshMs=${SHUTTLE_REMINDER_USER_REFRESH_MS}`
    );
}

function isSchedulerOpsRequestAuthorized(req) {
    const token = String(
        (req.query && req.query.token) ||
        (req.headers && (req.headers['x-admin-token'] || req.headers['x-app-token'])) ||
        ''
    ).trim();
    if (APP_SERVER_TOKEN) {
        return token === APP_SERVER_TOKEN;
    }
    return Boolean(normalizeUserCandidate(req.authUser));
}

async function runMobileReregisterPromptCampaign(jobContext = {}) {
    if (mobileReregisterCampaignState.running) {
        return {
            status: 'running',
            message: 'Mobile re-register prompt campaign is already running.'
        };
    }

    mobileReregisterCampaignState.running = true;
    const startedAt = Date.now();
    const requestId = jobContext.requestId || generateMessageId();
    const campaignId = sanitizeCampaignId(jobContext.campaignId);
    const requestedUsers = parseUsernamesInput(jobContext.usernames);
    const requestedDeviceTypes = parseSubscriptionDeviceTypesInput(jobContext.deviceTypes || jobContext.deviceType);
    const effectiveDeviceTypes = requestedDeviceTypes.length ? requestedDeviceTypes : ['mobile', 'pc'];
    const oneTime = parseBooleanInput(jobContext.oneTime, true);
    const force = parseBooleanInput(jobContext.force, false);
    const requireInteraction = parseBooleanInput(jobContext.requireInteraction, true);
    const maxTargets = parsePositiveInteger(jobContext.maxTargets, 0);
    const title = (typeof jobContext.title === 'string' && jobContext.title.trim())
        ? jobContext.title.trim()
        : MOBILE_REREGISTER_DEFAULT_TITLE;
    const body = (typeof jobContext.body === 'string' && jobContext.body.trim())
        ? jobContext.body.trim()
        : MOBILE_REREGISTER_DEFAULT_BODY;
    const url = (typeof jobContext.url === 'string' && jobContext.url.trim())
        ? jobContext.url.trim()
        : MOBILE_REREGISTER_DEFAULT_URL;

    let summary = {
        requestId,
        campaignId,
        startedAt,
        finishedAt: startedAt,
        requestedUserCount: requestedUsers.length,
        requestedDeviceTypes: effectiveDeviceTypes,
        oneTime,
        force,
        discoveredUserCount: 0,
        discoveredSubscriptions: 0,
        targetCandidates: 0,
        targeted: 0,
        skippedAlreadySent: 0,
        skippedMissingUser: 0,
        skippedByLimit: 0,
        success: 0,
        failed: 0,
        failures: []
    };

    try {
        const discoveryResult = await getAllSubscriptionsForAuthRefresh({ usernames: requestedUsers });
        const discoveredUsers = Array.isArray(discoveryResult.discoveredUsers) ? discoveryResult.discoveredUsers : [];
        const allDiscoveredSubscriptions = Array.isArray(discoveryResult.subscriptions)
            ? discoveryResult.subscriptions
            : [];
        const includeUnknownType = effectiveDeviceTypes.includes('mobile') && effectiveDeviceTypes.includes('pc');
        const filteredSubscriptions = allDiscoveredSubscriptions
            .filter((subscription) => {
                const subscriptionType = normalizeSubscriptionType(subscription && subscription.type);
                if (!subscriptionType) return includeUnknownType;
                return effectiveDeviceTypes.includes(subscriptionType);
            });
        summary.discoveredUserCount = discoveredUsers.length;
        summary.discoveredSubscriptions = filteredSubscriptions.length;

        if (!filteredSubscriptions.length) {
            summary.finishedAt = Date.now();
            summary.warning = 'No subscriptions discovered for requested device scope.';
            mobileReregisterCampaignState.lastRunAt = summary.finishedAt;
            mobileReregisterCampaignState.lastResult = summary;
            return summary;
        }

        const targetCandidates = dedupeSubscriptionsByEndpoint(filteredSubscriptions);
        summary.targetCandidates = targetCandidates.length;
        const sentTargetsSet = getCampaignSentTargetsSet(campaignId);
        const targets = [];
        targetCandidates.forEach((subscription) => {
            const endpoint = typeof subscription.endpoint === 'string' ? subscription.endpoint.trim() : '';
            const userKey = normalizeUserKey(subscription && (subscription.username || subscription.user));
            if (!endpoint) {
                summary.skippedMissingUser += 1;
                return;
            }
            if (!userKey) {
                summary.skippedMissingUser += 1;
                return;
            }
            if (oneTime && !force && sentTargetsSet.has(endpoint)) {
                summary.skippedAlreadySent += 1;
                return;
            }
            targets.push({ ...subscription, username: userKey, endpoint });
        });

        if (maxTargets > 0 && targets.length > maxTargets) {
            summary.skippedByLimit = targets.length - maxTargets;
            targets.length = maxTargets;
        }
        summary.targeted = targets.length;

        if (!targets.length) {
            summary.finishedAt = Date.now();
            summary.warning = 'No eligible subscriptions after one-time filters.';
            mobileReregisterCampaignState.lastRunAt = summary.finishedAt;
            mobileReregisterCampaignState.lastResult = summary;
            return summary;
        }

        const deliveredUsers = new Set();
        const deliveredEndpoints = new Set();
        const failures = [];

        for (let i = 0; i < targets.length; i += MOBILE_REREGISTER_SEND_CONCURRENCY) {
            const batch = targets.slice(i, i + MOBILE_REREGISTER_SEND_CONCURRENCY);
            const batchResults = await Promise.all(batch.map(async (subscription) => {
                const pushPayload = JSON.stringify({
                    data: {
                        type: MOBILE_REREGISTER_PUSH_TYPE,
                        title,
                        body,
                        user: subscription.username || '',
                        url,
                        requireInteraction,
                        skipNotification: false,
                        campaignId,
                        sender: 'System',
                        messageId: requestId
                    }
                });

                try {
                    const sendCall = fcmSender.isFcmSubscription(subscription)
                        ? fcmSender.sendFcmNotification(subscription, pushPayload, {
                            TTL: MOBILE_REREGISTER_PUSH_TTL_SECONDS,
                            headers: { Urgency: MOBILE_REREGISTER_PUSH_URGENCY },
                            timeout: 15000
                        })
                        : webpush.sendNotification(
                            subscription,
                            pushPayload,
                            {
                                TTL: MOBILE_REREGISTER_PUSH_TTL_SECONDS,
                                headers: { Urgency: MOBILE_REREGISTER_PUSH_URGENCY },
                                timeout: 15000
                            }
                        );
                    await sendCall;
                    return {
                        ok: true,
                        user: subscription.username,
                        endpoint: subscription.endpoint
                    };
                } catch (error) {
                    return {
                        ok: false,
                        user: subscription.username,
                        statusCode: error && error.statusCode ? error.statusCode : null,
                        error: error && error.message ? error.message : 'Unknown push error'
                    };
                }
            }));

            batchResults.forEach((result) => {
                if (result.ok) {
                    summary.success += 1;
                    deliveredUsers.add(normalizeUserKey(result.user));
                    if (result.endpoint) {
                        deliveredEndpoints.add(result.endpoint);
                    }
                } else {
                    summary.failed += 1;
                    failures.push({
                        user: result.user || null,
                        statusCode: result.statusCode || null,
                        error: result.error || 'Unknown'
                    });
                }
            });
        }

        failures
            .slice(0, AUTH_REFRESH_FAILURE_DETAILS_LIMIT)
            .forEach((failure) => summary.failures.push(failure));

        deliveredEndpoints.forEach((endpoint) => {
            if (endpoint) sentTargetsSet.add(endpoint);
        });
        summary.finishedAt = Date.now();
        summary.sentUsersSample = Array.from(deliveredUsers).slice(0, 120);
        summary.sentTargetsCountForCampaign = getCampaignSentCount(campaignId);

        const detailParts = [
            `requestId=${requestId}`,
            `campaignId=${campaignId}`,
            `requestedUserCount=${summary.requestedUserCount}`,
            `targeted=${summary.targeted}`,
            `success=${summary.success}`,
            `failed=${summary.failed}`,
            `skippedAlreadySent=${summary.skippedAlreadySent}`,
            `skippedByLimit=${summary.skippedByLimit}`,
            `deviceTypes=${effectiveDeviceTypes.join(',')}`,
            `oneTime=${oneTime}`,
            `force=${force}`,
            `campaignSentTargets=${summary.sentTargetsCountForCampaign}`
        ];
        const statusText = summary.success > 0 ? 'Sent' : 'Failed';
        logNotificationStatus(
            'System',
            requestedUsers.length ? requestedUsers.join(',') : 'ALL',
            'Device re-register prompt campaign',
            statusText,
            detailParts.join(' | ')
        );
    } catch (error) {
        summary.finishedAt = Date.now();
        summary.error = error && error.message ? error.message : 'Unknown campaign error';
        summary.failed = summary.targeted || summary.failed || 1;
        console.error('[MOBILE REREGISTER] Campaign failed:', summary.error);
    } finally {
        mobileReregisterCampaignState.running = false;
        mobileReregisterCampaignState.lastRunAt = Date.now();
        mobileReregisterCampaignState.lastResult = summary;
    }

    return summary;
}

function normalizeGroupMembersInput(rawValue) {
    return Array.from(
        new Set(parseUsernamesInput(rawValue).map(normalizeUserKey).filter(Boolean))
    );
}

function resolveGroupAdminsInput(rawValue, options = {}) {
    const normalizedRawAdmins = normalizeGroupMembersInput(rawValue);
    if (normalizedRawAdmins.length) {
        return normalizedRawAdmins;
    }

    const existingAdmins = normalizeGroupMembersInput(options.existingAdmins);
    if (existingAdmins.length) {
        return existingAdmins;
    }

    const hardcodedPolicy = resolveHardcodedCommunityPolicy(
        options.groupRecord || null,
        options.groupId || '',
        options.groupName || ''
    );
    if (hardcodedPolicy && hardcodedPolicy.writers && hardcodedPolicy.writers.size) {
        return Array.from(new Set(Array.from(hardcodedPolicy.writers).map(normalizeUserKey).filter(Boolean)));
    }

    const createdByFallback = normalizeUserKey(options.createdBy || '');
    if (createdByFallback) {
        return [createdByFallback];
    }

    return [];
}

function normalizeRuntimeGroupRecord(rawGroup = {}, idHint = '') {
    const groupId = String(rawGroup.id || rawGroup.groupId || rawGroup.groupID || idHint || '').trim();
    const groupName = String(rawGroup.name || rawGroup.groupName || rawGroup.title || '').trim();
    if (!groupId || !groupName) {
        return null;
    }

    const createdBy = normalizeUserKey(
        rawGroup.createdBy ||
        rawGroup.groupCreatedBy ||
        rawGroup.creator ||
        ''
    );
    const type = normalizeGroupType(rawGroup.type || rawGroup.groupType || 'group');
    const fallbackRecord = {
        id: groupId,
        name: groupName,
        type,
        createdBy
    };
    const admins = resolveGroupAdminsInput(
        rawGroup.admins || rawGroup.groupAdmins,
        {
            existingAdmins: rawGroup.admins || rawGroup.groupAdmins,
            groupId,
            groupName,
            groupRecord: fallbackRecord,
            createdBy
        }
    );
    const resolvedCreatedBy = createdBy || admins[0] || null;
    const updatedAtRaw = Number(rawGroup.updatedAt || rawGroup.groupUpdatedAt || rawGroup.lastUpdatedAt || Date.now());
    const updatedAt = Number.isFinite(updatedAtRaw) && updatedAtRaw > 0 ? updatedAtRaw : Date.now();
    const createdAtRaw = Number(rawGroup.createdAt || rawGroup.groupCreatedAt || updatedAt);
    const createdAt = Number.isFinite(createdAtRaw) && createdAtRaw > 0 ? createdAtRaw : updatedAt;
    const members = normalizeGroupMembersInput(
        rawGroup.members || rawGroup.groupMembers || rawGroup.memberList || []
    );

    return {
        id: groupId,
        name: groupName,
        members,
        admins,
        createdBy: resolvedCreatedBy,
        createdAt,
        updatedAt,
        type
    };
}

function normalizeGroupsCollection(rawGroups = {}) {
    const sourceItems = Array.isArray(rawGroups)
        ? rawGroups
        : Object.entries(rawGroups || {}).map(([groupId, groupValue]) => {
            if (groupValue && typeof groupValue === 'object') {
                return { ...groupValue, id: groupValue.id || groupId };
            }
            return { id: groupId };
        });
    const normalizedById = {};
    sourceItems.forEach((item) => {
        const normalized = normalizeRuntimeGroupRecord(item, item && item.id ? item.id : '');
        if (!normalized) return;
        const existing = normalizedById[normalized.id];
        if (!existing || Number(normalized.updatedAt || 0) >= Number(existing.updatedAt || 0)) {
            normalizedById[normalized.id] = normalized;
        }
    });
    return normalizedById;
}

function buildGroupsDbPayloadFromRuntime() {
    const groupRecords = Object.values(groups || {})
        .map((group) => normalizeRuntimeGroupRecord(group, group && group.id ? group.id : ''))
        .filter(Boolean)
        .map((group) => ({
            groupID: group.id,
            title: group.name,
            memberList: Array.isArray(group.members) ? group.members : [],
            admins: Array.isArray(group.admins) ? group.admins : [],
            createdBy: group.createdBy || null,
            groupType: group.type || 'group',
            createdAt: group.createdAt || Date.now(),
            updatedAt: group.updatedAt || Date.now()
        }))
        .sort((left, right) => String(left.groupID || '').localeCompare(String(right.groupID || '')));
    return {
        version: 1,
        updatedAt: Date.now(),
        groups: groupRecords
    };
}

async function persistGroupsLocalDb() {
    try {
        await fsp.mkdir(stateDir, { recursive: true });
        const payload = JSON.stringify(buildGroupsDbPayloadFromRuntime());
        const tmpFile = `${groupsDbFile}.tmp`;
        await fsp.writeFile(tmpFile, payload, 'utf8');
        await fsp.rename(tmpFile, groupsDbFile);
    } catch (error) {
        console.warn('[GROUPS DB] Failed to persist groups local DB:', error && error.message ? error.message : error);
    }
}

async function readGroupsLocalDbRecords() {
    try {
        await fsp.mkdir(stateDir, { recursive: true });
        const raw = await fsp.readFile(groupsDbFile, 'utf8');
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
            return parsed;
        }
        if (parsed && Array.isArray(parsed.groups)) {
            return parsed.groups;
        }
        if (parsed && typeof parsed === 'object') {
            return Object.values(parsed);
        }
        return [];
    } catch (error) {
        if (error && error.code !== 'ENOENT') {
            console.warn('[GROUPS DB] Failed to load groups local DB:', error.message);
        }
        return [];
    }
}

async function hydrateGroupsFromLocalDb() {
    const dbRecords = await readGroupsLocalDbRecords();
    if (!dbRecords.length) return;
    const normalizedDbGroups = normalizeGroupsCollection(
        dbRecords.map((record) => ({
            id: record && (record.id || record.groupId || record.groupID),
            name: record && (record.name || record.groupName || record.title),
            members: record && (record.members || record.groupMembers || record.memberList),
            admins: record && (record.admins || record.groupAdmins),
            createdBy: record && (record.createdBy || record.groupCreatedBy),
            updatedAt: record && (record.updatedAt || record.groupUpdatedAt),
            createdAt: record && (record.createdAt || record.groupCreatedAt),
            type: record && (record.type || record.groupType)
        }))
    );
    groups = normalizeGroupsCollection([
        ...Object.values(groups || {}),
        ...Object.values(normalizedDbGroups || {})
    ]);
}

async function hydrateGroupsFromMysql() {
    try {
        // One-time migration: seed MySQL from runtime groups if MySQL ChatGroups is empty
        const runtimeGroupRecords = Object.values(groups || {})
            .map((group) => normalizeRuntimeGroupRecord(group, group && group.id ? group.id : ''))
            .filter(Boolean)
            .map((group) => ({
                groupId: group.id,
                groupName: group.name,
                members: Array.isArray(group.members) ? group.members : [],
                admins: Array.isArray(group.admins) ? group.admins : [],
                createdBy: group.createdBy || null,
                type: group.type || 'group',
                createdAt: group.createdAt || Date.now(),
                updatedAt: group.updatedAt || Date.now()
            }));
        if (runtimeGroupRecords.length > 0) {
            await mysqlLogsService.seedChatGroupsFromRuntime(runtimeGroupRecords);
        }

        // Load all groups from MySQL and merge into runtime (MySQL wins for same-or-newer updatedAt)
        const mysqlGroups = await mysqlLogsService.loadAllChatGroups();
        if (!mysqlGroups.length) return;
        const mysqlNormalized = normalizeGroupsCollection(
            mysqlGroups.map((record) => ({
                id: record.groupId,
                name: record.groupName,
                members: record.members,
                admins: record.admins,
                createdBy: record.createdBy,
                type: record.type,
                createdAt: record.createdAt,
                updatedAt: record.updatedAt
            }))
        );
        // Merge: MySQL records override runtime if their updatedAt is >= runtime
        for (const [groupId, mysqlGroup] of Object.entries(mysqlNormalized)) {
            const existing = groups[groupId];
            if (!existing || Number(mysqlGroup.updatedAt || 0) >= Number(existing.updatedAt || 0)) {
                groups[groupId] = mysqlGroup;
            }
        }
        console.log(`[GROUPS DB] Loaded ${mysqlGroups.length} group(s) from MySQL.`);
    } catch (err) {
        console.warn('[GROUPS DB] Failed to hydrate groups from MySQL:', err && err.message ? err.message : err);
    }
}

function upsertGroup(payload = {}) {
    const groupId = String(payload.groupId || payload.groupID || '').trim();
    const groupName = String(payload.groupName || payload.title || '').trim();
    if (!groupId || !groupName) return null;

    const existing = normalizeRuntimeGroupRecord(groups[groupId] || {}, groupId) || {};
    const updatedAtRaw = Number(payload.groupUpdatedAt || payload.updatedAt || Date.now());
    const updatedAt = Number.isFinite(updatedAtRaw) && updatedAtRaw > 0 ? updatedAtRaw : Date.now();
    const incomingMembers = normalizeGroupMembersInput(payload.groupMembers || payload.memberList || []);
    const shouldUpdateMembers = incomingMembers.length > 0 &&
        (!existing.updatedAt || updatedAt >= Number(existing.updatedAt || 0));
    const nextMembers = shouldUpdateMembers
        ? incomingMembers
        : normalizeGroupMembersInput(existing.members || []);
    const type = normalizeGroupType(payload.groupType || existing.type || 'group');
    const rawCreatedBy = normalizeUserKey(payload.groupCreatedBy || payload.createdBy || existing.createdBy || '');
    const admins = resolveGroupAdminsInput(
        payload.groupAdmins || payload.admins,
        {
            existingAdmins: existing.admins,
            groupId,
            groupName,
            groupRecord: { id: groupId, name: groupName, type, createdBy: rawCreatedBy || existing.createdBy || '' },
            createdBy: rawCreatedBy || existing.createdBy || ''
        }
    );
    const createdBy = rawCreatedBy || admins[0] || null;
    const createdAtRaw = Number(existing.createdAt || payload.groupCreatedAt || payload.createdAt || Date.now());
    const createdAt = Number.isFinite(createdAtRaw) && createdAtRaw > 0 ? createdAtRaw : Date.now();

    const nextGroup = normalizeRuntimeGroupRecord({
        id: groupId,
        name: groupName,
        members: nextMembers,
        admins,
        createdBy,
        createdAt,
        updatedAt: Math.max(Number(existing.updatedAt || 0), updatedAt),
        type
    }, groupId);
    if (!nextGroup) return null;

    groups[groupId] = nextGroup;
    scheduleStateSave();
    // Persist to MySQL asynchronously (errors are logged but do not block the caller)
    mysqlLogsService.upsertChatGroup({
        groupId: nextGroup.id,
        groupName: nextGroup.name,
        members: Array.isArray(nextGroup.members) ? nextGroup.members : [],
        admins: Array.isArray(nextGroup.admins) ? nextGroup.admins : [],
        createdBy: nextGroup.createdBy || null,
        type: nextGroup.type || 'group',
        createdAt: nextGroup.createdAt || Date.now(),
        updatedAt: nextGroup.updatedAt || Date.now()
    }).catch((err) => {
        console.warn('[GROUPS DB] MySQL upsert failed for', groupId, ':', err && err.message ? err.message : err);
    });
    return nextGroup;
}

function resetShuttleReminderCaches() {
    shuttleReminderKnownUsersCache.at = 0;
    shuttleReminderKnownUsersCache.users = [];
    Object.keys(shuttleReminderOrdersCacheByUser).forEach((userKey) => {
        delete shuttleReminderOrdersCacheByUser[userKey];
    });
}

async function loadState() {
    // Set up Redis for queue pub/sub (message delivery), independent of state persistence
    const redisStore = await redisStateStorePromise;
    if (redisStore && redisStore.isEnabled) {
        activeRedisStateStore = redisStore;
        await ensureRedisQueuePubSubBridge();
    }

    // ── Primary: load persisted state from MySQL ──
    try {
        const mysqlState = await mysqlLogsService.loadServerState();
        if (mysqlState) {
            const nextUnreadCounts = (mysqlState.unreadCounts && typeof mysqlState.unreadCounts === 'object')
                ? mysqlState.unreadCounts
                : {};
            replaceObjectContents(unreadCounts, nextUnreadCounts);
            messageQueue = {};
            groups = (mysqlState.groups && typeof mysqlState.groups === 'object')
                ? mysqlState.groups
                : {};
            groups = normalizeGroupsCollection(groups);
            deviceSubscriptionsByUser = normalizeLocalDeviceSubscriptionsRegistry(
                (mysqlState.deviceSubscriptionsByUser && typeof mysqlState.deviceSubscriptionsByUser === 'object')
                    ? mysqlState.deviceSubscriptionsByUser
                    : {}
            );
            shuttleReminderSentAtByKey = normalizeShuttleReminderSentState(
                (mysqlState.shuttleReminderSentAtByKey && typeof mysqlState.shuttleReminderSentAtByKey === 'object')
                    ? mysqlState.shuttleReminderSentAtByKey
                    : {}
            );
            resetShuttleReminderCaches();
            console.log('[STATE] Loaded persisted state from MySQL.');
            mysqlStateEnabled = true;
            await hydrateGroupsFromMysql();
            await loadAndSeedCommunityGroups();
            return;
        }
    } catch (error) {
        mysqlStateEnabled = false;
        console.warn('[STATE] MySQL state load failed, falling back:', error && error.message ? error.message : error);
    }

    // ── Fallback: load from Redis (legacy) ──
    if (activeRedisStateStore && activeRedisStateStore.isEnabled) {
        try {
            const redisState = await activeRedisStateStore.loadState();
            if (redisState) {
                const nextUnreadCounts = (redisState.unreadCounts && typeof redisState.unreadCounts === 'object')
                    ? redisState.unreadCounts
                    : {};
                replaceObjectContents(unreadCounts, nextUnreadCounts);
                messageQueue = {};
                groups = (redisState.groups && typeof redisState.groups === 'object')
                    ? redisState.groups
                    : {};
                groups = normalizeGroupsCollection(groups);
                deviceSubscriptionsByUser = normalizeLocalDeviceSubscriptionsRegistry(
                    (redisState.deviceSubscriptionsByUser && typeof redisState.deviceSubscriptionsByUser === 'object')
                        ? redisState.deviceSubscriptionsByUser
                        : {}
                );
                shuttleReminderSentAtByKey = normalizeShuttleReminderSentState(
                    (redisState.shuttleReminderSentAtByKey && typeof redisState.shuttleReminderSentAtByKey === 'object')
                        ? redisState.shuttleReminderSentAtByKey
                        : {}
                );
                resetShuttleReminderCaches();
                await hydrateGroupsFromLocalDb();
                console.log('[STATE] Loaded persisted state from Redis (legacy). Will migrate to MySQL on next save.');
                await hydrateGroupsFromMysql();
                await loadAndSeedCommunityGroups();
                return;
            }
        } catch (error) {
            console.warn('[STATE] Redis load failed, falling back to file state:', error && error.message ? error.message : error);
        }
    }

    // ── Fallback: load from local file (legacy) ──
    try {
        await fsp.mkdir(stateDir, { recursive: true });
        const raw = await fsp.readFile(stateFile, 'utf8');
        const data = JSON.parse(raw);
        const nextUnreadCounts = (data.unreadCounts && typeof data.unreadCounts === 'object') ? data.unreadCounts : {};
        replaceObjectContents(unreadCounts, nextUnreadCounts);
        messageQueue = (data.messageQueue && typeof data.messageQueue === 'object') ? data.messageQueue : {};
        groups = (data.groups && typeof data.groups === 'object') ? data.groups : {};
        groups = normalizeGroupsCollection(groups);
        deviceSubscriptionsByUser = normalizeLocalDeviceSubscriptionsRegistry(
            (data.deviceSubscriptionsByUser && typeof data.deviceSubscriptionsByUser === 'object')
                ? data.deviceSubscriptionsByUser
                : {}
        );
        shuttleReminderSentAtByKey = normalizeShuttleReminderSentState(
            (data.shuttleReminderSentAtByKey && typeof data.shuttleReminderSentAtByKey === 'object')
                ? data.shuttleReminderSentAtByKey
                : {}
        );
        resetShuttleReminderCaches();
        await hydrateGroupsFromLocalDb();
        console.log('[STATE] Loaded persisted state from file (legacy). Will migrate to MySQL on next save.');
    } catch (err) {
        if (err.code !== 'ENOENT') {
            console.warn('[STATE] Failed to load state:', err.message);
        }
        groups = normalizeGroupsCollection(groups);
        await hydrateGroupsFromLocalDb();
    }

    await hydrateGroupsFromMysql();

    // One-time migration: backfill SeenTime for existing logs
    try {
        await mysqlLogsService.backfillSeenTimeWithSendTime();
    } catch (err) {
        console.warn('[SEEN-TIME] Backfill failed (non-fatal):', err && err.message ? err.message : err);
    }

    // Load community group configs from MySQL (overrides seed values)
    await loadAndSeedCommunityGroups();
}

async function persistState() {
    // ── Primary: persist to MySQL ──
    if (mysqlStateEnabled) {
        try {
            await mysqlLogsService.persistServerState({
                unreadCounts,
                groups,
                deviceSubscriptionsByUser,
                shuttleReminderSentAtByKey
            });
            return;
        } catch (error) {
            console.warn('[STATE] MySQL persist failed, falling back:', error && error.message ? error.message : error);
        }
    }

    // ── Fallback: persist to Redis ──
    if (activeRedisStateStore && activeRedisStateStore.isEnabled) {
        try {
            await activeRedisStateStore.persistState({
                unreadCounts,
                messageQueue,
                groups,
                deviceSubscriptionsByUser,
                shuttleReminderSentAtByKey
            });
            await persistGroupsLocalDb();
            return;
        } catch (error) {
            console.warn('[STATE] Redis persist failed, falling back to file state:', error && error.message ? error.message : error);
        }
    }

    // ── Fallback: persist to local file ──
    try {
        await fsp.mkdir(stateDir, { recursive: true });
        const payload = JSON.stringify({
            unreadCounts,
            messageQueue,
            groups,
            deviceSubscriptionsByUser,
            shuttleReminderSentAtByKey
        });
        const tmpFile = `${stateFile}.tmp`;
        await fsp.writeFile(tmpFile, payload, 'utf8');
        await fsp.rename(tmpFile, stateFile);
        await persistGroupsLocalDb();
    } catch (err) {
        console.warn('[STATE] Failed to persist state:', err.message);
        await persistGroupsLocalDb();
    }
}

function scheduleStateSave() {
    if (stateSaveTimer) return;
    stateSaveTimer = setTimeout(async () => {
        stateSaveTimer = null;
        await persistState();
    }, 1000);
}

function buildMobileAuthJsonByUser(subscriptions = []) {
    const authJsonByUser = new Map();
    (Array.isArray(subscriptions) ? subscriptions : []).forEach((subscription) => {
        if (!subscription || typeof subscription !== 'object') return;
        const subscriptionType = String(subscription.type || '').trim().toLowerCase();
        if (subscriptionType === 'pc') return;

        const username = normalizeUserKey(subscription.username || subscription.user);
        if (!username) return;
        const endpoint = typeof subscription.endpoint === 'string' ? subscription.endpoint.trim() : '';
        const keys = subscription.keys && typeof subscription.keys === 'object' ? subscription.keys : null;
        const p256dh = keys && typeof keys.p256dh === 'string' ? keys.p256dh.trim() : '';
        const auth = keys && typeof keys.auth === 'string' ? keys.auth.trim() : '';
        if (!endpoint || !p256dh || !auth) return;

        if (!authJsonByUser.has(username)) {
            authJsonByUser.set(username, JSON.stringify({
                endpoint,
                expirationTime: subscription.expirationTime || null,
                keys: { p256dh, auth }
            }));
        }
    });
    return authJsonByUser;
}

function buildMobileSubscriptionAuthJsonForLog(recipient, subscriptions = []) {
    const recipientUsers = parseUsernamesInput(recipient);
    const recipientSet = new Set(recipientUsers.map(normalizeUserKey).filter(Boolean));
    const authByUser = new Map();

    (Array.isArray(subscriptions) ? subscriptions : []).forEach((subscription) => {
        if (!subscription || typeof subscription !== 'object') return;
        const subscriptionType = String(subscription.type || '').trim().toLowerCase();
        if (subscriptionType === 'pc') return;

        const username = normalizeUserKey(subscription.username || subscription.user);
        if (recipientSet.size && username && !recipientSet.has(username)) return;

        const endpoint = typeof subscription.endpoint === 'string' ? subscription.endpoint.trim() : '';
        const keys = subscription.keys && typeof subscription.keys === 'object' ? subscription.keys : null;
        const p256dh = keys && typeof keys.p256dh === 'string' ? keys.p256dh.trim() : '';
        const auth = keys && typeof keys.auth === 'string' ? keys.auth.trim() : '';
        if (!endpoint || !p256dh || !auth) return;

        const mobileAuthJson = {
            endpoint,
            expirationTime: subscription.expirationTime || null,
            keys: { p256dh, auth }
        };
        const mapKey = username || '';
        if (!authByUser.has(mapKey)) {
            authByUser.set(mapKey, mobileAuthJson);
        }
    });

    if (!authByUser.size) return '';
    if (recipientSet.size <= 1) {
        const directKey = recipientUsers.length ? normalizeUserKey(recipientUsers[0]) : '';
        const directMatch = directKey ? authByUser.get(directKey) : null;
        const fallback = directMatch || authByUser.values().next().value;
        return fallback ? JSON.stringify(fallback) : '';
    }

    const merged = [];
    for (const [username, authJson] of authByUser.entries()) {
        if (!username || !authJson) continue;
        merged.push({ username, authJson });
    }
    if (!merged.length) {
        const fallback = authByUser.values().next().value;
        return fallback ? JSON.stringify(fallback) : '';
    }
    return JSON.stringify(merged);
}

function extractMessageIdFromLogDetails(details) {
    const detailsText = String(details || '').trim();
    if (!detailsText) return '';
    const jsonStart = detailsText.charAt(0);
    if (jsonStart === '{') {
        try {
            const parsed = JSON.parse(detailsText);
            const fromJson = String(
                parsed && (parsed.messageId || parsed.message_id || parsed.targetMessageId || parsed.target_message_id) || ''
            ).trim();
            if (fromJson) return fromJson;
        } catch (_error) {
            // Fallback to key=value scan.
        }
    }
    const match = detailsText.match(/(?:^|\|)\s*(?:messageId|message_id|targetMessageId|target_message_id)\s*=\s*([^|]+)/i);
    return match ? String(match[1] || '').trim() : '';
}

// Helper: Log status to MySQL logs table
function logNotificationStatus(sender, recipient, messageShort, status, details, recipientAuthJson = '', msgId = '', imageUrl = '', fileUrl = '', options = {}) {
    const resolvedMsgId = String(msgId || '').trim() || extractMessageIdFromLogDetails(details);
    const logPayload = {
        sender: sender || 'System',
        recipient: recipient,
        msgId: resolvedMsgId || '',
        message: messageShort,
        status: status,
        details: details,
        recipientAuthJson: recipientAuthJson || '',
        imageUrl: imageUrl || '',
        fileUrl: fileUrl || ''
    };
    const insertFn = options.dedup
        ? mysqlLogsService.insertLogIfNotDuplicate(logPayload)
        : mysqlLogsService.insertLog(logPayload);
    return insertFn.catch((err) => {
        console.error('[LOG ERROR]', err && err.message ? err.message : err);
        return null;
    });
}

function parseLogsDumpDateTime(rawValue) {
    if (rawValue instanceof Date) {
        const timestamp = rawValue.getTime();
        return Number.isFinite(timestamp) && timestamp > 0 ? rawValue : new Date();
    }
    const numeric = Number(rawValue);
    if (Number.isFinite(numeric) && numeric > 0) {
        return new Date(numeric);
    }
    const text = String(rawValue || '').trim();
    if (!text) {
        return new Date();
    }
    const parsed = Date.parse(text);
    if (Number.isFinite(parsed) && parsed > 0) {
        return new Date(parsed);
    }
    return new Date();
}

function mapLogsDumpRowForMysqlInsert(rawRow = {}) {
    if (!rawRow || typeof rawRow !== 'object') {
        return null;
    }
    const row = rawRow;
    const sender = String(
        row.fromUser ??
        row.from ??
        row.From ??
        row.sender ??
        'System'
    ).trim() || 'System';
    const recipient = String(
        row.toUser ??
        row.to ??
        row.ToUser ??
        row.recipient ??
        ''
    ).trim();
    const message = String(
        row.messagePreview ??
        row.message ??
        row['Message Preview'] ??
        ''
    ).trim();
    const msgId = String(
        row.msgId ??
        row.MsgID ??
        row.messageId ??
        row.message_id ??
        ''
    ).trim() || extractMessageIdFromLogDetails(
        row.errorMessageOrSuccessCount ??
        row.details ??
        row.ErrorMessageOrSuccessCount ??
        ''
    );
    const status = String(
        row.successOrFailed ??
        row.status ??
        row.SuccessOrFailed ??
        ''
    ).trim();
    const details = String(
        row.errorMessageOrSuccessCount ??
        row.details ??
        row.ErrorMessageOrSuccessCount ??
        ''
    ).trim();
    const recipientAuthJson = String(
        row.recipientAuthJson ??
        row.RecipientAuthJSON ??
        ''
    ).trim();
    return {
        sender,
        recipient,
        msgId,
        message,
        status,
        details,
        recipientAuthJson,
        dateTime: parseLogsDumpDateTime(
            row.dateTime ??
            row.DateTime ??
            row.date ??
            row.createdAt
        )
    };
}

async function updateSubscriptionAuthRefreshDateTime(usernames = [], requestId = '') {
    const normalizedUsers = parseUsernamesInput(usernames);
    if (!normalizedUsers.length) {
        return { updatedRows: 0, missingUsers: [], requestedUsers: 0 };
    }
    try {
        const response = await fetchWithRetry(
            GOOGLE_SHEET_URL,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    action: 'touch_subscription_auth_refresh',
                    usernames: normalizedUsers,
                    requestId: requestId || ''
                })
            },
            { timeoutMs: 15000, retries: 2, backoffMs: 700 }
        );
        if (!response.ok) {
            return {
                updatedRows: 0,
                missingUsers: normalizedUsers,
                requestedUsers: normalizedUsers.length,
                error: `Google Sheet returned ${response.status}`
            };
        }
        const payload = await response.json();
        if (payload && payload.result === 'success') {
            return {
                updatedRows: Number(payload.updatedRows || 0),
                missingUsers: Array.isArray(payload.missingUsers) ? payload.missingUsers : [],
                requestedUsers: Number(payload.requestedUsers || normalizedUsers.length)
            };
        }
        return {
            updatedRows: 0,
            missingUsers: normalizedUsers,
            requestedUsers: normalizedUsers.length,
            error: payload && payload.message ? payload.message : 'Unknown sheet response'
        };
    } catch (error) {
        return {
            updatedRows: 0,
            missingUsers: normalizedUsers,
            requestedUsers: normalizedUsers.length,
            error: error.message
        };
    }
}

async function getSubscriptionFromSheet(usernames, options = {}) {
    const forceRefresh = Boolean(options.forceRefresh);
    const cacheKey = buildSubscriptionCacheKey(usernames);
    if (!cacheKey) return [];

    const requestUserList = Array.isArray(usernames) ? usernames.join(',') : String(usernames || '').trim();
    if (!requestUserList) return [];

    const now = Date.now();
    const cached = subscriptionCache.get(cacheKey);
    if (!forceRefresh && cached && now - cached.at < SUBSCRIPTION_CACHE_TTL_MS) {
        return cached.subscriptions;
    }

    const requestedUsers = Array.from(
        new Set(parseUsernamesInput(requestUserList).map(normalizeUserKey).filter(Boolean))
    );
    const requestedAliasToCanonical = buildUserAliasLookupMap(requestedUsers);
    const singleRequestedUser = requestedUsers.length === 1 ? requestedUsers[0] : '';
    if (!requestedUsers.length) {
        return cached ? cached.subscriptions : [];
    }
    const normalizeLookupSubscriptions = (payload) => {
        const extracted = extractSubscriptionsFromSheetResponse(payload);
        if (!extracted.length) return [];
        const matched = [];
        const unknownWithoutUser = [];
        extracted.forEach((subscription) => {
            const rawUser = normalizeUserKey(subscription && (subscription.username || subscription.user));
            const canonicalUser = resolveCanonicalUserFromLookup(
                rawUser,
                requestedAliasToCanonical
            );
            if (canonicalUser) {
                matched.push({
                    ...subscription,
                    username: canonicalUser
                });
                return;
            }
            // If payload provides a user that does not match requested users, never remap it.
            if (rawUser) {
                return;
            }
            if (!singleRequestedUser) {
                return;
            }
            unknownWithoutUser.push({
                ...subscription,
                username: singleRequestedUser
            });
        });
        if (matched.length) {
            return matched;
        }
        // Only allow tiny user-less fallbacks; large sets likely indicate unfiltered sheet response.
        if (unknownWithoutUser.length > 0 && unknownWithoutUser.length <= UNKNOWN_USER_FALLBACK_MAX_ENDPOINTS) {
            return unknownWithoutUser;
        }
        return [];
    };
    const fetchLookupBatchSubscriptions = async (batchUsers = []) => {
        const normalizedBatch = Array.from(new Set(
            (Array.isArray(batchUsers) ? batchUsers : [])
                .map(normalizeUserKey)
                .filter(Boolean)
        ));
        if (!normalizedBatch.length) {
            return [];
        }
        const csvUsers = normalizedBatch.join(',');
        const candidateUrls = [
            buildGoogleSheetGetUrl({ usernames: csvUsers }),
            buildGoogleSheetGetUrl({ action: 'get_subscriptions', usernames: csvUsers })
        ];
        if (normalizedBatch.length === 1) {
            candidateUrls.push(buildGoogleSheetGetUrl({ action: 'get_subscriptions', username: normalizedBatch[0] }));
        }

        for (const url of candidateUrls) {
            try {
                const response = await fetchWithRetry(
                    url,
                    {},
                    { timeoutMs: 12000, retries: 2, backoffMs: 500 }
                );
                if (!response.ok) {
                    continue;
                }
                const result = await response.json();
                const subscriptions = normalizeLookupSubscriptions(result);
                if (subscriptions.length) {
                    return subscriptions;
                }
            } catch (_error) {
                // Continue with next variant; some Apps Script deployments only support one shape.
            }
        }

        // Last fallback: request each user explicitly via action=get_subscriptions&username=<user>.
        const collected = [];
        for (const userKey of normalizedBatch) {
            try {
                const response = await fetchWithRetry(
                    buildGoogleSheetGetUrl({ action: 'get_subscriptions', username: userKey }),
                    {},
                    { timeoutMs: 12000, retries: 2, backoffMs: 500 }
                );
                if (!response.ok) {
                    continue;
                }
                const result = await response.json();
                collected.push(...normalizeLookupSubscriptions(result));
            } catch (_error) {
                // Keep lookup resilient and continue trying remaining users.
            }
        }
        return dedupeSubscriptionsByEndpoint(collected);
    };

    try {
        let subscriptions = [];
        if (requestedUsers.length <= SUBSCRIPTION_LOOKUP_BATCH_SIZE) {
            subscriptions = await fetchLookupBatchSubscriptions(requestedUsers);
        } else {
            const collected = [];
            for (let i = 0; i < requestedUsers.length; i += SUBSCRIPTION_LOOKUP_BATCH_SIZE) {
                const batch = requestedUsers.slice(i, i + SUBSCRIPTION_LOOKUP_BATCH_SIZE);
                if (!batch.length) continue;
                const batchSubscriptions = await fetchLookupBatchSubscriptions(batch);
                if (batchSubscriptions.length) {
                    collected.push(...batchSubscriptions);
                }
            }
            subscriptions = dedupeSubscriptionsByEndpoint(collected);
        }
        if (subscriptions.length) {
            subscriptionCache.set(cacheKey, { at: now, subscriptions });
            return subscriptions;
        }
        return cached ? cached.subscriptions : [];
    } catch (error) {
        console.error('Network Error fetching from Google Sheet:', error);
        return cached ? cached.subscriptions : [];
    }
}

app.use((req, _res, next) => {
    const authSession = extractSessionFromRequest(req);
    req.authSession = authSession || null;
    req.authUser = authSession && authSession.user ? authSession.user : '';
    next();
});

// ── Session renewal: extend active sessions so they stay alive indefinitely ──
app.use((req, res, next) => {
    const session = req.authSession;
    if (!session || !session.user || !session.expiresAt) {
        return next();
    }
    const remainingMs = Number(session.expiresAt) - Date.now();
    if (remainingMs > SESSION_RENEWAL_THRESHOLD_MS) {
        return next();
    }
    // Session is past the halfway point – issue a fresh token with a new TTL.
    const renewed = createSessionToken(session.user);
    if (!renewed) {
        return next();
    }
    // Remove the old sessionId so the in-memory set doesn't grow unbounded.
    const userSessions = activeSessionIdsByUser.get(session.user);
    if (userSessions) {
        userSessions.delete(String(session.sessionId || ''));
        if (userSessions.size === 0) activeSessionIdsByUser.delete(session.user);
    }
    setSessionCookie(res, req, renewed.token, renewed.expiresAt);
    req.authSession = {
        user: session.user,
        expiresAt: renewed.expiresAt,
        sessionId: renewed.sessionId,
        csrfToken: renewed.csrfToken
    };
    return next();
});

app.use(attachResolvedUser);

app.use((req, res, next) => {
    if (!CSRF_PROTECTION_ENABLED) {
        return next();
    }

    const method = String(req.method || 'GET').toUpperCase();
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
        return next();
    }

    const requestPath = String(req.path || '').trim();
    const isAuthSessionPath = requestPath === '/auth/session' || requestPath === '/notify/auth/session';
    if (isAuthSessionPath && method === 'POST') {
        return next();
    }

    const session = req.authSession && typeof req.authSession === 'object'
        ? req.authSession
        : null;
    if (!session || !session.user) {
        return next();
    }

    const csrfHeader = String(req.headers[CSRF_HEADER_NAME] || '').trim();
    if (!csrfHeader || csrfHeader !== String(session.csrfToken || '')) {
        return res.status(403).json({ error: 'Invalid CSRF token' });
    }

    return next();
});

const io = new SocketIOServer(httpServer, {
    path: '/notify/socket.io',
    transports: ['websocket', 'polling'],
    cors: {
        origin: '*',
        methods: ['GET', 'POST']
    }
});

io.use((socket, next) => {
    try {
        const user = resolveSocketAuthorizedUser(socket);
        if (!user) {
            return next(new Error('Authentication required'));
        }
        socket.data.user = user;
        return next();
    } catch (error) {
        return next(error);
    }
});

io.on('connection', (socket) => {
    const socketUser = normalizeUserKey(socket && socket.data ? socket.data.user : '');
    if (!socketUser) {
        socket.disconnect(true);
        return;
    }

    addWebsocketClient(socketUser, socket);
    socket.emit('chat:connected', { user: socketUser, ts: Date.now() });

    socket.on('chat:reply', async (payload = {}, ack) => {
        const replyAck = typeof ack === 'function' ? ack : () => undefined;
        try {
            const result = await processReplyPayload(payload || {}, socketUser);
            replyAck(result);
        } catch (error) {
            replyAck({
                status: 'error',
                error: error && error.message ? error.message : 'Reply failed'
            });
        }
    });

    socket.on('chat:reaction', async (payload = {}, ack) => {
        const reactionAck = typeof ack === 'function' ? ack : () => undefined;
        try {
            const result = await processReactionPayload(payload || {}, socketUser);
            reactionAck(result);
        } catch (error) {
            reactionAck({
                status: 'error',
                error: error && error.message ? error.message : 'Reaction failed'
            });
        }
    });

    socket.on('chat:typing', (payload = {}, ack) => {
        const typingAck = typeof ack === 'function' ? ack : () => undefined;
        try {
            const result = emitTypingSignalToRecipients(payload || {}, socketUser);
            typingAck(result);
        } catch (error) {
            typingAck({
                status: 'error',
                error: error && error.message ? error.message : 'Typing signal failed'
            });
        }
    });

    socket.on('disconnect', () => {
        removeWebsocketClient(socketUser, socket);
    });
});

registerAuthController(app, {
    normalizeUserCandidate,
    buildUserLookupAliases,
    fetchWithRetry,
    buildGoogleSheetGetUrl,
    googleSheetUrl: GOOGLE_SHEET_URL,
    activeSessionIdsByUser,
    clearSessionCookie,
    SESSION_USER_PATTERN,
    ensureRegistrationFlowOnly,
    getClientIpAddress,
    consumeRateLimitEntry,
    authCodeRequestRateLimitByIp,
    AUTH_CODE_REQUEST_RATE_LIMIT_MAX_PER_IP,
    AUTH_CODE_RATE_LIMIT_WINDOW_MS,
    authCodeRequestRateLimitByUser,
    AUTH_CODE_REQUEST_RATE_LIMIT_MAX_PER_USER,
    AUTH_CODE_REQUIRE_REGISTERED_USER,
    ensureRequestedUserIsRegistered,
    generateAuthCode,
    setAuthCodeOnSubscribeSheet,
    sendAuthCodeSms,
    AUTH_CODE_TTL_SECONDS,
    normalizeAuthCode,
    AUTH_CODE_PATTERN,
    SESSION_SIGNING_SECRET,
    authCodeVerifyRateLimitByIp,
    AUTH_CODE_VERIFY_RATE_LIMIT_MAX_PER_IP,
    authCodeVerifyRateLimitByUser,
    AUTH_CODE_VERIFY_RATE_LIMIT_MAX_PER_USER,
    verifyAuthCodeFromSubscribeSheet,
    createSessionToken,
    setSessionCookie,
    upsertLocalDeviceSubscriptionsFromRegistration,
    scheduleStateSave,
    unreadCounts,
    requireAuthorizedUser,
    APP_SERVER_TOKEN,
    BADGE_RESET_ALL_ALLOWED_USERS
});

// --- CLIENT TELEMETRY ---
app.post(['/log', '/notify/log'], (req, res) => {
    const { event, payload, user, timestamp } = req.body || {};
    console.log(`[CLIENT LOG] ${event || 'event'} | user=${user || 'unknown'} | ts=${timestamp || Date.now()}`);
    if (payload) {
        console.log('[CLIENT LOG] payload:', payload);
    }
    if (String(event || '').trim().toLowerCase() === 'delivery-telemetry') {
        recordDeliveryTelemetryLog({ user, payload, timestamp, req });
    }
    res.json({ status: 'ok' });
});

app.get(['/delivery-telemetry/status', '/notify/delivery-telemetry/status'], (req, res) => {
    const token = String(
        (req.query && req.query.token) ||
        (req.headers && (req.headers['x-admin-token'] || req.headers['x-app-token'])) ||
        ''
    ).trim();
    const isAdminTokenValid = APP_SERVER_TOKEN && token === APP_SERVER_TOKEN;
    const requestingUser = normalizeUserCandidate(req.authUser);
    if (APP_SERVER_TOKEN) {
        if (!isAdminTokenValid) {
            return res.status(403).json({ error: 'Forbidden' });
        }
    } else if (!requestingUser) {
        return res.status(401).json({ error: 'Authentication required' });
    }

    pruneDeliveryTelemetryStore();
    const limitRaw = Number(req.query && req.query.limit);
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(1, Math.floor(limitRaw)), 500) : 100;
    const filterUser = normalizeUserCandidate(req.query && req.query.user);
    const filterDeviceId = String((req.query && req.query.deviceId) || '').trim();
    const effectiveFilterUser = isAdminTokenValid
        ? filterUser
        : (requestingUser || filterUser);

    const rows = Array.from(deliveryTelemetryByDevice.values())
        .filter((entry) => {
            if (effectiveFilterUser && normalizeUserCandidate(entry.user) !== effectiveFilterUser) return false;
            if (filterDeviceId && String(entry.deviceId || '') !== filterDeviceId) return false;
            return true;
        })
        .sort((a, b) => Number(b.lastSeenAt || 0) - Number(a.lastSeenAt || 0))
        .slice(0, limit);

    return res.json({
        result: 'success',
        totalTrackedDevices: deliveryTelemetryByDevice.size,
        count: rows.length,
        devices: rows
    });
});

// ── FCM diagnostics ────────────────────────────────────────────────────────
// Lets operators verify that the Firebase service-account credential is
// loaded, parseable, and accepted by Google. NEVER returns the private key.
// Pass `?probe=1` to actually request an OAuth access token from Google
// (slower but proves end-to-end that the key works).
app.get(['/fcm-status', '/notify/fcm-status'], async (req, res) => {
    if (!isSchedulerOpsRequestAuthorized(req)) {
        return res.status(403).json({ error: 'Forbidden' });
    }
    try {
        const probe = String((req.query && req.query.probe) || '').trim() === '1' ||
            String((req.query && req.query.probe) || '').trim().toLowerCase() === 'true';
        const diag = await fcmSender.getDiagnostics({ probe });
        let flutterStats = null;
        try {
            flutterStats = flutterPushService && typeof flutterPushService.getStats === 'function'
                ? flutterPushService.getStats()
                : null;
        } catch (statsError) {
            flutterStats = { error: statsError && statsError.message ? statsError.message : String(statsError) };
        }
        const ok = diag.configured && diag.firebaseAdmin.initialized &&
            (!probe || (diag.accessTokenProbe && diag.accessTokenProbe.ok));
        return res.json({
            ok,
            checkedAt: new Date().toISOString(),
            fcm: diag,
            flutterTokens: flutterStats
        });
    } catch (error) {
        console.error('[FCM-STATUS] Failed to build diagnostics:', error);
        return res.status(500).json({
            ok: false,
            error: error && error.message ? error.message : String(error)
        });
    }
});

app.post(['/logs/import-sheet-to-db', '/notify/logs/import-sheet-to-db'], async (req, res) => {
    if (!isSchedulerOpsRequestAuthorized(req)) {
        return res.status(403).json({ error: 'Forbidden' });
    }

    const payload = req.body && typeof req.body === 'object' ? req.body : {};
    const batchSizeRaw = parsePositiveInteger(payload.batchSize, 500);
    const batchSize = Math.max(50, Math.min(batchSizeRaw || 500, 5000));
    const maxRowsRaw = parsePositiveInteger(payload.maxRows, 0);
    const maxRows = maxRowsRaw > 0 ? Math.min(maxRowsRaw, 1000000) : 0;
    const truncateBeforeImport = parseBooleanInput(
        payload.truncateBeforeImport ?? payload.truncate ?? false,
        false
    );
    const dedupe = parseBooleanInput(
        payload.dedupe ?? payload.skipExisting ?? false,
        false
    );
    const dryRun = parseBooleanInput(payload.dryRun ?? false, false);
    const initialOffset = Math.max(0, Number(payload.offset || 0) || 0);

    try {
        if (truncateBeforeImport && !dryRun && initialOffset === 0) {
            await mysqlLogsService.truncateLogs();
        }

        let offset = initialOffset;
        let batches = 0;
        let imported = 0;
        let scanned = 0;
        let skippedExisting = 0;
        let hasMore = true;

        while (hasMore) {
            const remaining = maxRows > 0 ? Math.max(0, maxRows - scanned) : batchSize;
            if (maxRows > 0 && remaining <= 0) {
                break;
            }
            const effectiveLimit = maxRows > 0
                ? Math.max(1, Math.min(batchSize, remaining))
                : batchSize;

            const response = await fetchWithRetry(
                buildLogsBackupSheetGetUrl({
                    action: 'get_logs_dump',
                    offset: String(offset),
                    limit: String(effectiveLimit)
                }),
                {},
                { timeoutMs: 20000, retries: 2, backoffMs: 700 }
            );
            if (!response.ok) {
                throw new Error(`Sheet logs dump failed with ${response.status}`);
            }

            const dumpPayload = await response.json();
            const result = String(dumpPayload && dumpPayload.result ? dumpPayload.result : '').trim().toLowerCase();
            if (result && result !== 'success') {
                const errorMessage = String(
                    (dumpPayload && (dumpPayload.error || dumpPayload.message)) || 'Sheet logs dump failed'
                ).trim();
                if (/usernames parameter is missing/i.test(errorMessage)) {
                    throw new Error('Google Apps Script deployment is outdated (missing get_logs_dump action). Deploy latest code.gs first.');
                }
                throw new Error(errorMessage || 'Sheet logs dump failed');
            }

            const rawRows = Array.isArray(dumpPayload && dumpPayload.rows) ? dumpPayload.rows : [];
            if (!rawRows.length) {
                hasMore = false;
                break;
            }

            const normalizedRows = rawRows
                .map((row) => mapLogsDumpRowForMysqlInsert(row))
                .filter(Boolean);

            if (!dryRun && normalizedRows.length) {
                const insertedCount = await mysqlLogsService.insertLogsBulk(normalizedRows, {
                    dedupeExisting: dedupe
                });
                imported += insertedCount;
                if (dedupe) {
                    skippedExisting += Math.max(0, normalizedRows.length - insertedCount);
                }
            } else if (dryRun && dedupe && normalizedRows.length) {
                const rowsToInsert = await mysqlLogsService.filterNewLogsByCompositeKey(normalizedRows);
                imported += rowsToInsert.length;
                skippedExisting += Math.max(0, normalizedRows.length - rowsToInsert.length);
            } else {
                imported += normalizedRows.length;
            }

            scanned += rawRows.length;
            offset += rawRows.length;
            batches += 1;

            const payloadHasMore = Boolean(dumpPayload && dumpPayload.hasMore === true);
            hasMore = payloadHasMore;
            if (!payloadHasMore && rawRows.length < effectiveLimit) {
                hasMore = false;
            }
        }

        return res.json({
            result: 'success',
            dryRun,
            dedupe,
            truncated: truncateBeforeImport && initialOffset === 0,
            imported,
            skippedExisting,
            scanned,
            batches,
            nextOffset: initialOffset + scanned
        });
    } catch (error) {
        console.error('[LOGS IMPORT] Failed:', error && error.message ? error.message : error);
        return res.status(500).json({
            result: 'error',
            message: error && error.message ? error.message : 'Logs import failed'
        });
    }
});
// ======================================================
// [UPDATED] BACKUP CHATS ENDPOINT (NON-BLOCKING)
// ======================================================
app.post(['/backup', '/notify/backup'], (req, res) => {
    try {
        const { chats } = req.body; 

        if (!chats || !Array.isArray(chats)) {
             return res.status(400).json({ error: 'Invalid data format. Expecting "chats" array.' });
        }

        console.log(`[BACKUP] Received ${chats.length} messages.`);

        // 1. RESPOND TO MOBILE IMMEDIATELY (Fixes the hanging issue)
        // We tell the phone "Got it!" right away so the loading spinner stops.
        res.json({ status: 'success', message: `Queued ${chats.length} messages` });

        // 2. SAVE TO GOOGLE SHEET IN BACKGROUND
        // We do NOT use 'await' here. The server continues working while this uploads.
        fetchWithRetry(GOOGLE_SHEET_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                action: 'backup_chats',
                data: chats
            })
        })
        .then(() => console.log(`[BACKUP SUCCESS] Saved ${chats.length} messages to Sheet.`))
        .catch(err => console.error('[BACKUP FAIL] Could not save to Sheet:', err.message));

    } catch (e) {
        console.error('[BACKUP ERROR]', e);
        // Only send error if we haven't responded yet
        if (!res.headersSent) res.status(500).json({ error: e.message });
    }
});
// --- MESSAGE ACTION ENDPOINTS (EDIT / DELETE FOR EVERYONE) ---
app.post(
    ['/delete', '/notify/delete'],
    requireAuthorizedUser({
        required: true,
        candidateKeys: ['sender', 'user'],
        onError: (_req, res, resolution) => res.status(resolution.status).json({ error: resolution.error })
    }),
    async (req, res) => {
    try {
        const body = req.body || {};
        const sender = req.resolvedUser;
        const messageId = String(body.messageId || '').trim();
        const deletedAtRaw = Number(body.deletedAt || body.timestamp || Date.now());
        const deletedAt = Number.isFinite(deletedAtRaw) ? deletedAtRaw : Date.now();
        const groupId = body.groupId ? normalizeUserKey(body.groupId) : '';
        const groupRecord = groupId ? groups[groupId] : null;

        if (!sender || !messageId) {
            return res.status(400).json({ error: 'Missing sender or messageId' });
        }

        const recipientsFromPayload = parseUsernamesInput(
            body.recipients || body.membersToNotify || body.recipient
        );
        const fallbackGroupRecipients = groupRecord && Array.isArray(groupRecord.members)
            ? groupRecord.members.map(normalizeUserKey)
            : [];
        let recipients = recipientsFromPayload.length ? recipientsFromPayload : fallbackGroupRecipients;
        recipients = Array.from(new Set(recipients.map(normalizeUserKey).filter(Boolean)))
            .filter((recipientUser) => recipientUser !== sender);

        if (!recipients.length) {
            return res.json({ status: 'success', details: { success: 0, failed: 0 } });
        }

        const resolvedGroupName = (typeof body.groupName === 'string' && body.groupName.trim())
            ? body.groupName.trim()
            : (groupRecord ? groupRecord.name : null);
        const resolvedGroupMembers = Array.isArray(body.groupMembers) && body.groupMembers.length
            ? body.groupMembers.map(normalizeUserKey).filter(Boolean)
            : (groupRecord && Array.isArray(groupRecord.members)
                ? groupRecord.members.map(normalizeUserKey).filter(Boolean)
                : null);
        const resolvedGroupCreatedBy = body.groupCreatedBy
            ? normalizeUserKey(body.groupCreatedBy)
            : (groupRecord ? normalizeUserKey(groupRecord.createdBy) : null);
        const resolvedGroupUpdatedAt = Number(body.groupUpdatedAt || (groupRecord ? groupRecord.updatedAt : deletedAt));
        const resolvedGroupType = normalizeGroupType(body.groupType || (groupRecord ? groupRecord.type : 'group'));

        const actionRecord = {
            type: 'delete-action',
            messageId,
            sender,
            deletedAt,
            timestamp: Date.now(),
            groupId: groupId || null,
            groupName: resolvedGroupName || null,
            groupMembers: resolvedGroupMembers,
            groupCreatedBy: resolvedGroupCreatedBy || null,
            groupUpdatedAt: Number.isFinite(resolvedGroupUpdatedAt) ? resolvedGroupUpdatedAt : deletedAt,
            groupType: resolvedGroupType
        };

        // Audit: log message deletion to MessageActivities table (fire-and-forget).
        void mysqlLogsService.insertMessageActivity({
            actionType: 'delete-action',
            messageId,
            sender,
            recipient: recipients.join(','),
            groupId: groupId || null,
            actionTimestamp: deletedAt
        }).catch(() => {});

        await addToQueue(recipients, actionRecord);

        const notificationPayload = {
            messageId,
            title: '',
            body: {
                shortText: '',
                longText: ''
            },
            data: {
                ...actionRecord,
                skipNotification: true
            }
        };
        const result = await sendPushNotificationToUser(
            recipients,
            notificationPayload,
            groupId || sender,
            { messageId, skipBadge: true }
        );

        // ── Self-echo: notify sender's other devices ──
        if (sender) {
            void addToQueue(sender, actionRecord).catch(() => {});
            void sendPushNotificationToUser(sender, notificationPayload, groupId || sender, {
                messageId,
                skipBadge: true
            }).catch(() => {});
        }

        const deleteLogDetails = [
            'type=delete-action',
            `messageId=${messageId}`,
            `deletedAt=${deletedAt}`,
            `sender=${sender}`,
            `groupId=${groupId || ''}`,
            `recipients=${recipients.join(',')}`,
            `pushSuccess=${Number(result && result.success ? result.success : 0)}`,
            `pushFailed=${Number(result && result.failed ? result.failed : 0)}`
        ].join(' | ');
        void logNotificationStatus(
            sender,
            recipients.join(','),
            'Message deleted',
            'Deleted',
            deleteLogDetails,
            '',
            messageId
        );

        res.json({ status: 'success', details: result });
    } catch (e) {
        console.error('[DELETE ERROR]', e);
        res.status(500).json({ error: e.message });
    }
});

app.post(
    ['/edit', '/notify/edit'],
    requireAuthorizedUser({
        required: true,
        candidateKeys: ['sender', 'user'],
        onError: (_req, res, resolution) => res.status(resolution.status).json({ error: resolution.error })
    }),
    async (req, res) => {
    try {
        const body = req.body || {};
        const sender = req.resolvedUser;
        const messageId = String(body.messageId || '').trim();
        const editedBody = String(body.body || body.editedBody || '').trim();
        const editedAtRaw = Number(body.editedAt || body.timestamp || Date.now());
        const editedAt = Number.isFinite(editedAtRaw) ? editedAtRaw : Date.now();
        const groupId = body.groupId ? normalizeUserKey(body.groupId) : '';
        const groupRecord = groupId ? groups[groupId] : null;

        if (!sender || !messageId || !editedBody) {
            return res.status(400).json({ error: 'Missing sender, messageId or body' });
        }

        const recipientsFromPayload = parseUsernamesInput(
            body.recipients || body.membersToNotify || body.recipient
        );
        const fallbackGroupRecipients = groupRecord && Array.isArray(groupRecord.members)
            ? groupRecord.members.map(normalizeUserKey)
            : [];
        let recipients = recipientsFromPayload.length ? recipientsFromPayload : fallbackGroupRecipients;
        recipients = Array.from(new Set(recipients.map(normalizeUserKey).filter(Boolean)))
            .filter((recipientUser) => recipientUser !== sender);

        if (!recipients.length) {
            return res.json({ status: 'success', details: { success: 0, failed: 0 } });
        }

        const resolvedGroupName = (typeof body.groupName === 'string' && body.groupName.trim())
            ? body.groupName.trim()
            : (groupRecord ? groupRecord.name : null);
        const resolvedGroupMembers = Array.isArray(body.groupMembers) && body.groupMembers.length
            ? body.groupMembers.map(normalizeUserKey).filter(Boolean)
            : (groupRecord && Array.isArray(groupRecord.members)
                ? groupRecord.members.map(normalizeUserKey).filter(Boolean)
                : null);
        const resolvedGroupCreatedBy = body.groupCreatedBy
            ? normalizeUserKey(body.groupCreatedBy)
            : (groupRecord ? normalizeUserKey(groupRecord.createdBy) : null);
        const resolvedGroupUpdatedAt = Number(body.groupUpdatedAt || (groupRecord ? groupRecord.updatedAt : editedAt));
        const resolvedGroupType = normalizeGroupType(body.groupType || (groupRecord ? groupRecord.type : 'group'));

        const actionRecord = {
            type: 'edit-action',
            messageId,
            sender,
            body: editedBody,
            editedAt,
            timestamp: Date.now(),
            groupId: groupId || null,
            groupName: resolvedGroupName || null,
            groupMembers: resolvedGroupMembers,
            groupCreatedBy: resolvedGroupCreatedBy || null,
            groupUpdatedAt: Number.isFinite(resolvedGroupUpdatedAt) ? resolvedGroupUpdatedAt : editedAt,
            groupType: resolvedGroupType
        };

        // Audit: log message edit to MessageActivities table (fire-and-forget).
        void mysqlLogsService.insertMessageActivity({
            actionType: 'edit-action',
            messageId,
            sender,
            recipient: recipients.join(','),
            groupId: groupId || null,
            body: editedBody || null,
            actionTimestamp: editedAt
        }).catch(() => {});

        await addToQueue(recipients, actionRecord);

        const notificationPayload = {
            messageId,
            title: '',
            body: {
                shortText: '',
                longText: ''
            },
            data: {
                ...actionRecord,
                skipNotification: true
            }
        };
        const result = await sendPushNotificationToUser(
            recipients,
            notificationPayload,
            groupId || sender,
            { messageId, skipBadge: true }
        );

        // ── Self-echo: notify sender's other devices ──
        if (sender) {
            void addToQueue(sender, actionRecord).catch(() => {});
            void sendPushNotificationToUser(sender, notificationPayload, groupId || sender, {
                messageId,
                skipBadge: true
            }).catch(() => {});
        }

        res.json({ status: 'success', details: result });
    } catch (e) {
        console.error('[EDIT ERROR]', e);
        res.status(500).json({ error: e.message });
    }
});
// Add this to your server.js (ensure you have 'node-fetch' and 'web-push' configured)

// [FIXED] Uses the global GOOGLE_SHEET_URL variable defined at the top of your file
// [FIXED] Uses the global GOOGLE_SHEET_URL variable defined at the top of your file
app.post(['/verify-status', '/notify/verify-status'], async (req, res) => {
    const { username, subscription } = req.body;

    if (!username || !subscription) {
        return res.status(400).json({ error: 'Missing username or subscription' });
    }

    console.log(`[Verify] Checking status for user: ${username}...`);

    // --- FIX: Use the variable 'GOOGLE_SHEET_URL' declared at the top of server.js ---
    const scriptUrl = buildGoogleSheetGetUrl({ action: 'get_contacts', user: username });
    try {
        
        
        const sheetResponse = await fetchWithRetry(scriptUrl, {}, { timeoutMs: 10000, retries: 2 });
        
        // Safety check: Ensure we got a valid JSON response from Google
        if (!sheetResponse.ok) {
            throw new Error(`Google Sheet returned ${sheetResponse.status} ${sheetResponse.statusText}`);
        }

        const sheetData = await sheetResponse.json();

        // Logic: If users array is empty, it means Access Denied (Status 0 or Not Found)
        if (!sheetData.users || sheetData.users.length === 0) {
            console.log(`[Verify] User ${username} is BLOCKED (Status 0). Sending Push...`);

            const notificationPayload = JSON.stringify({
                title: 'Access Denied / גישה נדחתה',
                body: 'You do not have permission to use this app. Please contact the HR team.\nאין לך הרשאה להשתמש באפליקציה זו. אנא צור קשר עם משאבי אנוש.',
                icon: 'assets/icons/icon-192x192.png',
                data: {
                    url: 'https://www.tzmc.co.il/subscribes/'
                }
            });

            if (fcmSender.isFcmSubscription(subscription)) {
                await fcmSender.sendFcmNotification(subscription, notificationPayload);
            } else {
                await webpush.sendNotification(subscription, notificationPayload);
            }
            
            return res.json({ status: 'blocked', message: 'Notification sent' });
        } else {
            console.log(`[Verify] User ${username} is ACTIVE (Status 1).`);
            return res.json({ status: 'active', message: 'User is allowed' });
        }

    } catch (error) {
        console.error('[Verify] Error:', error); // Check your terminal to see the specific error
        res.status(500).json({ error: scriptUrl });
    }
});
// ======================================================
// [UPDATED] CORE SENDING LOGIC – delegated to NotificationService
// ======================================================
const MAX_PUSH_PAYLOAD_BYTES = Math.max(
    2048,
    Number(process.env.MAX_PUSH_PAYLOAD_BYTES || 3584) || 3584
);
const MAX_PUSH_TEXT_LENGTH = Math.max(
    80,
    Number(process.env.MAX_PUSH_TEXT_LENGTH || 280) || 280
);
const DEFAULT_CHAT_PUSH_MAX_ENDPOINTS_PER_USER = Math.max(
    1,
    Number(process.env.DEFAULT_CHAT_PUSH_MAX_ENDPOINTS_PER_USER || 2) || 2
);
const SINGLE_TARGET_MAX_SAFE_SUBSCRIPTIONS = Math.max(
    1,
    Number(process.env.SINGLE_TARGET_MAX_SAFE_SUBSCRIPTIONS || 8) || 8
);
const UNKNOWN_USER_FALLBACK_MAX_ENDPOINTS = Math.max(
    1,
    Number(process.env.UNKNOWN_USER_FALLBACK_MAX_ENDPOINTS || 4) || 4
);

const notificationService = new NotificationService(
    {
        maxPushPayloadBytes: MAX_PUSH_PAYLOAD_BYTES,
        maxPushTextLength: MAX_PUSH_TEXT_LENGTH,
        defaultMaxEndpointsPerUser: DEFAULT_CHAT_PUSH_MAX_ENDPOINTS_PER_USER,
        singleTargetMaxSafeSubscriptions: SINGLE_TARGET_MAX_SAFE_SUBSCRIPTIONS,
        unknownUserFallbackMaxEndpoints: UNKNOWN_USER_FALLBACK_MAX_ENDPOINTS
    },
    {
        sendNotification: (sub, payload, options) => {
            // Mobile devices register an FCM/APNs token (endpoint starts
            // with `fcm:` / `apns:` or carries an `fcmToken` field). Those
            // are NOT W3C web-push subscriptions and webpush.sendNotification
            // would fail with a "no endpoint" / "Bad request" error and the
            // notification would silently never reach the phone. Route them
            // through Firebase Admin SDK instead.
            if (fcmSender.isFcmSubscription(sub)) {
                return fcmSender.sendFcmNotification(sub, payload, options);
            }
            return webpush.sendNotification(sub, payload, options);
        },
        normalizeUserKey,
        normalizeSubscriptionType,
        dedupeSubscriptionsByEndpoint,
        parseUsernamesInput,
        buildUserAliasLookupMap,
        resolveCanonicalUserFromLookup,
        generateMessageId,
        getSubscriptionFromSheet,
        getAllSubscriptionsForAuthRefresh,
        getLocalDeviceSubscriptionsForUsers,
        removeLocalDeviceSubscriptionEndpoint,
        removeStaleSubscriptionsFromSheet,
        buildSubscriptionCacheKey,
        pruneSubscriptionCacheEndpoint,
        subscriptionCache,
        unreadCounts,
        scheduleStateSave,
        logNotificationStatus,
        buildMobileSubscriptionAuthJsonForLog,
        AUTH_REFRESH_PUSH_TYPE
    }
);

function trimPushTextValue(value, maxLength) { return notificationService.trimPushTextValue(value, maxLength); }
function buildCompactPushCustomData(rawData, messageType) { return notificationService.buildCompactPushCustomData(rawData, messageType); }
function buildPushPayloadString(payloadData, options) { return notificationService.buildPushPayloadString(payloadData, options); }
function isLikelyPhoneUserKey(userKey) { return notificationService.isLikelyPhoneUserKey(userKey); }
function limitSubscriptionsPerUser(subscriptions, maxPerUser) { return notificationService.limitSubscriptionsPerUser(subscriptions, maxPerUser); }

// ── Flutter / FCM delivery (parallel, additive path) ────────────────────────
// The Angular frontend keeps using the web-push pipeline above unchanged.
// The Flutter mobile app registers FCM tokens via /flutter/register-fcm and
// receives the same notification payloads through Firebase Admin. Failures in
// this path are logged and never propagated to the web-push result.
const flutterPushService = createFlutterPushService({
    stateDir,
    notificationService,
    fcmSender,
    normalizeUserKey
});
flutterPushService.loadFromDisk().catch((err) =>
    console.warn('[FLUTTER-FCM] Initial load failed:', err && err.message ? err.message : err)
);

registerFlutterPushRoutes(app, {
    flutterPushService,
    requireAuthorizedUser,
    googleSheetUrl: GOOGLE_SHEET_URL,
    fetchWithRetry
});

async function sendPushNotificationToUser(targetUser, message, senderuser, options) {
    const result = await notificationService.sendPushNotificationToUser(targetUser, message, senderuser, options);
    // Fire-and-forget fan-out to Flutter FCM tokens. Wrapped in try/catch so
    // any FCM error (incl. missing FIREBASE_SERVICE_ACCOUNT_BASE64) never
    // affects the web-push result returned to the caller.
    try {
        const fanOut = flutterPushService.dispatchToUsers(targetUser, message, senderuser, options);
        if (fanOut && typeof fanOut.then === 'function') {
            fanOut.catch((err) => console.warn(
                '[FLUTTER-FCM] Fan-out rejected:',
                err && err.message ? err.message : err
            ));
        }
    } catch (err) {
        console.warn(
            '[FLUTTER-FCM] Fan-out threw synchronously:',
            err && err.message ? err.message : err
        );
    }
    return result;
}
// --- ROUTES ---

app.get(['/', '/notify'], (req, res) => {
    res.send('TZMC Server Running (Push + Polling Supported - Case Insensitive)');
});

app.get(['/version', '/notify/version'], (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ version: SERVER_VERSION, notes: SERVER_RELEASE_NOTES });
});

// --- BROADCAST VERSION UPDATE TO ALL USERS ---
const versionUpdateBroadcastAllowedSet = new Set(
    VERSION_UPDATE_BROADCAST_ALLOWED_USERS.map(normalizeUserKey).filter(Boolean)
);
const versionBroadcastRateLimitStore = new Map();
const communityGroupConfigsRateLimitStore = new Map();

app.post(
    ['/broadcast-version-update', '/notify/broadcast-version-update'],
    requireAuthorizedUser({
        required: true,
        candidateKeys: ['user'],
        onError: (_req, res, resolution) => res.status(resolution.status).json({ status: 'error', message: resolution.error })
    }),
    async (req, res) => {
        const sender = normalizeUserKey(req.resolvedUser || '');
        if (!sender || !versionUpdateBroadcastAllowedSet.has(sender)) {
            return res.status(403).json({ status: 'error', message: 'Forbidden' });
        }

        const rateCheck = consumeRateLimitEntry(versionBroadcastRateLimitStore, sender, 1, 60 * 1000);
        if (!rateCheck.allowed) {
            return res.status(429).json({ status: 'error', message: `נסה שוב בעוד ${rateCheck.retryAfterSeconds} שניות` });
        }

        const allUsers = Object.keys(deviceSubscriptionsByUser || {}).filter(Boolean);
        if (!allUsers.length) {
            return res.json({ status: 'success', notifiedUsers: 0 });
        }

        const pushTitle = 'עדכון גרסה';
        const pushBody = 'גרסה חדשה זמינה – האפליקציה תתעדכן אוטומטית.';

        const results = await Promise.allSettled(
            allUsers.map((targetUser) =>
                sendPushNotificationToUser(
                    targetUser,
                    {
                        title: pushTitle,
                        body: { shortText: pushBody },
                        data: { type: 'version-update' }
                    },
                    'מערכות מידע',
                    { skipBadge: true }
                )
            )
        );

        const successCount = results.filter((r) => r.status === 'fulfilled').length;
        const failCount = results.filter((r) => r.status === 'rejected').length;

        console.log(`[VERSION-BROADCAST] Sent version update push to ${successCount}/${allUsers.length} users (${failCount} failed). Triggered by ${sender}.`);
        return res.json({ status: 'success', notifiedUsers: successCount, failed: failCount, total: allUsers.length });
    }
);

app.get(['/community-group-configs', '/notify/community-group-configs'],
    requireAuthorizedUser({
        required: true,
        candidateKeys: ['user'],
        onError: (_req, res, resolution) => res.status(resolution.status).json({ configs: [], error: resolution.error })
    }),
    (req, res, next) => {
        const user = normalizeUserKey(req.resolvedUser || '');
        if (!user) return res.status(401).json({ configs: [], error: 'Unauthorized' });
        const rateCheck = consumeRateLimitEntry(communityGroupConfigsRateLimitStore, user, 10, 60 * 1000);
        if (!rateCheck.allowed) {
            return res.status(429).json({ configs: [], error: `Rate limited. Retry after ${rateCheck.retryAfterSeconds}s` });
        }
        next();
    },
    async (_req, res) => {
        try {
            const configs = await mysqlLogsService.loadCommunityGroups();
            return res.json({
                configs: configs.map((cfg) => ({
                    id: cfg.groupId,
                    name: cfg.groupName,
                    staticMembers: cfg.members,
                    allowedWriters: cfg.writers
                }))
            });
        } catch (err) {
            console.error('[COMMUNITY-GROUPS] Failed to load configs:', err && err.message ? err.message : err);
            return res.status(500).json({ configs: [], error: 'Failed to load community group configs' });
        }
    }
);

const userGroupsRateLimitStore = new Map();

app.get(['/user-chat-groups', '/notify/user-chat-groups'],
    requireAuthorizedUser({
        required: true,
        candidateKeys: ['user'],
        onError: (_req, res, resolution) => res.status(resolution.status).json({ groups: [], error: resolution.error })
    }),
    (req, res, next) => {
        const user = normalizeUserKey(req.resolvedUser || '');
        if (!user) return res.status(401).json({ groups: [], error: 'Unauthorized' });
        const rateCheck = consumeRateLimitEntry(userGroupsRateLimitStore, user, 10, 60 * 1000);
        if (!rateCheck.allowed) {
            return res.status(429).json({ groups: [], error: `Rate limited. Retry after ${rateCheck.retryAfterSeconds}s` });
        }
        next();
    },
    async (req, res) => {
        const user = normalizeUserKey(req.resolvedUser || '');
        try {
            const allGroups = await mysqlLogsService.loadAllChatGroups();
            // Return only groups where the user is a member
            const userGroups = allGroups.filter((group) => {
                if (!Array.isArray(group.members) || group.members.length === 0) return true;
                return group.members.some((member) => normalizeUserKey(member) === user);
            });
            return res.json({
                groups: userGroups.map((g) => ({
                    id: g.groupId,
                    name: g.groupName,
                    members: g.members,
                    admins: g.admins,
                    createdBy: g.createdBy,
                    type: g.type,
                    createdAt: g.createdAt,
                    updatedAt: g.updatedAt
                }))
            });
        } catch (err) {
            console.error('[USER-GROUPS] Failed to load user groups:', err && err.message ? err.message : err);
            return res.status(500).json({ groups: [], error: 'Failed to load user groups' });
        }
    }
);

// --- Mark messages as seen ---
const markSeenRateLimitStore = new Map();

app.post(['/mark-seen', '/notify/mark-seen'],
    requireAuthorizedUser({
        required: true,
        candidateKeys: ['user'],
        onError: (_req, res, resolution) => res.status(resolution.status).json({ error: resolution.error })
    }),
    async (req, res) => {
        const user = normalizeUserKey(req.resolvedUser || '');
        if (!user) return res.status(401).json({ error: 'Unauthorized' });
        const rateCheck = consumeRateLimitEntry(markSeenRateLimitStore, user, 30, 60 * 1000);
        if (!rateCheck.allowed) {
            return res.status(429).json({ error: `Rate limited. Retry after ${rateCheck.retryAfterSeconds}s` });
        }
        const chatId = String(req.body && req.body.chatId || '').trim().toLowerCase();
        if (!chatId) {
            return res.status(400).json({ error: 'Missing chatId' });
        }
        try {
            const affected = await mysqlLogsService.markMessagesSeen(user, chatId);
            return res.json({ status: 'ok', marked: affected });
        } catch (err) {
            console.error('[MARK-SEEN] Failed:', err && err.message ? err.message : err);
            return res.status(500).json({ error: 'Failed to mark messages as seen' });
        }
    }
);

// --- Admin: backup all server groups to DB ---
const BACKUP_GROUPS_ALLOWED_USERS_SET = new Set(
    ['0546799693'].map(normalizeUserKey).filter(Boolean)
);
const backupGroupsRateLimitStore = new Map();

app.post(['/backup-all-groups-to-db', '/notify/backup-all-groups-to-db'],
    requireAuthorizedUser({
        required: true,
        candidateKeys: ['user'],
        onError: (_req, res, resolution) => res.status(resolution.status).json({ status: 'error', message: resolution.error })
    }),
    async (req, res) => {
        const sender = normalizeUserKey(req.resolvedUser || '');
        if (!sender || !BACKUP_GROUPS_ALLOWED_USERS_SET.has(sender)) {
            return res.status(403).json({ status: 'error', message: 'Forbidden' });
        }

        const rateCheck = consumeRateLimitEntry(backupGroupsRateLimitStore, sender, 1, 60 * 1000);
        if (!rateCheck.allowed) {
            return res.status(429).json({ status: 'error', message: `נסה שוב בעוד ${rateCheck.retryAfterSeconds} שניות` });
        }

        try {
            const allGroupIds = Object.keys(groups || {});
            let upsertedCount = 0;
            for (const groupId of allGroupIds) {
                const group = groups[groupId];
                if (!group || !group.id || !group.name) continue;
                const ok = await mysqlLogsService.upsertChatGroup({
                    groupId: group.id,
                    groupName: group.name,
                    members: Array.isArray(group.members) ? group.members : [],
                    admins: Array.isArray(group.admins) ? group.admins : [],
                    createdBy: group.createdBy || null,
                    type: group.type || 'group',
                    createdAt: group.createdAt || Date.now(),
                    updatedAt: group.updatedAt || Date.now()
                });
                if (ok) upsertedCount++;
            }
            console.log(`[BACKUP-GROUPS] ${sender} backed up ${upsertedCount}/${allGroupIds.length} groups to DB.`);
            return res.json({ status: 'success', backedUp: upsertedCount, total: allGroupIds.length });
        } catch (err) {
            console.error('[BACKUP-GROUPS] Failed:', err && err.message ? err.message : err);
            return res.status(500).json({ status: 'error', message: 'Failed to backup groups' });
        }
    }
);

// --- Sync all MessageActivities (no filtering) ---
app.get(['/message-activities', '/notify/message-activities'], async (_req, res) => {
    try {
        const activities = await mysqlLogsService.getAllMessageActivities();
        return res.json({ activities });
    } catch (err) {
        console.error('[MESSAGE-ACTIVITIES] Failed to fetch:', err && err.message ? err.message : err);
        return res.status(500).json({ activities: [], error: 'Failed to fetch message activities' });
    }
});

app.get(['/webhook-registry', '/notify/webhook-registry'], (_req, res) => {
    res.json({
        webhooks: webhookRegistryService.list()
    });
});

app.post(['/webhook-registry', '/notify/webhook-registry'], (req, res) => {
    if (!isSchedulerOpsRequestAuthorized(req)) {
        return res.status(403).json({ error: 'Forbidden' });
    }
    const type = String(req.body && req.body.type || '').trim();
    const url = String(req.body && req.body.url || '').trim();
    if (!type || !url) {
        return res.status(400).json({ error: 'Both type and url are required' });
    }
    webhookRegistryService.register(type, url);
    return res.json({
        status: 'ok',
        webhooks: webhookRegistryService.list()
    });
});

app.get(['/refresh-subscribe-auth/status', '/notify/refresh-subscribe-auth/status'], (req, res) => {
    res.json({
        running: subscriptionAuthRefreshState.running,
        lastRunAt: subscriptionAuthRefreshState.lastRunAt || null,
        lastResult: subscriptionAuthRefreshState.lastResult || null
    });
});

app.post(['/refresh-subscribe-auth', '/notify/refresh-subscribe-auth'], (req, res) => {
    if (subscriptionAuthRefreshState.running) {
        return res.status(409).json({
            status: 'running',
            message: 'Auth refresh is already running.',
            lastResult: subscriptionAuthRefreshState.lastResult || null
        });
    }

    const requestId = generateMessageId();
    const reason = (req.body && typeof req.body.reason === 'string') ? req.body.reason.trim() : 'manual';
    const initiatedBy = (req.body && typeof req.body.initiatedBy === 'string') ? req.body.initiatedBy.trim() : 'api';
    const forceResubscribe = !(req.body && req.body.forceResubscribe === false);
    const usernames = parseUsernamesInput(req.body && req.body.usernames);
    const deviceTypes = parseSubscriptionDeviceTypesInput(req.body && (req.body.deviceTypes || req.body.deviceType));
    const excludeIosEndpoints = req.body && Object.prototype.hasOwnProperty.call(req.body, 'excludeIosEndpoints')
        ? parseBooleanInput(req.body.excludeIosEndpoints, false)
        : false;
    res.json({
        status: 'queued',
        requestId,
        reason: reason || 'manual',
        forceResubscribe,
        requestedUserCount: usernames.length,
        deviceTypes: deviceTypes.length ? deviceTypes : ['all'],
        excludeIosEndpoints
    });

    runSubscriptionAuthRefreshJob({
        requestId,
        reason,
        initiatedBy,
        forceResubscribe,
        usernames,
        deviceTypes,
        excludeIosEndpoints
    })
        .then((summary) => {
            console.log(
                `[AUTH REFRESH] Completed ${summary.requestId} | discoveredUsers=${summary.discoveredUserCount || 0} targeted=${summary.targeted} success=${summary.success} failed=${summary.failed}`
            );
        })
        .catch((error) => {
            console.error(`[AUTH REFRESH] Failed ${requestId}:`, error.message);
        });
});

// Temporary ops endpoint: one-time visible device prompt campaign to recover devices
// that stopped receiving pushes until users reopen the app.
app.get(['/mobile-reregister-campaign/status', '/notify/mobile-reregister-campaign/status'], (req, res) => {
    const campaignIdQuery = (req.query && typeof req.query.campaignId === 'string')
        ? sanitizeCampaignId(req.query.campaignId)
        : '';
    res.json({
        running: mobileReregisterCampaignState.running,
        lastRunAt: mobileReregisterCampaignState.lastRunAt || null,
        lastResult: mobileReregisterCampaignState.lastResult || null,
        campaignId: campaignIdQuery || null,
        campaignSentTargets: campaignIdQuery ? getCampaignSentCount(campaignIdQuery) : null,
        campaignSentUsers: campaignIdQuery ? getCampaignSentCount(campaignIdQuery) : null, // Legacy alias
        trackedCampaigns: listTrackedCampaigns(20)
    });
});

app.post(['/mobile-reregister-campaign', '/notify/mobile-reregister-campaign'], (req, res) => {
    if (mobileReregisterCampaignState.running) {
        return res.status(409).json({
            status: 'running',
            message: 'Mobile re-register prompt campaign is already running.',
            lastResult: mobileReregisterCampaignState.lastResult || null
        });
    }

    const payload = req.body && typeof req.body === 'object' ? req.body : {};
    const requestId = generateMessageId();
    const campaignId = sanitizeCampaignId(payload.campaignId);
    const usernames = parseUsernamesInput(payload.usernames);
    const oneTime = payload.oneTime === undefined ? true : parseBooleanInput(payload.oneTime, true);
    const force = parseBooleanInput(payload.force, false);
    const requestedDeviceTypes = parseSubscriptionDeviceTypesInput(payload.deviceTypes || payload.deviceType);
    const deviceTypes = requestedDeviceTypes.length ? requestedDeviceTypes : ['mobile', 'pc'];
    const requireInteraction = payload.requireInteraction === undefined
        ? true
        : parseBooleanInput(payload.requireInteraction, true);
    const maxTargets = parsePositiveInteger(payload.maxTargets, 0);
    const title = typeof payload.title === 'string' ? payload.title.trim() : '';
    const body = typeof payload.body === 'string' ? payload.body.trim() : '';
    const url = typeof payload.url === 'string' ? payload.url.trim() : '';

    res.json({
        status: 'queued',
        requestId,
        campaignId,
        requestedUserCount: usernames.length,
        deviceTypes,
        oneTime,
        force,
        maxTargets
    });

    runMobileReregisterPromptCampaign({
        requestId,
        campaignId,
        usernames,
        deviceTypes,
        oneTime,
        force,
        requireInteraction,
        maxTargets,
        title,
        body,
        url
    })
        .then((summary) => {
            console.log(
                `[MOBILE REREGISTER] Completed ${summary.requestId || requestId} | campaign=${summary.campaignId || campaignId} targeted=${summary.targeted || 0} success=${summary.success || 0} failed=${summary.failed || 0}`
            );
        })
        .catch((error) => {
            console.error(`[MOBILE REREGISTER] Failed ${requestId}:`, error && error.message ? error.message : error);
        });
});

registerShuttleController(app, {
    isSchedulerOpsRequestAuthorized,
    requireAuthorizedUser,
    fetchWithRetry,
    buildShuttleUserOrdersUrl: (queryParams = {}) => sheetIntegrationService.buildShuttleUserOrdersUrl(queryParams),
    getShuttleReminderEffectiveTimeZone,
    SHUTTLE_REMINDER_ENABLED,
    shuttleReminderState,
    getShuttleReminderSchedulerStarted: () => shuttleReminderSchedulerStarted,
    SHUTTLE_REMINDER_INTERVAL_MS,
    SHUTTLE_REMINDER_LEAD_MS,
    SHUTTLE_REMINDER_USER_REFRESH_MS,
    SHUTTLE_REMINDER_USERS_DISCOVERY_REFRESH_MS,
    SHUTTLE_REMINDER_FETCH_TIMEOUT_MS,
    SHUTTLE_REMINDER_FETCH_RETRIES,
    SHUTTLE_USER_ORDERS_URL,
    shuttleReminderSentAtByKey,
    shuttleReminderKnownUsersCache,
    shuttleReminderOrdersCacheByUser,
    parseBooleanInput,
    generateMessageId,
    runShuttleReminderJob
});

registerHelpdeskController(app, {
    requireAuthorizedUser,
    env: process.env,
    buildGoogleSheetGetUrl,
    fetchWithRetry
});

registerMessageController(app, {
    requireAuthorizedUser,
    normalizeUserKey,
    fetchWithRetry,
    buildGoogleSheetGetUrl,
    getLogsMessagesForUser: (user, options = {}) => mysqlLogsService.getLogsMessagesForUser(user, options),
    getHardcodedGroupIds: () => communityGroupIds,
    getHardcodedGroupMembers: () => {
        const membersMap = {};
        hardcodedCommunityGroupsByKey.forEach((policy, key) => {
            if (Array.isArray(policy.members) && policy.members.length) {
                membersMap[key] = policy.members;
            }
        });
        return membersMap;
    },
    getGroups: () => groups,
    loadAllChatGroups: () => mysqlLogsService.loadAllChatGroups(),
    getActiveRedisStateStore: () => activeRedisStateStore,
    getMessageQueue: () => messageQueue,
    scheduleStateSave,
    sseClients,
    updateUserReceivedTime: (msgId, receivedAt) => mysqlLogsService.updateUserReceivedTime(msgId, receivedAt),
    updateUserReceivedTimeBatch: (entries) => mysqlLogsService.updateUserReceivedTimeBatch(entries)
});

app.post(['/upload', '/notify/upload'], uploadFieldsValidated, async (req, res) => {
    const file = req.files && req.files.file ? req.files.file[0] : null;
    const thumbnail = req.files && req.files.thumbnail ? req.files.thumbnail[0] : null;
    const uploadedFiles = [file, thumbnail].filter(Boolean);
    const rejectWithCleanup = async (statusCode, message) => {
        await Promise.all(uploadedFiles.map((entry) => safelyDeleteUploadedFile(entry)));
        return res.status(statusCode).json({ error: message });
    };

    if (!file) {
        return rejectWithCleanup(400, 'No file uploaded');
    }
    if (!isAllowedMainUpload(file)) {
        return rejectWithCleanup(400, 'Only image and PDF files are allowed');
    }
    if (thumbnail && !isAllowedThumbnailUpload(thumbnail)) {
        return rejectWithCleanup(400, 'Thumbnail must be an image file');
    }

    try {
        const mainValidation = await validateUploadedFileSecurity(file, { allowImage: true, allowPdf: true });
        if (!mainValidation.ok) {
            return rejectWithCleanup(400, mainValidation.message || 'Unsafe file content detected');
        }

        if (thumbnail) {
            const thumbnailValidation = await validateUploadedFileSecurity(thumbnail, { allowImage: true, allowPdf: false });
            if (!thumbnailValidation.ok) {
                return rejectWithCleanup(400, thumbnailValidation.message || 'Unsafe thumbnail content detected');
            }
        }
    } catch (error) {
        console.error('[UPLOAD SECURITY] Validation failure:', error && error.message ? error.message : error);
        return rejectWithCleanup(400, 'File content validation failed');
    }

    const fileUrl = `/notify/uploads/${encodeURIComponent(file.filename)}`;
    const thumbUrl = thumbnail ? `/notify/uploads/${encodeURIComponent(thumbnail.filename)}` : null;
    res.json({ status: 'success', url: fileUrl, thumbUrl, type: file.mimetype });
});

app.post(
    ['/reply', '/notify/reply'],
    requireAuthorizedUser({
        required: true,
        candidateKeys: ['user'],
        onError: (_req, res, resolution) => res.status(resolution.status).json({ error: resolution.error })
    }),
    async (req, res) => {
        try {
            const result = await processReplyPayload(req.body || {}, req.resolvedUser);
            return res.json(result);
        } catch (error) {
            const statusCode = Number(error && error.status) || 500;
            console.error('[REPLY ERROR]', error);
            return res.status(statusCode).json({
                error: error && error.message ? error.message : 'Reply failed'
            });
        }
});

app.post(
    ['/group-update', '/notify/group-update'],
    requireAuthorizedUser({
        required: true,
        candidateKeys: ['actorUser', 'user', 'groupCreatedBy'],
        onError: (_req, res, resolution) => res.status(resolution.status).json({ error: resolution.error })
    }),
    async (req, res) => {
    try {
        const {
            groupId,
            groupName,
            groupMembers,
            groupCreatedBy,
            groupAdmins,
            actorUser,
            groupUpdatedAt,
            groupType,
            membersToNotify
        } = req.body || {};
        if (!groupId || !groupName) {
            return res.status(400).json({ error: 'Missing group update fields' });
        }
        const normalizedActorUser = normalizeUserKey(req.resolvedUser || actorUser || '');
        if (!normalizedActorUser) {
            return res.status(400).json({ error: 'Missing actor user' });
        }
        const existingGroupRecord = groups[groupId] && typeof groups[groupId] === 'object'
            ? groups[groupId]
            : null;
        if (!canManageGroupUpdate(normalizedActorUser, existingGroupRecord, req.body || {})) {
            return res.status(403).json({ error: 'Only group admins can update group metadata' });
        }
        const hardcodedCommunityPolicy = resolveHardcodedCommunityPolicy(null, groupId, groupName);
        const requestedRecipients = (hardcodedCommunityPolicy && Array.isArray(hardcodedCommunityPolicy.members) && hardcodedCommunityPolicy.members.length)
            ? hardcodedCommunityPolicy.members
            : membersToNotify;
        if (!Array.isArray(requestedRecipients) || requestedRecipients.length === 0) {
            return res.status(400).json({ error: 'Missing group update recipients' });
        }
        const groupRecord = upsertGroup({
            groupId,
            groupName,
            groupMembers,
            groupCreatedBy,
            groupAdmins,
            groupUpdatedAt,
            groupType
        });
        const recipientByKey = new Map();
        requestedRecipients.forEach(member => {
            const rawMember = String(member || '').trim();
            const memberKey = normalizeUserKey(rawMember);
            if (!memberKey) return;
            if (!recipientByKey.has(memberKey)) {
                recipientByKey.set(memberKey, rawMember);
            }
        });
        const dedupedRecipients = Array.from(recipientByKey.values());
        if (!dedupedRecipients.length) {
            return res.json({ status: 'success', details: { success: 0, failed: 0 } });
        }

        const resolvedGroupMembers = groupRecord && Array.isArray(groupRecord.members)
            ? groupRecord.members
            : (Array.isArray(groupMembers) ? groupMembers : []);
        const resolvedGroupCreatedBy = groupRecord ? groupRecord.createdBy : (groupCreatedBy || null);
        const resolvedGroupUpdatedAt = groupRecord ? groupRecord.updatedAt : (groupUpdatedAt || Date.now());
        const resolvedGroupType = normalizeGroupType(groupType || (groupRecord ? groupRecord.type : 'group'));
        const resolvedGroupName = groupRecord ? groupRecord.name : groupName;
        const messageId = generateMessageId();
        const notificationData = {
            messageId,
            title: '',
            body: {
                shortText: '',
                longText: ''
            },
            data: {
                type: 'group-update',
                groupId,
                groupName: resolvedGroupName,
                groupMembers: resolvedGroupMembers,
                groupCreatedBy: resolvedGroupCreatedBy,
                groupAdmins: groupRecord && Array.isArray(groupRecord.admins) ? groupRecord.admins : undefined,
                groupUpdatedAt: resolvedGroupUpdatedAt,
                groupType: resolvedGroupType
            }
        };

        const groupUpdateRecord = {
            messageId,
            sender: groupId,
            type: 'group-update',
            groupId,
            groupName: resolvedGroupName,
            groupMembers: resolvedGroupMembers,
            groupCreatedBy: resolvedGroupCreatedBy,
            groupAdmins: groupRecord && Array.isArray(groupRecord.admins) ? groupRecord.admins : undefined,
            groupUpdatedAt: resolvedGroupUpdatedAt,
            groupType: resolvedGroupType,
            timestamp: Date.now()
        };
        await addToQueue(dedupedRecipients, groupUpdateRecord);

        const result = await sendPushNotificationToUser(dedupedRecipients, notificationData, groupId, { messageId, skipBadge: true });
        res.json({ status: 'success', details: result });
    } catch (e) {
        console.error('[GROUP UPDATE ERROR]', e);
        res.status(500).json({ error: e.message });
    }
});

app.post(
    ['/reaction', '/notify/reaction'],
    requireAuthorizedUser({
        required: true,
        candidateKeys: ['reactor'],
        onError: (_req, res, resolution) => res.status(resolution.status).json({ error: resolution.error })
    }),
    async (req, res) => {
        try {
            const result = await processReactionPayload(req.body || {}, req.resolvedUser);
            return res.json(result);
        } catch (error) {
            const statusCode = Number(error && error.status) || 500;
            console.error('[REACTION ERROR]', error);
            return res.status(statusCode).json({
                error: error && error.message ? error.message : 'Reaction failed'
            });
        }
});

app.post(
    ['/typing', '/notify/typing'],
    requireAuthorizedUser({
        required: true,
        candidateKeys: ['user'],
        onError: (_req, res, resolution) => res.status(resolution.status).json({ error: resolution.error })
    }),
    (req, res) => {
        try {
            const result = emitTypingSignalToRecipients(req.body || {}, req.resolvedUser);
            return res.json(result);
        } catch (error) {
            const statusCode = Number(error && error.status) || 500;
            return res.status(statusCode).json({
                error: error && error.message ? error.message : 'Typing signal failed'
            });
        }
    }
);

app.post(
    ['/read', '/notify/read'],
    requireAuthorizedUser({
        required: true,
        candidateKeys: ['reader'],
        onError: (_req, res, resolution) => res.status(resolution.status).json({ status: 'error', message: resolution.error })
    }),
    async (req, res) => {
    try {
        const { reader: requestedReader, sender, messageIds, readAt } = req.body;
        if (!requestedReader || !sender || !Array.isArray(messageIds) || messageIds.length === 0) {
            return res.status(400).json({ status: 'error', message: 'Missing fields' });
        }
        const normalizedReader = req.resolvedUser;
        const normalizedSender = String(sender).trim();
        const uniqueMessageIds = Array.from(
            new Set(
                messageIds
                    .map((id) => String(id || '').trim())
                    .filter(Boolean)
            )
        );
        if (!normalizedReader || !normalizedSender || uniqueMessageIds.length === 0) {
            return res.status(400).json({ status: 'error', message: 'Invalid read receipt payload' });
        }

        const effectiveReadAt = Number(readAt) || Date.now();

        const payload = {
            title: '',
            body: { shortText: '', longText: '' },
            data: {
                type: 'read-receipt',
                messageIds: uniqueMessageIds,
                readAt: effectiveReadAt,
                sender: normalizedReader
            }
        };

        // Queue as well so polling/SSE can recover if push is delayed/missed.
        await addToQueue(normalizedSender, {
            type: 'read-receipt',
            messageIds: uniqueMessageIds,
            readAt: effectiveReadAt,
            sender: normalizedReader,
            timestamp: Date.now()
        });

        // Persist SeenTime in the database so it reflects that this reader read the chat.
        mysqlLogsService.markMessagesSeen(normalizedReader, normalizedSender).catch((err) => {
            console.warn('[READ RECEIPT] Failed to update SeenTime in DB:', err && err.message ? err.message : err);
        });

        const result = await sendPushNotificationToUser(normalizedSender, payload, normalizedReader, { skipBadge: true });
        res.json({ status: 'ok', details: result });
    } catch (err) {
        console.error('[READ RECEIPT] Failed:', err.message);
        res.status(500).json({ status: 'error', message: err.message });
    }
});

app.post('/notify', async (req, res) => {
    try {
        const { targetUser, title, shortText, longText, senderuser, imageUrl } = req.body;

        if (!targetUser) return res.status(400).json({ error: 'Missing targetUser' });

        const messageId = generateMessageId();
        const messageParam = {
            messageId,
            title: title || 'Work Alert',
            body: {
                shortText: shortText || (imageUrl ? 'Image Attachment' : 'Alert'),
                longText: longText || shortText
            },
            image: imageUrl
        };

        // ======================================================
        // [NEW] SAVE TO POLLING QUEUE
        // ======================================================
        const pollingMessage = {
            messageId,
            sender: senderuser || 'System',
            body: longText || shortText,
            timestamp: Date.now(),
            imageUrl: imageUrl || null
        };
        // The helper function will handle lowercasing the KEY for storage
        await addToQueue(targetUser, pollingMessage);
        
        await sleep(100);
        
        // [UPDATED] Send to ALL devices found for this user
        const result = await sendPushNotificationToUser(targetUser, messageParam, senderuser || 'System', {
            messageId,
            maxPerUserEndpoints: 1
        });
        res.json({ status: 'done', details: result });

    } catch (e) {
        console.error(e);
        res.status(500).json({ error: e.message });
    }
});

// ======================================================
// [UPDATED] 5. OUTGOING MESSAGE POLLER
// ======================================================
async function checkOutgoingQueue() {
    try {
        pruneRecentProcessedQueueMessages();
        // Ask Google Script for pending messages
        const response = await fetchWithRetry(
            buildGoogleSheetGetUrl({ action: 'check_queue' }, { token: CHECK_QUEUE_SERVER_TOKEN }),
            {},
            { timeoutMs: 10000, retries: 2 }
        );
        const data = await response.json();

        const queuedMessages = Array.isArray(data && data.messages) ? data.messages : [];
        if (queuedMessages.length > 0) {
            console.log(`[QUEUE] Found ${queuedMessages.length} messages.`);

            for (const msg of queuedMessages) {
                const rawRecipients = parseUsernamesInput(msg && msg.recipient);
                const normalizedRecipients = Array.from(new Set(
                    rawRecipients.map((value) => normalizeUserKey(value)).filter(Boolean)
                ));
                let targetUsers = normalizedRecipients.filter((value) => isLikelyPhoneUserKey(value));
                if (!targetUsers.length && normalizedRecipients.length === 1) {
                    // Keep backwards compatibility for non-phone usernames in controlled/dev flows.
                    targetUsers = normalizedRecipients;
                }
                if (targetUsers.length > 3) {
                    console.warn(
                        `[QUEUE] Suspicious recipient fanout trimmed: ${targetUsers.length} -> 3`
                    );
                    targetUsers = targetUsers.slice(0, 3);
                }
                const senderName = String((msg && msg.sender) || 'System').trim() || 'System';
                const bodyText = String((msg && msg.content) || '').trim();
                if (!targetUsers.length || !bodyText) {
                    continue;
                }

                const sourceUniqueId = String(
                    (msg && (msg.messageId || msg.id || msg.queueId || msg.rowId || msg.sheetRow || msg.row || msg.uid || msg.createdAt || msg.timestamp)) ||
                    ''
                ).trim();
                if (!sourceUniqueId) {
                    console.warn('[QUEUE] Message has no unique identifier; deduplication relies on sender+recipients only.', {
                        sender: senderName,
                        recipients: targetUsers
                    });
                }
                const senderKey = normalizeUserKey(senderName);
                const recipientKey = targetUsers.map((entry) => normalizeUserKey(entry)).filter(Boolean).sort().join(',');
                // Dedup key: [From, To, sourceUniqueId] — content is NOT part of the key.
                // Same content with different DateTime/sourceId is a new message.
                const dedupKey = sourceUniqueId
                    ? `${senderKey}|${recipientKey}|${sourceUniqueId}`
                    : `${senderKey}|${recipientKey}|${Date.now()}`;
                if (recentProcessedQueueMessages.has(dedupKey)) {
                    continue;
                }

                const messageId = (msg && msg.messageId)
                    ? String(msg.messageId).trim()
                    : `queue-${hashStringToShortId(dedupKey)}`;

                // 0. DB-backed dedup: check if same [From, To, DateTime] already logged.
                //    Uniqueness = [From, To, DateTime] — content is NOT part of the key.
                //    Survives server restarts (unlike in-memory map).
                let alreadyInDb = false;
                if (sourceUniqueId) {
                    try {
                        const dbChecks = await Promise.all(
                            targetUsers.map((user) => mysqlLogsService.hasDuplicateLog(senderName, user, sourceUniqueId).catch(() => false))
                        );
                        alreadyInDb = dbChecks.some(Boolean);
                    } catch (_dbErr) {
                        // On DB error, proceed with in-memory dedup only.
                    }
                }
                if (alreadyInDb) {
                    console.log(`[QUEUE] Skipping duplicate (DB): messageId=${messageId}`);
                    recentProcessedQueueMessages.set(dedupKey, Date.now());
                    continue;
                }

                const notificationData = {
                    messageId,
                    title: `Message from ${senderName}`,
                    body: {
                        shortText: bodyText,
                        longText: bodyText
                    }
                };

                // 0.5 Audit: record the queue message in MessageActivities
                for (const recipient of targetUsers) {
                    void mysqlLogsService.insertMessageActivity({
                        actionType: 'queue-message',
                        messageId,
                        sender: senderName,
                        recipient,
                        groupId: null,
                        body: bodyText || null,
                        imageUrl: null,
                        fileUrl: null,
                        actionTimestamp: Date.now()
                    }).catch(() => {});
                }

                // 1. Add to Polling Queue
                const pollingMessage = {
                    messageId,
                    sender: senderName,
                    body: bodyText,
                    timestamp: Date.now(),
                    imageUrl: null
                };
                await addToQueue(targetUsers, pollingMessage);

                // 2. Send Push Notification (Handles all devices)
                const pushResult = await sendPushNotificationToUser(targetUsers, notificationData, senderName, {
                    messageId,
                    maxPerUserEndpoints: 1,
                    dedupLog: true
                });
                if (pushResult && pushResult.failed > 0) {
                    console.warn(`[QUEUE] Push notification partially failed: ${pushResult.failed} failed, ${pushResult.success} succeeded for messageId=${messageId}`);
                }
                const processedAt = Date.now();
                recentProcessedQueueMessages.set(dedupKey, processedAt);
            }
        }
    } catch (error) {
        console.error('[QUEUE ERROR] Failed to check sheet:', error.message);
    }
}

// Start the Timer (10,000 ms = 10 seconds)
setInterval(checkOutgoingQueue, 10000);
startSubscriptionAuthRefreshScheduler();
//startShuttleReminderScheduler();

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
    if (fcmSender.isFcmSenderConfigured()) {
        console.log('[FCM] Firebase Admin credentials detected — mobile (Android/iOS) push delivery is enabled.');
    } else {
        console.warn(
            '[FCM] ⚠️  No Firebase Admin credentials available. Mobile push notifications ' +
            '(Android/iOS) WILL NOT be delivered. Set FIREBASE_SERVICE_ACCOUNT_BASE64 (or ' +
            'FIREBASE_SERVICE_ACCOUNT_JSON / FIREBASE_CREDENTIAL_FILE / GOOGLE_APPLICATION_CREDENTIALS) ' +
            'to a Firebase service-account JSON, or place ' +
            'tzmc-notifications-firebase-adminsdk-fbsvc-bb92594301.json next to server.js. ' +
            'See flutter_app/PLATFORM_SETUP.md §"Backend — Firebase service account".'
        );
    }
});
