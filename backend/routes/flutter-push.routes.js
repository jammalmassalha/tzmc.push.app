// ─── Flutter Push Routes ─────────────────────────────────────────────────────
// Dedicated registration endpoints for the Flutter mobile app's FCM tokens.
// Kept entirely separate from the Angular `/register-device` flow so the
// existing web-push pipeline is unaffected.
//
// Sheet sync: in addition to keeping the FCM token in the local registry,
// each register/unregister call POSTs a marker payload to the same Google
// Apps Script URL the Angular client uses, so the spreadsheet records who
// is connected via the Flutter app:
//   • column L  ←  Flutter Mobile  (Android / iOS)
//   • column M  ←  Flutter Web     (PWA / browser)
// The Apps Script discriminates Flutter rows via `source: 'flutter'` and
// writes the value to the column named in `targetColumn`.
// ─────────────────────────────────────────────────────────────────────────────

const FLUTTER_MOBILE_SHEET_COLUMN = 'L';
const FLUTTER_WEB_SHEET_COLUMN = 'M';

function classifyFlutterPlatform(rawPlatform) {
    const normalized = String(rawPlatform || '').trim().toLowerCase();
    if (normalized === 'web' || normalized === 'pwa' || normalized === 'browser') {
        return { kind: 'web', column: FLUTTER_WEB_SHEET_COLUMN };
    }
    // Default everything else (android, ios, mobile, …) to the mobile column.
    return { kind: 'mobile', column: FLUTTER_MOBILE_SHEET_COLUMN };
}

function buildFlutterSheetPayload({ username, platform, fcmToken, action }) {
    const classification = classifyFlutterPlatform(platform);
    return {
        username,
        action, // 'subscribe' | 'unsubscribe'
        source: 'flutter',
        client: 'flutter',
        flutterPlatform: classification.kind, // 'mobile' | 'web'
        platform: String(platform || classification.kind),
        targetColumn: classification.column, // 'L' or 'M'
        column: classification.column,
        fcmToken: fcmToken || undefined,
        timestamp: new Date().toISOString()
    };
}

function syncFlutterRegistrationToSheet(deps, payload) {
    const sheetUrl = deps && typeof deps.googleSheetUrl === 'string' ? deps.googleSheetUrl.trim() : '';
    const fetcher = deps && typeof deps.fetchWithRetry === 'function' ? deps.fetchWithRetry : null;
    if (!sheetUrl || !fetcher) return Promise.resolve(null);
    return fetcher(
        sheetUrl,
        {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        },
        { timeoutMs: 15000, retries: 2, backoffMs: 700 }
    ).catch((error) => {
        console.warn(
            '[FLUTTER-FCM] Google Sheet sync failed:',
            error && error.message ? error.message : error
        );
        return null;
    });
}

function registerFlutterPushRoutes(app, deps = {}) {
    const { flutterPushService, requireAuthorizedUser } = deps;
    if (!app) throw new Error('flutter-push.routes: app is required');
    if (!flutterPushService) throw new Error('flutter-push.routes: flutterPushService is required');
    if (typeof requireAuthorizedUser !== 'function') {
        throw new Error('flutter-push.routes: requireAuthorizedUser middleware is required');
    }

    const authMiddleware = requireAuthorizedUser({
        required: true,
        candidateKeys: ['username', 'user'],
        onError: (_req, res, resolution) =>
            res.status(resolution.status).json({ status: 'error', message: resolution.error })
    });

    function readBody(req) {
        return (req && req.body && typeof req.body === 'object') ? req.body : {};
    }

    app.post(
        ['/flutter/register-fcm', '/notify/flutter/register-fcm'],
        authMiddleware,
        async (req, res) => {
            try {
                const body = readBody(req);
                const username = req.resolvedUser || body.username || body.user;
                const token = body.fcmToken || body.token;
                const platform = body.platform || body.deviceType;
                const result = flutterPushService.registerToken({ username, token, platform });
                const sheetPayload = buildFlutterSheetPayload({
                    username: result.username,
                    platform,
                    fcmToken: token,
                    action: 'subscribe'
                });
                // Fire-and-forget: don't block the API response on the sheet
                // round-trip and don't fail the registration if the sheet
                // sync errors (already handled inside the helper).
                syncFlutterRegistrationToSheet(deps, sheetPayload);
                return res.json({
                    status: 'success',
                    ...result,
                    sheetColumn: sheetPayload.targetColumn
                });
            } catch (error) {
                const status = (error && Number(error.statusCode)) || 500;
                console.error(
                    '[FLUTTER-FCM] register-fcm failed:',
                    error && error.message ? error.message : error
                );
                return res.status(status).json({
                    status: 'error',
                    message: (error && error.message) || 'Failed to register FCM token'
                });
            }
        }
    );

    app.post(
        ['/flutter/unregister-fcm', '/notify/flutter/unregister-fcm'],
        authMiddleware,
        async (req, res) => {
            try {
                const body = readBody(req);
                const username = req.resolvedUser || body.username || body.user;
                const token = body.fcmToken || body.token;
                const platform = body.platform || body.deviceType;
                const result = flutterPushService.unregisterToken({ username, token });
                const sheetPayload = buildFlutterSheetPayload({
                    username: result.username || username,
                    platform,
                    fcmToken: token,
                    action: 'unsubscribe'
                });
                syncFlutterRegistrationToSheet(deps, sheetPayload);
                return res.json({
                    status: 'success',
                    ...result,
                    sheetColumn: sheetPayload.targetColumn
                });
            } catch (error) {
                const status = (error && Number(error.statusCode)) || 500;
                console.error(
                    '[FLUTTER-FCM] unregister-fcm failed:',
                    error && error.message ? error.message : error
                );
                return res.status(status).json({
                    status: 'error',
                    message: (error && error.message) || 'Failed to unregister FCM token'
                });
            }
        }
    );
}

module.exports = {
    registerFlutterPushRoutes,
    classifyFlutterPlatform,
    buildFlutterSheetPayload,
    FLUTTER_MOBILE_SHEET_COLUMN,
    FLUTTER_WEB_SHEET_COLUMN
};
