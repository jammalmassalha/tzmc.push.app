// ─── Flutter Push Service ────────────────────────────────────────────────────
// Self-contained delivery path for the Flutter mobile app. Maintains its own
// FCM-token registry (decoupled from the W3C `PushSubscription` records that
// power the Angular web client) and exposes a single helper, `dispatchToUsers`,
// that mirrors the payload-building logic already used by
// `NotificationService.sendPushNotificationToUser` but routes the result
// through Firebase Admin instead of `web-push`.
//
// Goals:
//   1. Touch nothing in the existing web-push pipeline. The Angular frontend
//      keeps using `/register-device` and continues to receive web-push
//      notifications exactly as on `main`.
//   2. Provide a parallel, opt-in path the Flutter app uses on its own
//      endpoints (`/flutter/register-fcm`, `/flutter/unregister-fcm`).
//   3. Reuse the existing payload helpers (compact data + envelope JSON) so
//      Flutter receives the same structured `data` map the Angular service
//      worker already understands.
// ─────────────────────────────────────────────────────────────────────────────

const fs = require('fs');
const path = require('path');

const fsp = fs.promises;

function safeNormalizeUserKey(value) {
    return String(value || '').trim().toLowerCase();
}

function normalizePlatformName(value) {
    const normalized = String(value || '').trim().toLowerCase();
    if (normalized.includes('ios')) return 'ios';
    if (normalized.includes('android')) return 'android';
    return normalized || 'unknown';
}

function isLikelyFcmToken(value) {
    if (typeof value !== 'string') return false;
    const trimmed = value.trim();
    // FCM tokens are typically > 100 chars; APNs device tokens are 64+ hex
    // chars when delivered raw, longer once Firebase wraps them. Reject
    // obviously-bad inputs (URLs, JSON, etc.).
    if (trimmed.length < 32 || trimmed.length > 4096) return false;
    if (trimmed.includes(' ') || trimmed.includes('\n')) return false;
    return true;
}

function createFlutterPushService(options = {}) {
    const {
        stateDir,
        notificationService,
        fcmSender,
        normalizeUserKey,
        logger
    } = options;

    if (!notificationService) {
        throw new Error('flutterPushService: notificationService is required');
    }
    if (!fcmSender || typeof fcmSender.sendFcmNotification !== 'function') {
        throw new Error('flutterPushService: fcmSender.sendFcmNotification is required');
    }

    const log = logger || console;
    const userKeyFn = typeof normalizeUserKey === 'function'
        ? normalizeUserKey
        : safeNormalizeUserKey;

    const tokensFile = stateDir
        ? path.join(stateDir, 'flutter-fcm-tokens.json')
        : null;

    // tokensByUser: Map<username, Map<token, { token, platform, registeredAt, lastSeenAt }>>
    const tokensByUser = new Map();
    // userByToken: Map<token, username>  (one user per token; logging in as a
    // different user moves the token to the new user.)
    const userByToken = new Map();

    let saveTimer = null;
    let saveInFlight = Promise.resolve();
    let loaded = false;

    function snapshotForDisk() {
        const out = {};
        for (const [username, tokenMap] of tokensByUser.entries()) {
            out[username] = Array.from(tokenMap.values());
        }
        return { savedAt: new Date().toISOString(), users: out };
    }

    async function persistNow() {
        if (!tokensFile) return;
        const snapshot = snapshotForDisk();
        const tmp = `${tokensFile}.tmp`;
        try {
            await fsp.mkdir(path.dirname(tokensFile), { recursive: true });
            await fsp.writeFile(tmp, JSON.stringify(snapshot, null, 2), 'utf8');
            await fsp.rename(tmp, tokensFile);
        } catch (error) {
            log.warn(
                '[FLUTTER-FCM] Failed to persist tokens:',
                error && error.message ? error.message : error
            );
        }
    }

    function schedulePersist() {
        if (!tokensFile) return;
        if (saveTimer) return;
        saveTimer = setTimeout(() => {
            saveTimer = null;
            saveInFlight = saveInFlight.then(persistNow, persistNow);
        }, 750);
        if (typeof saveTimer.unref === 'function') saveTimer.unref();
    }

    async function loadFromDisk() {
        if (!tokensFile) {
            loaded = true;
            return;
        }
        try {
            const raw = await fsp.readFile(tokensFile, 'utf8');
            const parsed = JSON.parse(raw);
            const users = parsed && typeof parsed.users === 'object' ? parsed.users : {};
            for (const [usernameRaw, list] of Object.entries(users)) {
                const username = userKeyFn(usernameRaw);
                if (!username || !Array.isArray(list)) continue;
                const tokenMap = new Map();
                for (const entry of list) {
                    if (!entry || typeof entry !== 'object') continue;
                    const token = String(entry.token || '').trim();
                    if (!isLikelyFcmToken(token)) continue;
                    tokenMap.set(token, {
                        token,
                        platform: normalizePlatformName(entry.platform),
                        registeredAt: entry.registeredAt || new Date().toISOString(),
                        lastSeenAt: entry.lastSeenAt || entry.registeredAt || new Date().toISOString()
                    });
                    userByToken.set(token, username);
                }
                if (tokenMap.size) tokensByUser.set(username, tokenMap);
            }
            log.log(
                `[FLUTTER-FCM] Loaded ${userByToken.size} token(s) for ${tokensByUser.size} user(s) from disk`
            );
        } catch (error) {
            if (error && error.code !== 'ENOENT') {
                log.warn(
                    '[FLUTTER-FCM] Failed to load token registry:',
                    error.message ? error.message : error
                );
            }
        } finally {
            loaded = true;
        }
    }

    function _attachToken(username, token, platform) {
        let tokenMap = tokensByUser.get(username);
        if (!tokenMap) {
            tokenMap = new Map();
            tokensByUser.set(username, tokenMap);
        }
        const now = new Date().toISOString();
        const existing = tokenMap.get(token);
        const record = existing
            ? { ...existing, platform, lastSeenAt: now }
            : { token, platform, registeredAt: now, lastSeenAt: now };
        tokenMap.set(token, record);
        userByToken.set(token, username);
    }

    function _detachToken(token) {
        const owner = userByToken.get(token);
        if (!owner) return false;
        userByToken.delete(token);
        const tokenMap = tokensByUser.get(owner);
        if (!tokenMap) return true;
        tokenMap.delete(token);
        if (tokenMap.size === 0) tokensByUser.delete(owner);
        return true;
    }

    function registerToken(input) {
        const { username, token, platform } = input || {};
        const userKey = userKeyFn(username);
        const tokenStr = typeof token === 'string' ? token.trim() : '';
        if (!userKey) {
            const err = new Error('username is required');
            err.statusCode = 400;
            throw err;
        }
        if (!isLikelyFcmToken(tokenStr)) {
            const err = new Error('A valid FCM/APNs token is required');
            err.statusCode = 400;
            throw err;
        }

        // If this token previously belonged to another user, move it. This
        // keeps the registry consistent when a device logs out and a
        // different user logs in on the same install.
        const previousOwner = userByToken.get(tokenStr);
        if (previousOwner && previousOwner !== userKey) {
            const previousMap = tokensByUser.get(previousOwner);
            if (previousMap) {
                previousMap.delete(tokenStr);
                if (previousMap.size === 0) tokensByUser.delete(previousOwner);
            }
        }

        _attachToken(userKey, tokenStr, normalizePlatformName(platform));
        schedulePersist();
        return {
            username: userKey,
            platform: normalizePlatformName(platform),
            tokenCountForUser: (tokensByUser.get(userKey) || new Map()).size
        };
    }

    function unregisterToken(input) {
        const { username, token } = input || {};
        const tokenStr = typeof token === 'string' ? token.trim() : '';
        if (!tokenStr) {
            const err = new Error('token is required');
            err.statusCode = 400;
            throw err;
        }
        const userKey = userKeyFn(username);
        const owner = userByToken.get(tokenStr);
        // Allow unregister even if username doesn't match the stored owner
        // — e.g. when a user is logging out we trust the session-validated
        // call.
        const removed = _detachToken(tokenStr);
        if (removed) schedulePersist();
        return { removed, username: owner || userKey || null };
    }

    function getTokensForUsers(targetUsers) {
        const list = Array.isArray(targetUsers) ? targetUsers : [targetUsers];
        const seen = new Set();
        const out = [];
        for (const raw of list) {
            const userKey = userKeyFn(raw);
            if (!userKey || seen.has(userKey)) continue;
            seen.add(userKey);
            const tokenMap = tokensByUser.get(userKey);
            if (!tokenMap) continue;
            for (const record of tokenMap.values()) {
                out.push({
                    token: record.token,
                    platform: record.platform,
                    username: userKey
                });
            }
        }
        return out;
    }

    function getStats() {
        return {
            users: tokensByUser.size,
            tokens: userByToken.size,
            loaded
        };
    }

    // Build the same payload string `NotificationService.sendPushNotificationToUser`
    // would build for a given message, so the Flutter client receives the
    // identical `data` envelope it already knows how to parse.
    function buildPayloadStringForMessage(message, options = {}) {
        const msg = message && typeof message === 'object' ? message : {};
        const msgBody = (msg.body && typeof msg.body === 'object') ? msg.body : {};
        const customData = (msg.data && typeof msg.data === 'object') ? msg.data : {};
        const messageType = String(customData.type || '').trim().toLowerCase();
        const imageUrl = (typeof msg.image === 'string' && msg.image) ? msg.image : null;
        const messageId = (options && options.messageId)
            || (typeof msg.messageId === 'string' && msg.messageId)
            || null;
        const sender = options && options.sender
            ? String(options.sender)
            : (typeof msg.sender === 'string' && msg.sender) || 'System';

        let title = (typeof msg.title === 'string' && msg.title) || 'Work Alert';

        // Build compactCustomData first so its messageText can serve as a fallback
        // for the notification body when shortText/longText are absent.
        const compactCustomData = notificationService.buildCompactPushCustomData(
            customData,
            messageType
        );

        let body = (typeof msgBody.shortText === 'string' && msgBody.shortText)
            || (typeof msgBody.longText === 'string' && msgBody.longText)
            || (typeof compactCustomData.messageText === 'string' && compactCustomData.messageText)
            || 'New Notification';
        if (messageType === 'reaction') {
            const reactionGroupName = String(customData.groupName || msg.title || sender || '').trim();
            title = reactionGroupName || 'Group';
            body = 'new reaction';
        }

        // Build the payload with display-text fields first so that actual data
        // fields from compactCustomData always win.  This is critical for
        // edit-action: customData.body = the real edited text; if we spread
        // compactCustomData first and then set `body` to the display fallback
        // ('New Notification'), the edited text is overwritten and the Flutter
        // client applies 'New Notification' as the new message body.
        const payloadData = {
            title,
            body,
            badge: 'https://www.tzmc.co.il/subscribes/assets/icon-192.png',
            icon: 'https://www.tzmc.co.il/subscribes/assets/icon-192.png',
            requireInteraction: true,
            image: imageUrl,
            sender,
            messageId: messageId || undefined,
            ...compactCustomData
        };

        const includeNotification = !(
            payloadData.skipNotification === true ||
            payloadData.skipNotification === 'true' ||
            messageType === 'read-receipt' ||
            messageType === 'group-update' ||
            messageType === 'delete-action' ||
            messageType === 'edit-action' ||
            messageType === 'reaction'
        );

        return notificationService.buildPushPayloadString(payloadData, { includeNotification });
    }

    // Dispatch a message to all Flutter tokens registered for the given
    // users. Mirrors the public contract of `sendPushNotificationToUser`
    // but is independent of the web-push pipeline. Failures are logged and
    // never re-thrown — callers should fire-and-forget so the existing
    // notification result is unaffected.
    async function dispatchToUsers(targetUsers, message, sender, options = {}) {
        try {
            if (!loaded) await loadFromDisk();
            const recipients = getTokensForUsers(targetUsers);
            if (!recipients.length) return { delivered: 0, failed: 0, pruned: 0 };

            const payloadString = buildPayloadStringForMessage(message, {
                sender,
                messageId: options && options.messageId
            });

            let delivered = 0;
            let failed = 0;
            let pruned = 0;

            await Promise.all(
                recipients.map(async (recipient) => {
                    const subscription = {
                        endpoint: `fcm:${recipient.token}`,
                        fcmToken: recipient.token,
                        type: recipient.platform === 'ios' ? 'apns' : 'fcm',
                        platform: recipient.platform,
                        username: recipient.username
                    };
                    try {
                        await fcmSender.sendFcmNotification(subscription, payloadString, {
                            TTL: 604800,
                            timeout: 15000
                        });
                        delivered += 1;
                    } catch (error) {
                        failed += 1;
                        const status = error && Number(error.statusCode);
                        if (status === 404 || status === 410) {
                            // Token is dead — prune so we don't keep retrying.
                            if (_detachToken(recipient.token)) {
                                pruned += 1;
                                schedulePersist();
                            }
                        }
                        log.warn(
                            `[FLUTTER-FCM] Send failed user=${recipient.username} ` +
                            `status=${status || 'N/A'} msg=${(error && error.message) || error}`
                        );
                    }
                })
            );

            return { delivered, failed, pruned, recipients: recipients.length };
        } catch (error) {
            log.warn(
                '[FLUTTER-FCM] dispatchToUsers crashed:',
                error && error.message ? error.message : error
            );
            return { delivered: 0, failed: 0, pruned: 0, error: error && error.message };
        }
    }

    return {
        loadFromDisk,
        registerToken,
        unregisterToken,
        getTokensForUsers,
        dispatchToUsers,
        getStats
    };
}

module.exports = {
    createFlutterPushService,
    isLikelyFcmToken,
    normalizePlatformName
};
