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
            const result = Object.values(groups || {})
                .map((group) => {
                    if (!group || typeof group !== 'object') return null;
                    const members = Array.isArray(group.members)
                        ? group.members
                        : (Array.isArray(group.memberList) ? group.memberList : []);
                    const admins = Array.isArray(group.admins)
                        ? group.admins
                        : (Array.isArray(group.groupAdmins) ? group.groupAdmins : []);
                    if (!members.length) return null;
                    if (!members.map(normalizeUserKey).includes(user)) return null;
                    return {
                        ...group,
                        groupID: group.id || group.groupID || group.groupId || null,
                        title: group.name || group.title || null,
                        memberList: members,
                        members,
                        admins
                    };
                })
                .filter(Boolean);
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
        ['/messages/logs', '/notify/messages/logs'],
        requireAuthorizedUser({
            required: true,
            candidateKeys: ['user'],
            onError: (_req, res, resolution) =>
                res.status(resolution.status).json({ messages: [], error: resolution.error })
        }),
        async (req, res) => {
            const sessionUser = normalizeUserKey(req && req.authUser);
            if (!sessionUser) {
                return res.status(401).json({ messages: [], error: 'Authentication required' });
            }
            const requestedUser = normalizeUserKey(req && req.query ? req.query.user : '');
            if (requestedUser && requestedUser !== sessionUser) {
                return res.status(403).json({ messages: [], error: 'User mismatch' });
            }
            const user = sessionUser;

            const limitRaw = Number(req.query && req.query.limit);
            const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(1, Math.floor(limitRaw)), 1000) : 700;
            const knownGroupNamesById = new Map();
            const knownGroupIds = new Set();
            const isLikelyPhoneUser = (value) => {
                const digits = String(value || '').replace(/\D/g, '');
                if (!digits) return false;
                return (
                    /^05\d{8}$/.test(digits) ||
                    /^5\d{8}$/.test(digits) ||
                    /^9725\d{8}$/.test(digits) ||
                    /^97205\d{8}$/.test(digits)
                );
            };

            try {
                const groups = getGroups && typeof getGroups === 'function' ? getGroups() : {};
                Object.values(groups || {}).forEach((group) => {
                    if (!group || typeof group !== 'object') {
                        return;
                    }
                    const members = Array.isArray(group.members)
                        ? group.members
                        : (Array.isArray(group.memberList) ? group.memberList : []);
                    const normalizedMembers = members.map((member) => normalizeUserKey(member)).filter(Boolean);
                    if (normalizedMembers.length > 0 && !normalizedMembers.includes(user)) {
                        return;
                    }
                    const normalizedGroupId = normalizeUserKey(
                        String(group.id || group.groupID || group.groupId || '').trim()
                    );
                    if (!normalizedGroupId) {
                        return;
                    }
                    knownGroupIds.add(normalizedGroupId);
                    const groupName = String(group.name || group.title || group.groupName || '').trim();
                    if (groupName) {
                        knownGroupNamesById.set(normalizedGroupId, groupName);
                    }
                });
            } catch (_error) {
                // Keep logs sync resilient even if in-memory groups are unavailable.
            }

            try {
                const response = await fetchWithRetry(
                    buildGoogleSheetGetUrl({
                        action: 'get_logs_messages',
                        user,
                        excludeSystem: '1',
                        limit: String(limit)
                    }),
                    {},
                    { timeoutMs: 15000, retries: 1 }
                );
                if (!response.ok) {
                    return res.status(response.status).json({ messages: [] });
                }

                const payload = await response.json();
                const payloadResult = String(payload && payload.result ? payload.result : '').trim().toLowerCase();
                if (payloadResult && payloadResult !== 'success') {
                    const payloadError = String(
                        (payload && (payload.message || payload.error)) || 'Logs sync failed'
                    ).trim();
                    const statusCode = /unauthorized|forbidden/i.test(payloadError) ? 403 : 502;
                    return res.status(statusCode).json({ messages: [], error: payloadError || 'Logs sync failed' });
                }
                const rawMessages = Array.isArray(payload && payload.messages) ? payload.messages : [];
                const messages = rawMessages
                    .map((message, index) => {
                        if (!message || typeof message !== 'object') {
                            return null;
                        }
                        const sender = normalizeUserKey(message.sender || message.from || '');
                        if (!sender || sender === 'system') {
                            return null;
                        }
                        const body = String(message.body ?? message.message ?? message.content ?? '').trim();
                        if (!body) {
                            return null;
                        }
                        const normalizedBody = body.toLowerCase();
                        if (normalizedBody === 'new notification' || normalizedBody === 'new reaction') {
                            return null;
                        }

                        const timestampRaw = Number(message.timestamp ?? message.sentAt ?? message.at ?? 0);
                        const timestamp = Number.isFinite(timestampRaw) && timestampRaw > 0
                            ? timestampRaw
                            : Date.now() + index;
                        const explicitGroupIdRaw = String(
                            message.groupId ??
                            message.group_id ??
                            message.chatId ??
                            message.chat_id ??
                            ''
                        ).trim();
                        const toUserCandidateRaw = String(
                            message.toUser ??
                            message.to_user ??
                            message.to ??
                            message.recipient ??
                            message.targetUser ??
                            message.target_user ??
                            ''
                        ).trim();
                        const normalizedExplicitGroupId = normalizeUserKey(explicitGroupIdRaw);
                        const normalizedToUserCandidate = normalizeUserKey(toUserCandidateRaw);

                        let resolvedGroupId = normalizedExplicitGroupId;
                        if (
                            !resolvedGroupId &&
                            normalizedToUserCandidate &&
                            normalizedToUserCandidate !== user &&
                            normalizedToUserCandidate !== sender &&
                            (
                                knownGroupIds.has(normalizedToUserCandidate) ||
                                !isLikelyPhoneUser(normalizedToUserCandidate)
                            )
                        ) {
                            resolvedGroupId = normalizedToUserCandidate;
                        }

                        const groupName = String(
                            message.groupName ??
                            message.group_name ??
                            message.chatName ??
                            message.chat_name ??
                            ''
                        ).trim();
                        const resolvedGroupName = groupName
                            || (resolvedGroupId ? (knownGroupNamesById.get(resolvedGroupId) || toUserCandidateRaw || resolvedGroupId) : '');
                        const messageIdRaw = String(
                            message.messageId ??
                            message.message_id ??
                            message.msgId ??
                            message.msg_id ??
                            message.mid ??
                            message.uuid ??
                            message.id ??
                            ''
                        ).trim();
                        const fingerprintSource = `${sender}|${resolvedGroupId || normalizedToUserCandidate || user}|${timestamp}|${body}`;
                        let fingerprint = 0;
                        for (let charIndex = 0; charIndex < fingerprintSource.length; charIndex += 1) {
                            fingerprint = ((fingerprint << 5) - fingerprint + fingerprintSource.charCodeAt(charIndex)) | 0;
                        }
                        const messageId = messageIdRaw || `logs-${sender}-${timestamp}-${Math.abs(fingerprint).toString(36)}`;
                        const groupTypeRaw = String(
                            message.groupType ??
                            message.group_type ??
                            ''
                        ).trim().toLowerCase();
                        const groupSenderName = String(
                            message.groupSenderName ??
                            message.group_sender_name ??
                            message.senderName ??
                            message.sender_name ??
                            message.fromName ??
                            message.from_name ??
                            message.senderDisplayName ??
                            message.sender_name ??
                            ''
                        ).trim();
                        const resolvedGroupType = groupTypeRaw === 'community'
                            ? 'community'
                            : (groupTypeRaw === 'group'
                                ? 'group'
                                : (resolvedGroupId ? 'group' : undefined));

                        return {
                            messageId,
                            sender,
                            body,
                            timestamp,
                            groupId: resolvedGroupId || undefined,
                            groupName: resolvedGroupName || undefined,
                            groupType: resolvedGroupType,
                            groupSenderName: groupSenderName || undefined
                        };
                    })
                    .filter(Boolean);

                return res.json({ result: 'success', messages });
            } catch (error) {
                console.error('[LOGS SYNC] Failed to load logs messages:', error && error.message ? error.message : error);
                return res.status(502).json({ messages: [], error: 'Logs sync failed' });
            }
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
