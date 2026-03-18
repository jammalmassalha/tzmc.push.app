function registerMessageController(app, deps = {}) {
    const {
        requireAuthorizedUser,
        normalizeUserKey,
        fetchWithRetry,
        buildGoogleSheetGetUrl,
        getLogsMessagesForUser,
        getGroups,
        getActiveRedisStateStore,
        getMessageQueue,
        scheduleStateSave,
        sseClients
    } = deps;
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
            const parseFlexibleTimestamp = (...candidates) => {
                for (const candidate of candidates) {
                    if (candidate === null || candidate === undefined) continue;
                    const numeric = Number(candidate);
                    if (Number.isFinite(numeric) && numeric > 0) {
                        return numeric;
                    }
                    const text = String(candidate || '').trim();
                    if (!text) continue;
                    const parsedDate = Date.parse(text);
                    if (Number.isFinite(parsedDate) && parsedDate > 0) {
                        return parsedDate;
                    }
                }
                return 0;
            };
            const parseLogDetailsMap = (rawValue) => {
                const detailsText = String(rawValue || '').trim();
                if (!detailsText) {
                    return {};
                }
                try {
                    const parsed = JSON.parse(detailsText);
                    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                        return Object.entries(parsed).reduce((acc, [key, value]) => {
                            acc[String(key)] = String(value == null ? '' : value).trim();
                            return acc;
                        }, {});
                    }
                } catch (_error) {
                    // Fallback to key=value parser.
                }
                return detailsText
                    .split('|')
                    .map((segment) => String(segment || '').trim())
                    .filter(Boolean)
                    .reduce((acc, segment) => {
                        const separatorIndex = segment.indexOf('=');
                        if (separatorIndex <= 0) {
                            return acc;
                        }
                        const key = String(segment.slice(0, separatorIndex) || '').trim();
                        const value = String(segment.slice(separatorIndex + 1) || '').trim();
                        if (!key) {
                            return acc;
                        }
                        acc[key] = value;
                        return acc;
                    }, {});
            };
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
                const rawMessages = typeof getLogsMessagesForUser === 'function'
                    ? await getLogsMessagesForUser(user, { limit, excludeSystem: true })
                    : [];
                const messages = rawMessages
                    .map((message, index) => {
                        if (!message || typeof message !== 'object') {
                            return null;
                        }
                        const messageStatus = String(
                            message.status ??
                            message.deliveryStatus ??
                            ''
                        ).trim().toLowerCase();
                        const detailsMap = parseLogDetailsMap(
                            message.details ??
                            message.detail ??
                            message.logDetails ??
                            message.metadata ??
                            ''
                        );
                        const rawType = String(
                            message.type ??
                            message.eventType ??
                            message.event_type ??
                            message.actionType ??
                            message.action_type ??
                            detailsMap.type ??
                            detailsMap.eventType ??
                            detailsMap.event_type ??
                            detailsMap.actionType ??
                            detailsMap.action_type ??
                            (messageStatus.startsWith('deleted') ? 'delete-action' : '') ??
                            ''
                        ).trim().toLowerCase();
                        const supportedActionTypes = new Set([
                            'reaction',
                            'group-update',
                            'read-receipt',
                            'edit-action',
                            'delete-action'
                        ]);
                        const normalizedType = supportedActionTypes.has(rawType) ? rawType : '';
                        const isActionMessage = Boolean(normalizedType);
                        const sender = normalizeUserKey(
                            message.sender ||
                            message.from ||
                            message.reactor ||
                            ''
                        );
                        if (!isActionMessage && (!sender || sender === 'system')) {
                            return null;
                        }
                        const body = String(message.body ?? message.message ?? message.content ?? '').trim();
                        if (!isActionMessage && !body) {
                            return null;
                        }
                        const normalizedBody = body.toLowerCase();
                        if (!isActionMessage && (normalizedBody === 'new notification' || normalizedBody === 'new reaction')) {
                            return null;
                        }

                        const sourceTimestamp = parseFlexibleTimestamp(
                            message.timestamp,
                            message.sentAt,
                            message.at,
                            message.createdAt,
                            message.created_at,
                            message.dateTime,
                            message.datetime,
                            message.date,
                            message.time
                        );
                        const timestamp = sourceTimestamp > 0
                            ? sourceTimestamp
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
                            detailsMap.messageId ??
                            detailsMap.message_id ??
                            detailsMap.targetMessageId ??
                            detailsMap.target_message_id ??
                            ''
                        ).trim();
                        const timestampSeed = String(
                            message.timestamp ??
                            message.sentAt ??
                            message.at ??
                            message.createdAt ??
                            message.created_at ??
                            message.dateTime ??
                            message.datetime ??
                            message.date ??
                            message.time ??
                            ''
                        ).trim();
                        const targetMessageId = String(
                            message.targetMessageId ??
                            message.target_message_id ??
                            message.messageTargetId ??
                            message.message_target_id ??
                            detailsMap.targetMessageId ??
                            detailsMap.target_message_id ??
                            detailsMap.messageId ??
                            detailsMap.message_id ??
                            ''
                        ).trim();
                        const emoji = String(message.emoji ?? message.reaction ?? '').trim();
                        const readMessageIds = Array.isArray(message.messageIds)
                            ? message.messageIds.map((id) => String(id || '').trim()).filter(Boolean)
                            : String(
                                message.messageIds ??
                                message.message_ids ??
                                detailsMap.messageIds ??
                                detailsMap.message_ids ??
                                message.messageId ??
                                message.message_id ??
                                ''
                            ).split(',').map((id) => String(id || '').trim()).filter(Boolean);
                        const actionFingerprintSeed = isActionMessage
                            ? `${normalizedType}|${targetMessageId}|${emoji}|${readMessageIds.join(',')}`
                            : body;
                        const fingerprintSource = `${sender || 'unknown'}|${resolvedGroupId || normalizedToUserCandidate || user}|${timestampSeed || 'na'}|${actionFingerprintSeed}`;
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

                        if (isActionMessage) {
                            const normalizedReactor = normalizeUserKey(message.reactor || sender);
                            const reactorName = String(
                                message.reactorName ??
                                message.reactor_name ??
                                message.senderName ??
                                message.sender_name ??
                                ''
                            ).trim();
                            const readAt = parseFlexibleTimestamp(
                                message.readAt,
                                message.read_at,
                                message.readTime,
                                message.read_time
                            );
                            const editedAt = parseFlexibleTimestamp(
                                message.editedAt,
                                message.edited_at,
                                detailsMap.editedAt,
                                detailsMap.edited_at
                            );
                            const deletedAt = parseFlexibleTimestamp(
                                message.deletedAt,
                                message.deleted_at,
                                detailsMap.deletedAt,
                                detailsMap.deleted_at
                            );

                            return {
                                type: normalizedType,
                                messageId,
                                messageIds: normalizedType === 'read-receipt' && readMessageIds.length
                                    ? readMessageIds
                                    : undefined,
                                readAt: normalizedType === 'read-receipt' && readAt > 0 ? readAt : undefined,
                                sender: sender || undefined,
                                targetMessageId: normalizedType === 'reaction'
                                    ? (targetMessageId || undefined)
                                    : undefined,
                                emoji: normalizedType === 'reaction' ? (emoji || undefined) : undefined,
                                reactor: normalizedType === 'reaction' ? (normalizedReactor || undefined) : undefined,
                                reactorName: normalizedType === 'reaction' ? (reactorName || undefined) : undefined,
                                body: normalizedType === 'edit-action' ? (body || undefined) : undefined,
                                editedAt: normalizedType === 'edit-action' && editedAt > 0 ? editedAt : undefined,
                                deletedAt: normalizedType === 'delete-action' && deletedAt > 0 ? deletedAt : undefined,
                                timestamp,
                                groupId: resolvedGroupId || undefined,
                                groupName: resolvedGroupName || undefined,
                                groupType: resolvedGroupType,
                                groupSenderName: groupSenderName || undefined
                            };
                        }

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

                const dedupedMessages = dedupeLogsMessages(messages);
                const dedupedCount = messages.length - dedupedMessages.length;
                if (dedupedCount > 0) {
                    console.warn(`[LOGS SYNC] Deduped ${dedupedCount} duplicate logs messages for ${user}`);
                }
                return res.json({ result: 'success', messages: dedupedMessages });
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
