function registerAuthController(app, deps = {}) {
    const {
        normalizeUserCandidate,
        fetchWithRetry,
        buildGoogleSheetGetUrl,
        googleSheetUrl,
        activeSessionIdByUser,
        clearSessionCookie,
        SESSION_USER_PATTERN,
        ensureRegistrationFlowOnly,
        getClientIpAddress,
        consumeRateLimitEntry,
        authCodeRequestRateLimitByIp,
        AUTH_CODE_REQUEST_RATE_LIMIT_MAX_PER_IP,
        AUTH_CODE_RATE_LIMIT_WINDOW_MS,
        authCodeRequestRateLimitByUser,
        AUTH_CODE_REQUEST_RATE_LIMIT_MAX_PER_USER,
        AUTH_CODE_REQUIRE_REGISTERED_USER,
        ensureRequestedUserIsRegistered,
        generateAuthCode,
        setAuthCodeOnSubscribeSheet,
        sendAuthCodeSms,
        AUTH_CODE_TTL_SECONDS,
        normalizeAuthCode,
        AUTH_CODE_PATTERN,
        SESSION_SIGNING_SECRET,
        authCodeVerifyRateLimitByIp,
        AUTH_CODE_VERIFY_RATE_LIMIT_MAX_PER_IP,
        authCodeVerifyRateLimitByUser,
        AUTH_CODE_VERIFY_RATE_LIMIT_MAX_PER_USER,
        verifyAuthCodeFromSubscribeSheet,
        createSessionToken,
        setSessionCookie,
        upsertLocalDeviceSubscriptionsFromRegistration,
        scheduleStateSave,
        unreadCounts,
        requireAuthorizedUser
    } = deps;

    const requireAuthorizedSheetUser = typeof requireAuthorizedUser === 'function'
        ? requireAuthorizedUser({
            required: true,
            candidateKeys: ['user', 'username'],
            onError: (_req, res, resolution) => res.status(resolution.status).json({
                result: 'error',
                message: resolution.error || 'Authentication required'
            })
        })
        : (_req, _res, next) => next();

    app.get(
        ['/hr/steps', '/notify/hr/steps'],
        requireAuthorizedSheetUser,
        async (_req, res) => {
            try {
                const response = await fetchWithRetry(
                    buildGoogleSheetGetUrl({ action: 'get_hr_steps' }),
                    {},
                    { timeoutMs: 12000, retries: 2, backoffMs: 500 }
                );
                const bodyText = String(await response.text() || '').trim();
                if (!response.ok) {
                    return res.status(response.status).json({ result: 'error', data: [] });
                }
                try {
                    return res.json(JSON.parse(bodyText));
                } catch {
                    return res.json({ result: 'error', data: [] });
                }
            } catch (error) {
                const message = error && error.message ? String(error.message) : 'HR steps fetch failed';
                return res.status(502).json({ result: 'error', message, data: [] });
            }
        }
    );

    app.get(
        ['/hr/actions', '/notify/hr/actions'],
        requireAuthorizedSheetUser,
        async (req, res) => {
            const serviceId = String(req && req.query ? req.query.serviceId : '').trim();
            if (!serviceId) {
                return res.json({ result: 'success', data: [] });
            }
            try {
                const response = await fetchWithRetry(
                    buildGoogleSheetGetUrl({ action: 'get_hr_steps_action', serviceId }),
                    {},
                    { timeoutMs: 12000, retries: 2, backoffMs: 500 }
                );
                const bodyText = String(await response.text() || '').trim();
                if (!response.ok) {
                    return res.status(response.status).json({ result: 'error', data: [] });
                }
                try {
                    return res.json(JSON.parse(bodyText));
                } catch {
                    return res.json({ result: 'error', data: [] });
                }
            } catch (error) {
                const message = error && error.message ? String(error.message) : 'HR actions fetch failed';
                return res.status(502).json({ result: 'error', message, data: [] });
            }
        }
    );

    app.get(
        ['/subscriptions', '/notify/subscriptions'],
        requireAuthorizedSheetUser,
        async (req, res) => {
            const username = req.resolvedUser || '';
            if (!username) {
                return res.status(400).json({ result: 'error', subscriptions: [], message: 'Missing username' });
            }
            try {
                const response = await fetchWithRetry(
                    buildGoogleSheetGetUrl({ action: 'get_subscriptions', username }),
                    {},
                    { timeoutMs: 12000, retries: 2, backoffMs: 500 }
                );
                const bodyText = String(await response.text() || '').trim();
                if (!response.ok) {
                    return res.status(response.status).json({ result: 'error', subscriptions: [] });
                }
                try {
                    return res.json(JSON.parse(bodyText));
                } catch {
                    return res.json({ result: 'error', subscriptions: [] });
                }
            } catch (error) {
                const message = error && error.message ? String(error.message) : 'Subscriptions fetch failed';
                return res.status(502).json({ result: 'error', message, subscriptions: [] });
            }
        }
    );

    app.get(['/auth/session', '/notify/auth/session'], (req, res) => {
        const user = normalizeUserCandidate(req.authUser);
        const authSession = req.authSession && typeof req.authSession === 'object' ? req.authSession : null;
        if (!user) {
            return res.json({ authenticated: false, user: null });
        }
        return res.json({
            authenticated: true,
            user,
            csrfToken: authSession && authSession.csrfToken ? authSession.csrfToken : null
        });
    });

    app.post(['/auth/session', '/notify/auth/session'], (_req, res) => {
        return res.status(410).json({
            status: 'error',
            message: 'Direct login is disabled. Use SMS verification code flow.',
            verificationRequired: true,
            legacyLoginDisabled: true
        });
    });

    app.post(['/auth/session/request-code', '/notify/auth/session/request-code'], async (req, res) => {
        const payload = req.body && typeof req.body === 'object' ? req.body : {};
        const requestedUser = normalizeUserCandidate(payload.username || payload.user || payload.phone);
        if (!SESSION_USER_PATTERN.test(requestedUser)) {
            return res.status(400).json({ status: 'error', message: 'Invalid user' });
        }
        const registrationFlowCheck = ensureRegistrationFlowOnly(req, requestedUser);
        if (!registrationFlowCheck.ok) {
            return res.status(registrationFlowCheck.status).json({
                status: 'error',
                message: registrationFlowCheck.message
            });
        }

        const clientIp = getClientIpAddress(req);
        const ipLimit = consumeRateLimitEntry(
            authCodeRequestRateLimitByIp,
            clientIp,
            AUTH_CODE_REQUEST_RATE_LIMIT_MAX_PER_IP,
            AUTH_CODE_RATE_LIMIT_WINDOW_MS
        );
        const userLimit = consumeRateLimitEntry(
            authCodeRequestRateLimitByUser,
            requestedUser,
            AUTH_CODE_REQUEST_RATE_LIMIT_MAX_PER_USER,
            AUTH_CODE_RATE_LIMIT_WINDOW_MS
        );
        if (!ipLimit.allowed || !userLimit.allowed) {
            const retryAfterSeconds = Math.max(ipLimit.retryAfterSeconds || 0, userLimit.retryAfterSeconds || 0, 1);
            res.setHeader('Retry-After', String(retryAfterSeconds));
            return res.status(429).json({
                status: 'error',
                message: 'Too many verification attempts. Please try again later.',
                retryAfterSeconds
            });
        }

        try {
            if (AUTH_CODE_REQUIRE_REGISTERED_USER) {
                const registrationCheck = await ensureRequestedUserIsRegistered(requestedUser);
                if (!registrationCheck.ok) {
                    return res.status(registrationCheck.status).json({
                        status: 'error',
                        message: registrationCheck.message
                    });
                }
            }

            const verificationCode = generateAuthCode();
            await setAuthCodeOnSubscribeSheet(requestedUser, verificationCode);
            await sendAuthCodeSms(requestedUser, verificationCode);

            return res.json({
                status: 'success',
                verificationRequired: true,
                codeSent: true,
                user: requestedUser,
                expiresInSeconds: AUTH_CODE_TTL_SECONDS
            });
        } catch (error) {
            const reason = error && error.message ? String(error.message) : 'Unable to send verification code';
            console.error('[AUTH CODE] Failed to send verification code:', reason);
            return res.status(502).json({ status: 'error', message: reason });
        }
    });

    app.post(['/auth/session/verify-code', '/notify/auth/session/verify-code'], async (req, res) => {
        const payload = req.body && typeof req.body === 'object' ? req.body : {};
        const requestedUser = normalizeUserCandidate(payload.username || payload.user || payload.phone);
        const submittedCode = normalizeAuthCode(payload.code || payload.otp || payload.verificationCode);
        if (!SESSION_USER_PATTERN.test(requestedUser)) {
            return res.status(400).json({ status: 'error', message: 'Invalid user' });
        }
        if (!AUTH_CODE_PATTERN.test(submittedCode)) {
            return res.status(400).json({ status: 'error', message: 'Invalid verification code' });
        }
        if (!SESSION_SIGNING_SECRET) {
            return res.status(500).json({ status: 'error', message: 'Session configuration missing' });
        }
        const registrationFlowCheck = ensureRegistrationFlowOnly(req, requestedUser);
        if (!registrationFlowCheck.ok) {
            return res.status(registrationFlowCheck.status).json({
                status: 'error',
                message: registrationFlowCheck.message
            });
        }

        const clientIp = getClientIpAddress(req);
        const ipLimit = consumeRateLimitEntry(
            authCodeVerifyRateLimitByIp,
            clientIp,
            AUTH_CODE_VERIFY_RATE_LIMIT_MAX_PER_IP,
            AUTH_CODE_RATE_LIMIT_WINDOW_MS
        );
        const userLimit = consumeRateLimitEntry(
            authCodeVerifyRateLimitByUser,
            requestedUser,
            AUTH_CODE_VERIFY_RATE_LIMIT_MAX_PER_USER,
            AUTH_CODE_RATE_LIMIT_WINDOW_MS
        );
        if (!ipLimit.allowed || !userLimit.allowed) {
            const retryAfterSeconds = Math.max(ipLimit.retryAfterSeconds || 0, userLimit.retryAfterSeconds || 0, 1);
            res.setHeader('Retry-After', String(retryAfterSeconds));
            return res.status(429).json({
                status: 'error',
                message: 'Too many verification attempts. Please try again later.',
                retryAfterSeconds
            });
        }

        try {
            if (AUTH_CODE_REQUIRE_REGISTERED_USER) {
                const registrationCheck = await ensureRequestedUserIsRegistered(requestedUser);
                if (!registrationCheck.ok) {
                    return res.status(registrationCheck.status).json({
                        status: 'error',
                        message: registrationCheck.message
                    });
                }
            }

            const verified = await verifyAuthCodeFromSubscribeSheet(requestedUser, submittedCode);
            if (!verified) {
                return res.status(401).json({ status: 'error', message: 'Invalid verification code' });
            }

            const sessionToken = createSessionToken(requestedUser);
            if (!sessionToken) {
                return res.status(500).json({ status: 'error', message: 'Failed to create session' });
            }

            setSessionCookie(res, req, sessionToken.token, sessionToken.expiresAt);
            return res.json({
                status: 'success',
                authenticated: true,
                user: requestedUser,
                expiresAt: sessionToken.expiresAt,
                csrfToken: sessionToken.csrfToken
            });
        } catch (error) {
            const reason = error && error.message ? String(error.message) : 'Unable to verify code';
            console.error('[AUTH CODE] Failed to verify code:', reason);
            return res.status(502).json({ status: 'error', message: reason });
        }
    });

    app.delete(['/auth/session', '/notify/auth/session'], (req, res) => {
        const authSession = req.authSession && typeof req.authSession === 'object' ? req.authSession : null;
        if (authSession && authSession.user) {
            const currentSessionId = String(activeSessionIdByUser.get(authSession.user) || '').trim();
            if (!currentSessionId || currentSessionId === String(authSession.sessionId || '')) {
                activeSessionIdByUser.delete(authSession.user);
            }
        }
        clearSessionCookie(res, req);
        return res.json({ status: 'success', authenticated: false });
    });

    app.post(
        ['/register-device', '/notify/register-device'],
        requireAuthorizedUser({
            required: true,
            candidateKeys: ['username', 'user'],
            onError: (_req, res, resolution) => res.status(resolution.status).json({ status: 'error', message: resolution.error })
        }),
        async (req, res) => {
            try {
                const payload = req.body && typeof req.body === 'object' ? req.body : {};
                const username = req.resolvedUser;

                const trackedSubscriptions = upsertLocalDeviceSubscriptionsFromRegistration({
                    ...payload,
                    username
                });
                if (!trackedSubscriptions) {
                    return res.status(400).json({ status: 'error', message: 'Missing valid subscription payload' });
                }

                scheduleStateSave();

                const sheetPayload = {
                    ...payload,
                    username
                };
                const syncToSheetTask = (typeof fetchWithRetry === 'function' && typeof googleSheetUrl === 'string' && googleSheetUrl.trim())
                    ? fetchWithRetry(
                        String(googleSheetUrl).trim(),
                        {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify(sheetPayload)
                        },
                        { timeoutMs: 15000, retries: 2, backoffMs: 700 }
                    ).catch((error) => {
                        console.warn('[REGISTER DEVICE] Google Sheet sync failed:', error && error.message ? error.message : error);
                        return null;
                    })
                    : Promise.resolve(null);

                await syncToSheetTask;
                return res.json({
                    status: 'success',
                    username,
                    trackedSubscriptions
                });
            } catch (error) {
                console.error('[REGISTER DEVICE] Failed:', error.message);
                return res.status(500).json({ status: 'error', message: error.message });
            }
        }
    );

    app.post(
        ['/reset-badge', '/notify/reset-badge'],
        requireAuthorizedUser({
            required: false,
            candidateKeys: ['user'],
            onError: (_req, res, resolution) => res.status(resolution.status).json({ status: 'error', message: resolution.error })
        }),
        (req, res) => {
            const user = req.resolvedUser;
            if (user) {
                unreadCounts[user] = 0;
                console.log(`[BADGE] Reset count for ${user}`);
                scheduleStateSave();
            }
            return res.json({ status: 'success' });
        }
    );
}

module.exports = {
    registerAuthController
};
