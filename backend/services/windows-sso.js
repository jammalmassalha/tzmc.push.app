'use strict';

const crypto = require('crypto');

/**
 * Windows Integrated Authentication (SSO) identity resolution.
 *
 * The browser cannot tell us the Windows login name — the sandbox exposes no
 * such API. The only trustworthy source is a reverse proxy (IIS with Windows
 * Authentication, or nginx/Apache with mod_auth_gssapi) that terminates the
 * Negotiate handshake and injects the authenticated principal as a header.
 *
 * That makes the header a *credential*, so this module is deliberately
 * fail-closed:
 *
 *   * SSO is off unless `WINDOWS_SSO_ENABLED` is explicitly turned on. A
 *     deployment with no proxy in front of it therefore ignores the header
 *     completely, instead of trusting whatever a client sends.
 *   * When `WINDOWS_SSO_SIGNATURE_SECRET` is set, the proxy must also send an
 *     HMAC of the principal. This is what protects the hop between the proxy
 *     and Node when they are not on the same host.
 *
 * Neither guard removes the operator's obligation to strip the inbound header
 * at the proxy and to keep Node off the public network — see PLATFORM_SETUP.md.
 */

/** Default header carrying the principal, matching common IIS/ARR setups. */
const DEFAULT_SSO_USER_HEADER = 'x-remote-user';

/** Default header carrying the HMAC of the principal. */
const DEFAULT_SSO_SIGNATURE_HEADER = 'x-remote-user-signature';

/**
 * Longest accepted principal. `sAMAccountName` maxes out at 20 characters and
 * a UPN at 256; the bound simply stops an absurd header from reaching the
 * lookup.
 */
const MAX_PRINCIPAL_LENGTH = 256;

/**
 * Characters allowed in the account portion of a principal.
 *
 * Windows already forbids `" / \ [ ] : ; | = , + * ? < >` in a
 * `sAMAccountName`. Restricting to this set keeps a hostile header from
 * smuggling control characters or separators into the downstream sheet lookup.
 */
const PRINCIPAL_ACCOUNT_PATTERN = /^[A-Za-z0-9._-]+$/;

function readEnvFlag(value, fallback = false) {
    if (value === undefined || value === null || value === '') return fallback;
    const normalized = String(value).trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
    if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
    return fallback;
}

/**
 * Reduce a Windows principal to the bare account name used for the lookup.
 *
 * Accepts the shapes a proxy may produce and returns '' for anything else:
 *   - `DOMAIN\jmassalha`     → `jmassalha`
 *   - `jmassalha@tzmc.co.il` → `jmassalha`
 *   - `jmassalha`            → `jmassalha`
 *
 * A value carrying both a domain prefix and a UPN suffix is rejected rather
 * than "cleaned up", since that combination is malformed and most likely
 * hand-crafted.
 */
function normalizeWindowsPrincipal(value) {
    if (value === null || value === undefined) return '';
    if (typeof value === 'object') return '';

    const raw = String(value).trim();
    if (!raw || raw.length > MAX_PRINCIPAL_LENGTH) return '';

    // Reject embedded NULs/newlines outright — a header should never contain
    // them, and they are the classic vehicle for downstream injection.
    if (/[\0\r\n]/.test(raw)) return '';

    const hasDomainPrefix = raw.includes('\\');
    const hasUpnSuffix = raw.includes('@');
    if (hasDomainPrefix && hasUpnSuffix) return '';

    let account = raw;
    if (hasDomainPrefix) {
        const parts = raw.split('\\');
        // Exactly one separator: `DOMAIN\user`.
        if (parts.length !== 2) return '';
        if (!parts[0].trim()) return '';
        account = parts[1];
    } else if (hasUpnSuffix) {
        const parts = raw.split('@');
        if (parts.length !== 2) return '';
        if (!parts[1].trim()) return '';
        account = parts[0];
    }

    account = account.trim();
    if (!account || !PRINCIPAL_ACCOUNT_PATTERN.test(account)) return '';

    return account.toLowerCase();
}

/**
 * Constant-time comparison that tolerates differing lengths.
 *
 * `crypto.timingSafeEqual` throws when the buffers differ in length, and
 * returning early on that would leak the signature length through timing.
 */
function safeCompare(a, b) {
    const bufferA = Buffer.from(String(a || ''), 'utf8');
    const bufferB = Buffer.from(String(b || ''), 'utf8');
    if (bufferA.length !== bufferB.length) {
        // Still perform a comparison so the work is length-independent.
        crypto.timingSafeEqual(bufferA, bufferA);
        return false;
    }
    return crypto.timingSafeEqual(bufferA, bufferB);
}

/**
 * HMAC-SHA256 of the *normalized* principal, hex encoded.
 *
 * Signing the normalized form means the proxy and this server agree on one
 * canonical string, so `DOMAIN\User` and `user@domain` cannot produce two
 * different valid signatures for the same account.
 */
function signWindowsPrincipal(principal, secret) {
    const normalized = normalizeWindowsPrincipal(principal);
    if (!normalized || !secret) return '';
    return crypto.createHmac('sha256', String(secret)).update(normalized).digest('hex');
}

/**
 * Read the SSO configuration from an environment-like object.
 */
function resolveWindowsSsoConfig(env = process.env) {
    const source = env && typeof env === 'object' ? env : {};
    const userHeader = String(source.WINDOWS_SSO_USER_HEADER || DEFAULT_SSO_USER_HEADER)
        .trim()
        .toLowerCase() || DEFAULT_SSO_USER_HEADER;
    const signatureHeader = String(
        source.WINDOWS_SSO_SIGNATURE_HEADER || DEFAULT_SSO_SIGNATURE_HEADER
    ).trim().toLowerCase() || DEFAULT_SSO_SIGNATURE_HEADER;

    return {
        enabled: readEnvFlag(source.WINDOWS_SSO_ENABLED, false),
        userHeader,
        signatureHeader,
        signatureSecret: String(source.WINDOWS_SSO_SIGNATURE_SECRET || '').trim(),
    };
}

/**
 * Resolve the authenticated Windows account from request headers.
 *
 * Returns `{ user, reason }`. `user` is '' whenever the request must not be
 * authenticated, with `reason` describing why (for logging only — it is never
 * returned to the caller, so a prober learns nothing about the configuration).
 */
function resolveWindowsSsoUser(headers, config) {
    const settings = config || resolveWindowsSsoConfig();
    if (!settings.enabled) {
        return { user: '', reason: 'disabled' };
    }

    const source = headers && typeof headers === 'object' ? headers : {};
    const rawPrincipal = source[settings.userHeader];
    // A duplicated header arrives as an array. Trusting either element would
    // let a client append a second value to whatever the proxy set, so the
    // whole request is refused.
    if (Array.isArray(rawPrincipal)) {
        return { user: '', reason: 'duplicate-header' };
    }

    const principal = normalizeWindowsPrincipal(rawPrincipal);
    if (!principal) {
        return { user: '', reason: 'missing-or-invalid-principal' };
    }

    if (settings.signatureSecret) {
        const provided = source[settings.signatureHeader];
        if (!provided || Array.isArray(provided)) {
            return { user: '', reason: 'missing-signature' };
        }
        const expected = signWindowsPrincipal(principal, settings.signatureSecret);
        if (!expected || !safeCompare(String(provided).trim().toLowerCase(), expected)) {
            return { user: '', reason: 'invalid-signature' };
        }
    }

    return { user: principal, reason: 'ok' };
}

module.exports = {
    DEFAULT_SSO_USER_HEADER,
    DEFAULT_SSO_SIGNATURE_HEADER,
    MAX_PRINCIPAL_LENGTH,
    normalizeWindowsPrincipal,
    signWindowsPrincipal,
    resolveWindowsSsoConfig,
    resolveWindowsSsoUser,
};
