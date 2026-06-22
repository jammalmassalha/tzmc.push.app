function registerAuthController(app, deps = {}) {
    const {
        normalizeUserCandidate,
        buildUserLookupAliases,
        fetchWithRetry,
        buildGoogleSheetGetUrl,
        googleSheetUrl,
        activeSessionIdsByUser,
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
        requireAuthorizedUser,
        APP_SERVER_TOKEN,
        BADGE_RESET_ALL_ALLOWED_USERS,
        lookupUserByWindowsUsername,
        mysqlLogsService,
        licenserService
    } = deps;
    const resetAllAllowedUserSet = new Set(
        (Array.isArray(BADGE_RESET_ALL_ALLOWED_USERS) ? BADGE_RESET_ALL_ALLOWED_USERS : [])
            .map((value) => normalizeUserCandidate(value))
            .filter(Boolean)
    );

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

    app.get(['/auth/session', '/notify/auth/session'], async (req, res) => {
        const user = normalizeUserCandidate(req.authUser);
        const authSession = req.authSession && typeof req.authSession === 'object' ? req.authSession : null;
        if (!user) {
            return res.json({ authenticated: false, user: null });
        }

        let isRestricted = false;
        if (mysqlLogsService) {
            try {
                const authResult = await mysqlLogsService.checkAuth(user);
                if (authResult && authResult.isRestricted) {
                    isRestricted = true;
                }
            } catch (err) {
                console.error('[AUTH SESSION] Error checking auth status:', err);
            }
        }

        return res.json({
            authenticated: true,
            user,
            isRestricted,
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

    // IP-level rate-limit middleware applied before the request-code handler so
    // that it runs unconditionally, ahead of any authorization checks.
    const rateLimit = require('express-rate-limit');
    const requestCodeIpRateLimit = rateLimit({
        windowMs: AUTH_CODE_RATE_LIMIT_WINDOW_MS,
        limit: AUTH_CODE_REQUEST_RATE_LIMIT_MAX_PER_IP,
        standardHeaders: true,
        legacyHeaders: false,
        keyGenerator: (req) => getClientIpAddress(req),
        handler: (_req, res, _next, options) => {
            const retryAfterSeconds = Math.ceil(options.windowMs / 1000);
            res.setHeader('Retry-After', String(retryAfterSeconds));
            res.status(429).json({
                status: 'error',
                message: 'Too many verification attempts. Please try again later.',
                retryAfterSeconds
            });
        }
    });

    app.post(
        ['/auth/session/request-code', '/notify/auth/session/request-code'],
        requestCodeIpRateLimit,
        async (req, res) => {
            let requestedUser = '';
            try {
                const payload = req.body && typeof req.body === 'object' ? req.body : {};
                requestedUser = normalizeUserCandidate(payload.username || payload.user || payload.phone);
                if (!SESSION_USER_PATTERN.test(requestedUser)) {
                    return res.status(400).json({ status: 'error', message: 'Invalid user' });
                }

                // Per-user rate limit (requires the parsed user identifier).
                const userLimit = consumeRateLimitEntry(
                    authCodeRequestRateLimitByUser,
                    requestedUser,
                    AUTH_CODE_REQUEST_RATE_LIMIT_MAX_PER_USER,
                    AUTH_CODE_RATE_LIMIT_WINDOW_MS
                );
                if (!userLimit.allowed) {
                    const retryAfterSeconds = Math.max(userLimit.retryAfterSeconds || 0, 1);
                    res.setHeader('Retry-After', String(retryAfterSeconds));
                    return res.status(429).json({
                        status: 'error',
                        message: 'Too many verification attempts. Please try again later.',
                        retryAfterSeconds
                    });
                }

                const registrationFlowCheck = ensureRegistrationFlowOnly(req, requestedUser);
                if (!registrationFlowCheck.ok) {
                    return res.status(registrationFlowCheck.status).json({
                        status: 'error',
                        message: registrationFlowCheck.message
                    });
                }

                if (AUTH_CODE_REQUIRE_REGISTERED_USER) {
                    const registrationCheck = await ensureRequestedUserIsRegistered(requestedUser);
                    if (!registrationCheck.ok) {
                        return res.status(registrationCheck.status).json({
                            status: 'error',
                            message: registrationCheck.message
                        });
                    }
                }

                // When a user's Subscribe-table status is empty it means the licenser
                // service on the other server has not yet processed the record.  Poll
                // the Subscribe table until the status column is populated (non-empty),
                // so the correct UI (active vs. restricted) is shown when the user logs
                // in with the SMS code.  A status of '0' means the other server has
                // already marked the user as restricted — no wait is needed in that case.
                //
                // Configurable via env vars:
                //   LICENSER_WAIT_MS            – total wait ceiling (default 45 000 ms)
                //   LICENSER_POLL_INTERVAL_MS   – poll cadence         (default 3 000 ms)
                if (mysqlLogsService) {
                    let authResult = null;
                    try {
                        authResult = await mysqlLogsService.checkAuth(requestedUser);
                    } catch (authCheckErr) {
                        console.error('[AUTH CODE] Status pre-check: could not read Subscribe table:', authCheckErr && authCheckErr.message);
                    }

                    const isPending = authResult && authResult.isPending === true;
                    if (isPending) {
                        const parsePositiveInt = (raw, fallback) => {
                            const n = parseInt(String(raw ?? ''), 10);
                            return Number.isFinite(n) && n > 0 ? n : fallback;
                        };
                        const totalWaitMs = parsePositiveInt(
                            process.env.LICENSER_WAIT_MS,
                            45000
                        );
                        const pollIntervalMs = Math.min(
                            parsePositiveInt(process.env.LICENSER_POLL_INTERVAL_MS, 3000),
                            Math.max(totalWaitMs, 1000)
                        );
                        const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

                        console.log('[AUTH CODE] Status pending for user', requestedUser, '— polling Subscribe table for up to', totalWaitMs, 'ms');
                        const deadline = Date.now() + totalWaitMs;
                        let statusResolved = false;

                        while (!statusResolved && Date.now() < deadline) {
                            const remaining = deadline - Date.now();
                            await sleep(Math.min(pollIntervalMs, Math.max(remaining, 0)));
                            if (Date.now() >= deadline) break;
                            try {
                                const pollResult = await mysqlLogsService.checkAuth(requestedUser);
                                if (pollResult && !pollResult.isPending) {
                                    statusResolved = true;
                                }
                            } catch (err) {
                                console.error('[AUTH CODE] Subscribe table poll error:', err && err.message);
                                break;
                            }
                        }

                        if (statusResolved) {
                            console.log('[AUTH CODE] Status resolved for user', requestedUser, '— proceeding to send SMS');
                        } else {
                            console.log('[AUTH CODE] Status still pending for user', requestedUser, 'after', totalWaitMs, 'ms — sending SMS anyway');
                        }
                    }
                }

                const verificationCode = generateAuthCode();
                await setAuthCodeOnSubscribeSheet(requestedUser, verificationCode);

                // Send SMS asynchronously so the client is not blocked waiting for the
                // SMS gateway. The code is already persisted in the sheet at this point,
                // so verification will work regardless of when the SMS actually delivers.
                sendAuthCodeSms(requestedUser, verificationCode).catch((smsError) => {
                    const reason = smsError && smsError.message ? String(smsError.message) : 'Unknown SMS error';
                    console.error('[AUTH CODE] Background SMS delivery failed for user', requestedUser, ':', reason);
                });

                return res.json({
                    status: 'success',
                    verificationRequired: true,
                    codeSent: true,
                    user: requestedUser,
                    expiresInSeconds: AUTH_CODE_TTL_SECONDS
                });
            } catch (error) {
                const reason = error && error.message ? String(error.message) : 'Unable to send verification code';
                console.error('[AUTH CODE] Failed to send verification code for user', requestedUser, 'error:', reason, error && error.stack ? error.stack : '');
                return res.status(502).json({ status: 'error', message: reason });
            }
        }
    );

    // IP-level rate-limit middleware for the verify-code handler.
    const verifyCodeIpRateLimit = rateLimit({
        windowMs: AUTH_CODE_RATE_LIMIT_WINDOW_MS,
        limit: AUTH_CODE_VERIFY_RATE_LIMIT_MAX_PER_IP,
        standardHeaders: true,
        legacyHeaders: false,
        keyGenerator: (req) => getClientIpAddress(req),
        handler: (_req, res, _next, options) => {
            const retryAfterSeconds = Math.ceil(options.windowMs / 1000);
            res.setHeader('Retry-After', String(retryAfterSeconds));
            res.status(429).json({
                status: 'error',
                message: 'Too many verification attempts. Please try again later.',
                retryAfterSeconds
            });
        }
    });

    app.post(
        ['/auth/session/verify-code', '/notify/auth/session/verify-code'],
        verifyCodeIpRateLimit,
        async (req, res) => {
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

            // Per-user rate limit (requires the parsed user identifier).
            const userLimit = consumeRateLimitEntry(
                authCodeVerifyRateLimitByUser,
                requestedUser,
                AUTH_CODE_VERIFY_RATE_LIMIT_MAX_PER_USER,
                AUTH_CODE_RATE_LIMIT_WINDOW_MS
            );
            if (!userLimit.allowed) {
                const retryAfterSeconds = Math.max(userLimit.retryAfterSeconds || 0, 1);
                res.setHeader('Retry-After', String(retryAfterSeconds));
                return res.status(429).json({
                    status: 'error',
                    message: 'Too many verification attempts. Please try again later.',
                    retryAfterSeconds
                });
            }

            const registrationFlowCheck = ensureRegistrationFlowOnly(req, requestedUser);
            if (!registrationFlowCheck.ok) {
                return res.status(registrationFlowCheck.status).json({
                    status: 'error',
                    message: registrationFlowCheck.message
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

                // After verifying the SMS code, give the external service time to
                // process the user and update their final Status on the Subscribe
                // sheet. The client keeps showing a loader while we hold this
                // response open. Configurable via env vars:
                //   AUTH_CODE_POST_VERIFY_STATUS_WAIT_MS (default 8000)
                //   AUTH_CODE_POST_VERIFY_STATUS_POLL_INTERVAL_MS (default 2000)
                const parsePositiveInt = (raw, fallback) => {
                    const n = parseInt(String(raw ?? ''), 10);
                    return Number.isFinite(n) && n > 0 ? n : fallback;
                };
                const totalWaitMs = parsePositiveInt(
                    process.env.AUTH_CODE_POST_VERIFY_STATUS_WAIT_MS,
                    8000
                );
                const pollIntervalMs = Math.min(
                    parsePositiveInt(process.env.AUTH_CODE_POST_VERIFY_STATUS_POLL_INTERVAL_MS, 2000),
                    Math.max(totalWaitMs, 1000)
                );
                const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

                let isRestricted = false;
                if (mysqlLogsService) {
                    const deadline = Date.now() + totalWaitMs;
                    let lastResult = null;
                    // Initial check so callers whose status is already final return
                    // promptly without waiting the full window.
                    try {
                        lastResult = await mysqlLogsService.checkAuth(requestedUser);
                    } catch (err) {
                        console.error('[AUTH CODE] Error checking auth status during verification:', err);
                    }
                    // Poll only while the status is still empty/pending (external service
                    // hasn't written the correct value yet).  A status of '0' (explicitly
                    // restricted) or '1' (active) means the external service has already
                    // decided — do not wait, use that value as-is.
                    while (
                        lastResult &&
                        lastResult.isPending &&
                        Date.now() < deadline
                    ) {
                        const remaining = deadline - Date.now();
                        await sleep(Math.min(pollIntervalMs, Math.max(remaining, 0)));
                        if (Date.now() >= deadline) break;
                        try {
                            lastResult = await mysqlLogsService.checkAuth(requestedUser);
                        } catch (err) {
                            console.error('[AUTH CODE] Error polling auth status during verification:', err);
                            break;
                        }
                    }
                    if (lastResult && lastResult.isRestricted) {
                        isRestricted = true;
                    }
                }

                setSessionCookie(res, req, sessionToken.token, sessionToken.expiresAt);
                return res.json({
                    status: 'success',
                    authenticated: true,
                    user: requestedUser,
                    isRestricted,
                    expiresAt: sessionToken.expiresAt,
                    csrfToken: sessionToken.csrfToken
                });
            } catch (error) {
                const reason = error && error.message ? String(error.message) : 'Unable to verify code';
                console.error('[AUTH CODE] Failed to verify code:', reason);
                return res.status(502).json({ status: 'error', message: reason });
            }
        }
    );

    app.delete(['/auth/session', '/notify/auth/session'], (req, res) => {
        const authSession = req.authSession && typeof req.authSession === 'object' ? req.authSession : null;
        if (authSession && authSession.user) {
            const userSessions = activeSessionIdsByUser.get(authSession.user);
            if (userSessions) {
                userSessions.delete(String(authSession.sessionId || ''));
                if (userSessions.size === 0) activeSessionIdsByUser.delete(authSession.user);
            }
        }
        clearSessionCookie(res, req);
        return res.json({ status: 'success', authenticated: false });
    });

    // Windows desktop auto-login: looks up the Windows username in column O of
    // the Subscribe sheet and creates a session without requiring SMS verification.
    // Requires a valid APP_SERVER_TOKEN so only the trusted desktop build can use it.
    app.post(
        ['/auth/session/windows-login', '/notify/auth/session/windows-login'],
        async (req, res) => {
            const payload = req.body && typeof req.body === 'object' ? req.body : {};
            const windowsUser = String(payload.windowsUser || '').trim();
            const submittedToken = String(payload.token || '').trim();

            if (!windowsUser) {
                return res.status(400).json({ status: 'error', message: 'Missing windowsUser' });
            }

            const configuredToken = String(APP_SERVER_TOKEN || '').trim();
            if (!configuredToken || submittedToken !== configuredToken) {
                return res.status(403).json({ status: 'error', message: 'Invalid token' });
            }

            if (!SESSION_SIGNING_SECRET) {
                return res.status(500).json({ status: 'error', message: 'Session configuration missing' });
            }

            try {
                const lookupResult = await lookupUserByWindowsUsername(windowsUser);
                if (!lookupResult || !lookupResult.user) {
                    return res.status(403).json({ status: 'error', message: 'Windows user not registered' });
                }

                const matchedUser = normalizeUserCandidate(lookupResult.user);
                if (!matchedUser) {
                    return res.status(403).json({ status: 'error', message: 'Windows user not registered' });
                }

                const sessionToken = createSessionToken(matchedUser);
                if (!sessionToken) {
                    return res.status(500).json({ status: 'error', message: 'Failed to create session' });
                }

                let isRestricted = false;
                if (mysqlLogsService) {
                    try {
                        const authResult = await mysqlLogsService.checkAuth(matchedUser);
                        if (authResult && authResult.isRestricted) {
                            isRestricted = true;
                        }
                    } catch (err) {
                        console.error('[WINDOWS LOGIN] Error checking auth status during login:', err);
                    }
                }

                setSessionCookie(res, req, sessionToken.token, sessionToken.expiresAt);
                console.log('[WINDOWS LOGIN] Auto-login successful for windowsUser:', windowsUser, '→ user:', matchedUser);
                return res.json({
                    status: 'success',
                    authenticated: true,
                    user: matchedUser,
                    isRestricted,
                    expiresAt: sessionToken.expiresAt,
                    csrfToken: sessionToken.csrfToken
                });
            } catch (error) {
                const reason = error && error.message ? String(error.message) : 'Windows login failed';
                console.error('[WINDOWS LOGIN] Error:', reason);
                return res.status(502).json({ status: 'error', message: reason });
            }
        }
    );

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

                const fullName = String(payload.fullName || payload.name || '').trim();
                if (fullName && mysqlLogsService && mysqlLogsService.pool) {
                    try {
                        await mysqlLogsService.pool.execute(
                            'INSERT INTO `Subscribe` (`User`, `ExeptionName`) VALUES (?, ?) ON DUPLICATE KEY UPDATE `ExeptionName` = VALUES(`ExeptionName`)',
                            [username, fullName]
                        );
                    } catch (dbErr) {
                        console.warn('[REGISTER DEVICE] DB ExeptionName update failed:', dbErr && dbErr.message ? dbErr.message : dbErr);
                    }
                }

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
            const body = req.body && typeof req.body === 'object' ? req.body : {};
            const resetAllRaw = body.all ?? body.resetAll ?? body.clearAll ?? false;
            const resetAll = (
                resetAllRaw === true ||
                String(resetAllRaw || '').trim().toLowerCase() === '1' ||
                String(resetAllRaw || '').trim().toLowerCase() === 'true' ||
                String(resetAllRaw || '').trim().toLowerCase() === 'yes'
            );
            const adminToken = String(
                (req.query && req.query.token) ||
                (req.headers && (req.headers['x-admin-token'] || req.headers['x-app-token'])) ||
                ''
            ).trim();
            const hasConfiguredAdminToken = Boolean(String(APP_SERVER_TOKEN || '').trim());
            const isAdminTokenValid = hasConfiguredAdminToken && adminToken === String(APP_SERVER_TOKEN || '').trim();
            const user = req.resolvedUser;
            const normalizedUser = normalizeUserCandidate(user);
            const isAllowedResetAllUser = Boolean(
                normalizedUser && resetAllAllowedUserSet.has(normalizedUser)
            );

            if (resetAll) {
                if (hasConfiguredAdminToken && !isAdminTokenValid && !isAllowedResetAllUser) {
                    return res.status(403).json({ status: 'error', message: 'Forbidden' });
                }
                if (!hasConfiguredAdminToken && !normalizedUser) {
                    return res.status(401).json({ status: 'error', message: 'Authentication required' });
                }
                if (!hasConfiguredAdminToken && !isAllowedResetAllUser) {
                    return res.status(403).json({ status: 'error', message: 'Forbidden' });
                }

                const keys = Object.keys(unreadCounts || {});
                keys.forEach((key) => {
                    delete unreadCounts[key];
                });
                console.log(`[BADGE] Reset all unread counts (${keys.length} keys).`);
                scheduleStateSave();
                return res.json({
                    status: 'success',
                    scope: 'all',
                    clearedKeys: keys.length
                });
            }

            if (user) {
                const aliasCandidates = typeof buildUserLookupAliases === 'function'
                    ? buildUserLookupAliases(user)
                    : [user];
                const normalizedAliases = Array.from(
                    new Set(
                        (Array.isArray(aliasCandidates) ? aliasCandidates : [user])
                            .map((value) => String(value || '').trim().toLowerCase())
                            .filter(Boolean)
                    )
                );
                if (!normalizedAliases.length) {
                    normalizedAliases.push(String(user || '').trim().toLowerCase());
                }
                normalizedAliases.forEach((alias) => {
                    unreadCounts[alias] = 0;
                });
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
