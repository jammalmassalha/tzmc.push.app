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
const MAX_CHARS_PER_FILE = 100000000;

/** Embedding model used to build the in-memory vector store. */
const EMBEDDING_MODEL = 'text-embedding-004';

/** Chunk size for PDF text before embedding. */
const CHUNK_SIZE_CHARS = 1200;

/** Overlap size between adjacent chunks. */
const CHUNK_OVERLAP_CHARS = 200;

/** Maximum number of text chunks sent to Gemini per question. */
const MAX_CHUNKS_IN_PROMPT = 20;

/** Maximum number of PDFs sent inline to Gemini per request. */
const MAX_INLINE_PDFS = 10;

/** Maximum PDF file size (bytes) sent inline to Gemini. */
const MAX_INLINE_PDF_SIZE_BYTES = 8 * 1024 * 1024; // 8 MB

/** Image extensions supported for inline Gemini multimodal input. */
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp']);

/** Maximum number of images sent to Gemini per request. */
const MAX_IMAGES = 10;

/** Maximum image file size (bytes) sent inline to Gemini. */
const MAX_IMAGE_SIZE_BYTES = 2 * 1024 * 1024; // 2 MB

/** Gemini model to use. */
const GEMINI_MODEL = 'gemini-2.5-flash';

/** Rate-limit: max requests per user per window. */
const RATE_LIMIT_MAX = 120;

/** Rate-limit window in milliseconds. */
const RATE_LIMIT_WINDOW_MS = 2 * 60 * 1000;

// ── In-memory PDF text cache ─────────────────────────────────────────────────

/**
 * Cache: filename → extracted text.
 * Invalidated whenever the Accreditation directory changes.
 * @type {Map<string, string>}
 */
const pdfTextCache = new Map();
/**
 * Cache: filename → { mtimeMs, size, chunks } where chunks are embedded
 * document chunks for vector retrieval.
 * @type {Map<string, {mtimeMs: number, size: number, chunks: Array<{name: string, text: string, embedding: number[]}>}>}
 */
const pdfVectorCache = new Map();
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
            pdfVectorCache.clear();
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
 * Splits text into overlapping chunks suitable for embeddings.
 *
 * @param {string} text
 * @returns {string[]}
 */
function splitIntoChunks(text) {
    const clean = (text || '').trim();
    if (!clean) return [];
    if (clean.length <= CHUNK_SIZE_CHARS) return [clean];

    const chunks = [];
    const chunkOverlap = CHUNK_OVERLAP_CHARS >= CHUNK_SIZE_CHARS
        ? Math.max(0, CHUNK_SIZE_CHARS - 1)
        : CHUNK_OVERLAP_CHARS;
    const step = Math.max(1, CHUNK_SIZE_CHARS - chunkOverlap);
    for (let start = 0; start < clean.length; start += step) {
        const chunk = clean.slice(start, start + CHUNK_SIZE_CHARS).trim();
        if (!chunk) continue;
        chunks.push(chunk);
        if (start + CHUNK_SIZE_CHARS >= clean.length) break;
    }
    return chunks;
}

/**
 * Safely extracts embedding values from Gemini embedding responses.
 *
 * @param {any} embeddingResult
 * @returns {number[]}
 */
function extractEmbeddingValues(embeddingResult) {
    const values = embeddingResult && embeddingResult.embedding && embeddingResult.embedding.values;
    return Array.isArray(values) ? values : [];
}

/**
 * Computes cosine similarity for two vectors.
 *
 * @param {number[]} a
 * @param {number[]} b
 * @returns {number}
 */
function cosineSimilarity(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length === 0 || b.length === 0 || a.length !== b.length) {
        return Number.NEGATIVE_INFINITY;
    }
    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < a.length; i += 1) {
        const av = Number(a[i]) || 0;
        const bv = Number(b[i]) || 0;
        dot += av * bv;
        normA += av * av;
        normB += bv * bv;
    }
    if (normA <= 0 || normB <= 0) return Number.NEGATIVE_INFINITY;
    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Creates a single embedding for text using Gemini.
 *
 * @param {object} embeddingModel
 * @param {string} text
 * @param {string} taskType
 * @returns {Promise<number[]>}
 */
async function embedText(embeddingModel, text, taskType) {
    try {
        const embeddingResult = await embeddingModel.embedContent({
            content: { parts: [{ text }] },
            taskType,
        });
        const values = extractEmbeddingValues(embeddingResult);
        if (values.length > 0) return values;
    } catch (_ignored) {
        // Fall back to plain string payload for SDK compatibility across versions.
    }
    const fallbackResult = await embeddingModel.embedContent(text);
    return extractEmbeddingValues(fallbackResult);
}

/**
 * Builds (or reuses) cached embedded chunks for a PDF file.
 *
 * @param {object} options
 * @param {object} options.embeddingModel
 * @param {string} options.filename
 * @param {string} options.filePath
 * @returns {Promise<Array<{name: string, text: string, embedding: number[]}>>}
 */
async function getEmbeddedPdfChunks({ embeddingModel, filename, filePath }) {
    let stat = null;
    try {
        stat = await fs.promises.stat(filePath);
    } catch (_err) {
        return [];
    }
    const cacheEntry = pdfVectorCache.get(filename);
    if (cacheEntry && cacheEntry.mtimeMs === stat.mtimeMs && cacheEntry.size === stat.size) {
        return cacheEntry.chunks;
    }

    const text = await extractPdfText(filePath, filename);
    const chunks = splitIntoChunks(text);
    const embeddedChunks = [];
    for (const chunk of chunks) {
        try {
            const embedding = await embedText(embeddingModel, chunk, 'RETRIEVAL_DOCUMENT');
            if (embedding.length > 0) {
                embeddedChunks.push({ name: filename, text: chunk, embedding });
            }
        } catch (err) {
            console.warn(`[ACCREDITATION-AGENT] Failed embedding chunk for ${filename}: ${err.message}`);
        }
    }

    pdfVectorCache.set(filename, {
        mtimeMs: stat.mtimeMs,
        size: stat.size,
        chunks: embeddedChunks,
    });

    return embeddedChunks;
}

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

/**
 * Reads a PDF file and returns an inline Gemini part, or null if the
 * file is too large or cannot be read.
 *
 * @param {string} filePath
 * @param {string} filename
 * @returns {Promise<{inlineData: {mimeType: string, data: string}}|null>}
 */
async function buildPdfPart(filePath, filename) {
    try {
        const stat = await fs.promises.stat(filePath); // lgtm[js/missing-rate-limiting]
        if (stat.size > MAX_INLINE_PDF_SIZE_BYTES) {
            console.warn(`[ACCREDITATION-AGENT] Skipping large PDF ${filename} (${stat.size} bytes)`);
            return null;
        }
        const buffer = await fs.promises.readFile(filePath); // lgtm[js/missing-rate-limiting]
        return {
            inlineData: {
                mimeType: 'application/pdf',
                data: buffer.toString('base64'),
            },
        };
    } catch (err) {
        console.warn(`[ACCREDITATION-AGENT] Failed to read PDF ${filename}: ${err.message}`);
        return null;
    }
}

// ── Gemini prompt builder ─────────────────────────────────────────────────────

/**
 * Builds the prompt sent to Gemini.
 *
 * @param {Array<{name: string, text: string}>} docs
 * @param {number} textDocCount  Number of extracted text docs included in the prompt.
 * @param {number} inlinePdfCount  Number of inline PDF files included in the request.
 * @param {number} imageCount  Number of inline images included in the request.
 * @param {string} userQuestion
 * @returns {string}
 */
function buildPrompt(docs, textDocCount, inlinePdfCount, imageCount, userQuestion) {
    const docsSection = docs.length > 0
        ? docs
            .map(({ name, text }) => `[FILE: ${name}]\n${text || '(no extractable text)'}`)
            .join('\n\n---\n\n')
        : '';

    const contextNotes = [];
    if (textDocCount > 0) {
        contextNotes.push(`${textDocCount} extracted PDF text chunk(s) are included below.`);
    }
    if (inlinePdfCount > 0) {
        contextNotes.push(`${inlinePdfCount} PDF file(s) from the Accreditation folder are also provided above as inline documents for visual/text reading.`);
    }
    if (imageCount > 0) {
        contextNotes.push(`${imageCount} image file(s) from the Accreditation folder are also provided above as visual context.`);
    }
    const contextNoteBlock = contextNotes.length > 0
        ? `\n\nNote: ${contextNotes.join(' ')}`
        : '';

    return `You are an accreditation assistant. Your job is to answer questions based \
only on the accreditation documents listed below. When answering, mention the \
file(s) you drew the information from.
${docsSection ? `\n=== DOCUMENTS ===\n${docsSection}` : ''}${contextNoteBlock}

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
        const apiKey = (process.env.GEMINI_API_KEY || '').trim();
        if (!apiKey) {
            console.error('[ACCREDITATION-AGENT] GEMINI_API_KEY is not set');
            return res.status(503).json({ error: 'AI service is not configured' });
        }
        const genAI = new GoogleGenerativeAI(apiKey);
        const answerModel = genAI.getGenerativeModel({ model: GEMINI_MODEL });
        const embeddingModel = genAI.getGenerativeModel({ model: EMBEDDING_MODEL });

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

        // Build vector-search context from all PDFs in Accreditation folder.
        const docs = [];
        if (pdfFilenames.length > 0) {
            let queryEmbedding = [];
            try {
                queryEmbedding = await embedText(embeddingModel, question, 'RETRIEVAL_QUERY');
            } catch (err) {
                console.warn(`[ACCREDITATION-AGENT] Failed to embed query: ${err.message}`);
            }

            if (queryEmbedding.length > 0) {
                const scoredChunks = [];
                for (const filename of pdfFilenames) {
                    const filePath = path.join(accreditationDir, filename);
                    const embeddedChunks = await getEmbeddedPdfChunks({ embeddingModel, filename, filePath });
                    for (const chunk of embeddedChunks) {
                        const score = cosineSimilarity(queryEmbedding, chunk.embedding);
                        scoredChunks.push({
                            name: chunk.name,
                            text: chunk.text,
                            score,
                        });
                    }
                }
                scoredChunks
                    .sort((a, b) => b.score - a.score)
                    .slice(0, MAX_CHUNKS_IN_PROMPT)
                    .forEach(({ name, text }) => docs.push({ name, text }));
            }

            // Fallback if embeddings are unavailable.
            if (docs.length === 0) {
                for (const filename of pdfFilenames) {
                    const filePath = path.join(accreditationDir, filename);
                    const text = await extractPdfText(filePath, filename);
                    docs.push({ name: filename, text: text || '' });
                }
            }
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

        // Build inline PDF parts for Gemini multimodal input (helps for scanned PDFs).
        const pdfParts = [];
        for (const filename of pdfFilenames.slice(0, MAX_INLINE_PDFS)) {
            const filePath = path.join(accreditationDir, filename);
            const part = await buildPdfPart(filePath, filename);
            if (part) {
                pdfParts.push(part);
            }
        }

        // ── Call Gemini ───────────────────────────────────────────────────
        let answerText = '';
        try {
            const prompt = buildPrompt(docs, docs.length, pdfParts.length, imageParts.length, question);
            // Build multimodal content: text prompt first, then inline PDFs/images.
            const contentParts = [{ text: prompt }, ...pdfParts, ...imageParts];
            const result = await answerModel.generateContent(contentParts);
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
        const uniquePdfNames = [...new Set(docs.map(({ name }) => name))];
        const mentionedPdfNames = uniquePdfNames.filter((name) => {
            const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            return new RegExp(`\\b${escaped}\\b`, 'i').test(answerText);
        });
        const relevantPdfNames = mentionedPdfNames.length > 0
            ? mentionedPdfNames
            : (uniquePdfNames.length > 0 ? uniquePdfNames : pdfFilenames);
        const relevantPdfs = relevantPdfNames.map((name) => ({
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
