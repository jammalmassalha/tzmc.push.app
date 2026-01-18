const vapidKeys = {
    publicKey: "BNgK2Le8hUyXIrFeuHJJsHwjOUkK5y5bf46QH80Ybd1AoQFfQDEanVCfjo9HwqdJwWoD2-2pxxgTRdTasf9YYMk",
    privateKey: "fMQqCaakMboV7LEV57wJhxPAdyppOBRDBjRDVQBxg1s"
};
const GOOGLE_SHEET_URL = 'https://script.google.com/macros/s/AKfycbw70tnIlHsQTke8BxFhEbEQQJxMhKzN85cCTkJOuS_L7zUnCxNYLX-r2cxYU2j8jIn5/exec';

const express = require('express');
const webpush = require('web-push');
const fetch = require('node-fetch');
const bodyParser = require('body-parser');
const multer = require('multer'); 
const path = require('path');
const fs = require('fs');
const cors = require('cors');

// --- 1. SETUP UPLOADS FOLDER ---
const uploadDir = path.join(__dirname, 'uploads');
const app = express();
const SERVER_VERSION = '1.13'; // Bumped version

let unreadCounts = {};



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
    allowedHeaders: ['Content-Type', 'Authorization']
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
    });
}
// ======================================================

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Helper: Log status to Google Sheets
function logNotificationStatus(sender, recipient, messageShort, status, details) {
    fetch(GOOGLE_SHEET_URL, {
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
    }).catch(err => console.error('[LOG ERROR]', err.message));
}

async function getSubscriptionFromSheet(usernames) {
    if (!usernames || usernames.length === 0) return [];
    const userListString = Array.isArray(usernames) ? usernames.join(',') : usernames;
    try {
        const response = await fetch(`${GOOGLE_SHEET_URL}?usernames=${encodeURIComponent(userListString)}`);
        const result = await response.json();
        if (result.result === 'success' && Array.isArray(result.subscriptions)) {
            return result.subscriptions;
        }
        return [];
    } catch (error) {
        console.error('Network Error fetching from Google Sheet:', error);
        return [];
    }
}
// --- RESET BADGE ENDPOINT ---
app.post(['/reset-badge', '/notify/reset-badge'], (req, res) => {
    const { user } = req.body;
    if (user) {
        // Reset count for this user
        unreadCounts[String(user).toLowerCase()] = 0;
        console.log(`[BADGE] Reset count for ${user}`);
    }
    res.json({ status: 'success' });
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
        fetch(GOOGLE_SHEET_URL, {
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
        const { timestamp, sender, recipient } = req.body;
        console.log(`[DELETE] Request from ${sender} to remove msg ${timestamp}`);

        // Send Silent Push to Recipient
        // We use a specific 'delete-action' type so the phone handles it in background
        const payload = JSON.stringify({
            data: {
                type: 'delete-action',
                timestamp: timestamp,
                sender: sender
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
        
        
        const sheetResponse = await fetch(scriptUrl);
        
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
async function sendPushNotificationToUser(targetUser, message, senderuser) {
    const targetUsersArray = Array.isArray(targetUser) ? targetUser : [targetUser];
    
    // 1. Prepare Content
    const msgBody = message.body || {};
    const logContent = msgBody.shortText || message.data?.type || 'System Notification';
    const msgTitle = message.title || 'Work Alert';
    const imageUrl = message.image || null;
    const finalSender = senderuser || 'System';

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

    let successCount = 0;
    let failCount = 0;
    let executionLogs = [];

    for (const subscription of uniqueSubscriptions) {
        
        // 2. Increment Badge (Server Memory)
        const userKey = String(subscription.username).trim().toLowerCase();
        let currentCount = (unreadCounts[userKey] || 0) + 1;
        unreadCounts[userKey] = currentCount;

        const clickUrl = `https://www.tzmc.co.il/subscribes/?chat=${encodeURIComponent(finalSender)}&user=${encodeURIComponent(subscription.username)}`;
        const customData = message.data || {};

        // 3. [CRITICAL CHANGE] Rename keys to prevent collision
        const payload = JSON.stringify({
            data: {
                ...customData,
                title: msgTitle,
                body: msgBody.shortText || 'New Notification',
                
                // RENAMED: 'badge' -> 'badgeIcon' (The small monochrome icon)
                badge: 'https://www.tzmc.co.il/subscribes/assets/icon-192.png', 
                icon: 'https://www.tzmc.co.il/subscribes/assets/icon-192.png',
                requireInteraction: true,
                image: imageUrl,
                
                url: clickUrl,
                user: subscription.username,
                sender: finalSender,
                
                // THE NUMBER (Only this variable holds the integer)
                badgeCount: currentCount 
            }
        });

        try {
            const options = {
                TTL: 86400,
                headers: { 'Urgency': 'high', 'Topic': 'messages' }
            };
        
            await webpush.sendNotification(subscription, payload, options);
            successCount++;
            executionLogs.push(`Device (${subscription.username}): ✅ Delivered (Badge: ${currentCount})`);
        } catch (err) {
            failCount++;
            const statusCode = err.statusCode || 'N/A';
            executionLogs.push(`Device (${subscription.username}): ❌ Failed [${statusCode}]`);
            console.error(`[PUSH FAIL] ${subscription.username}:`, err.message);
        }
        await sleep(40); 
    }

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
    res.json({ version: SERVER_VERSION });
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
        
        console.log(`[POLLING] Delivered ${waitingMessages.length} msgs to ${user}`);
        return res.json({ messages: waitingMessages });
    }

    return res.json({ messages: [] });
});

app.post(['/upload', '/notify/upload'], upload.single('file'), (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'No file uploaded' });
    }
    const fileUrl = `https://www.tzmc.co.il/notify/uploads/${req.file.filename}`;
    res.json({ status: 'success', url: fileUrl, type: req.file.mimetype });
});

app.post(['/reply', '/notify/reply'], async (req, res) => {
    try {
        const { user, reply, originalSender, imageUrl, senderName } = req.body;
        console.log(`[REPLY] From: ${user} | To: ${originalSender}`);

        const targetToNotify = (originalSender && originalSender !== 'System') ? originalSender : ['Jmassalha'];

        // 1. Prepare Message Text for Logging
        let messageContent = reply;
        if (!messageContent && imageUrl) {
            messageContent = `[Image Sent]: ${imageUrl}`;
        }

        // ======================================================
        // [NEW] SAVE TO GOOGLE SHEET "Replay"
        // ======================================================
        fetch(GOOGLE_SHEET_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                action: 'save_reply',
                fromUser: user,
                toUser: originalSender || 'System',
                message: messageContent
            })
        }).catch(err => console.error('[SHEET ERROR] Failed to save reply:', err.message));

        const notificationData = {
            title: `New message from ${senderName || user}`,
            body: {
                shortText: reply || (imageUrl ? 'Sent an image' : 'New Message'),
                longText: reply
            },
            image: imageUrl 
        };

        // [EXISTING] SAVE TO POLLING QUEUE
        const pollingMessage = {
            sender: user, 
            body: reply,
            timestamp: Date.now(),
            imageUrl: imageUrl || null
        };
        addToQueue(targetToNotify, pollingMessage);

        // [EXISTING] SEND WEB PUSH (To all devices)
        const result = await sendPushNotificationToUser(targetToNotify, notificationData, user);
        res.json({ status: 'success', details: result });

    } catch (e) {
        console.error('[REPLY ERROR]', e);
        res.status(500).json({ error: e.message });
    }
});

app.post('/notify', async (req, res) => {
    try {
        const { targetUser, title, shortText, longText, senderuser, imageUrl } = req.body;

        if (!targetUser) return res.status(400).json({ error: 'Missing targetUser' });

        const messageParam = {
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
            sender: senderuser || 'System',
            body: longText || shortText,
            timestamp: Date.now(),
            imageUrl: imageUrl || null
        };
        // The helper function will handle lowercasing the KEY for storage
        addToQueue(targetUser, pollingMessage);
        
        await sleep(100);
        
        // [UPDATED] Send to ALL devices found for this user
        const result = await sendPushNotificationToUser(targetUser, messageParam, senderuser || 'System');
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
        const response = await fetch(`${GOOGLE_SHEET_URL}?action=check_queue`);
        const data = await response.json();

        if (data.messages && data.messages.length > 0) {
            console.log(`[QUEUE] Found ${data.messages.length} messages.`);

            for (const msg of data.messages) {
                const targetUser = msg.recipient;
                const senderName = msg.sender || 'System'; 
                const bodyText = msg.content;
                
                const notificationData = {
                    title: `Message from ${senderName}`,
                    body: {
                        shortText: bodyText,
                        longText: bodyText
                    }
                };

                // 1. Send Push Notification (Handles all devices)
                await sendPushNotificationToUser(targetUser, notificationData, senderName);
                
                // 2. Add to Polling Queue
                const pollingMessage = {
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