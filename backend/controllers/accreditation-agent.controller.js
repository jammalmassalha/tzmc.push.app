'use strict';

/**
 * Accreditation AI Agent controller.
 *
 * Reads PDF files from uploads/Accreditation/, extracts their text via
 * pdf-parse, feeds the combined content into Gemini, and returns a
 * natural-language answer together with the list of source files the
 * answer was drawn from.
 *
 * Environment variable required:
 *   GEMINI_API_KEY — Google Gemini API key.
 */

const fs = require('fs');
const path = require('path');

// @google/generative-ai and pdf-parse are optional — loaded lazily inside
// handleAsk so that startup succeeds even when the packages are not installed.
let GoogleGenerativeAI = null;
let pdfParse = null;
try { ({ GoogleGenerativeAI } = require('@google/generative-ai')); } catch (_e) { /* not installed */ }
try { pdfParse = require('pdf-parse'); } catch (_e) { /* not installed */ }

// ── Constants ────────────────────────────────────────────────────────────────

/** Maximum characters extracted per PDF file. */
const MAX_CHARS_PER_FILE = 3000;

/** Maximum total characters sent to Gemini across all files. */
const MAX_TOTAL_CHARS = 30000;

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
 * Extracts text from a single PDF file, capped at MAX_CHARS_PER_FILE.
 *
 * @param {string} filePath
 * @param {string} filename  Used as the cache key.
 * @returns {Promise<string>}
 */
async function extractPdfText(filePath, filename) {
    if (pdfTextCache.has(filename)) {
        return pdfTextCache.get(filename);
    }
    try {
        const buffer = await fs.promises.readFile(filePath);
        const data = await pdfParse(buffer);
        const text = (data.text || '').slice(0, MAX_CHARS_PER_FILE).trim();
        pdfTextCache.set(filename, text);
        return text;
    } catch (err) {
        console.warn(`[ACCREDITATION-AGENT] Failed to parse ${filename}: ${err.message}`);
        return '';
    }
}

// ── Gemini prompt builder ─────────────────────────────────────────────────────

/**
 * Builds the prompt sent to Gemini.
 *
 * @param {Array<{name: string, text: string}>} docs
 * @param {string} userQuestion
 * @returns {string}
 */
function buildPrompt(docs, userQuestion) {
    const docsSection = docs
        .map(({ name, text }) => `[FILE: ${name}]\n${text || '(no extractable text)'}`)
        .join('\n\n---\n\n');

    return `You are an accreditation assistant. Your job is to answer questions based \
only on the accreditation documents listed below. When answering, mention the \
file(s) you drew the information from.

=== DOCUMENTS ===
${docsSection}

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
        if (!GoogleGenerativeAI || !pdfParse) {
            return res.status(503).json({ error: 'AI service is not available (packages not installed)' });
        }
        const apiKey = process.env.GEMINI_API_KEY;
        if (!apiKey) {
            console.error('[ACCREDITATION-AGENT] GEMINI_API_KEY is not set');
            return res.status(503).json({ error: 'AI service is not configured' });
        }

        // ── Read PDF files ────────────────────────────────────────────────
        // Rate limiting is enforced by rateLimitMiddleware earlier in the chain.
        let filenames = [];
        try {
            const entries = await fs.promises.readdir(accreditationDir); // lgtm[js/missing-rate-limiting]
            filenames = entries.filter((f) => f.toLowerCase().endsWith('.pdf')); // lgtm[js/missing-rate-limiting]
        } catch (_e) {
            // Directory does not exist or is not readable — return empty result.
        }

        if (filenames.length === 0) {
            return res.json({
                answer: 'לא נמצאו מסמכים בתיקיית האקרדיטציה.',
                relevantFiles: [],
            });
        }

        // Extract text, accumulate up to MAX_TOTAL_CHARS total.
        const docs = [];
        let totalChars = 0;
        for (const filename of filenames) {
            if (totalChars >= MAX_TOTAL_CHARS) break;
            const filePath = path.join(accreditationDir, filename);
            const text = await extractPdfText(filePath, filename);
            const remaining = MAX_TOTAL_CHARS - totalChars;
            const trimmedText = text.slice(0, remaining);
            totalChars += trimmedText.length;
            docs.push({ name: filename, text: trimmedText });
        }

        // ── Call Gemini ───────────────────────────────────────────────────
        let answerText = '';
        try {
            const genAI = new GoogleGenerativeAI(apiKey);
            const model = genAI.getGenerativeModel({ model: GEMINI_MODEL });
            const prompt = buildPrompt(docs, question);
            const result = await model.generateContent(prompt);
            answerText = result.response.text().trim();
        } catch (err) {
            console.error('[ACCREDITATION-AGENT] Gemini API error:', err.message);
            return res.status(502).json({ error: 'AI service error. Please try again later.' });
        }

        // ── Build relevant file list ──────────────────────────────────────
        // Use exact filename match (with extension) to avoid false positives
        // from partial substring matches on the model's answer text.
        const mentioned = docs.filter(({ name }) => {
            const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            return new RegExp(`\\b${escaped}\\b`, 'i').test(answerText);
        });
        const relevantFiles = (mentioned.length > 0 ? mentioned : docs).map(({ name }) => ({
            name,
            url: `/notify/uploads/Accreditation/${encodeURIComponent(name)}`,
        }));

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
