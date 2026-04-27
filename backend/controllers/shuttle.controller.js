function resolveTodayIsoDate() {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function isLikelyHtmlPayload(payloadText) {
    return /<html[\s>]/i.test(payloadText) || /<body[\s>]/i.test(payloadText);
}

function extractMovedTemporarilyHref(payloadText) {
    const hrefMatch = String(payloadText || '').match(/<a[^>]+href="([^"]+)"/i);
    const href = String((hrefMatch && hrefMatch[1]) || '').trim();
    if (!href) return '';
    const decodedHref = href.replace(/&amp;/g, '&');
    if (!/^https:\/\/script\.googleusercontent\.com\//i.test(decodedHref)) {
        return '';
    }
    return decodedHref;
}

async function fetchShuttleOrdersProxyPayloadText(requestUrl, deps = {}) {
    const {
        fetchWithRetry
    } = deps;
    if (typeof fetchWithRetry !== 'function') {
        throw new Error('fetchWithRetry dependency is required');
    }
    const requestOptions = {
        timeoutMs: 60000,
        retries: 1,
        backoffMs: 700
    };

    const response = await fetchWithRetry(requestUrl, {}, requestOptions);
    if (!response.ok) {
        throw new Error(`Shuttle orders request failed (${response.status})`);
    }
    const body = String(await response.text() || '');
    if (!isLikelyHtmlPayload(body)) {
        return body;
    }

    const fallbackHref = extractMovedTemporarilyHref(body);
    if (!fallbackHref) {
        if (/accounts\.google\.com/i.test(body)) {
            throw new Error('Shuttle orders endpoint is not publicly accessible');
        }
        throw new Error('Shuttle orders endpoint returned unexpected HTML');
    }

    const fallbackResponse = await fetchWithRetry(fallbackHref, {}, requestOptions);
    if (!fallbackResponse.ok) {
        throw new Error(`Shuttle orders fallback request failed (${fallbackResponse.status})`);
    }
    return String(await fallbackResponse.text() || '');
}

function parseShuttleOrdersProxyPayload(payloadText) {
    const raw = String(payloadText || '').trim();
    if (!raw) {
        return {
            result: 'success',
            orders: []
        };
    }

    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch (_error) {
        throw new Error('Invalid shuttle orders payload');
    }

    if (Array.isArray(parsed)) {
        return {
            result: 'success',
            orders: parsed
        };
    }

    if (!parsed || typeof parsed !== 'object') {
        throw new Error('Invalid shuttle orders payload');
    }

    return parsed;
}

function parseJsonStringArray(payloadText) {
    try {
        const parsed = JSON.parse(String(payloadText || ''));
        if (!Array.isArray(parsed)) return [];
        return parsed
            .map((item) => String(item || '').trim())
            .filter(Boolean);
    } catch (_error) {
        return [];
    }
}

function buildShuttleOperationsProxyResponse(payload, source, startedAt) {
    const normalizedSource = source === 'cache' ? 'cache' : 'remote';
    const basePayload = (payload && typeof payload === 'object' && !Array.isArray(payload))
        ? payload
        : {
            result: 'success',
            orders: Array.isArray(payload) ? payload : []
        };
    return {
        ...basePayload,
        source: normalizedSource,
        proxyMs: Math.max(0, Date.now() - Number(startedAt || Date.now()))
    };
}

const SHUTTLE_OPERATIONS_PROXY_CACHE_TTL_MS = 90 * 1000;
const shuttleOperationsProxyCacheByDate = new Map();
const shuttleOperationsProxyInFlightByDate = new Map();
const SHUTTLE_ENTRY_EMPLOYEE = 'entry.1035269960';
const SHUTTLE_ENTRY_DATE = 'entry.794242217';
const SHUTTLE_ENTRY_DATE_ALT = 'entry.794242217_22';
const SHUTTLE_ENTRY_SHIFT = 'entry.1992732561';
const SHUTTLE_ENTRY_STATION = 'entry.1096369604';
const SHUTTLE_ENTRY_STATUS = 'entry.798637322';

function getShuttleOperationsProxyCachedPayload(cacheKey, now = Date.now()) {
    const entry = shuttleOperationsProxyCacheByDate.get(cacheKey);
    if (!entry || !entry.payload) return null;
    if (now - Number(entry.at || 0) > SHUTTLE_OPERATIONS_PROXY_CACHE_TTL_MS) {
        shuttleOperationsProxyCacheByDate.delete(cacheKey);
        return null;
    }
    return entry.payload;
}

function registerShuttleController(app, deps = {}) {
    const {
        isSchedulerOpsRequestAuthorized,
        requireAuthorizedUser,
        fetchWithRetry,
        buildShuttleUserOrdersUrl,
        getShuttleReminderEffectiveTimeZone,
        SHUTTLE_REMINDER_ENABLED,
        shuttleReminderState,
        getShuttleReminderSchedulerStarted,
        SHUTTLE_REMINDER_INTERVAL_MS,
        SHUTTLE_REMINDER_LEAD_MS,
        SHUTTLE_REMINDER_USER_REFRESH_MS,
        SHUTTLE_REMINDER_USERS_DISCOVERY_REFRESH_MS,
        SHUTTLE_REMINDER_FETCH_TIMEOUT_MS,
        SHUTTLE_REMINDER_FETCH_RETRIES,
        SHUTTLE_USER_ORDERS_URL,
        shuttleReminderSentAtByKey,
        shuttleReminderKnownUsersCache,
        shuttleReminderOrdersCacheByUser,
        parseBooleanInput,
        generateMessageId,
        runShuttleReminderJob
    } = deps;

    const requireAuthorizedUserForOperations = typeof requireAuthorizedUser === 'function'
        ? requireAuthorizedUser({
            required: true,
            candidateKeys: ['user'],
            onError: (_req, res, resolution) =>
                res.status(resolution.status || 401).json({
                    result: 'error',
                    message: resolution.error || 'Authentication required',
                    orders: []
                })
        })
        : (_req, _res, next) => next();

    app.get(
        ['/shuttle/employees', '/notify/shuttle/employees'],
        requireAuthorizedUserForOperations,
        async (_req, res) => {
            if (!SHUTTLE_USER_ORDERS_URL || typeof buildShuttleUserOrdersUrl !== 'function') {
                return res.status(503).json({ result: 'error', data: [], message: 'Shuttle endpoint is not configured' });
            }
            try {
                const response = await fetchWithRetry(
                    buildShuttleUserOrdersUrl({ emp: 'test', _ts: Date.now() }),
                    {},
                    { timeoutMs: 15000, retries: 1, backoffMs: 700 }
                );
                if (!response.ok) {
                    return res.status(response.status).json({ result: 'error', data: [] });
                }
                const body = await response.text();
                return res.json({ result: 'success', data: parseJsonStringArray(body) });
            } catch (error) {
                const message = error && error.message ? error.message : 'Failed to load shuttle employees';
                return res.status(502).json({ result: 'error', data: [], message });
            }
        }
    );

    app.get(
        ['/shuttle/stations', '/notify/shuttle/stations'],
        requireAuthorizedUserForOperations,
        async (_req, res) => {
            if (!SHUTTLE_USER_ORDERS_URL || typeof buildShuttleUserOrdersUrl !== 'function') {
                return res.status(503).json({ result: 'error', data: [], message: 'Shuttle endpoint is not configured' });
            }
            try {
                const response = await fetchWithRetry(
                    buildShuttleUserOrdersUrl({ park: 'test', _ts: Date.now() }),
                    {},
                    { timeoutMs: 15000, retries: 1, backoffMs: 700 }
                );
                if (!response.ok) {
                    return res.status(response.status).json({ result: 'error', data: [] });
                }
                const body = await response.text();
                return res.json({ result: 'success', data: parseJsonStringArray(body) });
            } catch (error) {
                const message = error && error.message ? error.message : 'Failed to load shuttle stations';
                return res.status(502).json({ result: 'error', data: [], message });
            }
        }
    );

    app.get(
        ['/shuttle/orders/user', '/notify/shuttle/orders/user'],
        requireAuthorizedUserForOperations,
        async (req, res) => {
            if (!SHUTTLE_USER_ORDERS_URL || typeof buildShuttleUserOrdersUrl !== 'function') {
                return res.status(503).json({ result: 'error', orders: [], message: 'Shuttle endpoint is not configured' });
            }
            const user = req.resolvedUser || '';
            if (!user) {
                return res.status(400).json({ result: 'error', orders: [], message: 'Missing user' });
            }
            const force = parseBooleanInput(req && req.query ? req.query.force : '', true);
            const requestUrl = buildShuttleUserOrdersUrl({
                action: 'get_user_orders',
                user,
                force: force ? '1' : '0',
                _ts: Date.now()
            });
            try {
                const payloadText = await fetchShuttleOrdersProxyPayloadText(requestUrl, { fetchWithRetry });
                const payload = parseShuttleOrdersProxyPayload(payloadText);
                return res.json(payload);
            } catch (error) {
                const message = error && error.message ? error.message : 'Failed to load shuttle user orders';
                return res.status(502).json({ result: 'error', orders: [], message });
            }
        }
    );

    app.post(
        ['/shuttle/orders', '/notify/shuttle/orders'],
        requireAuthorizedUserForOperations,
        async (req, res) => {
            if (!SHUTTLE_USER_ORDERS_URL || typeof buildShuttleUserOrdersUrl !== 'function') {
                return res.status(503).json({ result: 'error', message: 'Shuttle endpoint is not configured' });
            }
            const payload = req && req.body && typeof req.body === 'object' ? req.body : {};
            const employee = String(payload.employee || '').trim();
            const date = String(payload.date || '').trim();
            const dateAlt = String(payload.dateAlt || '').trim();
            const shift = String(payload.shift || '').trim();
            const station = String(payload.station || '').trim();
            const status = String(payload.status || '').trim();
            if (!employee || !date || !dateAlt || !shift || !station || !status) {
                return res.status(400).json({ result: 'error', message: 'Shuttle payload is missing required fields' });
            }

            const requestUrl = buildShuttleUserOrdersUrl({
                [SHUTTLE_ENTRY_EMPLOYEE]: employee,
                [SHUTTLE_ENTRY_DATE]: date,
                [SHUTTLE_ENTRY_DATE_ALT]: dateAlt,
                [SHUTTLE_ENTRY_SHIFT]: shift,
                [SHUTTLE_ENTRY_STATION]: station,
                [SHUTTLE_ENTRY_STATUS]: status,
                _ts: Date.now()
            });
            try {
                const response = await fetchWithRetry(
                    requestUrl,
                    { cache: 'no-store' },
                    { timeoutMs: 20000, retries: 2, backoffMs: 700 }
                );
                const bodyText = String(await response.text() || '').trim();
                if (!response.ok) {
                    return res.status(response.status).send(bodyText || `Shuttle submit failed with ${response.status}`);
                }
                return res.type('text/plain').send(bodyText || 'Success');
            } catch (error) {
                const message = error && error.message ? error.message : 'Shuttle submit failed';
                return res.status(502).send(message);
            }
        }
    );

    app.get(
        ['/shuttle/orders/operations', '/notify/shuttle/orders/operations'],
        requireAuthorizedUserForOperations,
        async (req, res) => {
            const requestStartedAt = Date.now();
            if (!SHUTTLE_USER_ORDERS_URL || typeof buildShuttleUserOrdersUrl !== 'function') {
                return res.status(503).json({
                    result: 'error',
                    message: 'Shuttle orders endpoint is not configured',
                    orders: [],
                    source: 'remote',
                    proxyMs: 0
                });
            }

            const fromDateRaw = String(req && req.query ? req.query.fromDate : '').trim();
            const fromDate = /^\d{4}-\d{2}-\d{2}$/.test(fromDateRaw)
                ? fromDateRaw
                : resolveTodayIsoDate();
            const force = parseBooleanInput(req && req.query ? req.query.force : '', false);
            const cacheKey = fromDate;
            const now = Date.now();
            const cachedPayload = getShuttleOperationsProxyCachedPayload(cacheKey, now);
            if (!force && cachedPayload) {
                return res.json(buildShuttleOperationsProxyResponse(cachedPayload, 'cache', requestStartedAt));
            }

            const existingInFlight = shuttleOperationsProxyInFlightByDate.get(cacheKey);
            if (existingInFlight) {
                if (!force && cachedPayload) {
                    return res.json(buildShuttleOperationsProxyResponse(cachedPayload, 'cache', requestStartedAt));
                }
                try {
                    const payload = await existingInFlight;
                    return res.json(buildShuttleOperationsProxyResponse(payload, 'remote', requestStartedAt));
                } catch (error) {
                    if (cachedPayload) {
                        return res.json(buildShuttleOperationsProxyResponse(cachedPayload, 'cache', requestStartedAt));
                    }
                    const message = error && error.message ? error.message : 'Failed to load shuttle operations orders';
                    return res.status(502).json({
                        result: 'error',
                        message,
                        orders: [],
                        source: 'remote',
                        proxyMs: Math.max(0, Date.now() - requestStartedAt)
                    });
                }
            }

            const requestUrl = buildShuttleUserOrdersUrl({
                action: 'get_operations_orders',
                fromDate,
                force: force ? '1' : '0',
                _ts: Date.now()
            });

            const syncPromise = (async () => {
                const payloadText = await fetchShuttleOrdersProxyPayloadText(requestUrl, { fetchWithRetry });
                const payload = parseShuttleOrdersProxyPayload(payloadText);
                shuttleOperationsProxyCacheByDate.set(cacheKey, {
                    at: Date.now(),
                    payload
                });
                return payload;
            })();
            shuttleOperationsProxyInFlightByDate.set(cacheKey, syncPromise);
            try {
                const payload = await syncPromise;
                return res.json(buildShuttleOperationsProxyResponse(payload, 'remote', requestStartedAt));
            } catch (error) {
                if (cachedPayload) {
                    return res.json(buildShuttleOperationsProxyResponse(cachedPayload, 'cache', requestStartedAt));
                }
                const message = error && error.message ? error.message : 'Failed to load shuttle operations orders';
                console.error('[SHUTTLE OPS] Failed to proxy operations orders:', message);
                return res.status(502).json({
                    result: 'error',
                    message,
                    orders: [],
                    source: 'remote',
                    proxyMs: Math.max(0, Date.now() - requestStartedAt)
                });
            } finally {
                if (shuttleOperationsProxyInFlightByDate.get(cacheKey) === syncPromise) {
                    shuttleOperationsProxyInFlightByDate.delete(cacheKey);
                }
            }
        }
    );

    app.get(['/shuttle-reminders/status', '/notify/shuttle-reminders/status'], (req, res) => {
        if (!isSchedulerOpsRequestAuthorized(req)) {
            return res.status(403).json({ error: 'Forbidden' });
        }
        const effectiveTimeZone = getShuttleReminderEffectiveTimeZone();
        return res.json({
            enabled: SHUTTLE_REMINDER_ENABLED,
            running: shuttleReminderState.running,
            lastRunAt: shuttleReminderState.lastRunAt || null,
            lastResult: shuttleReminderState.lastResult || null,
            schedulerStarted: getShuttleReminderSchedulerStarted(),
            intervalMs: SHUTTLE_REMINDER_INTERVAL_MS,
            leadMs: SHUTTLE_REMINDER_LEAD_MS,
            userRefreshMs: SHUTTLE_REMINDER_USER_REFRESH_MS,
            usersDiscoveryRefreshMs: SHUTTLE_REMINDER_USERS_DISCOVERY_REFRESH_MS,
            fetchTimeoutMs: SHUTTLE_REMINDER_FETCH_TIMEOUT_MS,
            fetchRetries: SHUTTLE_REMINDER_FETCH_RETRIES,
            ordersUrlConfigured: Boolean(SHUTTLE_USER_ORDERS_URL),
            timezone: effectiveTimeZone,
            trackedSentReminders: Object.keys(shuttleReminderSentAtByKey).length,
            cachedUsers: Array.isArray(shuttleReminderKnownUsersCache.users)
                ? shuttleReminderKnownUsersCache.users.length
                : 0,
            cachedOrderUsers: Object.keys(shuttleReminderOrdersCacheByUser).length
        });
    });

    app.post(['/shuttle-reminders/run', '/notify/shuttle-reminders/run'], (req, res) => {
        if (!isSchedulerOpsRequestAuthorized(req)) {
            return res.status(403).json({ error: 'Forbidden' });
        }
        if (shuttleReminderState.running) {
            return res.status(409).json({
                status: 'running',
                message: 'Shuttle reminder scheduler is already running.',
                lastResult: shuttleReminderState.lastResult || null
            });
        }

        const payload = req.body && typeof req.body === 'object' ? req.body : {};
        const requestId = generateMessageId();
        const forceUsersRefresh = parseBooleanInput(payload.forceUsersRefresh, false);
        const forceOrdersRefresh = parseBooleanInput(payload.forceOrdersRefresh, false);
        const allowWhenDisabled = parseBooleanInput(payload.allowWhenDisabled, false);

        res.json({
            status: 'queued',
            requestId,
            forceUsersRefresh,
            forceOrdersRefresh,
            allowWhenDisabled
        });

        runShuttleReminderJob({
            requestId,
            trigger: 'manual-api',
            forceUsersRefresh,
            forceOrdersRefresh,
            allowWhenDisabled
        })
            .then((summary) => {
                if (!summary || summary.status === 'running' || summary.status === 'disabled') {
                    return;
                }
                console.log(
                    `[SHUTTLE REMINDER] Manual run ${summary.requestId} | users=${summary.candidateUsers} due=${summary.dueOrders} sent=${summary.sent} failed=${summary.failed} noTarget=${summary.noTarget}`
                );
            })
            .catch((error) => {
                console.error('[SHUTTLE REMINDER] Manual run failed:', error && error.message ? error.message : error);
            });
    });
}

module.exports = {
    registerShuttleController
};
