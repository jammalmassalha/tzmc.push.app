"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const promises_1 = __importDefault(require("node:fs/promises"));
const node_path_1 = __importDefault(require("node:path"));
const node_worker_threads_1 = require("node:worker_threads");
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
const DEFAULT_MAX_UPLOAD_INSPECTION_BYTES = 40 * 1024 * 1024;
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
function normalizeUploadMimeType(file) {
    return String(file.mimetype || '').trim().toLowerCase();
}
function normalizeUploadExtension(file) {
    return node_path_1.default.extname(String(file.originalname || '')).toLowerCase();
}
function isImageUpload(file) {
    const mimeType = normalizeUploadMimeType(file);
    const extension = normalizeUploadExtension(file);
    return mimeType.startsWith('image/') || ALLOWED_IMAGE_EXTENSIONS.has(extension);
}
function isPdfUpload(file) {
    const mimeType = normalizeUploadMimeType(file);
    const extension = normalizeUploadExtension(file);
    return mimeType === PDF_MIME_TYPE || extension === PDF_EXTENSION;
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
    if (buffer.length < 12)
        return false;
    if (!buffer.subarray(0, 4).equals(Buffer.from('RIFF')))
        return false;
    if (!buffer.subarray(8, 12).equals(Buffer.from('WEBP')))
        return false;
    const declaredSize = buffer.readUInt32LE(4) + 8;
    return declaredSize === buffer.length;
}
function validateJpegStructure(buffer) {
    // JPEG must start with SOI marker (0xFF 0xD8)
    if (buffer.length < 4)
        return false;
    if (buffer[0] !== 0xff || buffer[1] !== 0xd8)
        return false;
    // Search for EOI marker (0xFF 0xD9) anywhere in the buffer.
    // Many valid JPEGs from cameras/phones have trailing metadata or padding
    // after the EOI, so we only require that an EOI marker exists somewhere
    // after the SOI — not necessarily at the very end of the file.
    const eoiMarker = Buffer.from([0xff, 0xd9]);
    const eoiIndex = buffer.lastIndexOf(eoiMarker);
    return eoiIndex >= 2;
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
        if (boxSize === 0) {
            return offset + 8 <= buffer.length;
        }
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
        if (nextOffset > buffer.length) {
            return false;
        }
        offset = nextOffset;
    }
    return offset === buffer.length;
}
function detectImageFormat(buffer) {
    if (validatePngStructure(buffer))
        return 'png';
    if (validateJpegStructure(buffer))
        return 'jpeg';
    if ((bufferStartsWith(buffer, Buffer.from('GIF87a')) || bufferStartsWith(buffer, Buffer.from('GIF89a'))) &&
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
async function validateUploadedFileSecurity(file, options = {}, maxInspectionBytes = DEFAULT_MAX_UPLOAD_INSPECTION_BYTES) {
    const allowImage = options.allowImage !== false;
    const allowPdf = options.allowPdf !== false;
    if (!file || !file.path) {
        return { ok: false, message: 'Invalid uploaded file data' };
    }
    const fileSize = Number(file.size || 0);
    if (!Number.isFinite(fileSize) || fileSize <= 0) {
        return { ok: false, message: 'Uploaded file is empty' };
    }
    if (fileSize > maxInspectionBytes) {
        return { ok: false, message: 'File is too large for security inspection' };
    }
    const fileBuffer = await promises_1.default.readFile(file.path);
    if (!fileBuffer.length) {
        return { ok: false, message: 'Uploaded file is empty' };
    }
    if (allowPdf && isPdfUpload(file)) {
        const pdfResult = hasUnsafePdfContent(fileBuffer);
        if (pdfResult.unsafe) {
            return { ok: false, message: pdfResult.reason || 'Unsafe PDF content detected' };
        }
        return { ok: true, message: '' };
    }
    if (allowImage && isImageUpload(file)) {
        const detectedFormat = detectImageFormat(fileBuffer);
        if (!detectedFormat) {
            return { ok: false, message: 'Invalid image content or hidden payload detected' };
        }
        return { ok: true, message: '' };
    }
    return { ok: false, message: 'Only secure image and PDF files are allowed' };
}
async function run() {
    const payload = (node_worker_threads_1.workerData || {});
    const file = payload.file || {};
    const options = payload.options || {};
    const maxInspectionBytes = Math.max(1, Number(payload.maxInspectionBytes || DEFAULT_MAX_UPLOAD_INSPECTION_BYTES) || DEFAULT_MAX_UPLOAD_INSPECTION_BYTES);
    const result = await validateUploadedFileSecurity(file, options, maxInspectionBytes);
    node_worker_threads_1.parentPort?.postMessage(result);
}
void run().catch((error) => {
    node_worker_threads_1.parentPort?.postMessage({
        ok: false,
        message: error instanceof Error ? error.message : 'File content validation failed'
    });
});
