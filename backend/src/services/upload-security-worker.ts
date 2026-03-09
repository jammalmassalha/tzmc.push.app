import fs from 'node:fs/promises';
import path from 'node:path';
import { parentPort, workerData } from 'node:worker_threads';

interface UploadedFileDescriptor {
  path: string;
  size?: number;
  mimetype?: string;
  originalname?: string;
}

interface UploadValidationOptions {
  allowImage?: boolean;
  allowPdf?: boolean;
}

interface UploadValidationPayload {
  file: UploadedFileDescriptor;
  options?: UploadValidationOptions;
  maxInspectionBytes?: number;
}

interface UploadValidationResult {
  ok: boolean;
  message: string;
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

function normalizeUploadMimeType(file: UploadedFileDescriptor): string {
  return String(file.mimetype || '').trim().toLowerCase();
}

function normalizeUploadExtension(file: UploadedFileDescriptor): string {
  return path.extname(String(file.originalname || '')).toLowerCase();
}

function isImageUpload(file: UploadedFileDescriptor): boolean {
  const mimeType = normalizeUploadMimeType(file);
  const extension = normalizeUploadExtension(file);
  return mimeType.startsWith('image/') || ALLOWED_IMAGE_EXTENSIONS.has(extension);
}

function isPdfUpload(file: UploadedFileDescriptor): boolean {
  const mimeType = normalizeUploadMimeType(file);
  const extension = normalizeUploadExtension(file);
  return mimeType === PDF_MIME_TYPE || extension === PDF_EXTENSION;
}

function bufferStartsWith(buffer: Buffer, signature: Buffer): boolean {
  if (!Buffer.isBuffer(buffer) || !Buffer.isBuffer(signature)) return false;
  if (buffer.length < signature.length) return false;
  return buffer.subarray(0, signature.length).equals(signature);
}

function validatePngStructure(buffer: Buffer): boolean {
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

function validateWebpStructure(buffer: Buffer): boolean {
  if (buffer.length < 12) return false;
  if (!buffer.subarray(0, 4).equals(Buffer.from('RIFF'))) return false;
  if (!buffer.subarray(8, 12).equals(Buffer.from('WEBP'))) return false;
  const declaredSize = buffer.readUInt32LE(4) + 8;
  return declaredSize === buffer.length;
}

function validateBmpStructure(buffer: Buffer): boolean {
  if (buffer.length < 14) return false;
  if (!buffer.subarray(0, 2).equals(Buffer.from('BM'))) return false;
  const declaredSize = buffer.readUInt32LE(2);
  return declaredSize === buffer.length;
}

function validateIsoBmffStructure(buffer: Buffer): boolean {
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

function detectImageFormat(buffer: Buffer): string {
  if (validatePngStructure(buffer)) return 'png';
  if (
    bufferStartsWith(buffer, Buffer.from([0xff, 0xd8])) &&
    buffer.subarray(buffer.length - 2).equals(Buffer.from([0xff, 0xd9]))
  ) {
    return 'jpeg';
  }
  if (
    (bufferStartsWith(buffer, Buffer.from('GIF87a')) || bufferStartsWith(buffer, Buffer.from('GIF89a'))) &&
    buffer[buffer.length - 1] === 0x3b
  ) {
    return 'gif';
  }
  if (validateWebpStructure(buffer)) return 'webp';
  if (validateBmpStructure(buffer)) return 'bmp';
  if (validateIsoBmffStructure(buffer)) return 'iso-bmff';
  return '';
}

function hasUnsafePdfContent(buffer: Buffer): { unsafe: boolean; reason: string } {
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

async function validateUploadedFileSecurity(
  file: UploadedFileDescriptor,
  options: UploadValidationOptions = {},
  maxInspectionBytes = DEFAULT_MAX_UPLOAD_INSPECTION_BYTES
): Promise<UploadValidationResult> {
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

  const fileBuffer = await fs.readFile(file.path);
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

async function run(): Promise<void> {
  const payload = (workerData || {}) as UploadValidationPayload;
  const file = payload.file || ({} as UploadedFileDescriptor);
  const options = payload.options || {};
  const maxInspectionBytes = Math.max(
    1,
    Number(payload.maxInspectionBytes || DEFAULT_MAX_UPLOAD_INSPECTION_BYTES) || DEFAULT_MAX_UPLOAD_INSPECTION_BYTES
  );

  const result = await validateUploadedFileSecurity(file, options, maxInspectionBytes);
  parentPort?.postMessage(result);
}

void run().catch((error) => {
  parentPort?.postMessage({
    ok: false,
    message: error instanceof Error ? error.message : 'File content validation failed'
  } satisfies UploadValidationResult);
});
