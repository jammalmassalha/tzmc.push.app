"use strict";
// ─── Notification Service ────────────────────────────────────────────────────
// Encapsulates push-payload building, subscription filtering/limiting, and the
// core logic for sending web-push notifications.
// All external dependencies (webpush, subscription lookup, state mutation) are
// injected via the constructor so the service stays unit-testable.
// ─────────────────────────────────────────────────────────────────────────────
Object.defineProperty(exports, "__esModule", { value: true });
exports.NotificationService = void 0;
// ─── Service ────────────────────────────────────────────────────────────────
class NotificationService {
    maxPushPayloadBytes;
    maxPushTextLength;
    defaultMaxEndpointsPerUser;
    singleTargetMaxSafe;
    unknownUserFallbackMax;
    deps;
    constructor(config, deps) {
        this.maxPushPayloadBytes = Math.max(2048, config.maxPushPayloadBytes ?? 3584);
        this.maxPushTextLength = Math.max(80, config.maxPushTextLength ?? 280);
        this.defaultMaxEndpointsPerUser = Math.max(1, config.defaultMaxEndpointsPerUser ?? 2);
        this.singleTargetMaxSafe = Math.max(1, config.singleTargetMaxSafeSubscriptions ?? 8);
        this.unknownUserFallbackMax = Math.max(1, config.unknownUserFallbackMaxEndpoints ?? 4);
        this.deps = deps;
    }
    // ── Public: payload building ────────────────────────────────────────────
    trimPushTextValue(value, maxLength = this.maxPushTextLength) {
        const text = String(value || '');
        if (text.length <= maxLength)
            return text;
        if (maxLength <= 3)
            return text.slice(0, maxLength);
        return `${text.slice(0, maxLength - 3)}...`;
    }
    buildCompactPushCustomData(rawData = {}, messageType = '') {
        if (!rawData || typeof rawData !== 'object')
            return {};
        const compact = {};
        Object.entries(rawData).forEach(([key, rawValue]) => {
            if (rawValue === undefined || rawValue === null)
                return;
            if (key === 'membersToNotify')
                return;
            if (key === 'groupMembers') {
                if (messageType === 'group-update') {
                    compact.groupMembers = this.deps.parseUsernamesInput(rawValue).slice(0, 120);
                }
                return;
            }
            if (typeof rawValue === 'string') {
                // Preserve messageText with a higher limit so the full message body
                // survives payload compaction and can be used by the client.
                const limit = key === 'messageText' ? 2000 : this.maxPushTextLength;
                compact[key] = this.trimPushTextValue(rawValue, limit);
                return;
            }
            if (Array.isArray(rawValue)) {
                compact[key] = rawValue.slice(0, 20);
                return;
            }
            compact[key] = rawValue;
        });
        return compact;
    }
    buildPushPayloadString(payloadData = {}, options = {}) {
        const includeNotification = options.includeNotification !== false;
        const buildPayloadEnvelope = (dataPayload) => {
            if (!includeNotification)
                return { data: dataPayload };
            const title = String(dataPayload.title || '').trim();
            const body = String(dataPayload.body || dataPayload.groupMessageText || dataPayload.messageText || 'New Notification').trim();
            const notification = {
                title: title || 'Work Alert',
                body: body || 'New Notification',
                icon: dataPayload.icon || dataPayload.badge,
                badge: dataPayload.badge || dataPayload.icon,
                image: dataPayload.image || undefined,
                requireInteraction: Boolean(dataPayload.requireInteraction),
                tag: String(dataPayload.messageId || '').trim() || undefined
            };
            return { notification, data: dataPayload };
        };
        let compactData = { ...payloadData };
        let payload = JSON.stringify(buildPayloadEnvelope(compactData));
        if (Buffer.byteLength(payload, 'utf8') <= this.maxPushPayloadBytes)
            return payload;
        delete compactData.groupMembers;
        delete compactData.membersToNotify;
        delete compactData.replyToBody;
        delete compactData.replyToImageUrl;
        delete compactData.forwardedFromName;
        if (typeof compactData.groupMessageText === 'string') {
            compactData.groupMessageText = this.trimPushTextValue(compactData.groupMessageText, 120);
        }
        if (typeof compactData.body === 'string') {
            compactData.body = this.trimPushTextValue(compactData.body, 120);
        }
        payload = JSON.stringify(buildPayloadEnvelope(compactData));
        if (Buffer.byteLength(payload, 'utf8') <= this.maxPushPayloadBytes)
            return payload;
        // If still too large, trim messageText but preserve more than notification fields
        if (typeof compactData.messageText === 'string' && compactData.messageText.length > 500) {
            compactData.messageText = this.trimPushTextValue(compactData.messageText, 500);
        }
        payload = JSON.stringify(buildPayloadEnvelope(compactData));
        if (Buffer.byteLength(payload, 'utf8') <= this.maxPushPayloadBytes)
            return payload;
        const emergencyData = {
            type: compactData.type,
            messageId: compactData.messageId,
            groupId: compactData.groupId,
            groupName: compactData.groupName,
            sender: compactData.sender,
            user: compactData.user,
            title: compactData.title,
            body: this.trimPushTextValue(compactData.body || compactData.groupMessageText || compactData.messageText || 'New Notification', 120),
            messageText: this.trimPushTextValue(compactData.messageText || compactData.groupMessageText || compactData.body || '', 500),
            image: compactData.image,
            url: compactData.url,
            badge: compactData.badge,
            icon: compactData.icon,
            requireInteraction: compactData.requireInteraction
        };
        return JSON.stringify(buildPayloadEnvelope(emergencyData));
    }
    // ── Public: subscription filtering ──────────────────────────────────────
    isLikelyPhoneUserKey(userKey) {
        const digits = String(userKey || '').replace(/\D/g, '');
        return (/^0\d{9}$/.test(digits) ||
            /^5\d{8}$/.test(digits) ||
            /^9725\d{8}$/.test(digits) ||
            /^97205\d{8}$/.test(digits));
    }
    limitSubscriptionsPerUser(subscriptions = [], maxPerUser = this.defaultMaxEndpointsPerUser) {
        const normalizedMax = Math.max(1, Number(maxPerUser) || this.defaultMaxEndpointsPerUser);
        const byUser = new Map();
        const orderedUsers = [];
        (Array.isArray(subscriptions) ? subscriptions : []).forEach((subscription) => {
            if (!subscription || typeof subscription !== 'object')
                return;
            const userKey = this.deps.normalizeUserKey(subscription.username || subscription.user || '');
            if (!userKey)
                return;
            if (!byUser.has(userKey)) {
                byUser.set(userKey, { mobile: [], pc: [], unknown: [] });
                orderedUsers.push(userKey);
            }
            const bucket = byUser.get(userKey);
            const type = this.deps.normalizeSubscriptionType(subscription.type || subscription.deviceType || '');
            if (type === 'mobile') {
                bucket.mobile.push(subscription);
                return;
            }
            if (type === 'pc') {
                bucket.pc.push(subscription);
                return;
            }
            bucket.unknown.push(subscription);
        });
        const selected = [];
        orderedUsers.forEach((userKey) => {
            const bucket = byUser.get(userKey);
            if (!bucket)
                return;
            const pickedForUser = [];
            const pickOne = (list) => {
                if (!Array.isArray(list) || !list.length)
                    return;
                pickedForUser.push(list[0]);
            };
            pickOne(bucket.mobile);
            pickOne(bucket.pc);
            if (!pickedForUser.length)
                pickOne(bucket.unknown);
            const overflowPool = [...bucket.mobile.slice(1), ...bucket.pc.slice(1), ...bucket.unknown.slice(1)];
            while (pickedForUser.length < normalizedMax && overflowPool.length) {
                pickedForUser.push(overflowPool.shift());
            }
            selected.push(...pickedForUser.slice(0, normalizedMax));
        });
        return this.deps.dedupeSubscriptionsByEndpoint(selected);
    }
    // ── Public: core send ───────────────────────────────────────────────────
    async sendPushNotificationToUser(targetUser, message, senderuser, options = {}) {
        const targetUsersArray = Array.isArray(targetUser) ? targetUser : [targetUser];
        // 1. Prepare content
        const msgBody = (message.body && typeof message.body === 'object' ? message.body : {});
        const customData = (message.data && typeof message.data === 'object' ? message.data : {});
        const messageType = String(customData.type || '').trim().toLowerCase();
        const isGroupScopedPush = Boolean(customData.groupId || customData.groupName || messageType === 'group-update' || messageType === 'reaction' ||
            (Array.isArray(customData.groupMembers) && customData.groupMembers.length));
        const imageUrl = message.image || null;
        const fileUrl = customData.fileUrl || null;
        const finalSender = senderuser || 'System';
        const singlePerUser = Boolean(options.singlePerUser || messageType === 'reaction');
        const allowSecondAttempt = options.allowSecondAttempt !== false && messageType !== 'reaction';
        const shouldLimitPerUserEndpoints = options.limitPerUserEndpoints !== false && !messageType;
        const configuredMaxEndpoints = Number(options.maxPerUserEndpoints);
        const maxEndpointsPerUser = (Number.isFinite(configuredMaxEndpoints) && configuredMaxEndpoints > 0)
            ? Math.floor(configuredMaxEndpoints)
            : (shouldLimitPerUserEndpoints ? this.defaultMaxEndpointsPerUser : 0);
        const compactCustomData = this.buildCompactPushCustomData(customData, messageType);
        let msgTitle = message.title || 'Work Alert';
        let msgText = msgBody.shortText || 'New Notification';
        if (messageType === 'reaction') {
            const reactionGroupName = String(customData.groupName || message.title || finalSender || '').trim();
            msgTitle = reactionGroupName || 'Group';
            msgText = 'new reaction';
        }
        const logContent = msgText || messageType || 'System Notification';
        const shouldPersistPushLog = messageType !== 'read-receipt';
        const messageId = options.messageId || message.messageId || this.deps.generateMessageId();
        const shouldDedupLog = Boolean(options.dedupLog);
        const shouldIncrementBadge = !options.skipBadge;
        let normalizedTargetUsers = Array.from(new Set(targetUsersArray.map((u) => this.deps.normalizeUserKey(u)).filter(Boolean)));
        if (!isGroupScopedPush && normalizedTargetUsers.length > 3) {
            console.warn(`[PUSH] Direct-target users trimmed: ${normalizedTargetUsers.length} -> 3`);
            normalizedTargetUsers = normalizedTargetUsers.slice(0, 3);
        }
        const targetAliasToCanonical = this.deps.buildUserAliasLookupMap(normalizedTargetUsers);
        const targetUsersSet = new Set(normalizedTargetUsers);
        const singleTargetUser = normalizedTargetUsers.length === 1 ? normalizedTargetUsers[0] : '';
        // ── Subscription resolution helpers ─────────────────────────────────
        const normalizeAndFilterTargetSubscriptions = (subscriptions, filterOptions = {}) => {
            const allowUnknownUser = Boolean(filterOptions.allowUnknownUser);
            const normalized = this.deps.dedupeSubscriptionsByEndpoint(subscriptions || []);
            const matched = [];
            const unknownWithoutUser = [];
            normalized.forEach((subscription) => {
                const rawUser = this.deps.normalizeUserKey(subscription.username || subscription.user);
                const canonicalUser = this.deps.resolveCanonicalUserFromLookup(rawUser, targetAliasToCanonical);
                if (canonicalUser) {
                    matched.push({ ...subscription, username: canonicalUser });
                    return;
                }
                if (rawUser)
                    return;
                if (!allowUnknownUser || !singleTargetUser)
                    return;
                unknownWithoutUser.push({ ...subscription, username: singleTargetUser });
            });
            if (matched.length)
                return matched;
            if (unknownWithoutUser.length > 0 && unknownWithoutUser.length <= this.unknownUserFallbackMax) {
                return unknownWithoutUser;
            }
            return [];
        };
        console.log(`[PUSH] Searching subs for: ${targetUsersArray.join(', ')} from ${finalSender}`);
        // ── Fetch subscriptions (multiple strategies) ───────────────────────
        let rawSubscriptions = normalizeAndFilterTargetSubscriptions(await this.deps.getSubscriptionFromSheet(targetUsersArray), { allowUnknownUser: true });
        if (!rawSubscriptions.length) {
            rawSubscriptions = normalizeAndFilterTargetSubscriptions(await this.deps.getSubscriptionFromSheet(targetUsersArray, { forceRefresh: true }), { allowUnknownUser: true });
        }
        if (!rawSubscriptions.length) {
            const fallbackDiscovery = await this.deps.getAllSubscriptionsForAuthRefresh({ usernames: targetUsersArray });
            const discoveredSubscriptions = Array.isArray(fallbackDiscovery.subscriptions) ? fallbackDiscovery.subscriptions : [];
            rawSubscriptions = normalizeAndFilterTargetSubscriptions(discoveredSubscriptions, { allowUnknownUser: false });
            if (rawSubscriptions.length) {
                const cacheKey = this.deps.buildSubscriptionCacheKey(targetUsersArray);
                if (cacheKey) {
                    this.deps.subscriptionCache.set(cacheKey, { at: Date.now(), subscriptions: rawSubscriptions });
                }
            }
        }
        const localSubscriptions = this.deps.getLocalDeviceSubscriptionsForUsers(targetUsersArray);
        if (localSubscriptions.length) {
            rawSubscriptions = normalizeAndFilterTargetSubscriptions([...rawSubscriptions, ...localSubscriptions], { allowUnknownUser: true });
            const cacheKey = this.deps.buildSubscriptionCacheKey(targetUsersArray);
            if (cacheKey && rawSubscriptions.length) {
                this.deps.subscriptionCache.set(cacheKey, { at: Date.now(), subscriptions: rawSubscriptions });
            }
        }
        const recipientAuthJsonForLog = this.deps.buildMobileSubscriptionAuthJsonForLog(targetUsersArray.join(','), rawSubscriptions || []);
        if (!rawSubscriptions.length) {
            this.deps.logNotificationStatus(finalSender, targetUsersArray.join(','), logContent, 'Failed', 'No subscriptions found', recipientAuthJsonForLog, messageId, '', '', { dedup: shouldDedupLog });
            return { success: 0, failed: 0 };
        }
        // ── Send to subscriptions helper ────────────────────────────────────
        const sendToSubscriptions = async (subscriptions, allowBadgeIncrement) => {
            const badgeCountByUser = new Map();
            return Promise.all(subscriptions.map(async (subscription) => {
                const userKey = this.deps.normalizeUserKey(subscription.username || subscription.user);
                const hasExplicitUser = Boolean(userKey);
                const resolvedUserKey = userKey || singleTargetUser;
                if (hasExplicitUser && targetUsersSet.size && !targetUsersSet.has(userKey)) {
                    return { ok: false, username: userKey || 'unknown', statusCode: 'SKIP', message: 'Subscription user mismatch' };
                }
                let currentCount = resolvedUserKey ? (this.deps.unreadCounts[resolvedUserKey] || 0) : 0;
                if (shouldIncrementBadge && resolvedUserKey) {
                    if (allowBadgeIncrement) {
                        if (badgeCountByUser.has(resolvedUserKey)) {
                            currentCount = badgeCountByUser.get(resolvedUserKey);
                        }
                        else {
                            currentCount = currentCount + 1;
                            this.deps.unreadCounts[resolvedUserKey] = currentCount;
                            badgeCountByUser.set(resolvedUserKey, currentCount);
                        }
                    }
                    else {
                        currentCount = this.deps.unreadCounts[resolvedUserKey] || 0;
                    }
                }
                const clickUrl = `/subscribes/?chat=${encodeURIComponent(finalSender)}`;
                const payloadData = {
                    ...compactCustomData,
                    title: msgTitle,
                    body: msgText || 'New Notification',
                    badge: 'https://www.tzmc.co.il/subscribes/assets/icon-192.png',
                    icon: 'https://www.tzmc.co.il/subscribes/assets/icon-192.png',
                    requireInteraction: true,
                    image: imageUrl,
                    url: clickUrl,
                    user: resolvedUserKey,
                    sender: finalSender,
                    messageId
                };
                if (shouldIncrementBadge && resolvedUserKey)
                    payloadData.badgeCount = currentCount;
                const includeNotificationPayload = !(payloadData.skipNotification === true ||
                    messageType === 'read-receipt' ||
                    messageType === 'group-update' ||
                    messageType === 'delete-action' ||
                    messageType === 'edit-action' ||
                    messageType === this.deps.AUTH_REFRESH_PUSH_TYPE);
                const payload = this.buildPushPayloadString(payloadData, { includeNotification: includeNotificationPayload });
                try {
                    const pushOptions = { TTL: 604800, headers: { Urgency: 'high' }, timeout: 15000 };
                    await this.deps.sendNotification(subscription, payload, pushOptions);
                    return { ok: true, username: subscription.username || resolvedUserKey || 'unknown', badge: currentCount, endpoint: subscription.endpoint };
                }
                catch (err) {
                    const errorObj = err;
                    const statusCode = errorObj.statusCode || 'N/A';
                    if (statusCode === 404 || statusCode === 410) {
                        this.deps.pruneSubscriptionCacheEndpoint(subscription.endpoint || '');
                    }
                    return { ok: false, username: subscription.username || resolvedUserKey || 'unknown', statusCode, message: errorObj.message, endpoint: subscription.endpoint };
                }
            }));
        };
        // ── Filter & limit subscriptions ────────────────────────────────────
        let uniqueSubscriptions = normalizeAndFilterTargetSubscriptions(rawSubscriptions);
        if (singlePerUser) {
            const onePerUser = new Map();
            uniqueSubscriptions.forEach((sub) => {
                const uKey = this.deps.normalizeUserKey(sub.username || sub.user || '');
                if (!uKey)
                    return;
                onePerUser.set(uKey, sub);
            });
            uniqueSubscriptions = Array.from(onePerUser.values());
        }
        else if (maxEndpointsPerUser > 0) {
            uniqueSubscriptions = this.limitSubscriptionsPerUser(uniqueSubscriptions, maxEndpointsPerUser);
        }
        if (singleTargetUser && uniqueSubscriptions.length > this.singleTargetMaxSafe) {
            console.warn(`[PUSH] Single-target subscriptions trimmed for ${singleTargetUser}: ${uniqueSubscriptions.length} -> ${this.singleTargetMaxSafe}`);
            uniqueSubscriptions = uniqueSubscriptions.slice(0, this.singleTargetMaxSafe);
        }
        if (!isGroupScopedPush) {
            const maxDirect = Math.max(1, Math.min(24, normalizedTargetUsers.length * this.singleTargetMaxSafe));
            if (uniqueSubscriptions.length > maxDirect) {
                console.warn(`[PUSH] Direct subscriptions hard-trimmed: ${uniqueSubscriptions.length} -> ${maxDirect}`);
                uniqueSubscriptions = uniqueSubscriptions.slice(0, maxDirect);
            }
        }
        let sendResults = await sendToSubscriptions(uniqueSubscriptions, true);
        // ── Count results ───────────────────────────────────────────────────
        let successCount = 0;
        let failCount = 0;
        const executionLogs = [];
        const appendResultsToLogs = (results) => {
            for (const result of results) {
                if (result.ok) {
                    successCount++;
                    executionLogs.push(`Device (${result.username}): ✅ Delivered (Badge: ${result.badge})`);
                }
                else {
                    failCount++;
                    executionLogs.push(`Device (${result.username}): ❌ Failed [${result.statusCode}]`);
                    console.error(`[PUSH FAIL] ${result.username}:`, result.message);
                }
            }
        };
        appendResultsToLogs(sendResults);
        // ── Retry on total failure ──────────────────────────────────────────
        if (successCount === 0 && allowSecondAttempt) {
            const cacheKey = this.deps.buildSubscriptionCacheKey(targetUsersArray);
            if (cacheKey)
                this.deps.subscriptionCache.delete(cacheKey);
            const refreshedRaw = await this.deps.getSubscriptionFromSheet(targetUsersArray, { forceRefresh: true });
            let refreshedUnique = normalizeAndFilterTargetSubscriptions([
                ...(Array.isArray(refreshedRaw) ? refreshedRaw : []),
                ...this.deps.getLocalDeviceSubscriptionsForUsers(targetUsersArray)
            ]);
            if (!singlePerUser && maxEndpointsPerUser > 0) {
                refreshedUnique = this.limitSubscriptionsPerUser(refreshedUnique, maxEndpointsPerUser);
            }
            if (refreshedUnique.length) {
                const existingEndpoints = new Set(uniqueSubscriptions.map((s) => s.endpoint));
                const retryTargets = refreshedUnique.filter((s) => !existingEndpoints.has(s.endpoint));
                const effectiveRetryTargets = retryTargets.length ? retryTargets : refreshedUnique;
                const retryResults = await sendToSubscriptions(effectiveRetryTargets, false);
                appendResultsToLogs(retryResults);
                sendResults = [...sendResults, ...retryResults];
            }
        }
        // ── Stale endpoint cleanup ──────────────────────────────────────────
        const staleEndpoints = Array.from(new Set(sendResults
            .filter((r) => !r.ok && (r.statusCode === 404 || r.statusCode === 410))
            .map((r) => String(r.endpoint || '').trim())
            .filter(Boolean)));
        if (staleEndpoints.length) {
            let localRemoved = 0;
            staleEndpoints.forEach((endpoint) => {
                if (this.deps.removeLocalDeviceSubscriptionEndpoint(endpoint))
                    localRemoved += 1;
            });
            let staleCleanupSummary = null;
            try {
                staleCleanupSummary = await this.deps.removeStaleSubscriptionsFromSheet(staleEndpoints);
            }
            catch {
                staleCleanupSummary = null;
            }
            if (localRemoved > 0 || staleCleanupSummary) {
                executionLogs.push(`[STALE CLEANUP] endpoints=${staleEndpoints.length}, localRemoved=${localRemoved}, ` +
                    `sheetCleared=${Number(staleCleanupSummary?.clearedSubscriptions || 0)}`);
            }
        }
        this.deps.scheduleStateSave();
        if (shouldPersistPushLog) {
            const fullReport = executionLogs.join('\n');
            const finalStatus = successCount > 0 ? 'Sent' : 'Failed';
            this.deps.logNotificationStatus(finalSender, targetUsersArray.join(','), logContent, finalStatus, fullReport, recipientAuthJsonForLog, messageId, imageUrl || '', fileUrl || '', { dedup: shouldDedupLog });
        }
        return { success: successCount, failed: failCount };
    }
}
exports.NotificationService = NotificationService;
