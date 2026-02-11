const vapidKeys = {
    publicKey: "BNgK2Le8hUyXIrFeuHJJsHwjOUkK5y5bf46QH80Ybd1AoQFfQDEanVCfjo9HwqdJwWoD2-2pxxgTRdTasf9YYMk",
    privateKey: "fMQqCaakMboV7LEV57wJhxPAdyppOBRDBjRDVQBxg1s"
};
const GOOGLE_SHEET_URL = 'https://script.google.com/macros/s/AKfycbxTzd4oEqs_3vGEObKpFUPcDjQbjuiOiFKDjUm6Kvvh2zsdzhu7zGrcewnuWrtEExbC/exec';

const express = require('express');
const webpush = require('web-push');
const fetch = require('node-fetch');
const bodyParser = require('body-parser');
const multer = require('multer'); 
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const crypto = require('crypto');

// --- 1. SETUP UPLOADS FOLDER ---
const uploadDir = path.join(__dirname, 'uploads');
const app = express();
const SERVER_VERSION = '1.40'; // Bumped version
const SERVER_RELEASE_NOTES = [
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
let stateSaveTimer = null;

let unreadCounts = {};
let groups = {};



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

// Keep your uploads separate
app.use(['/uploads', '/notify/uploads'], express.static(uploadDir));


app.use(bodyParser.json());
// --- CORS CONFIGURATION ---
app.use(cors({
    origin: '*', 
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: [
        'Content-Type',
        'Authorization',
        'Cache-Control',
        'Pragma',
        'Last-Event-ID',
        'X-Requested-With'
    ]
}));

app.options('*', cors());

// [FIX] INCREASE LIMIT TO 50MB (Default is only 100kb)
app.use(bodyParser.json({ limit: '350mb' }));
app.use(bodyParser.urlencoded({ limit: '350mb', extended: true }));

if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir);
}

// --- 2. STORAGE CONFIG ---
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname);
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, uniqueSuffix + ext);
    }
});
const upload = multer({ storage: storage });
const uploadFields = upload.fields([{ name: 'file', maxCount: 1 }, { name: 'thumbnail', maxCount: 1 }]);

// --- 3. WEB PUSH CONFIG ---


webpush.setVapidDetails(
    'mailto:jmassalha@tzmc.gov.il',
    vapidKeys.publicKey,
    vapidKeys.privateKey
);



// ======================================================
// [NEW] 4. POLLING MAILBOX (IN-MEMORY STORAGE)
// ======================================================
let messageQueue = {}; 
const sseClients = new Map();

function notifySseClients(username, messageObj) {
    const clientSet = sseClients.get(username);
    if (!clientSet) return;
    const payload = `event: message\ndata: ${JSON.stringify(messageObj)}\n\n`;
    clientSet.forEach(res => res.write(payload));
}

// Helper: Add message to queue (NORMALIZED TO LOWERCASE)
function addToQueue(targetUser, messageObj) {
    const recipients = Array.isArray(targetUser) ? targetUser : [targetUser];
    
    recipients.forEach(user => {
        // [CHANGE] Force Lowercase Key
        const normalizedUser = String(user).trim().toLowerCase(); 

        if (!messageQueue[normalizedUser]) {
            messageQueue[normalizedUser] = [];
        }
        messageQueue[normalizedUser].push(messageObj);
        notifySseClients(normalizedUser, messageObj);
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
const SUBSCRIPTION_CACHE_TTL_MS = 2 * 60 * 1000;
const subscriptionCache = new Map();

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
}

function upsertGroup(payload = {}) {
    const groupId = payload.groupId;
    const groupName = typeof payload.groupName === 'string' ? payload.groupName.trim() : payload.groupName;
    if (!groupId || !groupName) return null;
    const existing = groups[groupId] || {};
    const updatedAt = payload.groupUpdatedAt || Date.now();
    const createdAt = existing.createdAt || payload.groupCreatedAt || Date.now();
    const shouldUpdateMembers = Array.isArray(payload.groupMembers) &&
        (!existing.updatedAt || updatedAt >= existing.updatedAt);
    const nextMembers = shouldUpdateMembers ? payload.groupMembers : (existing.members || []);
    const nextGroup = {
        id: groupId,
        name: groupName,
        members: nextMembers,
        createdBy: payload.groupCreatedBy || existing.createdBy || null,
        createdAt,
        updatedAt: Math.max(existing.updatedAt || 0, updatedAt),
        type: normalizeGroupType(payload.groupType || existing.type || 'group')
    };
    groups[groupId] = nextGroup;
    scheduleStateSave();
    return nextGroup;
}

async function loadState() {
    try {
        await fsp.mkdir(stateDir, { recursive: true });
        const raw = await fsp.readFile(stateFile, 'utf8');
        const data = JSON.parse(raw);
        unreadCounts = (data.unreadCounts && typeof data.unreadCounts === 'object') ? data.unreadCounts : {};
        messageQueue = (data.messageQueue && typeof data.messageQueue === 'object') ? data.messageQueue : {};
        groups = (data.groups && typeof data.groups === 'object') ? data.groups : {};
        console.log('[STATE] Loaded persisted state.');
    } catch (err) {
        if (err.code !== 'ENOENT') {
            console.warn('[STATE] Failed to load state:', err.message);
        }
    }
}

async function persistState() {
    try {
        const payload = JSON.stringify({ unreadCounts, messageQueue, groups });
        const tmpFile = `${stateFile}.tmp`;
        await fsp.writeFile(tmpFile, payload, 'utf8');
        await fsp.rename(tmpFile, stateFile);
    } catch (err) {
        console.warn('[STATE] Failed to persist state:', err.message);
    }
}

function scheduleStateSave() {
    if (stateSaveTimer) return;
    stateSaveTimer = setTimeout(async () => {
        stateSaveTimer = null;
        await persistState();
    }, 1000);
}

// Helper: Log status to Google Sheets
function logNotificationStatus(sender, recipient, messageShort, status, details) {
    fetchWithRetry(GOOGLE_SHEET_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            action: 'save_log',
            sender: sender || 'System',
            recipient: recipient,
            message: messageShort,
            status: status,
            details: details
        })
    }, { timeoutMs: 10000, retries: 2 }).catch(err => console.error('[LOG ERROR]', err.message));
}

async function getSubscriptionFromSheet(usernames) {
    const cacheKey = buildSubscriptionCacheKey(usernames);
    if (!cacheKey) return [];

    const requestUserList = Array.isArray(usernames) ? usernames.join(',') : String(usernames || '').trim();
    if (!requestUserList) return [];

    const now = Date.now();
    const cached = subscriptionCache.get(cacheKey);
    if (cached && now - cached.at < SUBSCRIPTION_CACHE_TTL_MS) {
        return cached.subscriptions;
    }

    try {
        const response = await fetchWithRetry(
            `${GOOGLE_SHEET_URL}?usernames=${encodeURIComponent(requestUserList)}`,
            {},
            { timeoutMs: 12000, retries: 2, backoffMs: 500 }
        );
        const result = await response.json();
        if (Array.isArray(result.subscriptions)) {
            const subscriptions = result.subscriptions.filter(Boolean);
            subscriptionCache.set(cacheKey, { at: now, subscriptions });
            return subscriptions;
        }
        return cached ? cached.subscriptions : [];
    } catch (error) {
        console.error('Network Error fetching from Google Sheet:', error);
        return cached ? cached.subscriptions : [];
    }
}
// --- RESET BADGE ENDPOINT ---
app.post(['/reset-badge', '/notify/reset-badge'], (req, res) => {
    const { user } = req.body;
    if (user) {
        // Reset count for this user
        unreadCounts[String(user).toLowerCase()] = 0;
        console.log(`[BADGE] Reset count for ${user}`);
        scheduleStateSave();
    }
    res.json({ status: 'success' });
});

// --- CLIENT TELEMETRY ---
app.post(['/log', '/notify/log'], (req, res) => {
    const { event, payload, user, timestamp } = req.body || {};
    console.log(`[CLIENT LOG] ${event || 'event'} | user=${user || 'unknown'} | ts=${timestamp || Date.now()}`);
    if (payload) {
        console.log('[CLIENT LOG] payload:', payload);
    }
    res.json({ status: 'ok' });
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
// --- DELETE MESSAGE ENDPOINT ---
app.post(['/delete', '/notify/delete'], async (req, res) => {
    try {
        const { timestamp, sender, recipient, messageId } = req.body;
        console.log(`[DELETE] Request from ${sender} to remove msg ${timestamp}`);

        // Send Silent Push to Recipient
        // We use a specific 'delete-action' type so the phone handles it in background
        const payload = JSON.stringify({
            data: {
                type: 'delete-action',
                timestamp: timestamp,
                sender: sender,
                messageId: messageId || null
            }
        });

        // Send to the recipient using your existing logic
        await sendPushNotificationToUser(recipient, JSON.parse(payload), sender);
        
        res.json({ status: 'success' });

    } catch (e) {
        console.error('[DELETE ERROR]', e);
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
    const scriptUrl = `${GOOGLE_SHEET_URL}?action=get_contacts&user=${encodeURIComponent(username)}`;
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

            await webpush.sendNotification(subscription, notificationPayload);
            
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
// [UPDATED] CORE SENDING LOGIC (Data-Only Payload Fix)
// ======================================================
// ======================================================
// ======================================================
// [FINAL FIX] CORE SENDING LOGIC (Collision Proof)
// ======================================================
async function sendPushNotificationToUser(targetUser, message, senderuser, options = {}) {
    const targetUsersArray = Array.isArray(targetUser) ? targetUser : [targetUser];
    
    // 1. Prepare Content
    const msgBody = message.body || {};
    const logContent = msgBody.shortText || message.data?.type || 'System Notification';
    const msgTitle = message.title || 'Work Alert';
    const imageUrl = message.image || null;
    const finalSender = senderuser || 'System';
    const messageId = options.messageId || message.messageId || generateMessageId();
    const shouldIncrementBadge = !options.skipBadge;

    console.log(`[PUSH] Searching subs for: ${targetUsersArray.join(', ')} from ${finalSender}`);

    let rawSubscriptions = await getSubscriptionFromSheet(targetUsersArray);

    if (!rawSubscriptions || rawSubscriptions.length === 0) {
        logNotificationStatus(finalSender, targetUsersArray.join(','), logContent, 'Failed', 'No subscriptions found');
        return { success: 0, failed: 0 };
    }

    // Deduplicate
    const uniqueSubscriptions = rawSubscriptions.filter((sub, index, self) =>
        index === self.findIndex((t) => t.endpoint === sub.endpoint)
    );

    const badgeCountByUser = new Map();
    const sendResults = await Promise.all(
        uniqueSubscriptions.map(async (subscription) => {
            // Increment unread badge once per user, not once per device endpoint.
            const userKey = normalizeUserKey(subscription.username);
            let currentCount = unreadCounts[userKey] || 0;
            if (shouldIncrementBadge) {
                if (badgeCountByUser.has(userKey)) {
                    currentCount = badgeCountByUser.get(userKey);
                } else {
                    currentCount = currentCount + 1;
                    unreadCounts[userKey] = currentCount;
                    badgeCountByUser.set(userKey, currentCount);
                }
            }

            const clickUrl = `https://www.tzmc.co.il/subscribes/?chat=${encodeURIComponent(finalSender)}&user=${encodeURIComponent(subscription.username)}`;
            const customData = message.data || {};
            const payloadData = {
                ...customData,
                title: msgTitle,
                body: msgBody.shortText || 'New Notification',
                badge: 'https://www.tzmc.co.il/subscribes/assets/icon-192.png',
                icon: 'https://www.tzmc.co.il/subscribes/assets/icon-192.png',
                requireInteraction: true,
                image: imageUrl,
                url: clickUrl,
                user: subscription.username,
                sender: finalSender,
                messageId: messageId
            };
            if (shouldIncrementBadge) {
                payloadData.badgeCount = currentCount;
            }

            const payload = JSON.stringify({
                data: {
                    ...payloadData
                }
            });

            try {
                const pushOptions = {
                    TTL: 86400,
                    headers: { 'Urgency': 'high' },
                    timeout: 15000
                };
                await webpush.sendNotification(subscription, payload, pushOptions);
                return { ok: true, username: subscription.username, badge: currentCount };
            } catch (err) {
                const statusCode = err.statusCode || 'N/A';
                if (statusCode === 404 || statusCode === 410) {
                    pruneSubscriptionCacheEndpoint(subscription.endpoint);
                }
                return { ok: false, username: subscription.username, statusCode, message: err.message };
            }
        })
    );

    let successCount = 0;
    let failCount = 0;
    const executionLogs = [];
    for (const result of sendResults) {
        if (result.ok) {
            successCount++;
            executionLogs.push(`Device (${result.username}): ✅ Delivered (Badge: ${result.badge})`);
        } else {
            failCount++;
            executionLogs.push(`Device (${result.username}): ❌ Failed [${result.statusCode}]`);
            console.error(`[PUSH FAIL] ${result.username}:`, result.message);
        }
    }

    scheduleStateSave();

    // Log to Sheet
    const fullReport = executionLogs.join('\n');
    let finalStatus = successCount > 0 ? 'Sent' : 'Failed';
    logNotificationStatus(finalSender, targetUsersArray.join(','), logContent, finalStatus, fullReport);

    return { success: successCount, failed: failCount };
}
// --- ROUTES ---

app.get(['/', '/notify'], (req, res) => {
    res.send('TZMC Server Running (Push + Polling Supported - Case Insensitive)');
});

app.get(['/version', '/notify/version'], (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ version: SERVER_VERSION, notes: SERVER_RELEASE_NOTES });
});

app.get(['/groups', '/notify/groups'], (req, res) => {
    const user = req.query.user ? normalizeUserKey(req.query.user) : '';
    if (!user) return res.json({ groups: [] });
    const result = Object.values(groups || {}).filter(group => {
        if (!group || !Array.isArray(group.members)) return false;
        return group.members.map(normalizeUserKey).includes(user);
    });
    res.json({ groups: result });
});

// ======================================================
// [NEW] GET MESSAGES (For Flutter Polling)
// ======================================================
app.get(['/messages', '/notify/messages'], (req, res) => {
    // [CHANGE] Force Lowercase Lookup
    const user = req.query.user ? String(req.query.user).trim().toLowerCase() : null;
    
    if (!user) return res.json({ messages: [] });

    // Check mailbox (using lowercase key)
    if (messageQueue[user] && messageQueue[user].length > 0) {
        const waitingMessages = messageQueue[user];
        
        // Clear mailbox after picking up
        messageQueue[user] = []; 
        scheduleStateSave();
        
        console.log(`[POLLING] Delivered ${waitingMessages.length} msgs to ${user}`);
        return res.json({ messages: waitingMessages });
    }

    return res.json({ messages: [] });
});

// ======================================================
// [NEW] SSE STREAM (REAL-TIME)
// ======================================================
app.get(['/stream', '/notify/stream'], (req, res) => {
    const user = req.query.user ? String(req.query.user).trim().toLowerCase() : null;
    if (!user) {
        return res.status(400).json({ error: 'Missing user' });
    }

    res.set({
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, Cache-Control, Pragma, Last-Event-ID'
    });
    req.socket.setTimeout(0);
    res.setTimeout(0);
    if (typeof res.flushHeaders === 'function') {
        res.flushHeaders();
    }
    res.write(`event: connected\ndata: ${JSON.stringify({ user })}\n\n`);
    if (typeof res.flush === 'function') {
        res.flush();
    }

    const existing = sseClients.get(user) || new Set();
    existing.add(res);
    sseClients.set(user, existing);

    const keepAlive = setInterval(() => {
        res.write(`event: ping\ndata: ${Date.now()}\n\n`);
        if (typeof res.flush === 'function') {
            res.flush();
        }
    }, 15000);

    const cleanup = () => {
        clearInterval(keepAlive);
        const set = sseClients.get(user);
        if (set) {
            set.delete(res);
            if (set.size === 0) {
                sseClients.delete(user);
            }
        }
    };

    req.on('close', cleanup);
    req.on('error', cleanup);
});

app.post(['/upload', '/notify/upload'], uploadFields, (req, res) => {
    const file = req.files && req.files.file ? req.files.file[0] : null;
    const thumbnail = req.files && req.files.thumbnail ? req.files.thumbnail[0] : null;

    if (!file) {
        return res.status(400).json({ error: 'No file uploaded' });
    }
    const fileUrl = `https://www.tzmc.co.il/notify/uploads/${file.filename}`;
    const thumbUrl = thumbnail ? `https://www.tzmc.co.il/notify/uploads/${thumbnail.filename}` : null;
    res.json({ status: 'success', url: fileUrl, thumbUrl, type: file.mimetype });
});

app.post(['/reply', '/notify/reply'], async (req, res) => {
    try {
        const {
            user,
            reply,
            originalSender,
            imageUrl,
            senderName,
            messageId: clientMessageId,
            groupId,
            groupName,
            groupMembers,
            groupCreatedBy,
            groupUpdatedAt,
            groupSenderName,
            membersToNotify
        } = req.body;
        console.log(`[REPLY] From: ${user} | To: ${originalSender}`);

        let groupRecord = null;
        if (groupId) {
            groupRecord = upsertGroup({
                groupId,
                groupName,
                groupMembers,
                groupCreatedBy,
                groupUpdatedAt,
                groupType: req.body.groupType
            });
            if (groupRecord && groupRecord.type === 'community' && groupRecord.createdBy && normalizeUserKey(user) !== normalizeUserKey(groupRecord.createdBy)) {
                return res.status(403).json({ error: 'Only admins can send to this group' });
            }
        }

        let targetToNotify = [];
        if (Array.isArray(membersToNotify) && membersToNotify.length) {
            targetToNotify = membersToNotify;
        } else if (groupId) {
            const groupList = groupRecord && Array.isArray(groupRecord.members) ? groupRecord.members : groupMembers;
            targetToNotify = Array.isArray(groupList) ? groupList : [];
        } else if (originalSender && originalSender !== 'System') {
            targetToNotify = [originalSender];
        } else {
            targetToNotify = ['Jmassalha'];
        }
        targetToNotify = Array.isArray(targetToNotify)
            ? targetToNotify.filter(member => normalizeUserKey(member) !== normalizeUserKey(user))
            : targetToNotify;
        if (Array.isArray(targetToNotify) && targetToNotify.length === 0) {
            return res.json({ status: 'success', details: { success: 0, failed: 0 } });
        }

        // 1. Prepare Message Text for Logging
        let messageContent = reply;
        if (!messageContent && imageUrl) {
            messageContent = `[Image Sent]: ${imageUrl}`;
        }

        // ======================================================
        // [NEW] SAVE TO GOOGLE SHEET "Replay"
        // ======================================================
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

        const messageId = clientMessageId || generateMessageId();
        const isGroup = Boolean(groupId);
        const senderLabel = groupSenderName || senderName || user;
        const normalizedGroupName = (typeof groupName === 'string') ? groupName.trim() : groupName;
        const notificationTitle = isGroup ? (normalizedGroupName || 'Group message') : `New message from ${senderLabel}`;
        const shortText = reply || (imageUrl ? 'Sent an image' : 'New Message');
        const notificationData = {
            messageId,
            title: notificationTitle,
            body: {
                shortText: isGroup ? `${senderLabel}: ${shortText}` : shortText,
                longText: reply
            },
            image: imageUrl,
            data: isGroup ? {
                groupId,
                groupName: normalizedGroupName,
                groupMembers,
                groupCreatedBy,
                groupUpdatedAt,
                groupType: groupRecord ? groupRecord.type : normalizeGroupType(req.body.groupType || 'group'),
                groupMessageText: shortText,
                groupSenderName: senderLabel
            } : undefined
        };

        // [EXISTING] SAVE TO POLLING QUEUE
        const pollingMessage = {
            messageId,
            sender: isGroup ? groupId : user,
            body: reply,
            timestamp: Date.now(),
            imageUrl: imageUrl || null,
            groupId: groupId || null,
            groupName: groupName || null,
            groupMembers: groupMembers || null,
            groupCreatedBy: groupCreatedBy || null,
            groupUpdatedAt: groupUpdatedAt || null,
            groupType: groupRecord ? groupRecord.type : normalizeGroupType(req.body.groupType || 'group'),
            groupSenderName: senderLabel
        };
        addToQueue(targetToNotify, pollingMessage);

        // [EXISTING] SEND WEB PUSH (To all devices)
        const senderForPush = isGroup ? groupId : user;
        const result = await sendPushNotificationToUser(targetToNotify, notificationData, senderForPush, { messageId });
        res.json({ status: 'success', details: result });

    } catch (e) {
        console.error('[REPLY ERROR]', e);
        res.status(500).json({ error: e.message });
    }
});

app.post(['/group-update', '/notify/group-update'], async (req, res) => {
    try {
        const { groupId, groupName, groupMembers, groupCreatedBy, groupUpdatedAt, groupType, membersToNotify } = req.body || {};
        if (!groupId || !groupName || !Array.isArray(membersToNotify) || membersToNotify.length === 0) {
            return res.status(400).json({ error: 'Missing group update fields' });
        }
        const groupRecord = upsertGroup({ groupId, groupName, groupMembers, groupCreatedBy, groupUpdatedAt, groupType });
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
                groupName: groupRecord ? groupRecord.name : groupName,
                groupMembers: Array.isArray(groupMembers) ? groupMembers : [],
                groupCreatedBy: groupCreatedBy || null,
                groupUpdatedAt: groupUpdatedAt || Date.now(),
                groupType: normalizeGroupType(groupType || (groupRecord ? groupRecord.type : 'group'))
            }
        };
        const result = await sendPushNotificationToUser(membersToNotify, notificationData, groupId, { messageId, skipBadge: true });
        res.json({ status: 'success', details: result });
    } catch (e) {
        console.error('[GROUP UPDATE ERROR]', e);
        res.status(500).json({ error: e.message });
    }
});

app.post(['/reaction', '/notify/reaction'], async (req, res) => {
    try {
        const {
            groupId,
            groupName,
            groupMembers,
            groupCreatedBy,
            groupUpdatedAt,
            groupType,
            targetMessageId,
            emoji,
            reactor,
            reactorName
        } = req.body || {};
        const normalizedTargetMessageId = String(targetMessageId || '').trim();
        const normalizedEmoji = String(emoji || '').trim();
        const normalizedReactor = normalizeUserKey(reactor);
        if (!groupId || !normalizedTargetMessageId || !normalizedEmoji) {
            return res.status(400).json({ error: 'Missing reaction fields' });
        }

        const groupRecord = upsertGroup({ groupId, groupName, groupMembers, groupCreatedBy, groupUpdatedAt, groupType });
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
        const membersToNotify = Array.from(recipientByKey.values());

        if (!membersToNotify.length) {
            return res.json({ status: 'success', details: { success: 0, failed: 0 } });
        }

        const reactionId = generateMessageId();
        const resolvedGroupName = (groupRecord && groupRecord.name) || String(groupName || '').trim() || 'קבוצה';
        const resolvedGroupMembers = groupRecord && Array.isArray(groupRecord.members)
            ? groupRecord.members
            : providedMembers;
        const resolvedGroupCreatedBy = (groupRecord && groupRecord.createdBy) || groupCreatedBy || null;
        const resolvedGroupUpdatedAt = (groupRecord && groupRecord.updatedAt) || groupUpdatedAt || Date.now();
        const resolvedGroupType = groupRecord
            ? groupRecord.type
            : normalizeGroupType(groupType || 'group');
        const resolvedReactorName = String(reactorName || reactor || 'משתמש').trim();
        const reactionText = `${resolvedReactorName} הגיב ${normalizedEmoji}`;

        const notificationData = {
            messageId: reactionId,
            title: resolvedGroupName || 'תגובה חדשה',
            body: {
                shortText: reactionText,
                longText: reactionText
            },
            data: {
                type: 'reaction',
                targetMessageId: normalizedTargetMessageId,
                emoji: normalizedEmoji,
                reactor: normalizedReactor || reactor,
                reactorName: resolvedReactorName,
                groupId,
                groupName: resolvedGroupName,
                groupMembers: resolvedGroupMembers,
                groupCreatedBy: resolvedGroupCreatedBy,
                groupUpdatedAt: resolvedGroupUpdatedAt,
                groupType: resolvedGroupType
            }
        };

        const reactionRecord = {
            messageId: reactionId,
            sender: groupId,
            type: 'reaction',
            targetMessageId: normalizedTargetMessageId,
            emoji: normalizedEmoji,
            reactor: normalizedReactor || reactor,
            reactorName: resolvedReactorName,
            timestamp: Date.now(),
            groupId,
            groupName: resolvedGroupName,
            groupMembers: resolvedGroupMembers,
            groupCreatedBy: resolvedGroupCreatedBy,
            groupUpdatedAt: resolvedGroupUpdatedAt,
            groupType: resolvedGroupType
        };
        addToQueue(membersToNotify, reactionRecord);

        const result = await sendPushNotificationToUser(membersToNotify, notificationData, groupId, { messageId: reactionId, skipBadge: true });
        res.json({ status: 'success', details: result });
    } catch (err) {
        console.error('[REACTION ERROR]', err);
        res.status(500).json({ error: err.message });
    }
});

app.post(['/read', '/notify/read'], async (req, res) => {
    try {
        const { reader, sender, messageIds, readAt } = req.body;
        if (!reader || !sender || !Array.isArray(messageIds) || messageIds.length === 0) {
            return res.status(400).json({ status: 'error', message: 'Missing fields' });
        }

        const payload = {
            title: '',
            body: { shortText: '', longText: '' },
            data: {
                type: 'read-receipt',
                messageIds,
                readAt: readAt || Date.now(),
                sender: reader
            }
        };

        const result = await sendPushNotificationToUser(sender, payload, reader, { skipBadge: true });
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
        addToQueue(targetUser, pollingMessage);
        
        await sleep(100);
        
        // [UPDATED] Send to ALL devices found for this user
        const result = await sendPushNotificationToUser(targetUser, messageParam, senderuser || 'System', { messageId });
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
        // Ask Google Script for pending messages
        const response = await fetchWithRetry(`${GOOGLE_SHEET_URL}?action=check_queue`, {}, { timeoutMs: 10000, retries: 2 });
        const data = await response.json();

        if (data.messages && data.messages.length > 0) {
            console.log(`[QUEUE] Found ${data.messages.length} messages.`);

            for (const msg of data.messages) {
                const targetUser = msg.recipient;
                const senderName = msg.sender || 'System'; 
                const bodyText = msg.content;
                
                const messageId = msg.messageId || generateMessageId();
                const notificationData = {
                    messageId,
                    title: `Message from ${senderName}`,
                    body: {
                        shortText: bodyText,
                        longText: bodyText
                    }
                };

                // 1. Send Push Notification (Handles all devices)
                await sendPushNotificationToUser(targetUser, notificationData, senderName, { messageId });
                
                // 2. Add to Polling Queue
                const pollingMessage = {
                    messageId,
                    sender: senderName,
                    body: bodyText,
                    timestamp: Date.now(),
                    imageUrl: null
                };
                addToQueue(targetUser, pollingMessage);
            }
        }
    } catch (error) {
        console.error('[QUEUE ERROR] Failed to check sheet:', error.message);
    }
}

// Start the Timer (10,000 ms = 10 seconds)
setInterval(checkOutgoingQueue, 10000);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});