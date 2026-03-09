function registerMessageController(app, deps = {}) {
    const {
        requireAuthorizedUser,
        normalizeUserKey,
        fetchWithRetry,
        buildGoogleSheetGetUrl,
        getGroups,
        getActiveRedisStateStore,
        getMessageQueue,
        scheduleStateSave,
        sseClients
    } = deps;

    app.get(
        ['/contacts', '/notify/contacts', '/contacts/:user', '/notify/contacts/:user'],
        requireAuthorizedUser({
            required: true,
            candidateKeys: ['user'],
            onError: (_req, res, resolution) => res.status(resolution.status).json({ users: [], error: resolution.error })
        }),
        async (req, res) => {
            const user = req.resolvedUser;
            if (!user) {
                return res.status(400).json({ users: [], error: 'Missing user' });
            }

            try {
                const response = await fetchWithRetry(
                    buildGoogleSheetGetUrl({ action: 'get_contacts', user }),
                    {},
                    { timeoutMs: 10000, retries: 2 }
                );
                if (!response.ok) {
                    return res.status(response.status).json({ users: [] });
                }
                const payload = await response.json();
                const users = Array.isArray(payload && payload.users) ? payload.users : [];
                return res.json({
                    result: 'success',
                    users
                });
            } catch (error) {
                console.error('[CONTACTS] Failed to load contacts:', error && error.message ? error.message : error);
                return res.status(502).json({ users: [], error: 'Contacts fetch failed' });
            }
        }
    );

    app.get(
        ['/groups', '/notify/groups'],
        requireAuthorizedUser({
            required: true,
            candidateKeys: ['user'],
            onError: (_req, res, resolution) => res.status(resolution.status).json({ groups: [], error: resolution.error })
        }),
        (req, res) => {
            const user = req.resolvedUser;
            if (!user) return res.json({ groups: [] });

            const groups = getGroups();
            const result = Object.values(groups || {}).filter((group) => {
                if (!group || !Array.isArray(group.members)) return false;
                return group.members.map(normalizeUserKey).includes(user);
            });
            return res.json({ groups: result });
        }
    );

    app.get(
        ['/messages', '/notify/messages'],
        requireAuthorizedUser({
            required: true,
            candidateKeys: ['user'],
            onError: (_req, res) => res.json({ messages: [] })
        }),
        async (req, res) => {
            const user = req.resolvedUser;
            if (!user) return res.json({ messages: [] });

            let mailbox = [];
            const activeRedisStateStore = getActiveRedisStateStore();
            if (activeRedisStateStore && activeRedisStateStore.isEnabled) {
                try {
                    const redisMailbox = await activeRedisStateStore.drainQueue(user);
                    if (Array.isArray(redisMailbox) && redisMailbox.length > 0) {
                        mailbox = redisMailbox;
                    }
                } catch (error) {
                    console.warn('[REDIS] Drain queue failed:', error && error.message ? error.message : error);
                }
            }

            const messageQueue = getMessageQueue();
            if (!mailbox.length && messageQueue[user] && messageQueue[user].length > 0) {
                mailbox = Array.isArray(messageQueue[user]) ? messageQueue[user] : [];
            }

            if (mailbox.length > 0) {
                const waitingMessages = mailbox.filter((message) => {
                    if (!message || typeof message !== 'object') {
                        return true;
                    }
                    const recipient = normalizeUserKey(message.recipient || message.user || '');
                    return !recipient || recipient === user;
                });
                const droppedCount = mailbox.length - waitingMessages.length;

                messageQueue[user] = [];
                scheduleStateSave();

                if (droppedCount > 0) {
                    console.warn(`[POLLING] Dropped ${droppedCount} mismatched queued messages for ${user}`);
                }
                console.log(`[POLLING] Delivered ${waitingMessages.length} msgs to ${user}`);
                return res.json({ messages: waitingMessages });
            }

            return res.json({ messages: [] });
        }
    );

    app.get(
        ['/stream', '/notify/stream'],
        requireAuthorizedUser({
            required: true,
            candidateKeys: ['user'],
            onError: (_req, res, resolution) => res.status(resolution.status).json({ error: resolution.error })
        }),
        (req, res) => {
            const user = req.resolvedUser || null;
            if (!user) {
                return res.status(400).json({ error: 'Missing user' });
            }

            res.set({
                'Content-Type': 'text/event-stream; charset=utf-8',
                'Cache-Control': 'no-cache, no-transform',
                Connection: 'keep-alive',
                'X-Accel-Buffering': 'no',
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Headers': 'Content-Type, Authorization, Cache-Control, Pragma, Last-Event-ID, X-CSRF-Token'
            });
            req.socket.setTimeout(0);
            res.setTimeout(0);
            if (typeof res.flushHeaders === 'function') {
                res.flushHeaders();
            }
            res.write(`event: connected\ndata: ${JSON.stringify({ user })}\n\n`);
            if (typeof res.flush === 'function') {
                res.flush();
            }

            const existing = sseClients.get(user) || new Set();
            existing.add(res);
            sseClients.set(user, existing);

            const keepAlive = setInterval(() => {
                res.write(`event: ping\ndata: ${Date.now()}\n\n`);
                if (typeof res.flush === 'function') {
                    res.flush();
                }
            }, 15000);

            const cleanup = () => {
                clearInterval(keepAlive);
                const set = sseClients.get(user);
                if (set) {
                    set.delete(res);
                    if (set.size === 0) {
                        sseClients.delete(user);
                    }
                }
            };

            req.on('close', cleanup);
            req.on('error', cleanup);
        }
    );
}

module.exports = {
    registerMessageController
};
