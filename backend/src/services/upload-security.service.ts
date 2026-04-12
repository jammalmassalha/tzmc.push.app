import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Worker } from 'node:worker_threads';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface UploadedFileDescriptor {
  path: string;
  size?: number;
  mimetype?: string;
  originalname?: string;
  filename?: string;
  fieldname?: string;
}

export interface UploadValidationOptions {
  allowImage?: boolean;
  allowPdf?: boolean;
}

export interface UploadValidationResult {
  ok: boolean;
  message: string;
}

export interface UploadSecurityServiceConfig {
  uploadDir: string;
  workerPath: string;
  maxInspectionBytes?: number;
  workerTimeoutMs?: number;
}

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
const PDF_DISALLOWED_TOKENS: RegExp[] = [
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

function normalizeUploadMimeType(file: Partial<UploadedFileDescriptor>): string {
  return String(file.mimetype || '').trim().toLowerCase();
}

function normalizeUploadExtension(file: Partial<UploadedFileDescriptor>): string {
  return path.extname(String(file.originalname || '')).toLowerCase();
}

function bufferStartsWith(buffer: Buffer, signature: Buffer): boolean {
  if (!Buffer.isBuffer(buffer) || !Buffer.isBuffer(signature)) return false;
  if (buffer.length < signature.length) return false;
  return buffer.subarray(0, signature.length).equals(signature);
}

function validatePngStructure(buffer: Buffer): boolean {
  const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (!bufferStartsWith(buffer, pngSignature)) return false;
  let offset = pngSignature.length;
  while (offset + 12 <= buffer.length) {
    const chunkLength = buffer.readUInt32BE(offset);
    const chunkType = buffer.toString('ascii', offset + 4, offset + 8);
    const nextOffset = offset + 12 + chunkLength;
    if (nextOffset > buffer.length) return false;
    if (chunkType === 'IEND') return nextOffset === buffer.length;
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

function validateJpegStructure(buffer: Buffer): boolean {
  // JPEG must start with SOI marker (0xFF 0xD8)
  if (buffer.length < 4) return false;
  if (buffer[0] !== 0xff || buffer[1] !== 0xd8) return false;
  // Search for EOI marker (0xFF 0xD9) anywhere in the buffer.
  // Many valid JPEGs from cameras/phones have trailing metadata or padding
  // after the EOI, so we only require that an EOI marker exists somewhere
  // after the SOI — not necessarily at the very end of the file.
  const eoiMarker = Buffer.from([0xff, 0xd9]);
  const eoiIndex = buffer.lastIndexOf(eoiMarker);
  return eoiIndex >= 2;
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
    if (boxSize === 0) return offset + 8 <= buffer.length;
    if (boxSize === 1) {
      if (offset + 16 > buffer.length) return false;
      const extendedSize = Number(buffer.readBigUInt64BE(offset + 8));
      if (!Number.isFinite(extendedSize) || extendedSize < 16) return false;
      boxSize = extendedSize;
    } else if (boxSize < 8) {
      return false;
    }
    const nextOffset = offset + boxSize;
    if (nextOffset > buffer.length) return false;
    offset = nextOffset;
  }
  return offset === buffer.length;
}

// ─── Service ────────────────────────────────────────────────────────────────

export class UploadSecurityService {
  readonly uploadDir: string;
  private readonly workerPath: string;
  private readonly maxInspectionBytes: number;
  private readonly workerTimeoutMs: number;

  constructor(config: UploadSecurityServiceConfig) {
    this.uploadDir = config.uploadDir;
    this.workerPath = config.workerPath;
    this.maxInspectionBytes = Math.max(1, config.maxInspectionBytes ?? DEFAULT_MAX_UPLOAD_INSPECTION_BYTES);
    this.workerTimeoutMs = Math.max(1000, config.workerTimeoutMs ?? DEFAULT_WORKER_TIMEOUT_MS);
  }

  // ── Public: type checks ─────────────────────────────────────────────────

  isImageUpload(file: Partial<UploadedFileDescriptor>): boolean {
    const mimeType = normalizeUploadMimeType(file);
    const extension = normalizeUploadExtension(file);
    return mimeType.startsWith('image/') || ALLOWED_IMAGE_EXTENSIONS.has(extension);
  }

  isPdfUpload(file: Partial<UploadedFileDescriptor>): boolean {
    const mimeType = normalizeUploadMimeType(file);
    const extension = normalizeUploadExtension(file);
    return mimeType === PDF_MIME_TYPE || extension === PDF_EXTENSION;
  }

  isAllowedMainUpload(file: Partial<UploadedFileDescriptor>): boolean {
    return this.isImageUpload(file) || this.isPdfUpload(file);
  }

  isAllowedThumbnailUpload(file: Partial<UploadedFileDescriptor>): boolean {
    return this.isImageUpload(file);
  }

  // ── Public: filename helpers ────────────────────────────────────────────

  chooseSafeUploadExtension(file: Partial<UploadedFileDescriptor>): string {
    const ext = normalizeUploadExtension(file);
    if (ALLOWED_IMAGE_EXTENSIONS.has(ext) || ext === PDF_EXTENSION) return ext;
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

  sanitizeUploadBaseName(rawName = ''): string {
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

  buildSafeUploadFilename(file: Partial<UploadedFileDescriptor>): string {
    const originalName = path.basename(String(file.originalname || '').trim());
    if (originalName && originalName !== '.' && originalName !== '..') {
      return originalName;
    }
    const safeStem = this.sanitizeUploadBaseName(file.originalname || '');
    const extension = this.chooseSafeUploadExtension(file);
    const uniqueSuffix = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    return `${safeStem}-${uniqueSuffix}${extension}`;
  }

  // ── Public: image format detection ──────────────────────────────────────

  detectImageFormat(buffer: Buffer): string {
    if (validatePngStructure(buffer)) return 'png';
    if (validateJpegStructure(buffer)) return 'jpeg';
    if (
      (bufferStartsWith(buffer, Buffer.from('GIF87a')) ||
        bufferStartsWith(buffer, Buffer.from('GIF89a'))) &&
      buffer[buffer.length - 1] === 0x3b
    ) {
      return 'gif';
    }
    if (validateWebpStructure(buffer)) return 'webp';
    if (validateBmpStructure(buffer)) return 'bmp';
    if (validateIsoBmffStructure(buffer)) return 'iso-bmff';
    return '';
  }

  // ── Public: PDF safety ──────────────────────────────────────────────────

  hasUnsafePdfContent(buffer: Buffer): { unsafe: boolean; reason: string } {
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

  async safelyDeleteUploadedFile(file: Partial<UploadedFileDescriptor> | null): Promise<void> {
    if (!file || !file.path) return;
    try {
      const resolvedUploadDir = path.resolve(this.uploadDir) + path.sep;
      const resolvedPath = path.resolve(String(file.path));
      if (!resolvedPath.startsWith(resolvedUploadDir)) return;
      await fs.unlink(resolvedPath);
    } catch {
      // Ignore cleanup failures to keep request handling stable.
    }
  }

  // ── Public: full validation (worker-thread with in-process fallback) ───

  async validateUploadedFileSecurity(
    file: Partial<UploadedFileDescriptor>,
    options: UploadValidationOptions = {}
  ): Promise<UploadValidationResult> {
    if (!file || !file.path) {
      return { ok: false, message: 'Invalid uploaded file data' };
    }

    if (Worker && fsSync.existsSync(this.workerPath)) {
      try {
        return await this.runUploadValidationWorker(file, options);
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        console.warn('[UPLOAD SECURITY] Worker validation failed, falling back to in-process scan:', msg);
      }
    }

    return this.validateUploadedFileSecurityInProcess(file, options);
  }

  // ── Private: in-process validation ──────────────────────────────────────

  private async validateUploadedFileSecurityInProcess(
    file: Partial<UploadedFileDescriptor>,
    options: UploadValidationOptions = {}
  ): Promise<UploadValidationResult> {
    const allowImage = options.allowImage !== false;
    const allowPdf = options.allowPdf !== false;

    if (!file || !file.path) {
      return { ok: false, message: 'Invalid uploaded file data' };
    }

    // Guard against path traversal — only allow reading files inside the upload directory.
    const resolvedUploadDir = path.resolve(this.uploadDir) + path.sep;
    const resolvedPath = path.resolve(String(file.path));
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

    const fileBuffer = await fs.readFile(file.path);
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

  private runUploadValidationWorker(
    file: Partial<UploadedFileDescriptor>,
    options: UploadValidationOptions = {}
  ): Promise<UploadValidationResult> {
    return new Promise((resolve, reject) => {
      const worker = new Worker(this.workerPath, {
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
      const finishResolve = (value: UploadValidationResult): void => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      const finishReject = (error: Error): void => {
        if (settled) return;
        settled = true;
        reject(error);
      };

      const timeoutId = setTimeout(() => {
        try { worker.terminate(); } catch { /* ignore */ }
        finishReject(new Error('Upload security validation timed out'));
      }, this.workerTimeoutMs);

      worker.once('message', (payload: unknown) => {
        clearTimeout(timeoutId);
        finishResolve(UploadSecurityService.normalizeValidationResult(payload));
      });
      worker.once('error', (error: Error) => {
        clearTimeout(timeoutId);
        finishReject(error);
      });
      worker.once('exit', (code: number) => {
        if (settled) return;
        clearTimeout(timeoutId);
        if (code === 0) {
          finishResolve({ ok: false, message: 'File content validation failed' });
          return;
        }
        finishReject(new Error(`Upload validation worker exited with code ${code}`));
      });
    });
  }

  private static normalizeValidationResult(result: unknown): UploadValidationResult {
    if (!result || typeof result !== 'object') {
      return { ok: false, message: 'File content validation failed' };
    }
    const record = result as Record<string, unknown>;
    return {
      ok: record.ok === true,
      message: typeof record.message === 'string' ? record.message : ''
    };
  }
}

// ─── Factory ────────────────────────────────────────────────────────────────

export function createUploadSecurityService(config: UploadSecurityServiceConfig): UploadSecurityService {
  return new UploadSecurityService(config);
}
