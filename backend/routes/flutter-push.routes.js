// ─── Flutter Push Routes ─────────────────────────────────────────────────────
// Dedicated registration endpoints for the Flutter mobile app's FCM tokens.
// Kept entirely separate from the Angular `/register-device` flow so the
// existing web-push pipeline is unaffected.
// ─────────────────────────────────────────────────────────────────────────────

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
        (req, res) => {
            try {
                const body = readBody(req);
                const username = req.resolvedUser || body.username || body.user;
                const token = body.fcmToken || body.token;
                const platform = body.platform || body.deviceType;
                const result = flutterPushService.registerToken({ username, token, platform });
                return res.json({ status: 'success', ...result });
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
        (req, res) => {
            try {
                const body = readBody(req);
                const username = req.resolvedUser || body.username || body.user;
                const token = body.fcmToken || body.token;
                const result = flutterPushService.unregisterToken({ username, token });
                return res.json({ status: 'success', ...result });
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

module.exports = { registerFlutterPushRoutes };
