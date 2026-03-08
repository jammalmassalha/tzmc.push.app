import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

function toBase64Url(data: Buffer): string {
  return data.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function fromBase64Url(value: string): Buffer {
  const normalized = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
  const pad = normalized.length % 4 === 0 ? '' : '='.repeat(4 - (normalized.length % 4));
  return Buffer.from(normalized + pad, 'base64');
}

function toUtf8Json(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value), 'utf8');
}

function parseUtf8Json<T>(value: Buffer): T | null {
  try {
    return JSON.parse(value.toString('utf8')) as T;
  } catch {
    return null;
  }
}

export function looksLikeJweCompactToken(rawToken: unknown): boolean {
  const token = String(rawToken ?? '').trim();
  if (!token) return false;
  const parts = token.split('.');
  return parts.length === 5;
}

export class SessionTokenJweService {
  private readonly key: Buffer;

  constructor(secret: string) {
    const normalizedSecret = String(secret || '').trim();
    this.key = createHash('sha256').update(normalizedSecret || 'tzmc-default-session-key').digest();
  }

  encrypt(payload: Record<string, unknown>): string {
    const protectedHeader = { alg: 'dir', enc: 'A256GCM', typ: 'JWE' };
    const encodedHeader = toBase64Url(toUtf8Json(protectedHeader));
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(encodedHeader, 'utf8'));
    const encrypted = Buffer.concat([cipher.update(toUtf8Json(payload)), cipher.final()]);
    const tag = cipher.getAuthTag();

    // Compact serialization with direct encryption has empty encrypted_key segment.
    return `${encodedHeader}..${toBase64Url(iv)}.${toBase64Url(encrypted)}.${toBase64Url(tag)}`;
  }

  decrypt<T extends Record<string, unknown>>(token: string): T | null {
    if (!looksLikeJweCompactToken(token)) {
      return null;
    }
    const parts = String(token || '').trim().split('.');
    if (parts.length !== 5) {
      return null;
    }
    const [encodedHeader, encodedEncryptedKey, encodedIv, encodedCiphertext, encodedTag] = parts;
    if (!encodedHeader || encodedEncryptedKey !== '' || !encodedIv || !encodedCiphertext || !encodedTag) {
      return null;
    }

    try {
      const header = parseUtf8Json<{ alg?: string; enc?: string }>(fromBase64Url(encodedHeader));
      if (!header || header.alg !== 'dir' || header.enc !== 'A256GCM') {
        return null;
      }
      const iv = fromBase64Url(encodedIv);
      const ciphertext = fromBase64Url(encodedCiphertext);
      const authTag = fromBase64Url(encodedTag);
      if (iv.length !== 12 || authTag.length !== 16) {
        return null;
      }

      const decipher = createDecipheriv('aes-256-gcm', this.key, iv);
      decipher.setAAD(Buffer.from(encodedHeader, 'utf8'));
      decipher.setAuthTag(authTag);
      const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      return parseUtf8Json<T>(plaintext);
    } catch {
      return null;
    }
  }
}
