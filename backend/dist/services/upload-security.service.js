"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.UploadSecurityService = void 0;
exports.createUploadSecurityService = createUploadSecurityService;
const promises_1 = __importDefault(require("node:fs/promises"));
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const node_crypto_1 = __importDefault(require("node:crypto"));
const node_worker_threads_1 = require("node:worker_threads");
// ─── Constants ──────────────────────────────────────────────────────────────
const ALLOWED_IMAGE_EXTENSIONS = new Set([
    '.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.avif', '.heic', '.heif'
]);
const PDF_EXTENSION = '.pdf';
const PDF_MIME_TYPE = 'application/pdf';
const DEFAULT_MAX_UPLOAD_INSPECTION_BYTES = 40 * 1024 * 1024;
const DEFAULT_WORKER_TIMEOUT_MS = 90000;
const ISO_BMFF_IMAGE_BRANDS = new Set([
    'avif', 'avis', 'heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1'
]);
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
// ─── Pure helper functions ──────────────────────────────────────────────────
function normalizeUploadMimeType(file) {
    return String(file.mimetype || '').trim().toLowerCase();
}
function normalizeUploadExtension(file) {
    return node_path_1.default.extname(String(file.originalname || '')).toLowerCase();
}
function bufferStartsWith(buffer, signature) {
    if (!Buffer.isBuffer(buffer) || !Buffer.isBuffer(signature))
        return false;
    if (buffer.length < signature.length)
        return false;
    return buffer.subarray(0, signature.length).equals(signature);
}
function validatePngStructure(buffer) {
    const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    if (!bufferStartsWith(buffer, pngSignature))
        return false;
    let offset = pngSignature.length;
    while (offset + 12 <= buffer.length) {
        const chunkLength = buffer.readUInt32BE(offset);
        const chunkType = buffer.toString('ascii', offset + 4, offset + 8);
        const nextOffset = offset + 12 + chunkLength;
        if (nextOffset > buffer.length)
            return false;
        if (chunkType === 'IEND')
            return nextOffset === buffer.length;
        offset = nextOffset;
    }
    return false;
}
function validateWebpStructure(buffer) {
    if (buffer.length < 12)
        return false;
    if (!buffer.subarray(0, 4).equals(Buffer.from('RIFF')))
        return false;
    if (!buffer.subarray(8, 12).equals(Buffer.from('WEBP')))
        return false;
    const declaredSize = buffer.readUInt32LE(4) + 8;
    return declaredSize === buffer.length;
}
function validateBmpStructure(buffer) {
    if (buffer.length < 14)
        return false;
    if (!buffer.subarray(0, 2).equals(Buffer.from('BM')))
        return false;
    const declaredSize = buffer.readUInt32LE(2);
    return declaredSize === buffer.length;
}
function validateIsoBmffStructure(buffer) {
    if (buffer.length < 16)
        return false;
    if (buffer.toString('ascii', 4, 8) !== 'ftyp')
        return false;
    const brand = buffer.toString('ascii', 8, 12).toLowerCase();
    if (!ISO_BMFF_IMAGE_BRANDS.has(brand))
        return false;
    let offset = 0;
    while (offset + 8 <= buffer.length) {
        let boxSize = buffer.readUInt32BE(offset);
        if (boxSize === 0)
            return offset + 8 <= buffer.length;
        if (boxSize === 1) {
            if (offset + 16 > buffer.length)
                return false;
            const extendedSize = Number(buffer.readBigUInt64BE(offset + 8));
            if (!Number.isFinite(extendedSize) || extendedSize < 16)
                return false;
            boxSize = extendedSize;
        }
        else if (boxSize < 8) {
            return false;
        }
        const nextOffset = offset + boxSize;
        if (nextOffset > buffer.length)
            return false;
        offset = nextOffset;
    }
    return offset === buffer.length;
}
// ─── Service ────────────────────────────────────────────────────────────────
class UploadSecurityService {
    uploadDir;
    workerPath;
    maxInspectionBytes;
    workerTimeoutMs;
    constructor(config) {
        this.uploadDir = config.uploadDir;
        this.workerPath = config.workerPath;
        this.maxInspectionBytes = Math.max(1, config.maxInspectionBytes ?? DEFAULT_MAX_UPLOAD_INSPECTION_BYTES);
        this.workerTimeoutMs = Math.max(1000, config.workerTimeoutMs ?? DEFAULT_WORKER_TIMEOUT_MS);
    }
    // ── Public: type checks ─────────────────────────────────────────────────
    isImageUpload(file) {
        const mimeType = normalizeUploadMimeType(file);
        const extension = normalizeUploadExtension(file);
        return mimeType.startsWith('image/') || ALLOWED_IMAGE_EXTENSIONS.has(extension);
    }
    isPdfUpload(file) {
        const mimeType = normalizeUploadMimeType(file);
        const extension = normalizeUploadExtension(file);
        return mimeType === PDF_MIME_TYPE || extension === PDF_EXTENSION;
    }
    isAllowedMainUpload(file) {
        return this.isImageUpload(file) || this.isPdfUpload(file);
    }
    isAllowedThumbnailUpload(file) {
        return this.isImageUpload(file);
    }
    // ── Public: filename helpers ────────────────────────────────────────────
    chooseSafeUploadExtension(file) {
        const ext = normalizeUploadExtension(file);
        if (ALLOWED_IMAGE_EXTENSIONS.has(ext) || ext === PDF_EXTENSION)
            return ext;
        const mimeType = normalizeUploadMimeType(file);
        if (mimeType === 'image/jpeg')
            return '.jpg';
        if (mimeType === 'image/png')
            return '.png';
        if (mimeType === 'image/gif')
            return '.gif';
        if (mimeType === 'image/webp')
            return '.webp';
        if (mimeType === 'image/bmp' || mimeType === 'image/x-ms-bmp')
            return '.bmp';
        if (mimeType === 'image/avif')
            return '.avif';
        if (mimeType === 'image/heic')
            return '.heic';
        if (mimeType === 'image/heif')
            return '.heif';
        if (mimeType === PDF_MIME_TYPE)
            return PDF_EXTENSION;
        if (mimeType.startsWith('image/'))
            return '.jpg';
        return '';
    }
    sanitizeUploadBaseName(rawName = '') {
        const base = node_path_1.default.basename(String(rawName || '').trim());
        const ext = node_path_1.default.extname(base);
        const stem = base.slice(0, Math.max(0, base.length - ext.length));
        const sanitized = stem
            .normalize('NFKD')
            .replace(/[^a-zA-Z0-9._-]+/g, '-')
            .replace(/-+/g, '-')
            .replace(/^[._-]+|[._-]+$/g, '')
            .slice(0, 40);
        return sanitized || 'upload';
    }
    buildSafeUploadFilename(file) {
        const originalName = node_path_1.default.basename(String(file.originalname || '').trim());
        if (originalName && originalName !== '.' && originalName !== '..') {
            return originalName;
        }
        const safeStem = this.sanitizeUploadBaseName(file.originalname || '');
        const extension = this.chooseSafeUploadExtension(file);
        const uniqueSuffix = `${Date.now()}-${node_crypto_1.default.randomBytes(4).toString('hex')}`;
        return `${safeStem}-${uniqueSuffix}${extension}`;
    }
    // ── Public: image format detection ──────────────────────────────────────
    detectImageFormat(buffer) {
        if (validatePngStructure(buffer))
            return 'png';
        if (bufferStartsWith(buffer, Buffer.from([0xff, 0xd8])) &&
            buffer.subarray(buffer.length - 2).equals(Buffer.from([0xff, 0xd9]))) {
            return 'jpeg';
        }
        if ((bufferStartsWith(buffer, Buffer.from('GIF87a')) ||
            bufferStartsWith(buffer, Buffer.from('GIF89a'))) &&
            buffer[buffer.length - 1] === 0x3b) {
            return 'gif';
        }
        if (validateWebpStructure(buffer))
            return 'webp';
        if (validateBmpStructure(buffer))
            return 'bmp';
        if (validateIsoBmffStructure(buffer))
            return 'iso-bmff';
        return '';
    }
    // ── Public: PDF safety ──────────────────────────────────────────────────
    hasUnsafePdfContent(buffer) {
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
    // ── Public: safe file deletion ──────────────────────────────────────────
    async safelyDeleteUploadedFile(file) {
        if (!file || !file.path)
            return;
        try {
            const resolvedUploadDir = node_path_1.default.resolve(this.uploadDir) + node_path_1.default.sep;
            const resolvedPath = node_path_1.default.resolve(String(file.path));
            if (!resolvedPath.startsWith(resolvedUploadDir))
                return;
            await promises_1.default.unlink(resolvedPath);
        }
        catch {
            // Ignore cleanup failures to keep request handling stable.
        }
    }
    // ── Public: full validation (worker-thread with in-process fallback) ───
    async validateUploadedFileSecurity(file, options = {}) {
        if (!file || !file.path) {
            return { ok: false, message: 'Invalid uploaded file data' };
        }
        if (node_worker_threads_1.Worker && node_fs_1.default.existsSync(this.workerPath)) {
            try {
                return await this.runUploadValidationWorker(file, options);
            }
            catch (error) {
                const msg = error instanceof Error ? error.message : String(error);
                console.warn('[UPLOAD SECURITY] Worker validation failed, falling back to in-process scan:', msg);
            }
        }
        return this.validateUploadedFileSecurityInProcess(file, options);
    }
    // ── Private: in-process validation ──────────────────────────────────────
    async validateUploadedFileSecurityInProcess(file, options = {}) {
        const allowImage = options.allowImage !== false;
        const allowPdf = options.allowPdf !== false;
        if (!file || !file.path) {
            return { ok: false, message: 'Invalid uploaded file data' };
        }
        // Guard against path traversal — only allow reading files inside the upload directory.
        const resolvedUploadDir = node_path_1.default.resolve(this.uploadDir) + node_path_1.default.sep;
        const resolvedPath = node_path_1.default.resolve(String(file.path));
        if (!resolvedPath.startsWith(resolvedUploadDir)) {
            return { ok: false, message: 'Invalid uploaded file path' };
        }
        const fileSize = Number(file.size || 0);
        if (!Number.isFinite(fileSize) || fileSize <= 0) {
            return { ok: false, message: 'Uploaded file is empty' };
        }
        if (fileSize > this.maxInspectionBytes) {
            return { ok: false, message: 'File is too large for security inspection' };
        }
        const fileBuffer = await promises_1.default.readFile(file.path);
        if (!fileBuffer.length) {
            return { ok: false, message: 'Uploaded file is empty' };
        }
        const isPdfCandidate = allowPdf && this.isPdfUpload(file);
        if (isPdfCandidate) {
            const pdfResult = this.hasUnsafePdfContent(fileBuffer);
            if (pdfResult.unsafe) {
                return { ok: false, message: pdfResult.reason || 'Unsafe PDF content detected' };
            }
            return { ok: true, message: '' };
        }
        const isImageCandidate = allowImage && this.isImageUpload(file);
        if (isImageCandidate) {
            const detectedFormat = this.detectImageFormat(fileBuffer);
            if (!detectedFormat) {
                return { ok: false, message: 'Invalid image content or hidden payload detected' };
            }
            return { ok: true, message: '' };
        }
        return { ok: false, message: 'Only secure image and PDF files are allowed' };
    }
    // ── Private: worker thread validation ───────────────────────────────────
    runUploadValidationWorker(file, options = {}) {
        return new Promise((resolve, reject) => {
            const worker = new node_worker_threads_1.Worker(this.workerPath, {
                workerData: {
                    file: {
                        path: file.path,
                        size: file.size,
                        mimetype: file.mimetype,
                        originalname: file.originalname
                    },
                    options,
                    maxInspectionBytes: this.maxInspectionBytes
                }
            });
            let settled = false;
            const finishResolve = (value) => {
                if (settled)
                    return;
                settled = true;
                resolve(value);
            };
            const finishReject = (error) => {
                if (settled)
                    return;
                settled = true;
                reject(error);
            };
            const timeoutId = setTimeout(() => {
                try {
                    worker.terminate();
                }
                catch { /* ignore */ }
                finishReject(new Error('Upload security validation timed out'));
            }, this.workerTimeoutMs);
            worker.once('message', (payload) => {
                clearTimeout(timeoutId);
                finishResolve(UploadSecurityService.normalizeValidationResult(payload));
            });
            worker.once('error', (error) => {
                clearTimeout(timeoutId);
                finishReject(error);
            });
            worker.once('exit', (code) => {
                if (settled)
                    return;
                clearTimeout(timeoutId);
                if (code === 0) {
                    finishResolve({ ok: false, message: 'File content validation failed' });
                    return;
                }
                finishReject(new Error(`Upload validation worker exited with code ${code}`));
            });
        });
    }
    static normalizeValidationResult(result) {
        if (!result || typeof result !== 'object') {
            return { ok: false, message: 'File content validation failed' };
        }
        const record = result;
        return {
            ok: record.ok === true,
            message: typeof record.message === 'string' ? record.message : ''
        };
    }
}
exports.UploadSecurityService = UploadSecurityService;
// ─── Factory ────────────────────────────────────────────────────────────────
function createUploadSecurityService(config) {
    return new UploadSecurityService(config);
}
