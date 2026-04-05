function registerMessageController(app, deps = {}) {
    const {
        requireAuthorizedUser,
        normalizeUserKey,
        fetchWithRetry,
        buildGoogleSheetGetUrl,
        getLogsMessagesForUser,
        getHardcodedGroupIds,
        getHardcodedGroupMembers,
        // Legacy static fallbacks (kept for backward compatibility)
        hardcodedGroupIds: _legacyHardcodedGroupIds,
        hardcodedGroupMembers: _legacyHardcodedGroupMembers,
        getGroups,
        loadAllChatGroups,
        getActiveRedisStateStore,
        getMessageQueue,
        scheduleStateSave,
        sseClients,
        updateUserReceivedTime,
        updateUserReceivedTimeBatch
    } = deps;
    // Resolve dynamic getters with static fallbacks
    const resolveHardcodedGroupIds = () =>
        (typeof getHardcodedGroupIds === 'function' ? getHardcodedGroupIds() : _legacyHardcodedGroupIds) || [];
    const resolveHardcodedGroupMembers = () =>
        (typeof getHardcodedGroupMembers === 'function' ? getHardcodedGroupMembers() : _legacyHardcodedGroupMembers) || {};
    const RECENT_POLLING_MESSAGE_DEDUP_TTL_MS = 10 * 60 * 1000;
    const LOGS_MESSAGE_SEMANTIC_DEDUP_WINDOW_MS = 2 * 60 * 1000;
    const MAX_RECENT_POLLING_DEDUP_KEYS_PER_USER = 4000;
    const recentPollingMessageKeysByUser = new Map();

    const normalizeTextForDedup = (value) => String(value || '').replace(/\s+/g, ' ').trim();
    const normalizeTimestampMs = (value, fallback = 0) => {
        const numeric = Number(value);
        if (Number.isFinite(numeric) && numeric > 0) {
            return numeric;
        }
        return fallback;
    };
    const buildMessageIdsDedupKey = (value) => {
        if (Array.isArray(value)) {
            return value.map((id) => String(id || '').trim()).filter(Boolean).sort().join(',');
        }
        return String(value || '').split(',').map((id) => String(id || '').trim()).filter(Boolean).sort().join(',');
    };
    const pruneRecentPollingDedupKeys = (nowTs = Date.now()) => {
        for (const [userKey, keysMap] of recentPollingMessageKeysByUser.entries()) {
            if (!keysMap || !(keysMap instanceof Map)) {
                recentPollingMessageKeysByUser.delete(userKey);
                continue;
            }
            for (const [fingerprint, deliveredAt] of keysMap.entries()) {
                if (!fingerprint) {
                    keysMap.delete(fingerprint);
                    continue;
                }
                if (!Number.isFinite(Number(deliveredAt)) || nowTs - Number(deliveredAt) > RECENT_POLLING_MESSAGE_DEDUP_TTL_MS) {
                    keysMap.delete(fingerprint);
                }
            }
            if (keysMap.size === 0) {
                recentPollingMessageKeysByUser.delete(userKey);
            }
        }
    };
    const compactRecentPollingDedupKeys = (keysMap) => {
        if (!(keysMap instanceof Map)) return;
        if (keysMap.size <= MAX_RECENT_POLLING_DEDUP_KEYS_PER_USER) return;
        const sorted = Array.from(keysMap.entries())
            .sort((a, b) => Number(b[1] || 0) - Number(a[1] || 0))
            .slice(0, MAX_RECENT_POLLING_DEDUP_KEYS_PER_USER);
        keysMap.clear();
        sorted.forEach(([key, timestamp]) => {
            keysMap.set(key, Number(timestamp) || Date.now());
        });
    };
    const buildPollingMessageFingerprint = (message, user) => {
        if (!message || typeof message !== 'object') return '';
        const payloadType = String(message.type || 'message').trim().toLowerCase() || 'message';
        const messageId = String(message.messageId || message.id || '').trim();
        if (messageId) return `id:${payloadType}:${messageId}`;
        const sender = normalizeUserKey(message.sender || message.from || message.reactor || '');
        const recipient = normalizeUserKey(message.recipient || message.user || user || '');
        const groupId = normalizeUserKey(message.groupId || message.group_id || message.chatId || message.chat_id || '');
        const targetMessageId = String(
            message.targetMessageId ||
            message.target_message_id ||
            message.messageTargetId ||
            message.message_target_id ||
            ''
        ).trim();
        const body = normalizeTextForDedup(message.body || message.message || message.content || '');
        const imageUrl = normalizeTextForDedup(message.imageUrl || message.image || message.thumbnailUrl || '');
        const emoji = normalizeTextForDedup(message.emoji || message.reaction || '');
        const messageIds = buildMessageIdsDedupKey(message.messageIds || message.message_ids);
        return [
            payloadType,
            sender || 'na',
            recipient || 'na',
            groupId || 'na',
            targetMessageId || 'na',
            emoji || 'na',
            messageIds || 'na',
            body || 'na',
            imageUrl || 'na'
        ].join('|');
    };
    const dedupePollingMailboxMessages = (messages, user) => {
        if (!Array.isArray(messages) || messages.length === 0) {
            return [];
        }
        const normalizedUser = normalizeUserKey(user);
        if (!normalizedUser) {
            return messages;
        }
        const now = Date.now();
        pruneRecentPollingDedupKeys(now);
        const recentlyDeliveredKeys = recentPollingMessageKeysByUser.get(normalizedUser) || new Map();
        const seenInBatch = new Set();
        const deduped = [];
        for (const message of messages) {
            const fingerprint = buildPollingMessageFingerprint(message, normalizedUser);
            if (!fingerprint) {
                deduped.push(message);
                continue;
            }
            if (seenInBatch.has(fingerprint)) {
                continue;
            }
            const deliveredAt = Number(recentlyDeliveredKeys.get(fingerprint) || 0);
            if (deliveredAt > 0 && now - deliveredAt <= RECENT_POLLING_MESSAGE_DEDUP_TTL_MS) {
                continue;
            }
            seenInBatch.add(fingerprint);
            recentlyDeliveredKeys.set(fingerprint, now);
            deduped.push(message);
        }
        compactRecentPollingDedupKeys(recentlyDeliveredKeys);
        if (recentlyDeliveredKeys.size > 0) {
            recentPollingMessageKeysByUser.set(normalizedUser, recentlyDeliveredKeys);
        } else {
            recentPollingMessageKeysByUser.delete(normalizedUser);
        }
        return deduped;
    };
    const buildLogsSemanticFingerprint = (message) => {
        if (!message || typeof message !== 'object') return '';
        const sender = normalizeUserKey(message.sender || message.reactor || message.from || '');
        const groupId = normalizeUserKey(message.groupId || message.group_id || message.chatId || message.chat_id || '');
        const payloadType = String(message.type || 'message').trim().toLowerCase() || 'message';
        const body = normalizeTextForDedup(message.body || message.message || message.content || '');
        const imageUrl = normalizeTextForDedup(message.imageUrl || message.image || message.thumbnailUrl || '');
        const targetMessageId = String(
            message.targetMessageId ||
            message.target_message_id ||
            message.messageTargetId ||
            message.message_target_id ||
            ''
        ).trim();
        const emoji = normalizeTextForDedup(message.emoji || message.reaction || '');
        const messageIds = buildMessageIdsDedupKey(message.messageIds || message.message_ids);
        return [
            payloadType,
            sender || 'na',
            groupId || 'na',
            targetMessageId || 'na',
            emoji || 'na',
            messageIds || 'na',
            body || 'na',
            imageUrl || 'na'
        ].join('|');
    };
    const dedupeLogsMessages = (messages) => {
        if (!Array.isArray(messages) || messages.length === 0) {
            return [];
        }
        const seenMessageIds = new Set();
        const seenBySemanticKey = new Map();
        const deduped = [];
        for (const message of messages) {
            if (!message || typeof message !== 'object') {
                continue;
            }
            const payloadType = String(message.type || 'message').trim().toLowerCase() || 'message';
            const messageId = String(message.messageId || message.id || '').trim();
            if (messageId) {
                const scopedMessageId = `${payloadType}:${messageId}`;
                if (seenMessageIds.has(scopedMessageId)) {
                    continue;
                }
                seenMessageIds.add(scopedMessageId);
            }
            const semanticKey = buildLogsSemanticFingerprint(message);
            if (semanticKey) {
                const timestamp = normalizeTimestampMs(message.timestamp, 0);
                const previouslySeenTimestamps = seenBySemanticKey.get(semanticKey) || [];
                const hasEquivalentTimestamp = previouslySeenTimestamps.some((seenTimestamp) => {
                    if (!timestamp || !seenTimestamp) {
                        return false;
                    }
                    return Math.abs(Number(seenTimestamp) - timestamp) <= LOGS_MESSAGE_SEMANTIC_DEDUP_WINDOW_MS;
                });
                if (hasEquivalentTimestamp) {
                    continue;
                }
                if (timestamp > 0) {
                    previouslySeenTimestamps.push(timestamp);
                    if (previouslySeenTimestamps.length > 8) {
                        previouslySeenTimestamps.shift();
                    }
                    seenBySemanticKey.set(semanticKey, previouslySeenTimestamps);
                }
            }
            deduped.push(message);
        }
        return deduped;
    };

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

    const resolveRuntimeGroupsForUser = (user) => {
        const groups = getGroups();
        return Object.values(groups || {})
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
    };

    app.get(
        ['/groups', '/notify/groups'],
        requireAuthorizedUser({
            required: true,
            candidateKeys: ['user'],
            onError: (_req, res, resolution) => res.status(resolution.status).json({ groups: [], error: resolution.error })
        }),
        async (req, res) => {
            const user = req.resolvedUser;
            if (!user) return res.json({ groups: [] });

            try {
                // Primary source: MySQL database
                const dbGroups = typeof loadAllChatGroups === 'function'
                    ? await loadAllChatGroups()
                    : [];

                if (dbGroups && dbGroups.length > 0) {
                    const result = dbGroups
                        .filter((group) => {
                            if (!group || !group.groupId) return false;
                            const normalizedMembers = (group.members || []).map(normalizeUserKey);
                            return normalizedMembers.includes(user);
                        })
                        .map((group) => ({
                            id: group.groupId,
                            name: group.groupName,
                            members: group.members || [],
                            admins: group.admins || [],
                            createdBy: group.createdBy || null,
                            type: group.type || 'group',
                            updatedAt: group.updatedAt || 0,
                            groupID: group.groupId,
                            title: group.groupName,
                            memberList: group.members || []
                        }));
                    return res.json({ groups: result });
                }

                // Fallback: runtime memory (if DB is empty or unavailable)
                return res.json({ groups: resolveRuntimeGroupsForUser(user) });
            } catch (error) {
                console.error('[DB GROUPS] Fetch failed:', error && error.message ? error.message : error);
                try {
                    return res.json({ groups: resolveRuntimeGroupsForUser(user) });
                } catch (_fallbackError) {
                    return res.status(502).json({ groups: [], error: 'Database fetch failed' });
                }
            }
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
                const dedupedMessages = dedupePollingMailboxMessages(waitingMessages, user);
                const dedupedCount = waitingMessages.length - dedupedMessages.length;
                if (dedupedCount > 0) {
                    console.warn(`[POLLING] Deduped ${dedupedCount} duplicate msgs for ${user}`);
                }
                console.log(`[POLLING] Delivered ${dedupedMessages.length} msgs to ${user}`);
                return res.json({ messages: dedupedMessages });
            }

            return res.json({ messages: [] });
        }
    );

    // backend/controllers/message.controller.js

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
            const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(1, Math.floor(limitRaw)), 200000) : 700;
            const offsetRaw = Number(req.query && req.query.offset);
            const offset = Number.isFinite(offsetRaw) ? Math.max(0, Math.floor(offsetRaw)) : 0;

            // --- OPTIMIZATION: Extract 'since' timestamp ---
            const sinceRaw = Number(req.query && req.query.since);
            const since = Number.isFinite(sinceRaw) && sinceRaw > 0 ? sinceRaw : 0;

            const knownGroupNamesById = new Map();
            const knownGroupIds = new Set();
            const knownGroupIdByName = new Map();
            const knownGroupTypeById = new Map();
            const hardcodedGroupKeySet = new Set(
                (() => {
                    const ids = resolveHardcodedGroupIds();
                    return Array.isArray(ids)
                        ? ids.map((value) => normalizeUserKey(value)).filter(Boolean)
                        : [];
                })()
            );

            const parseFlexibleTimestamp = (...candidates) => {
                for (const candidate of candidates) {
                    if (candidate === null || candidate === undefined) continue;
                    const numeric = Number(candidate);
                    if (Number.isFinite(numeric) && numeric > 0) return numeric;
                    const text = String(candidate || '').trim();
                    if (!text) continue;
                    const parsedDate = Date.parse(text);
                    if (Number.isFinite(parsedDate) && parsedDate > 0) return parsedDate;
                }
                return 0;
            };

            const parseLogDetailsMap = (rawValue) => {
                const detailsText = String(rawValue || '').trim();
                if (!detailsText) return {};
                try {
                    const parsed = JSON.parse(detailsText);
                    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                        return Object.entries(parsed).reduce((acc, [key, value]) => {
                            acc[String(key)] = String(value == null ? '' : value).trim();
                            return acc;
                        }, {});
                    }
                } catch (_error) { }
                return detailsText.split('|').map(s => s.trim()).filter(Boolean).reduce((acc, segment) => {
                    const sepIdx = segment.indexOf('=');
                    if (sepIdx <= 0) return acc;
                    const key = segment.slice(0, sepIdx).trim();
                    const value = segment.slice(sepIdx + 1).trim();
                    if (key) acc[key] = value;
                    return acc;
                }, {});
            };

            const isLikelyPhoneUser = (value) => {
                const digits = String(value || '').replace(/\D/g, '');
                if (!digits) return false;
                return /^05\d{8}$|^5\d{8}$|^9725\d{8}$|^97205\d{8}$/.test(digits);
            };

            try {
                const groups = getGroups && typeof getGroups === 'function' ? getGroups() : {};
                Object.values(groups || {}).forEach((group) => {
                    if (!group || typeof group !== 'object') return;
                    const members = Array.isArray(group.members) ? group.members : (group.memberList || []);
                    const normalizedMembers = members.map(m => normalizeUserKey(m)).filter(Boolean);
                    if (normalizedMembers.length > 0 && !normalizedMembers.includes(user)) return;
                    const gid = normalizeUserKey(String(group.id || group.groupID || group.groupId || '').trim());
                    if (!gid) return;
                    knownGroupIds.add(gid);
                    const gname = String(group.name || group.title || group.groupName || '').trim();
                    if (gname) {
                        knownGroupNamesById.set(gid, gname);
                        const nameKey = normalizeUserKey(gname);
                        if (nameKey && !knownGroupIdByName.has(nameKey)) knownGroupIdByName.set(nameKey, gid);
                    }
                    const gtype = String(group.type || group.groupType || '').trim().toLowerCase();
                    if (gtype === 'community' || gtype === 'group') knownGroupTypeById.set(gid, gtype);
                    else if (hardcodedGroupKeySet.has(gid)) knownGroupTypeById.set(gid, 'community');
                });
            } catch (_error) { }

            // Supplement group maps with MySQL DB groups (authoritative source)
            const userDynamicGroupIds = [];
            try {
                const dbGroups = typeof loadAllChatGroups === 'function'
                    ? await loadAllChatGroups()
                    : [];
                for (const dbGroup of dbGroups) {
                    if (!dbGroup || !dbGroup.groupId || !dbGroup.groupName) continue;
                    const gid = normalizeUserKey(dbGroup.groupId);
                    if (!gid) continue;
                    knownGroupIds.add(gid);
                    // DB group name wins over runtime memory
                    knownGroupNamesById.set(gid, dbGroup.groupName);
                    const nameKey = normalizeUserKey(dbGroup.groupName);
                    if (nameKey && !knownGroupIdByName.has(nameKey)) knownGroupIdByName.set(nameKey, gid);
                    const gtype = String(dbGroup.type || '').trim().toLowerCase();
                    if (gtype === 'community' || gtype === 'group') knownGroupTypeById.set(gid, gtype);
                    else if (hardcodedGroupKeySet.has(gid)) knownGroupTypeById.set(gid, 'community');
                    // Track dynamic groups (group:xxx) the user actually belongs to
                    if (gid.startsWith('group:')) {
                        const normalizedMembers = (dbGroup.members || []).map(normalizeUserKey).filter(Boolean);
                        if (normalizedMembers.length > 0 && normalizedMembers.includes(user)) {
                            userDynamicGroupIds.push(gid);
                        }
                    }
                }
            } catch (_dbError) { }

            try {
                // CALLING OPTIMIZED SERVICE
                const rawMessages = typeof getLogsMessagesForUser === 'function'
                    ? await getLogsMessagesForUser(user, {
                        limit,
                        offset,
                        since, // Optimization passed here
                        excludeSystem: true,
                        hardcodedGroupIds: Array.from(hardcodedGroupKeySet),
                        hardcodedGroupMembers: resolveHardcodedGroupMembers(),
                        dynamicGroupIds: userDynamicGroupIds
                    })
                    : [];

                const messages = rawMessages.map((message, index) => {
                    if (!message || typeof message !== 'object') return null;

                    const messageStatus = String(message.status ?? message.deliveryStatus ?? '').trim().toLowerCase();
                    const detailsMap = parseLogDetailsMap(message.details ?? message.logDetails ?? message.metadata ?? '');

                    const rawType = String(
                        message.type ?? message.eventType ?? message.actionType ??
                        detailsMap.type ?? detailsMap.eventType ??
                        (messageStatus.startsWith('deleted') ? 'delete-action' : '') ?? ''
                    ).trim().toLowerCase();

                    const supportedActionTypes = new Set(['reaction', 'group-update', 'read-receipt', 'edit-action', 'delete-action']);
                    const normalizedType = supportedActionTypes.has(rawType) ? rawType : '';
                    const isActionMessage = Boolean(normalizedType);

                    const sender = normalizeUserKey(message.sender || message.from || message.reactor || '');
                    if (!isActionMessage && (!sender || sender === 'system')) return null;

                    const rawBody = String(message.body ?? message.message ?? message.content ?? '').trim();
                    const imageUrl = String(message.imageUrl ?? message.image ?? '').trim() || undefined;
                    const fileUrl = String(message.fileUrl ?? '').trim() || undefined;

                    // Strip placeholder body text when the actual image URL is present.
                    const rawBodyLower = rawBody.toLowerCase();
                    const imagePlaceholders = new Set(['sent an image', '[image sent]', 'image attachment']);
                    const isPlaceholderBody = imagePlaceholders.has(rawBodyLower) ||
                        rawBodyLower.startsWith('[image sent]:');
                    const body = (isPlaceholderBody && imageUrl) ? '' : rawBody;

                    if (!isActionMessage && !body && !imageUrl && !fileUrl) return null;

                    const normalizedBody = body.toLowerCase();
                    if (!isActionMessage && (normalizedBody === 'new notification' || normalizedBody === 'new reaction')) return null;

                    const sourceTimestamp = parseFlexibleTimestamp(message.timestamp, message.sentAt, message.at, message.createdAt);
                    const timestamp = sourceTimestamp > 0 ? sourceTimestamp : Date.now() + index;

                    const explicitGroupIdRaw = String(message.groupId ?? message.chatId ?? '').trim();
                    const toUserCandidateRaw = String(message.toUser ?? message.to ?? message.recipient ?? '').trim();
                    const normalizedExplicitGroupId = normalizeUserKey(explicitGroupIdRaw);
                    const normalizedToUserCandidate = normalizeUserKey(toUserCandidateRaw);

                    let resolvedGroupId = normalizedExplicitGroupId;
                    if (!resolvedGroupId && sender && hardcodedGroupKeySet.has(sender)) resolvedGroupId = sender;
                    if (!resolvedGroupId && sender && sender !== user && !isLikelyPhoneUser(sender)) {
                        if (knownGroupIds.has(sender)) resolvedGroupId = sender;
                        else if (knownGroupIdByName.has(sender)) resolvedGroupId = knownGroupIdByName.get(sender) || '';
                        // Sender starting with "group:" is always a group ID
                        else if (sender.startsWith('group:')) resolvedGroupId = sender;
                    }
                    if (!resolvedGroupId && normalizedToUserCandidate && hardcodedGroupKeySet.has(normalizedToUserCandidate)) resolvedGroupId = normalizedToUserCandidate;
                    // Only treat toUser as a group ID if it's a single non-phone identifier that matches a known group.
                    // Comma-separated recipient lists (e.g. "054xxx,055xxx") should never become group IDs.
                    if (!resolvedGroupId && normalizedToUserCandidate) {
                        const isSingleValue = !normalizedToUserCandidate.includes(',');
                        const isDistinctFromParticipants = normalizedToUserCandidate !== user && normalizedToUserCandidate !== sender;
                        const isKnownGroup = knownGroupIds.has(normalizedToUserCandidate) || (!isLikelyPhoneUser(normalizedToUserCandidate) && knownGroupIdByName.has(normalizedToUserCandidate));
                        if (isSingleValue && isDistinctFromParticipants && isKnownGroup) {
                            resolvedGroupId = normalizedToUserCandidate;
                        }
                    }

                    const groupName = String(message.groupName ?? message.chatName ?? '').trim();
                    const resolvedGroupName = groupName || (resolvedGroupId ? (knownGroupNamesById.get(resolvedGroupId) || resolvedGroupId) : '');

                    const messageIdRaw = String(message.messageId || message.id || detailsMap.messageId || '').trim();
                    const timestampSeed = String(message.timestamp ?? message.sentAt ?? '').trim();
                    const targetMessageId = String(message.targetMessageId ?? detailsMap.targetMessageId ?? '').trim();
                    const emoji = String(message.emoji ?? message.reaction ?? '').trim();

                    const readMessageIds = Array.isArray(message.messageIds)
                        ? message.messageIds.map(id => String(id || '').trim()).filter(Boolean)
                        : String(message.messageIds ?? detailsMap.messageIds ?? '').split(',').map(id => id.trim()).filter(Boolean);

                    const actionFingerprintSeed = isActionMessage ? `${normalizedType}|${targetMessageId}|${emoji}|${readMessageIds.join(',')}` : body;
                    const fingerprintSource = `${sender || 'unknown'}|${resolvedGroupId || normalizedToUserCandidate || user}|${timestampSeed || 'na'}|${actionFingerprintSeed}`;
                    let fingerprint = 0;
                    for (let i = 0; i < fingerprintSource.length; i++) fingerprint = ((fingerprint << 5) - fingerprint + fingerprintSource.charCodeAt(i)) | 0;

                    const messageId = messageIdRaw || `logs-${sender}-${timestamp}-${Math.abs(fingerprint).toString(36)}`;
                    const groupTypeRaw = String(message.groupType ?? '').trim().toLowerCase();
                    let groupSenderName = String(message.groupSenderName ?? message.senderName ?? message.fromName ?? '').trim();

                    // For group messages from DB logs, the body is stored as "SenderName: message text".
                    // Extract the sender name from the body prefix if not already set.
                    // Use a broad condition: strip whenever the message is group-like (resolved group ID,
                    // sender that looks like a group identifier, or sender matching a known/hardcoded group).
                    const looksLikeGroupMessage = resolvedGroupId || sender.startsWith('group:') || hardcodedGroupKeySet.has(sender) || knownGroupIds.has(sender);
                    let resolvedBody = body;
                    if (!groupSenderName && looksLikeGroupMessage && body) {
                        const senderPrefixMatch = body.match(/^([^:\n]{1,80})\s*:\s*([\s\S]+)$/);
                        if (senderPrefixMatch) {
                            groupSenderName = String(senderPrefixMatch[1] || '').trim();
                            resolvedBody = String(senderPrefixMatch[2] || '').trim() || body;
                        }
                    }
                    // Safety net: if groupSenderName is already known and the body still starts
                    // with "SenderName: ...", strip the redundant prefix to prevent duplication.
                    if (groupSenderName && resolvedBody && resolvedBody !== body) {
                        // Already stripped above – no further action needed.
                    } else if (groupSenderName && looksLikeGroupMessage && body) {
                        const escapedName = groupSenderName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                        const prefixPattern = new RegExp(`^${escapedName}\\s*:\\s*`);
                        if (prefixPattern.test(body)) {
                            const stripped = body.replace(prefixPattern, '').trim();
                            if (stripped) {
                                resolvedBody = stripped;
                            }
                        }
                    }

                    const resolvedGroupType = groupTypeRaw === 'community' ? 'community' : (groupTypeRaw === 'group' ? 'group' : (resolvedGroupId ? (knownGroupTypeById.get(resolvedGroupId) || (hardcodedGroupKeySet.has(resolvedGroupId) ? 'community' : 'group')) : undefined));

                    if (isActionMessage) {
                        const normalizedReactor = normalizeUserKey(message.reactor || sender);
                        const reactorName = String(message.reactorName ?? message.senderName ?? '').trim();
                        const readAt = parseFlexibleTimestamp(message.readAt, message.readTime);
                        const editedAt = parseFlexibleTimestamp(message.editedAt, detailsMap.editedAt);
                        const deletedAt = parseFlexibleTimestamp(message.deletedAt, detailsMap.deletedAt);

                        return {
                            type: normalizedType,
                            messageId,
                            messageIds: normalizedType === 'read-receipt' && readMessageIds.length ? readMessageIds : undefined,
                            readAt: normalizedType === 'read-receipt' && readAt > 0 ? readAt : undefined,
                            sender: sender || undefined,
                            targetMessageId: normalizedType === 'reaction' ? (targetMessageId || undefined) : undefined,
                            emoji: normalizedType === 'reaction' ? (emoji || undefined) : undefined,
                            reactor: normalizedType === 'reaction' ? (normalizedReactor || undefined) : undefined,
                            reactorName: normalizedType === 'reaction' ? (reactorName || undefined) : undefined,
                            body: normalizedType === 'edit-action' ? (body || undefined) : undefined,
                            editedAt: normalizedType === 'edit-action' && editedAt > 0 ? editedAt : undefined,
                            deletedAt: normalizedType === 'delete-action' && deletedAt > 0 ? deletedAt : undefined,
                            timestamp,
                            toUser: normalizedToUserCandidate || undefined,
                            groupId: resolvedGroupId || undefined,
                            groupName: resolvedGroupName || undefined,
                            groupType: resolvedGroupType,
                            groupSenderName: groupSenderName || undefined,
                            userReceivedTime: parseFlexibleTimestamp(message.userReceivedTime) || undefined
                        };
                    }

                    return {
                        messageId,
                        sender,
                        toUser: normalizedToUserCandidate || undefined,
                        body: resolvedBody,
                        imageUrl,
                        fileUrl,
                        timestamp,
                        groupId: resolvedGroupId || undefined,
                        groupName: resolvedGroupName || undefined,
                        groupType: resolvedGroupType,
                        groupSenderName: groupSenderName || undefined,
                        userReceivedTime: parseFlexibleTimestamp(message.userReceivedTime) || undefined
                    };
                }).filter(Boolean);

                const dedupedMessages = dedupeLogsMessages(messages);
                return res.json({ result: 'success', messages: dedupedMessages });
            } catch (error) {
                console.error('[LOGS SYNC] Failed:', error.message);
                return res.status(502).json({ messages: [], error: 'Logs sync failed' });
            }
        }
    );

    app.post(
        ['/messages/received', '/notify/messages/received'],
        requireAuthorizedUser({
            required: true,
            candidateKeys: ['user'],
            onError: (_req, res, resolution) =>
                res.status(resolution.status).json({ error: resolution.error })
        }),
        async (req, res) => {
            const msgId = String((req.body && req.body.msgId) || '').trim();
            const receivedAtRaw = Number(req.body && req.body.receivedAt);
            if (!msgId) {
                return res.status(400).json({ error: 'Missing msgId' });
            }
            if (!Number.isFinite(receivedAtRaw) || receivedAtRaw <= 0) {
                return res.status(400).json({ error: 'Invalid receivedAt timestamp' });
            }
            if (typeof updateUserReceivedTime !== 'function') {
                return res.status(500).json({ error: 'Server configuration error' });
            }
            try {
                await updateUserReceivedTime(msgId, new Date(receivedAtRaw));
                return res.json({ result: 'success' });
            } catch (error) {
                console.error('[RECEIVED TIME] Failed to update:', error.message);
                return res.status(502).json({ error: 'Failed to update received time' });
            }
        }
    );

    app.post(
        ['/messages/received-batch', '/notify/messages/received-batch'],
        requireAuthorizedUser({
            required: true,
            candidateKeys: ['user'],
            onError: (_req, res, resolution) =>
                res.status(resolution.status).json({ error: resolution.error })
        }),
        async (req, res) => {
            const entries = Array.isArray(req.body && req.body.entries) ? req.body.entries : [];
            if (!entries.length) {
                return res.status(400).json({ error: 'Missing or empty entries array' });
            }
            const MAX_BATCH_SIZE = 200;
            const validEntries = entries
                .slice(0, MAX_BATCH_SIZE)
                .map((e) => {
                    const msgId = String((e && e.msgId) || '').trim();
                    const receivedAtRaw = Number(e && e.receivedAt);
                    if (!msgId || !Number.isFinite(receivedAtRaw) || receivedAtRaw <= 0) return null;
                    return { msgId, receivedAt: new Date(receivedAtRaw) };
                })
                .filter(Boolean);
            if (!validEntries.length) {
                return res.status(400).json({ error: 'No valid entries' });
            }
            if (typeof updateUserReceivedTimeBatch !== 'function') {
                return res.status(500).json({ error: 'Server configuration error' });
            }
            try {
                const updated = await updateUserReceivedTimeBatch(validEntries);
                return res.json({ result: 'success', updated });
            } catch (error) {
                console.error('[RECEIVED TIME BATCH] Failed to update:', error.message);
                return res.status(502).json({ error: 'Failed to update received times' });
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
