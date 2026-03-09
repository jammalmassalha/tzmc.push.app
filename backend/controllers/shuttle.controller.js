function registerShuttleController(app, deps = {}) {
    const {
        isSchedulerOpsRequestAuthorized,
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
