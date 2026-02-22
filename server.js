const vapidKeys = {
    publicKey: "BNgK2Le8hUyXIrFeuHJJsHwjOUkK5y5bf46QH80Ybd1AoQFfQDEanVCfjo9HwqdJwWoD2-2pxxgTRdTasf9YYMk",
    privateKey: "fMQqCaakMboV7LEV57wJhxPAdyppOBRDBjRDVQBxg1s"
};
const GOOGLE_SHEET_URL = 'https://script.google.com/macros/s/AKfycbwvnlvHlDCEpMZmKRfXbaxwiO61I9AxIZcyMEyZsgRoYb4HbsflTXGmFpANkXj4QKcYLA/exec';

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
app.disable('x-powered-by');

const DEFAULT_ALLOWED_HOSTS = ['tzmc.co.il', 'www.tzmc.co.il', 'localhost', '127.0.0.1', '::1'];
const ALLOWED_HOSTS = buildHostAllowlist(
    String(process.env.ALLOWED_HOSTS || DEFAULT_ALLOWED_HOSTS.join(','))
);

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
let deviceSubscriptionsByUser = {};



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
app.use(cors({
    origin: '*', 
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: [
        'Content-Type',
        'Authorization',
        'Cache-Control',
        'Pragma',
        'Last-Event-ID',
        'X-Requested-With',
        'X-CSRF-Token'
    ]
}));

app.options('*', cors());

// [FIX] INCREASE LIMIT TO 50MB (Default is only 100kb)
app.use(bodyParser.json({ limit: '350mb' }));
app.use(bodyParser.urlencoded({ limit: '350mb', extended: true }));

if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir);
}

const ALLOWED_IMAGE_EXTENSIONS = new Set([
    '.jpg',
    '.jpeg',
    '.png',
    '.gif',
    '.webp',
    '.bmp',
    '.avif',
    '.heic',
    '.heif'
]);
const PDF_EXTENSION = '.pdf';
const PDF_MIME_TYPE = 'application/pdf';
const MAX_UPLOAD_INSPECTION_BYTES = 40 * 1024 * 1024;
const ISO_BMFF_IMAGE_BRANDS = new Set(['avif', 'avis', 'heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1']);
const PDF_DISALLOWED_TOKENS = [
    /\/javascript\b/i,
    /\/js\b/i,
    /\/openaction\b/i,
    /\/launch\b/i,
    /\/aa\b/i,
    /\/richmedia\b/i,
    /\/submitform\b/i,
    /\/embeddedfile\b/i,
    /\/encrypt\b/i
];

function normalizeUploadMimeType(file = {}) {
    return String(file.mimetype || '').trim().toLowerCase();
}

function normalizeUploadExtension(file = {}) {
    return path.extname(String(file.originalname || '')).toLowerCase();
}

function isImageUpload(file = {}) {
    const mimeType = normalizeUploadMimeType(file);
    const extension = normalizeUploadExtension(file);
    return mimeType.startsWith('image/') || ALLOWED_IMAGE_EXTENSIONS.has(extension);
}

function isPdfUpload(file = {}) {
    const mimeType = normalizeUploadMimeType(file);
    const extension = normalizeUploadExtension(file);
    return mimeType === PDF_MIME_TYPE || extension === PDF_EXTENSION;
}

function isAllowedMainUpload(file = {}) {
    return isImageUpload(file) || isPdfUpload(file);
}

function isAllowedThumbnailUpload(file = {}) {
    return isImageUpload(file);
}

function chooseSafeUploadExtension(file = {}) {
    const ext = normalizeUploadExtension(file);
    if (ALLOWED_IMAGE_EXTENSIONS.has(ext) || ext === PDF_EXTENSION) {
        return ext;
    }
    const mimeType = normalizeUploadMimeType(file);
    if (mimeType === 'image/jpeg') return '.jpg';
    if (mimeType === 'image/png') return '.png';
    if (mimeType === 'image/gif') return '.gif';
    if (mimeType === 'image/webp') return '.webp';
    if (mimeType === 'image/bmp' || mimeType === 'image/x-ms-bmp') return '.bmp';
    if (mimeType === 'image/avif') return '.avif';
    if (mimeType === 'image/heic') return '.heic';
    if (mimeType === 'image/heif') return '.heif';
    if (mimeType === PDF_MIME_TYPE) return PDF_EXTENSION;
    if (mimeType.startsWith('image/')) return '.jpg';
    return '';
}

function sanitizeUploadBaseName(rawName = '') {
    const base = path.basename(String(rawName || '').trim());
    const ext = path.extname(base);
    const stem = base.slice(0, Math.max(0, base.length - ext.length));
    const sanitized = stem
        .normalize('NFKD')
        .replace(/[^a-zA-Z0-9._-]+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^[._-]+|[._-]+$/g, '')
        .slice(0, 40);
    return sanitized || 'upload';
}

function buildSafeUploadFilename(file = {}) {
    const originalName = path.basename(String(file.originalname || '').trim());
    if (originalName && originalName !== '.' && originalName !== '..') {
        // Keep client filename as requested (without directory traversal segments).
        return originalName;
    }

    const safeStem = sanitizeUploadBaseName(file.originalname || '');
    const extension = chooseSafeUploadExtension(file);
    const uniqueSuffix = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    return `${safeStem}-${uniqueSuffix}${extension}`;
}

function bufferStartsWith(buffer, signature) {
    if (!Buffer.isBuffer(buffer) || !Buffer.isBuffer(signature)) return false;
    if (buffer.length < signature.length) return false;
    return buffer.subarray(0, signature.length).equals(signature);
}

function validatePngStructure(buffer) {
    const pngSignature = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
    if (!bufferStartsWith(buffer, pngSignature)) {
        return false;
    }

    let offset = pngSignature.length;
    while (offset + 12 <= buffer.length) {
        const chunkLength = buffer.readUInt32BE(offset);
        const chunkType = buffer.toString('ascii', offset + 4, offset + 8);
        const nextOffset = offset + 12 + chunkLength;
        if (nextOffset > buffer.length) {
            return false;
        }
        if (chunkType === 'IEND') {
            return nextOffset === buffer.length;
        }
        offset = nextOffset;
    }
    return false;
}

function validateWebpStructure(buffer) {
    if (buffer.length < 12) return false;
    if (!buffer.subarray(0, 4).equals(Buffer.from('RIFF'))) return false;
    if (!buffer.subarray(8, 12).equals(Buffer.from('WEBP'))) return false;
    const declaredSize = buffer.readUInt32LE(4) + 8;
    return declaredSize === buffer.length;
}

function validateBmpStructure(buffer) {
    if (buffer.length < 14) return false;
    if (!buffer.subarray(0, 2).equals(Buffer.from('BM'))) return false;
    const declaredSize = buffer.readUInt32LE(2);
    return declaredSize === buffer.length;
}

function validateIsoBmffStructure(buffer) {
    if (buffer.length < 16) return false;
    if (buffer.toString('ascii', 4, 8) !== 'ftyp') return false;
    const brand = buffer.toString('ascii', 8, 12).toLowerCase();
    if (!ISO_BMFF_IMAGE_BRANDS.has(brand)) return false;

    let offset = 0;
    while (offset + 8 <= buffer.length) {
        let boxSize = buffer.readUInt32BE(offset);
        if (boxSize === 0) {
            return offset + 8 <= buffer.length;
        }
        if (boxSize === 1) {
            if (offset + 16 > buffer.length) return false;
            const extendedSize = Number(buffer.readBigUInt64BE(offset + 8));
            if (!Number.isFinite(extendedSize) || extendedSize < 16) return false;
            boxSize = extendedSize;
        } else if (boxSize < 8) {
            return false;
        }

        const nextOffset = offset + boxSize;
        if (nextOffset > buffer.length) {
            return false;
        }
        offset = nextOffset;
    }
    return offset === buffer.length;
}

function detectImageFormat(buffer) {
    if (validatePngStructure(buffer)) return 'png';
    if (bufferStartsWith(buffer, Buffer.from([0xFF, 0xD8])) && buffer.subarray(buffer.length - 2).equals(Buffer.from([0xFF, 0xD9]))) {
        return 'jpeg';
    }
    if ((bufferStartsWith(buffer, Buffer.from('GIF87a')) || bufferStartsWith(buffer, Buffer.from('GIF89a'))) && buffer[buffer.length - 1] === 0x3B) {
        return 'gif';
    }
    if (validateWebpStructure(buffer)) return 'webp';
    if (validateBmpStructure(buffer)) return 'bmp';
    if (validateIsoBmffStructure(buffer)) return 'iso-bmff';
    return '';
}

function hasUnsafePdfContent(buffer) {
    if (!bufferStartsWith(buffer, Buffer.from('%PDF-'))) {
        return { unsafe: true, reason: 'Invalid PDF file signature' };
    }
    const eofMarker = Buffer.from('%%EOF');
    const eofIndex = buffer.lastIndexOf(eofMarker);
    if (eofIndex < 0) {
        return { unsafe: true, reason: 'Invalid PDF structure' };
    }
    const trailing = buffer.subarray(eofIndex + eofMarker.length).toString('latin1').trim();
    if (trailing) {
        return { unsafe: true, reason: 'PDF contains trailing hidden data' };
    }

    const text = buffer.toString('latin1');
    if (/<script\b/i.test(text) || /javascript:/i.test(text)) {
        return { unsafe: true, reason: 'PDF contains script content' };
    }
    for (const tokenRegex of PDF_DISALLOWED_TOKENS) {
        if (tokenRegex.test(text)) {
            return { unsafe: true, reason: 'PDF contains active or encrypted content' };
        }
    }
    return { unsafe: false, reason: '' };
}

async function safelyDeleteUploadedFile(file = null) {
    if (!file || !file.path) return;
    try {
        const resolvedUploadDir = path.resolve(uploadDir) + path.sep;
        const resolvedPath = path.resolve(String(file.path));
        if (!resolvedPath.startsWith(resolvedUploadDir)) {
            return;
        }
        await fsp.unlink(resolvedPath);
    } catch (error) {
        // Ignore cleanup failures to keep request handling stable.
    }
}

async function validateUploadedFileSecurity(file = {}, options = {}) {
    const allowImage = options.allowImage !== false;
    const allowPdf = options.allowPdf !== false;
    if (!file || !file.path) {
        return { ok: false, message: 'Invalid uploaded file data' };
    }

    const fileSize = Number(file.size || 0);
    if (!Number.isFinite(fileSize) || fileSize <= 0) {
        return { ok: false, message: 'Uploaded file is empty' };
    }
    if (fileSize > MAX_UPLOAD_INSPECTION_BYTES) {
        return { ok: false, message: 'File is too large for security inspection' };
    }

    const fileBuffer = await fsp.readFile(file.path);
    if (!fileBuffer.length) {
        return { ok: false, message: 'Uploaded file is empty' };
    }

    const isPdfCandidate = allowPdf && isPdfUpload(file);
    if (isPdfCandidate) {
        const pdfResult = hasUnsafePdfContent(fileBuffer);
        if (pdfResult.unsafe) {
            return { ok: false, message: pdfResult.reason || 'Unsafe PDF content detected' };
        }
        return { ok: true, message: '' };
    }

    const isImageCandidate = allowImage && isImageUpload(file);
    if (isImageCandidate) {
        const detectedFormat = detectImageFormat(fileBuffer);
        if (!detectedFormat) {
            return { ok: false, message: 'Invalid image content or hidden payload detected' };
        }
        return { ok: true, message: '' };
    }

    return { ok: false, message: 'Only secure image and PDF files are allowed' };
}

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
        const normalizedUser = normalizeUserCandidate(user);
        if (!normalizedUser) return;

        const queueEntry = (messageObj && typeof messageObj === 'object')
            ? { ...messageObj, recipient: normalizedUser }
            : {
                recipient: normalizedUser,
                body: String(messageObj || ''),
                timestamp: Date.now()
            };

        if (!messageQueue[normalizedUser]) {
            messageQueue[normalizedUser] = [];
        }
        messageQueue[normalizedUser].push(queueEntry);
        notifySseClients(normalizedUser, queueEntry);
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
const SESSION_COOKIE_SAME_SITE = String(process.env.SESSION_COOKIE_SAMESITE || 'Lax').trim();
const SESSION_COOKIE_SECURE = String(process.env.SESSION_COOKIE_SECURE || 'true').trim().toLowerCase() !== 'false';
const SESSION_SIGNING_SECRET = String(
    process.env.SESSION_SIGNING_SECRET ||
    APP_SERVER_TOKEN ||
    CHECK_QUEUE_SERVER_TOKEN ||
    vapidKeys.privateKey ||
    ''
).trim();
const SESSION_USER_PATTERN = /^0\d{9}$/;
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
const CSRF_PROTECTION_ENABLED = String(process.env.CSRF_PROTECTION_ENABLED || 'false').trim().toLowerCase() === 'true';
const CSRF_HEADER_NAME = 'x-csrf-token';
const MOBILE_REREGISTER_PUSH_TYPE = 'mobile-re-register-prompt';
const MOBILE_REREGISTER_DEFAULT_CAMPAIGN_ID = 'mobile-reregister-temp-v1';
const MOBILE_REREGISTER_DEFAULT_TITLE = 'Reconnect notifications';
const MOBILE_REREGISTER_DEFAULT_BODY = 'Open TZMC once to restore notifications on this device.';
const MOBILE_REREGISTER_DEFAULT_URL = '/subscribes/';
const MOBILE_REREGISTER_PUSH_URGENCY = 'high';
const MOBILE_REREGISTER_PUSH_TTL_SECONDS = 24 * 60 * 60;
const MOBILE_REREGISTER_SEND_CONCURRENCY = 20;
const MOBILE_REREGISTER_MAX_TRACKED_CAMPAIGNS = 20;
let subscriptionAuthRefreshState = {
    running: false,
    lastRunAt: 0,
    lastResult: null
};
let authRefreshSchedulerStarted = false;
const activeSessionIdByUser = new Map();
const authSessionRateLimitByIp = new Map();
const authSessionRateLimitByUser = new Map();
let mobileReregisterCampaignState = {
    running: false,
    lastRunAt: 0,
    lastResult: null,
    sentTargetsByCampaign: new Map()
};

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

    const collected = [];
    requestedUsers.forEach((userKey) => {
        const userSubscriptions = Array.isArray(deviceSubscriptionsByUser[userKey])
            ? deviceSubscriptionsByUser[userKey]
            : [];
        userSubscriptions.forEach((subscription) => {
            const normalized = normalizeSubscriptionRecord(
                subscription,
                userKey,
                subscription && subscription.type
            );
            if (normalized) {
                normalized.username = userKey;
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

function addUserToSet(targetSet, rawValue) {
    if (!targetSet) return;
    const normalized = normalizeUserCandidate(rawValue);
    if (normalized) {
        targetSet.add(normalized);
    }
}

function parseUsernamesInput(rawValue) {
    const values = [];
    if (Array.isArray(rawValue)) {
        values.push(...rawValue);
    } else if (typeof rawValue === 'string') {
        values.push(...rawValue.split(','));
    } else if (rawValue && typeof rawValue === 'object') {
        if (Array.isArray(rawValue.users)) {
            values.push(...rawValue.users);
        }
        if (Array.isArray(rawValue.usernames)) {
            values.push(...rawValue.usernames);
        }
    }

    const normalized = new Set();
    values.forEach((value) => addUserToSet(normalized, value));
    return Array.from(normalized);
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

function consumeRateLimitEntry(store, key, maxAttempts, windowMs) {
    const now = Date.now();
    const normalizedKey = String(key || '').trim().toLowerCase();
    if (!normalizedKey) {
        return { allowed: true, retryAfterSeconds: 0, remaining: maxAttempts };
    }

    const existing = Array.isArray(store.get(normalizedKey)) ? store.get(normalizedKey) : [];
    const threshold = now - windowMs;
    const recent = existing.filter((timestamp) => Number.isFinite(timestamp) && timestamp > threshold);
    if (recent.length >= maxAttempts) {
        const oldestActive = recent[0] || now;
        const retryAfterMs = Math.max(1000, windowMs - Math.max(0, now - oldestActive));
        store.set(normalizedKey, recent);
        return {
            allowed: false,
            retryAfterSeconds: Math.ceil(retryAfterMs / 1000),
            remaining: 0
        };
    }

    recent.push(now);
    store.set(normalizedKey, recent);
    return {
        allowed: true,
        retryAfterSeconds: 0,
        remaining: Math.max(0, maxAttempts - recent.length)
    };
}

function normalizeSameSiteValue(rawValue) {
    const normalized = String(rawValue || '').trim().toLowerCase();
    if (normalized === 'none') return 'None';
    if (normalized === 'strict') return 'Strict';
    return 'Lax';
}

function normalizeCookieHost(rawHost) {
    return normalizeHostValue(rawHost || '').replace(/\.+$/, '');
}

function shouldUseSecureSessionCookie(req) {
    if (!SESSION_COOKIE_SECURE) {
        return false;
    }
    const hostHeader = req && req.headers ? req.headers.host : '';
    const hostname = normalizeCookieHost(hostHeader);
    if (!hostname) {
        return true;
    }
    return !['localhost', '127.0.0.1', '::1'].includes(hostname);
}

function parseCookiesFromHeader(cookieHeader) {
    const result = {};
    String(cookieHeader || '')
        .split(';')
        .forEach((entry) => {
            const trimmed = String(entry || '').trim();
            if (!trimmed) return;
            const separatorIndex = trimmed.indexOf('=');
            if (separatorIndex <= 0) return;
            const key = trimmed.slice(0, separatorIndex).trim();
            if (!key) return;
            const value = trimmed.slice(separatorIndex + 1).trim();
            try {
                result[key] = decodeURIComponent(value);
            } catch (error) {
                result[key] = value;
            }
        });
    return result;
}

function encodeBase64Url(input) {
    return Buffer.from(String(input || ''), 'utf8')
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/g, '');
}

function decodeBase64Url(input) {
    const normalized = String(input || '').replace(/-/g, '+').replace(/_/g, '/');
    const remainder = normalized.length % 4;
    const padding = remainder === 0 ? '' : '='.repeat(4 - remainder);
    return Buffer.from(normalized + padding, 'base64').toString('utf8');
}

function signSessionPayload(payload) {
    if (!SESSION_SIGNING_SECRET) return '';
    return crypto
        .createHmac('sha256', SESSION_SIGNING_SECRET)
        .update(String(payload || ''))
        .digest('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/g, '');
}

function safeTimingCompare(leftValue, rightValue) {
    const leftBuffer = Buffer.from(String(leftValue || ''), 'utf8');
    const rightBuffer = Buffer.from(String(rightValue || ''), 'utf8');
    if (leftBuffer.length !== rightBuffer.length) {
        return false;
    }
    return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function generateRandomToken(byteLength = 24) {
    return crypto
        .randomBytes(byteLength)
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/g, '');
}

function createSessionToken(user) {
    const normalizedUser = normalizeUserCandidate(user);
    if (!normalizedUser || !SESSION_SIGNING_SECRET) {
        return null;
    }
    const sessionId = generateRandomToken(18);
    const csrfToken = generateRandomToken(24);
    const expiresAt = Date.now() + SESSION_COOKIE_TTL_MS;
    activeSessionIdByUser.set(normalizedUser, sessionId);
    const payload = encodeBase64Url(
        JSON.stringify({
            user: normalizedUser,
            expiresAt,
            sid: sessionId,
            csrfToken
        })
    );
    const signature = signSessionPayload(payload);
    if (!signature) {
        activeSessionIdByUser.delete(normalizedUser);
        return null;
    }
    return {
        token: `${payload}.${signature}`,
        expiresAt,
        sessionId,
        csrfToken
    };
}

function getSessionFromToken(rawToken) {
    const token = String(rawToken || '').trim();
    if (!token || !SESSION_SIGNING_SECRET) {
        return null;
    }

    const parts = token.split('.');
    if (parts.length !== 2) {
        return null;
    }
    const payloadEncoded = parts[0];
    const providedSignature = parts[1];
    const expectedSignature = signSessionPayload(payloadEncoded);
    if (!expectedSignature || !safeTimingCompare(providedSignature, expectedSignature)) {
        return null;
    }

    try {
        const parsed = JSON.parse(decodeBase64Url(payloadEncoded));
        const user = normalizeUserCandidate(parsed && parsed.user);
        const expiresAt = Number(parsed && parsed.expiresAt);
        const sessionId = String((parsed && parsed.sid) || '').trim();
        const csrfToken = String((parsed && parsed.csrfToken) || '').trim();
        if (!user || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
            return null;
        }
        if (!sessionId || !csrfToken) {
            return null;
        }

        const activeSessionId = String(activeSessionIdByUser.get(user) || '').trim();
        if (activeSessionId && activeSessionId !== sessionId) {
            return null;
        }
        if (!activeSessionId) {
            activeSessionIdByUser.set(user, sessionId);
        }
        return {
            user,
            expiresAt,
            sessionId,
            csrfToken
        };
    } catch (error) {
        return null;
    }
}

function setSessionCookie(res, req, tokenValue, expiresAt) {
    const sameSite = normalizeSameSiteValue(SESSION_COOKIE_SAME_SITE);
    const secure = shouldUseSecureSessionCookie(req);
    const maxAgeSeconds = Math.max(1, Math.floor((Number(expiresAt) - Date.now()) / 1000));
    const cookieParts = [
        `${SESSION_COOKIE_NAME}=${encodeURIComponent(String(tokenValue || ''))}`,
        'Path=/',
        'HttpOnly',
        `SameSite=${sameSite}`,
        `Max-Age=${maxAgeSeconds}`,
        `Expires=${new Date(Date.now() + maxAgeSeconds * 1000).toUTCString()}`
    ];
    if (secure) {
        cookieParts.push('Secure');
    }
    res.setHeader('Set-Cookie', cookieParts.join('; '));
}

function clearSessionCookie(res, req) {
    const sameSite = normalizeSameSiteValue(SESSION_COOKIE_SAME_SITE);
    const secure = shouldUseSecureSessionCookie(req);
    const cookieParts = [
        `${SESSION_COOKIE_NAME}=`,
        'Path=/',
        'HttpOnly',
        `SameSite=${sameSite}`,
        'Max-Age=0',
        'Expires=Thu, 01 Jan 1970 00:00:00 GMT'
    ];
    if (secure) {
        cookieParts.push('Secure');
    }
    res.setHeader('Set-Cookie', cookieParts.join('; '));
}

function extractSessionFromRequest(req) {
    const cookieMap = parseCookiesFromHeader(req && req.headers ? req.headers.cookie : '');
    return getSessionFromToken(cookieMap[SESSION_COOKIE_NAME]);
}

function extractSessionUserFromRequest(req) {
    const session = extractSessionFromRequest(req);
    return session && session.user ? session.user : '';
}

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

function buildGoogleSheetGetUrl(queryParams = {}, options = {}) {
    const url = new URL(GOOGLE_SHEET_URL);
    Object.entries(queryParams || {}).forEach(([key, value]) => {
        if (value === undefined || value === null) return;
        const normalizedValue = String(value).trim();
        if (!normalizedValue) return;
        url.searchParams.set(key, normalizedValue);
    });
    const token = String(
        Object.prototype.hasOwnProperty.call(options, 'token')
            ? (options && options.token)
            : APP_SERVER_TOKEN
    ).trim();
    if (token) {
        url.searchParams.set('token', token);
    }
    return url.toString();
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
                    subscriptionUrl: GOOGLE_SHEET_URL,
                    vapidPublicKey: vapidKeys.publicKey
                }
            });

            try {
                await webpush.sendNotification(
                    subscription,
                    pushPayload,
                    {
                        TTL: AUTH_REFRESH_PUSH_TTL_SECONDS,
                        headers: { Urgency: AUTH_REFRESH_PUSH_URGENCY },
                        timeout: 15000
                    }
                );
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
                    await webpush.sendNotification(
                        subscription,
                        pushPayload,
                        {
                            TTL: MOBILE_REREGISTER_PUSH_TTL_SECONDS,
                            headers: { Urgency: MOBILE_REREGISTER_PUSH_URGENCY },
                            timeout: 15000
                        }
                    );
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
        deviceSubscriptionsByUser = normalizeLocalDeviceSubscriptionsRegistry(
            (data.deviceSubscriptionsByUser && typeof data.deviceSubscriptionsByUser === 'object')
                ? data.deviceSubscriptionsByUser
                : {}
        );
        console.log('[STATE] Loaded persisted state.');
    } catch (err) {
        if (err.code !== 'ENOENT') {
            console.warn('[STATE] Failed to load state:', err.message);
        }
    }
}

async function persistState() {
    try {
        const payload = JSON.stringify({ unreadCounts, messageQueue, groups, deviceSubscriptionsByUser });
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

// Helper: Log status to Google Sheets
function logNotificationStatus(sender, recipient, messageShort, status, details, recipientAuthJson = '') {
    return fetchWithRetry(GOOGLE_SHEET_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            action: 'save_log',
            sender: sender || 'System',
            recipient: recipient,
            message: messageShort,
            status: status,
            details: details,
            recipientAuthJson: recipientAuthJson || ''
        })
    }, { timeoutMs: 10000, retries: 2 }).catch(err => {
        console.error('[LOG ERROR]', err.message);
        return null;
    });
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

    const requestedUsersSet = new Set(
        parseUsernamesInput(requestUserList).map(normalizeUserKey).filter(Boolean)
    );
    const normalizeLookupSubscriptions = (payload) => {
        const extracted = extractSubscriptionsFromSheetResponse(payload);
        if (!extracted.length) return [];
        return extracted.filter((subscription) => {
            const subscriptionUser = normalizeUserKey(
                subscription && (subscription.username || subscription.user)
            );
            if (!subscriptionUser) return false;
            if (!requestedUsersSet.size) return true;
            return requestedUsersSet.has(subscriptionUser);
        });
    };

    try {
        const response = await fetchWithRetry(
            buildGoogleSheetGetUrl({ usernames: requestUserList }),
            {},
            { timeoutMs: 12000, retries: 2, backoffMs: 500 }
        );
        const result = await response.json();
        const subscriptions = normalizeLookupSubscriptions(result);
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

app.get(['/auth/session', '/notify/auth/session'], (req, res) => {
    const user = normalizeUserCandidate(req.authUser);
    const authSession = req.authSession && typeof req.authSession === 'object' ? req.authSession : null;
    if (!user) {
        return res.json({ authenticated: false, user: null });
    }
    return res.json({
        authenticated: true,
        user,
        csrfToken: authSession && authSession.csrfToken ? authSession.csrfToken : null
    });
});

app.post(['/auth/session', '/notify/auth/session'], async (req, res) => {
    const payload = req.body && typeof req.body === 'object' ? req.body : {};
    const requestedUser = normalizeUserCandidate(payload.username || payload.user || payload.phone);
    if (!SESSION_USER_PATTERN.test(requestedUser)) {
        return res.status(400).json({ status: 'error', message: 'Invalid user' });
    }

    if (!SESSION_SIGNING_SECRET) {
        return res.status(500).json({ status: 'error', message: 'Session configuration missing' });
    }

    const clientIp = getClientIpAddress(req);
    const ipLimit = consumeRateLimitEntry(
        authSessionRateLimitByIp,
        clientIp,
        AUTH_SESSION_RATE_LIMIT_MAX_PER_IP,
        AUTH_SESSION_RATE_LIMIT_WINDOW_MS
    );
    const userLimit = consumeRateLimitEntry(
        authSessionRateLimitByUser,
        requestedUser,
        AUTH_SESSION_RATE_LIMIT_MAX_PER_USER,
        AUTH_SESSION_RATE_LIMIT_WINDOW_MS
    );
    if (!ipLimit.allowed || !userLimit.allowed) {
        const retryAfterSeconds = Math.max(ipLimit.retryAfterSeconds || 0, userLimit.retryAfterSeconds || 0, 1);
        res.setHeader('Retry-After', String(retryAfterSeconds));
        return res.status(429).json({
            status: 'error',
            message: 'Too many login attempts. Please try again later.',
            retryAfterSeconds
        });
    }

    try {
        if (AUTH_SESSION_REQUIRE_CONTACT_VERIFICATION) {
            const response = await fetchWithRetry(
                buildGoogleSheetGetUrl({ action: 'get_contacts', user: requestedUser }),
                {},
                { timeoutMs: 10000, retries: 1, backoffMs: 500 }
            );
            if (!response.ok) {
                return res.status(502).json({ status: 'error', message: 'Unable to verify user' });
            }
            const contactsPayload = await response.json();
            const users = Array.isArray(contactsPayload && contactsPayload.users) ? contactsPayload.users : [];
            if (!users.length) {
                return res.status(403).json({ status: 'error', message: 'Unauthorized user' });
            }
        }

        const sessionToken = createSessionToken(requestedUser);
        if (!sessionToken) {
            return res.status(500).json({ status: 'error', message: 'Failed to create session' });
        }

        setSessionCookie(res, req, sessionToken.token, sessionToken.expiresAt);
        return res.json({
            status: 'success',
            authenticated: true,
            user: requestedUser,
            expiresAt: sessionToken.expiresAt,
            csrfToken: sessionToken.csrfToken
        });
    } catch (error) {
        console.error('[AUTH SESSION] Failed to create session:', error && error.message ? error.message : error);
        return res.status(502).json({ status: 'error', message: 'Unable to verify user' });
    }
});

app.delete(['/auth/session', '/notify/auth/session'], (req, res) => {
    const authSession = req.authSession && typeof req.authSession === 'object' ? req.authSession : null;
    if (authSession && authSession.user) {
        const currentSessionId = String(activeSessionIdByUser.get(authSession.user) || '').trim();
        if (!currentSessionId || currentSessionId === String(authSession.sessionId || '')) {
            activeSessionIdByUser.delete(authSession.user);
        }
    }
    clearSessionCookie(res, req);
    return res.json({ status: 'success', authenticated: false });
});

app.post(['/register-device', '/notify/register-device'], (req, res) => {
    try {
        const payload = req.body && typeof req.body === 'object' ? req.body : {};
        const resolvedUser = resolveAuthorizedUser(req, payload.username || payload.user, { required: true });
        if (resolvedUser.error) {
            return res.status(resolvedUser.status).json({ status: 'error', message: resolvedUser.error });
        }
        const username = resolvedUser.user;

        const trackedSubscriptions = upsertLocalDeviceSubscriptionsFromRegistration({
            ...payload,
            username
        });
        if (!trackedSubscriptions) {
            return res.status(400).json({ status: 'error', message: 'Missing valid subscription payload' });
        }

        scheduleStateSave();
        res.json({
            status: 'success',
            username,
            trackedSubscriptions
        });
    } catch (error) {
        console.error('[REGISTER DEVICE] Failed:', error.message);
        res.status(500).json({ status: 'error', message: error.message });
    }
});
// --- RESET BADGE ENDPOINT ---
app.post(['/reset-badge', '/notify/reset-badge'], (req, res) => {
    const { user: requestedUser } = req.body || {};
    const resolvedUser = resolveAuthorizedUser(req, requestedUser, { required: false });
    if (resolvedUser.error) {
        return res.status(resolvedUser.status).json({ status: 'error', message: resolvedUser.error });
    }
    const user = resolvedUser.user;
    if (user) {
        // Reset count for this user
        unreadCounts[user] = 0;
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
// --- MESSAGE ACTION ENDPOINTS (EDIT / DELETE FOR EVERYONE) ---
app.post(['/delete', '/notify/delete'], async (req, res) => {
    try {
        const body = req.body || {};
        const resolvedSender = resolveAuthorizedUser(req, body.sender || body.user, { required: true });
        if (resolvedSender.error) {
            return res.status(resolvedSender.status).json({ error: resolvedSender.error });
        }
        const sender = resolvedSender.user;
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
        addToQueue(recipients, actionRecord);

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

        res.json({ status: 'success', details: result });
    } catch (e) {
        console.error('[DELETE ERROR]', e);
        res.status(500).json({ error: e.message });
    }
});

app.post(['/edit', '/notify/edit'], async (req, res) => {
    try {
        const body = req.body || {};
        const resolvedSender = resolveAuthorizedUser(req, body.sender || body.user, { required: true });
        if (resolvedSender.error) {
            return res.status(resolvedSender.status).json({ error: resolvedSender.error });
        }
        const sender = resolvedSender.user;
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
        addToQueue(recipients, actionRecord);

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
    const customData = message.data || {};
    const messageType = String(customData.type || '').trim().toLowerCase();
    const imageUrl = message.image || null;
    const finalSender = senderuser || 'System';
    const singlePerUser = Boolean(options.singlePerUser || messageType === 'reaction');
    const allowSecondAttempt = options.allowSecondAttempt !== false && messageType !== 'reaction';
    let msgTitle = message.title || 'Work Alert';
    let msgText = msgBody.shortText || 'New Notification';
    if (messageType === 'reaction') {
        const reactionGroupName = String(customData.groupName || message.title || finalSender || '').trim();
        msgTitle = reactionGroupName || 'Group';
        msgText = 'new reaction';
    }
    const logContent = msgText || messageType || 'System Notification';
    const messageId = options.messageId || message.messageId || generateMessageId();
    const shouldIncrementBadge = !options.skipBadge;
    const normalizedTargetUsers = Array.from(
        new Set(targetUsersArray.map(normalizeUserKey).filter(Boolean))
    );
    const targetUsersSet = new Set(normalizedTargetUsers);
    const normalizeAndFilterTargetSubscriptions = (subscriptions) => {
        const normalized = dedupeSubscriptionsByEndpoint(subscriptions || []);
        return normalized
            .map((subscription) => {
                const subscriptionUser = normalizeUserKey(
                    subscription && (subscription.username || subscription.user)
                );
                if (!subscriptionUser) return null;
                return {
                    ...subscription,
                    username: subscriptionUser
                };
            })
            .filter(Boolean)
            .filter((subscription) => {
                const subscriptionUser = normalizeUserKey(subscription && (subscription.username || subscription.user));
                return subscriptionUser && targetUsersSet.has(subscriptionUser);
            });
    };

    console.log(`[PUSH] Searching subs for: ${targetUsersArray.join(', ')} from ${finalSender}`);

    let rawSubscriptions = normalizeAndFilterTargetSubscriptions(
        await getSubscriptionFromSheet(targetUsersArray)
    );
    if (!rawSubscriptions.length) {
        // Force refresh once to avoid stale cache windows (common after iOS resubscribe).
        rawSubscriptions = normalizeAndFilterTargetSubscriptions(
            await getSubscriptionFromSheet(targetUsersArray, { forceRefresh: true })
        );
    }
    if (!rawSubscriptions.length) {
        // Some script deployments occasionally return an empty filtered lookup even though
        // valid endpoint rows still exist in the full subscription feed.
        const fallbackDiscovery = await getAllSubscriptionsForAuthRefresh({ usernames: targetUsersArray });
        const discoveredSubscriptions = Array.isArray(fallbackDiscovery.subscriptions)
            ? fallbackDiscovery.subscriptions
            : [];
        rawSubscriptions = normalizeAndFilterTargetSubscriptions(discoveredSubscriptions);
        if (rawSubscriptions.length) {
            const cacheKey = buildSubscriptionCacheKey(targetUsersArray);
            if (cacheKey) {
                subscriptionCache.set(cacheKey, { at: Date.now(), subscriptions: rawSubscriptions });
            }
        }
    }
    const localSubscriptions = getLocalDeviceSubscriptionsForUsers(targetUsersArray);
    if (localSubscriptions.length) {
        rawSubscriptions = normalizeAndFilterTargetSubscriptions([
            ...rawSubscriptions,
            ...localSubscriptions
        ]);
        const cacheKey = buildSubscriptionCacheKey(targetUsersArray);
        if (cacheKey && rawSubscriptions.length) {
            subscriptionCache.set(cacheKey, { at: Date.now(), subscriptions: rawSubscriptions });
        }
    }
    const recipientAuthJsonForLog = buildMobileSubscriptionAuthJsonForLog(
        targetUsersArray.join(','),
        rawSubscriptions || []
    );

    if (!rawSubscriptions.length) {
        logNotificationStatus(
            finalSender,
            targetUsersArray.join(','),
            logContent,
            'Failed',
            'No subscriptions found',
            recipientAuthJsonForLog
        );
        return { success: 0, failed: 0 };
    }

    const sendToSubscriptions = async (subscriptions, allowBadgeIncrement) => {
        const badgeCountByUser = new Map();
        return Promise.all(
            subscriptions.map(async (subscription) => {
                // Increment unread badge once per user, not once per device endpoint.
                const userKey = normalizeUserKey(
                    subscription.username || subscription.user
                );
                if (!userKey || (targetUsersSet.size && !targetUsersSet.has(userKey))) {
                    return {
                        ok: false,
                        username: userKey || 'unknown',
                        statusCode: 'SKIP',
                        message: 'Subscription user mismatch'
                    };
                }
                let currentCount = userKey ? (unreadCounts[userKey] || 0) : 0;
                if (shouldIncrementBadge && userKey) {
                    if (allowBadgeIncrement) {
                        if (badgeCountByUser.has(userKey)) {
                            currentCount = badgeCountByUser.get(userKey);
                        } else {
                            currentCount = currentCount + 1;
                            unreadCounts[userKey] = currentCount;
                            badgeCountByUser.set(userKey, currentCount);
                        }
                    } else {
                        currentCount = unreadCounts[userKey] || 0;
                    }
                }

                const clickUrl = `/subscribes/?chat=${encodeURIComponent(finalSender)}`;
                const payloadData = {
                    ...customData,
                    title: msgTitle,
                    body: msgText || 'New Notification',
                    badge: 'https://www.tzmc.co.il/subscribes/assets/icon-192.png',
                    icon: 'https://www.tzmc.co.il/subscribes/assets/icon-192.png',
                    requireInteraction: true,
                    image: imageUrl,
                    url: clickUrl,
                    user: userKey,
                    sender: finalSender,
                    messageId: messageId
                };
                if (shouldIncrementBadge && userKey) {
                    payloadData.badgeCount = currentCount;
                }

                const payload = JSON.stringify({
                    data: {
                        ...payloadData
                    }
                });

                try {
                    const pushOptions = {
                        TTL: 604800,
                        headers: { 'Urgency': 'high' },
                        timeout: 15000
                    };
                    await webpush.sendNotification(subscription, payload, pushOptions);
                    return {
                        ok: true,
                        username: subscription.username || userKey || 'unknown',
                        badge: currentCount
                    };
                } catch (err) {
                    const statusCode = err.statusCode || 'N/A';
                    if (statusCode === 404 || statusCode === 410) {
                        pruneSubscriptionCacheEndpoint(subscription.endpoint);
                    }
                    return {
                        ok: false,
                        username: subscription.username || userKey || 'unknown',
                        statusCode,
                        message: err.message
                    };
                }
            })
        );
    };

    let uniqueSubscriptions = normalizeAndFilterTargetSubscriptions(rawSubscriptions);
    if (singlePerUser) {
        const oneSubscriptionPerUser = new Map();
        uniqueSubscriptions.forEach((subscription) => {
            const userKey = normalizeUserKey(
                subscription.username || subscription.user || ''
            );
            if (!userKey) return;
            // Keep latest observed subscription per user to prevent duplicate pushes.
            oneSubscriptionPerUser.set(userKey, subscription);
        });
        uniqueSubscriptions = Array.from(oneSubscriptionPerUser.values());
    }
    let sendResults = await sendToSubscriptions(uniqueSubscriptions, true);

    let successCount = 0;
    let failCount = 0;
    const executionLogs = [];
    const appendResultsToLogs = (results) => {
        for (const result of results) {
            if (result.ok) {
                successCount++;
                executionLogs.push(`Device (${result.username}): ✅ Delivered (Badge: ${result.badge})`);
            } else {
                failCount++;
                executionLogs.push(`Device (${result.username}): ❌ Failed [${result.statusCode}]`);
                console.error(`[PUSH FAIL] ${result.username}:`, result.message);
            }
        }
    };

    appendResultsToLogs(sendResults);

    if (successCount === 0 && allowSecondAttempt) {
        const cacheKey = buildSubscriptionCacheKey(targetUsersArray);
        if (cacheKey) {
            subscriptionCache.delete(cacheKey);
        }

        const refreshedRawSubscriptions = await getSubscriptionFromSheet(targetUsersArray, { forceRefresh: true });
        const refreshedUniqueSubscriptions = normalizeAndFilterTargetSubscriptions([
            ...(Array.isArray(refreshedRawSubscriptions) ? refreshedRawSubscriptions : []),
            ...getLocalDeviceSubscriptionsForUsers(targetUsersArray)
        ]);
        if (refreshedUniqueSubscriptions.length) {
            const existingEndpoints = new Set(uniqueSubscriptions.map((sub) => sub.endpoint));
            const retryTargets = refreshedUniqueSubscriptions.filter(
                (sub) => !existingEndpoints.has(sub.endpoint)
            );
            const effectiveRetryTargets = retryTargets.length ? retryTargets : refreshedUniqueSubscriptions;

            const retryResults = await sendToSubscriptions(effectiveRetryTargets, false);
            appendResultsToLogs(retryResults);
        }
    }

    scheduleStateSave();

    // Log to Sheet
    const fullReport = executionLogs.join('\n');
    let finalStatus = successCount > 0 ? 'Sent' : 'Failed';
    logNotificationStatus(
        finalSender,
        targetUsersArray.join(','),
        logContent,
        finalStatus,
        fullReport,
        recipientAuthJsonForLog
    );

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

app.get(['/contacts', '/notify/contacts', '/contacts/:user', '/notify/contacts/:user'], async (req, res) => {
    const requestedUser = normalizeUserKey(
        (req.query && req.query.user) ||
        (req.params && req.params.user) ||
        ''
    );
    const resolvedUser = resolveAuthorizedUser(req, requestedUser, { required: true });
    if (resolvedUser.error) {
        return res.status(resolvedUser.status).json({ users: [], error: resolvedUser.error });
    }
    const user = resolvedUser.user;
    if (!user) {
        return res.status(400).json({ users: [], error: 'Missing user' });
    }

    try {
        const response = await fetchWithRetry(
            buildGoogleSheetGetUrl({ action: 'get_contacts', user }),
            {},
            { timeoutMs: 10000, retries: 2 }
        );
        if (!response.ok) {
            return res.status(response.status).json({ users: [] });
        }
        const payload = await response.json();
        const users = Array.isArray(payload && payload.users) ? payload.users : [];
        return res.json({
            result: 'success',
            users
        });
    } catch (error) {
        console.error('[CONTACTS] Failed to load contacts:', error && error.message ? error.message : error);
        return res.status(502).json({ users: [], error: 'Contacts fetch failed' });
    }
});

app.get(['/groups', '/notify/groups'], (req, res) => {
    const requestedUser = req.query.user ? normalizeUserKey(req.query.user) : '';
    const resolvedUser = resolveAuthorizedUser(req, requestedUser, { required: true });
    if (resolvedUser.error) {
        return res.status(resolvedUser.status).json({ groups: [], error: resolvedUser.error });
    }
    const user = resolvedUser.user;
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
    const requestedUser = req.query.user ? normalizeUserKey(req.query.user) : '';
    const resolvedUser = resolveAuthorizedUser(req, requestedUser, { required: true });
    if (resolvedUser.error) {
        return res.status(resolvedUser.status).json({ messages: [] });
    }
    const user = resolvedUser.user;
    
    if (!user) return res.json({ messages: [] });

    // Check mailbox (using lowercase key)
    if (messageQueue[user] && messageQueue[user].length > 0) {
        const mailbox = Array.isArray(messageQueue[user]) ? messageQueue[user] : [];
        const waitingMessages = mailbox.filter((message) => {
            if (!message || typeof message !== 'object') {
                return true;
            }
            const recipient = normalizeUserKey(message.recipient || message.user || '');
            return !recipient || recipient === user;
        });
        const droppedCount = mailbox.length - waitingMessages.length;
        
        // Clear mailbox after picking up
        messageQueue[user] = []; 
        scheduleStateSave();
        
        if (droppedCount > 0) {
            console.warn(`[POLLING] Dropped ${droppedCount} mismatched queued messages for ${user}`);
        }
        console.log(`[POLLING] Delivered ${waitingMessages.length} msgs to ${user}`);
        return res.json({ messages: waitingMessages });
    }

    return res.json({ messages: [] });
});

// ======================================================
// [NEW] SSE STREAM (REAL-TIME)
// ======================================================
app.get(['/stream', '/notify/stream'], (req, res) => {
    const requestedUser = req.query.user ? String(req.query.user).trim().toLowerCase() : '';
    const resolvedUser = resolveAuthorizedUser(req, requestedUser, { required: true });
    if (resolvedUser.error) {
        return res.status(resolvedUser.status).json({ error: resolvedUser.error });
    }
    const user = resolvedUser.user || null;
    if (!user) {
        return res.status(400).json({ error: 'Missing user' });
    }

    res.set({
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, Cache-Control, Pragma, Last-Event-ID, X-CSRF-Token'
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

app.post(['/reply', '/notify/reply'], async (req, res) => {
    try {
        const {
            user: requestedUser,
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
            membersToNotify,
            replyToMessageId,
            replyToSender,
            replyToSenderName,
            replyToBody,
            replyToImageUrl,
            forwarded,
            forwardedFrom,
            forwardedFromName
        } = req.body;
        const resolvedSender = resolveAuthorizedUser(req, requestedUser, { required: true });
        if (resolvedSender.error) {
            return res.status(resolvedSender.status).json({ error: resolvedSender.error });
        }
        const user = resolvedSender.user;
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
        const notificationExtraData = {
            ...(isGroup ? {
                groupId,
                groupName: normalizedGroupName,
                groupMembers,
                groupCreatedBy,
                groupUpdatedAt,
                groupType: groupRecord ? groupRecord.type : normalizeGroupType(req.body.groupType || 'group'),
                groupMessageText: shortText,
                groupSenderName: senderLabel
            } : {}),
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
            groupSenderName: senderLabel,
            ...messageMetadata
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
        const recipientByKey = new Map();
        membersToNotify.forEach(member => {
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
            groupUpdatedAt: resolvedGroupUpdatedAt,
            groupType: resolvedGroupType,
            timestamp: Date.now()
        };
        addToQueue(dedupedRecipients, groupUpdateRecord);

        const result = await sendPushNotificationToUser(dedupedRecipients, notificationData, groupId, { messageId, skipBadge: true });
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
        const resolvedReactor = resolveAuthorizedUser(req, reactor, { required: true });
        if (resolvedReactor.error) {
            return res.status(resolvedReactor.status).json({ error: resolvedReactor.error });
        }
        const normalizedReactor = resolvedReactor.user;
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

        const result = await sendPushNotificationToUser(membersToNotify, notificationData, groupId, {
            messageId: reactionId,
            skipBadge: true,
            singlePerUser: true,
            allowSecondAttempt: false
        });
        res.json({ status: 'success', details: result });
    } catch (err) {
        console.error('[REACTION ERROR]', err);
        res.status(500).json({ error: err.message });
    }
});

app.post(['/read', '/notify/read'], async (req, res) => {
    try {
        const { reader: requestedReader, sender, messageIds, readAt } = req.body;
        if (!requestedReader || !sender || !Array.isArray(messageIds) || messageIds.length === 0) {
            return res.status(400).json({ status: 'error', message: 'Missing fields' });
        }
        const resolvedReader = resolveAuthorizedUser(req, requestedReader, { required: true });
        if (resolvedReader.error) {
            return res.status(resolvedReader.status).json({ status: 'error', message: resolvedReader.error });
        }

        const normalizedReader = resolvedReader.user;
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
        addToQueue(normalizedSender, {
            type: 'read-receipt',
            messageIds: uniqueMessageIds,
            readAt: effectiveReadAt,
            sender: normalizedReader,
            timestamp: Date.now()
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
                const targetUsers = parseUsernamesInput(msg && msg.recipient);
                const senderName = String((msg && msg.sender) || 'System').trim() || 'System';
                const bodyText = String((msg && msg.content) || '').trim();
                if (!targetUsers.length || !bodyText) {
                    continue;
                }
                
                const messageId = (msg && msg.messageId) ? String(msg.messageId).trim() : generateMessageId();
                const notificationData = {
                    messageId,
                    title: `Message from ${senderName}`,
                    body: {
                        shortText: bodyText,
                        longText: bodyText
                    }
                };

                // 1. Send Push Notification (Handles all devices)
                await sendPushNotificationToUser(targetUsers, notificationData, senderName, { messageId });
                
                // 2. Add to Polling Queue
                const pollingMessage = {
                    messageId,
                    sender: senderName,
                    body: bodyText,
                    timestamp: Date.now(),
                    imageUrl: null
                };
                addToQueue(targetUsers, pollingMessage);
            }
        }
    } catch (error) {
        console.error('[QUEUE ERROR] Failed to check sheet:', error.message);
    }
}

// Start the Timer (10,000 ms = 10 seconds)
setInterval(checkOutgoingQueue, 10000);
startSubscriptionAuthRefreshScheduler();

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
