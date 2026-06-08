'use strict';

/**
 * Accreditation AI Agent controller.
 *
 * Reads PDF and image files from uploads/Accreditation/, extracts text from
 * PDFs via pdf-parse v2 (PDFParse class), sends images as inline Gemini parts,
 * and returns a natural-language answer together with the list of source files.
 *
 * Environment variable required:
 *   GEMINI_API_KEY — Google Gemini API key.
 */

const fs = require('fs');
const path = require('path');
const { createRequire } = require('module');

function loadOptionalPackage(packageName) {
    try {
        return require(packageName);
    } catch (_err) {
        try {
            const requireFromCwd = createRequire(path.join(process.cwd(), 'package.json'));
            return requireFromCwd(packageName);
        } catch (_cwdErr) {
            return null;
        }
    }
}

// @google/generative-ai is optional — loaded lazily so startup succeeds even
// when the package is not installed.
let GoogleGenerativeAI = null;
{
    const geminiPkg = loadOptionalPackage('@google/generative-ai');
    if (geminiPkg && typeof geminiPkg.GoogleGenerativeAI === 'function') {
        ({ GoogleGenerativeAI } = geminiPkg);
    }
}

// pdf-parse v2 exports { PDFParse } class (not a callable function).
let PDFParse = null;
{
    const pdfParsePkg = loadOptionalPackage('pdf-parse');
    if (pdfParsePkg && typeof pdfParsePkg.PDFParse === 'function') {
        ({ PDFParse } = pdfParsePkg);
    }
}

// ── Constants ────────────────────────────────────────────────────────────────

/** Maximum characters extracted per PDF file. */
const MAX_CHARS_PER_FILE = 3000;

/** Maximum total characters sent to Gemini across all PDF files. */
const MAX_TOTAL_CHARS = 30000;

/** Image extensions supported for inline Gemini multimodal input. */
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp']);

/** Maximum number of images sent to Gemini per request. */
const MAX_IMAGES = 10;

/** Maximum image file size (bytes) sent inline to Gemini. */
const MAX_IMAGE_SIZE_BYTES = 2 * 1024 * 1024; // 2 MB

/** Gemini model to use. */
const GEMINI_MODEL = 'gemini-1.5-flash';

/** Rate-limit: max requests per user per window. */
const RATE_LIMIT_MAX = 10;

/** Rate-limit window in milliseconds. */
const RATE_LIMIT_WINDOW_MS = 60 * 1000;

// ── In-memory PDF text cache ─────────────────────────────────────────────────

/**
 * Cache: filename → extracted text.
 * Invalidated whenever the Accreditation directory changes.
 * @type {Map<string, string>}
 */
const pdfTextCache = new Map();
let cacheWatcher = null;
let warnedMissingPdfParse = false;

/**
 * Starts watching the Accreditation directory for changes and clears
 * the PDF text cache whenever a file is added, removed, or modified.
 *
 * @param {string} accreditationDir
 */
function startCacheWatcher(accreditationDir) {
    if (cacheWatcher) return;
    try {
        cacheWatcher = fs.watch(accreditationDir, () => {
            pdfTextCache.clear();
        });
        cacheWatcher.on('error', () => {
            // Non-fatal — cache will still be used, just not invalidated automatically.
        });
    } catch (_e) {
        // Directory may not exist yet at startup; that's fine.
    }
}

// ── PDF extraction ────────────────────────────────────────────────────────────

/**
 * Extracts text from a single PDF file using pdf-parse v2 PDFParse class,
 * capped at MAX_CHARS_PER_FILE characters.
 *
 * @param {string} filePath
 * @param {string} filename  Used as the cache key.
 * @returns {Promise<string>}
 */
async function extractPdfText(filePath, filename) {
    if (pdfTextCache.has(filename)) {
        return pdfTextCache.get(filename);
    }
    if (!PDFParse) {
        if (!warnedMissingPdfParse) {
            warnedMissingPdfParse = true;
            console.warn('[ACCREDITATION-AGENT] pdf-parse is unavailable; continuing without PDF text extraction');
        }
        return '';
    }
    try {
        const buffer = await fs.promises.readFile(filePath);
        const parser = new PDFParse({ data: buffer });
        const data = await parser.getText();
        await parser.destroy().catch((err) => console.warn(`[ACCREDITATION-AGENT] PDF parser cleanup failed: ${err.message}`));
        const text = (data.text || '').slice(0, MAX_CHARS_PER_FILE).trim();
        pdfTextCache.set(filename, text);
        return text;
    } catch (err) {
        console.warn(`[ACCREDITATION-AGENT] Failed to parse ${filename}: ${err.message}`);
        return '';
    }
}

// ── Image helpers ─────────────────────────────────────────────────────────────

/**
 * Returns the MIME type for a given image file extension.
 *
 * @param {string} ext  e.g. '.jpg'
 * @returns {string}
 */
function imageMimeType(ext) {
    const map = {
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.png': 'image/png',
        '.gif': 'image/gif',
        '.webp': 'image/webp',
    };
    return map[ext] || 'image/jpeg';
}

/**
 * Reads an image file and returns an inline Gemini part, or null if the
 * file is too large or cannot be read.
 *
 * @param {string} filePath
 * @param {string} filename
 * @returns {Promise<{inlineData: {mimeType: string, data: string}}|null>}
 */
async function buildImagePart(filePath, filename) {
    try {
        const stat = await fs.promises.stat(filePath); // lgtm[js/missing-rate-limiting]
        if (stat.size > MAX_IMAGE_SIZE_BYTES) {
            console.warn(`[ACCREDITATION-AGENT] Skipping large image ${filename} (${stat.size} bytes)`);
            return null;
        }
        const buffer = await fs.promises.readFile(filePath); // lgtm[js/missing-rate-limiting]
        const ext = path.extname(filename).toLowerCase();
        return {
            inlineData: {
                mimeType: imageMimeType(ext),
                data: buffer.toString('base64'),
            },
        };
    } catch (err) {
        console.warn(`[ACCREDITATION-AGENT] Failed to read image ${filename}: ${err.message}`);
        return null;
    }
}

// ── Gemini prompt builder ─────────────────────────────────────────────────────

/**
 * Builds the prompt sent to Gemini.
 *
 * @param {Array<{name: string, text: string}>} docs
 * @param {number} imageCount  Number of inline images included in the request.
 * @param {string} userQuestion
 * @returns {string}
 */
function buildPrompt(docs, imageCount, userQuestion) {
    const docsSection = docs.length > 0
        ? docs
            .map(({ name, text }) => `[FILE: ${name}]\n${text || '(no extractable text)'}`)
            .join('\n\n---\n\n')
        : '';

    const imageNote = imageCount > 0
        ? `\n\nNote: ${imageCount} image file(s) from the Accreditation folder are also provided as visual context above.`
        : '';

    return `You are an accreditation assistant. Your job is to answer questions based \
only on the accreditation documents listed below. When answering, mention the \
file(s) you drew the information from.
${docsSection ? `\n=== DOCUMENTS ===\n${docsSection}` : ''}${imageNote}

=== USER QUESTION ===
${userQuestion}

Answer in the same language the user used for the question. If the question is \
in Hebrew, answer in Hebrew. Provide a concise, accurate summary and list the \
relevant file names at the end.`;
}

// ── Controller factory ────────────────────────────────────────────────────────

/**
 * Creates the accreditation-agent route handler.
 *
 * @param {object} options
 * @param {string} options.uploadDir   Root uploads directory (e.g. `__dirname + '/uploads'`).
 * @param {Function} options.consumeRateLimitEntry  Rate-limit helper from server.js.
 * @param {Function} options.normalizeUserKey  User-key normaliser from server.js.
 * @returns {{ registerAccreditationAgentRoutes: Function }}
 */
function createAccreditationAgentController({ uploadDir, consumeRateLimitEntry, normalizeUserKey }) {
    const accreditationDir = path.join(uploadDir, 'Accreditation');
    startCacheWatcher(accreditationDir);

    const rateLimitStore = new Map();

    /**
     * Express middleware that applies per-user rate limiting.
     * Extracted as a standalone middleware so that static analysis tools
     * can recognise the rate-limit guard before the file-system handler.
     */
    function rateLimitMiddleware(req, res, next) {
        const user = normalizeUserKey(req.resolvedUser || '');
        if (!user) {
            return res.status(401).json({ error: 'Unauthorized' });
        }
        const rateCheck = consumeRateLimitEntry(rateLimitStore, user, RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS);
        if (!rateCheck.allowed) {
            return res.status(429).json({
                error: `Rate limited. Retry after ${rateCheck.retryAfterSeconds}s`,
            });
        }
        return next();
    }

    /**
     * POST /accreditation/ask — main handler.
     */
    async function handleAsk(req, res) {
        const user = normalizeUserKey(req.resolvedUser || '');
        if (!user) {
            return res.status(401).json({ error: 'Unauthorized' });
        }

        // ── Validate request body ─────────────────────────────────────────
        const question = typeof req.body.question === 'string' ? req.body.question.trim() : '';
        if (!question) {
            return res.status(400).json({ error: 'question is required' });
        }
        if (question.length > 1000) {
            return res.status(400).json({ error: 'question is too long (max 1000 characters)' });
        }

        // ── Gemini API key ────────────────────────────────────────────────
        if (!GoogleGenerativeAI) {
            return res.status(503).json({ error: 'AI service is not available (packages not installed)' });
        }
        const apiKey = (process.env.GEMINI_API_KEY || 'AIzaSyAuRYn0Kcbon6T6WZ1owhPE-NHnORjzvIM').trim();
        if (!apiKey) {
            console.error('[ACCREDITATION-AGENT] GEMINI_API_KEY is not set');
            return res.status(503).json({ error: 'AI service is not configured' });
        }

        // ── Read files from Accreditation directory ───────────────────────
        // Rate limiting is enforced by rateLimitMiddleware earlier in the chain.
        let allFilenames = [];
        try {
            allFilenames = await fs.promises.readdir(accreditationDir); // lgtm[js/missing-rate-limiting]
        } catch (_e) {
            // Directory does not exist or is not readable — return empty result.
        }

        const pdfFilenames = allFilenames.filter((f) => f.toLowerCase().endsWith('.pdf'));
        const imgFilenames = allFilenames.filter((f) =>
            IMAGE_EXTENSIONS.has(path.extname(f).toLowerCase()),
        );

        if (pdfFilenames.length === 0 && imgFilenames.length === 0) {
            return res.json({
                answer: 'לא נמצאו מסמכים בתיקיית האקרדיטציה.',
                relevantFiles: [],
            });
        }

        // Extract PDF text, accumulate up to MAX_TOTAL_CHARS total.
        const docs = [];
        let totalChars = 0;
        for (const filename of pdfFilenames) {
            if (totalChars >= MAX_TOTAL_CHARS) break;
            const filePath = path.join(accreditationDir, filename);
            const text = await extractPdfText(filePath, filename);
            const remaining = MAX_TOTAL_CHARS - totalChars;
            const trimmedText = text.slice(0, remaining);
            totalChars += trimmedText.length;
            docs.push({ name: filename, text: trimmedText });
        }

        // Build inline image parts for Gemini multimodal input.
        const imageParts = [];
        const includedImageNames = [];
        for (const filename of imgFilenames.slice(0, MAX_IMAGES)) {
            const filePath = path.join(accreditationDir, filename);
            const part = await buildImagePart(filePath, filename);
            if (part) {
                imageParts.push(part);
                includedImageNames.push(filename);
            }
        }

        // ── Call Gemini ───────────────────────────────────────────────────
        let answerText = '';
        try {
            const genAI = new GoogleGenerativeAI(apiKey);
            const model = genAI.getGenerativeModel({ model: GEMINI_MODEL });
            const prompt = buildPrompt(docs, imageParts.length, question);
            // Build multimodal content: text prompt first, then inline images.
            const contentParts = [{ text: prompt }, ...imageParts];
            const result = await model.generateContent(contentParts);
            answerText = result.response.text().trim();
        } catch (err) {
            // Extract a safe, human-readable reason from the Gemini SDK error.
            // The SDK wraps Google API errors in err.message — strip any echoed
            // API key from the message before forwarding it to the client.
            const rawMessage = (err && (err.message || String(err))) || 'Unknown error';
            const safeMessage = rawMessage.replace(/key=[A-Za-z0-9_-]{10,}/g, 'key=***');
            const statusCode = (err && err.status) || (err && err.statusCode) || null;
            console.error('[ACCREDITATION-AGENT] Gemini API error' + (statusCode ? ` (HTTP ${statusCode})` : '') + ':', rawMessage);
            return res.status(502).json({
                error: `AI service error: ${safeMessage}`,
            });
        }

        // ── Build relevant file list ──────────────────────────────────────
        // For PDFs: use exact filename match against the model's answer text.
        const mentionedPdfs = docs.filter(({ name }) => {
            const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            return new RegExp(`\\b${escaped}\\b`, 'i').test(answerText);
        });
        const relevantPdfs = (mentionedPdfs.length > 0 ? mentionedPdfs : docs).map(({ name }) => ({
            name,
            url: `/notify/uploads/Accreditation/${encodeURIComponent(name)}`,
        }));

        // For images: always include every image that was sent to Gemini.
        const relevantImages = includedImageNames.map((name) => ({
            name,
            url: `/notify/uploads/Accreditation/${encodeURIComponent(name)}`,
        }));

        const relevantFiles = [...relevantPdfs, ...relevantImages];

        return res.json({ answer: answerText, relevantFiles });
    }

    /**
     * Registers the accreditation-agent routes on the given Express app.
     *
     * @param {object} app  Express app instance.
     * @param {Function} requireAuthorizedUser  Auth middleware factory from server.js.
     */
    function registerAccreditationAgentRoutes(app, requireAuthorizedUser) {
        app.post(
            ['/accreditation/ask', '/notify/accreditation/ask'],
            requireAuthorizedUser({
                required: true,
                candidateKeys: ['user'],
                onError: (_req, res, resolution) =>
                    res.status(resolution.status).json({ error: resolution.error }),
            }),
            rateLimitMiddleware,
            handleAsk,
        );
    }

    return { registerAccreditationAgentRoutes };
}

module.exports = { createAccreditationAgentController };
