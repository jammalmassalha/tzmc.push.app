const fs = require('fs');
const path = 'C:/apps/tzmc.push.app/server.js';
let content = fs.readFileSync(path, 'utf8');

const oldFunc = `async function processReactionPayload(rawPayload = {}, resolvedUser = '') {
    const {
        groupId,
        groupName,
        groupMembers,
        groupCreatedBy,
        groupAdmins,
        groupUpdatedAt,
        groupType,
        targetMessageId,
        emoji,
        reactor,
        reactorName
    } = rawPayload || {};
    const normalizedTargetMessageId = String(targetMessageId || '').trim();
    const normalizedEmoji = String(emoji || '').trim();
    const normalizedReactor = normalizeUserKey(resolvedUser || reactor || '');
    if (!groupId || !normalizedTargetMessageId || !normalizedEmoji) {
        throw createHttpError(400, 'Missing reaction fields');
    }
    if (!normalizedReactor) {
        throw createHttpError(400, 'Missing reaction user');
    }

    const groupRecord = upsertGroup({
        groupId,
        groupName,
        groupMembers,
        groupCreatedBy,
        groupAdmins,
        groupUpdatedAt,
        groupType
    });
    const storedMembers = groupRecord && Array.isArray(groupRecord.members) ? groupRecord.members : [];
    const providedMembers = Array.isArray(groupMembers) ? groupMembers : [];
    const recipientByKey = new Map();
    [...storedMembers, ...providedMembers].forEach(member => {
        const rawMember = String(member || '').trim();
        const memberKey = normalizeUserKey(rawMember);
        if (!memberKey || memberKey === normalizedReactor) return;
        if (!recipientByKey.has(memberKey)) {
            recipientByKey.set(memberKey, rawMember);
        }
    });
    const membersToNotify = Array.from(recipientByKey.values());
    if (!membersToNotify.length) {
        return { status: 'success', details: { success: 0, failed: 0 } };
    }
    const adminByKey = new Map();
    const adminCandidates = [
        ...(groupRecord && Array.isArray(groupRecord.admins) ? groupRecord.admins : []),
        ...(Array.isArray(groupAdmins) ? groupAdmins : []),
        (groupRecord && groupRecord.createdBy) ? groupRecord.createdBy : '',
        groupCreatedBy || ''
    ];
    adminCandidates.forEach((candidate) => {
        const rawAdmin = String(candidate || '').trim();
        const adminKey = normalizeUserKey(rawAdmin);
        if (!adminKey || adminKey === normalizedReactor) return;
        if (!adminByKey.has(adminKey)) {
            adminByKey.set(adminKey, rawAdmin || adminKey);
        }
    });
    const adminMembersToNotify = Array.from(adminByKey.values());

    const reactionId = generateMessageId();
    const resolvedGroupName = (groupRecord && groupRecord.name) || String(groupName || '').trim() || 'קבוצה';
    const resolvedGroupMembers = groupRecord && Array.isArray(groupRecord.members)
        ? groupRecord.members
        : providedMembers;
    const resolvedGroupCreatedBy = (groupRecord && groupRecord.createdBy) || groupCreatedBy || null;
    const resolvedGroupUpdatedAt = (groupRecord && groupRecord.updatedAt) || groupUpdatedAt || Date.now();
    const resolvedGroupType = groupRecord
        ? groupRecord.type
        : normalizeGroupType(groupType || 'group');
    const resolvedReactorName = String(reactorName || reactor || 'משתמש').trim();
    const reactionText = \`\${resolvedReactorName} הגיב/ה \${normalizedEmoji}\`;

    const notificationData = {
        messageId: reactionId,
        title: resolvedGroupName || 'הודעה חדשה',
        body: {
            shortText: reactionText,
            longText: reactionText
        },
        data: {
            type: 'reaction',
            targetMessageId: normalizedTargetMessageId,
            emoji: normalizedEmoji,
            reactor: normalizedReactor || reactor,
            reactorName: resolvedReactorName,
            groupId,
            groupName: resolvedGroupName,
            groupMembers: resolvedGroupMembers,
            groupCreatedBy: resolvedGroupCreatedBy,
            groupAdmins: groupRecord && Array.isArray(groupRecord.admins) ? groupRecord.admins : undefined,
            groupUpdatedAt: resolvedGroupUpdatedAt,
            groupType: resolvedGroupType
        }
    };

    const reactionRecord = {
        messageId: reactionId,
        sender: groupId,
        type: 'reaction',
        targetMessageId: normalizedTargetMessageId,
        emoji: normalizedEmoji,
        reactor: normalizedReactor || reactor,
        reactorName: resolvedReactorName,
        timestamp: Date.now(),
        groupId,
        groupName: resolvedGroupName,
        groupMembers: resolvedGroupMembers,
        groupCreatedBy: resolvedGroupCreatedBy,
        groupAdmins: groupRecord && Array.isArray(groupRecord.admins) ? groupRecord.admins : undefined,
        groupUpdatedAt: resolvedGroupUpdatedAt,
        groupType: resolvedGroupType
    };
    await addToQueue(membersToNotify, reactionRecord);
    const result = adminMembersToNotify.length
        ? await sendPushNotificationToUser(adminMembersToNotify, notificationData, groupId, {
            messageId: reactionId,
            skipBadge: true,
            singlePerUser: true,
            allowSecondAttempt: false
        })
        : { success: 0, failed: 0 };
    return { status: 'success', details: result };
}`;

const newFunc = `async function processReactionPayload(rawPayload = {}, resolvedUser = '') {
    const {
        groupId,
        groupName,
        groupMembers,
        groupCreatedBy,
        groupAdmins,
        groupUpdatedAt,
        groupType,
        targetMessageId,
        emoji,
        reactor,
        reactorName,
        targetUser,
        originalSender
    } = rawPayload || {};
    const normalizedTargetMessageId = String(targetMessageId || '').trim();
    const normalizedEmoji = String(emoji || '').trim();
    const normalizedReactor = normalizeUserKey(resolvedUser || reactor || '');
    const normalizedTargetUser = normalizeUserKey(targetUser || originalSender || '');
    
    if ((!groupId && !normalizedTargetUser) || !normalizedTargetMessageId || !normalizedEmoji) {
        throw createHttpError(400, 'Missing reaction fields');
    }
    if (!normalizedReactor) {
        throw createHttpError(400, 'Missing reaction user');
    }

    const reactionId = generateMessageId();
    const resolvedReactorName = String(reactorName || reactor || 'משתמש').trim();
    const reactionText = \`\${resolvedReactorName} הגיב/ה \${normalizedEmoji}\`;

    let membersToNotify = [];
    let adminMembersToNotify = [];
    let reactionRecord = {
        messageId: reactionId,
        type: 'reaction',
        targetMessageId: normalizedTargetMessageId,
        emoji: normalizedEmoji,
        reactor: normalizedReactor || reactor,
        reactorName: resolvedReactorName,
        timestamp: Date.now()
    };
    let notificationData = {
        messageId: reactionId,
        body: {
            shortText: reactionText,
            longText: reactionText
        },
        data: {
            type: 'reaction',
            targetMessageId: normalizedTargetMessageId,
            emoji: normalizedEmoji,
            reactor: normalizedReactor || reactor,
            reactorName: resolvedReactorName
        }
    };

    if (groupId) {
        const groupRecord = upsertGroup({
            groupId, groupName, groupMembers, groupCreatedBy, groupAdmins, groupUpdatedAt, groupType
        });
        const storedMembers = groupRecord && Array.isArray(groupRecord.members) ? groupRecord.members : [];
        const providedMembers = Array.isArray(groupMembers) ? groupMembers : [];
        const recipientByKey = new Map();
        [...storedMembers, ...providedMembers].forEach(member => {
            const rawMember = String(member || '').trim();
            const memberKey = normalizeUserKey(rawMember);
            if (!memberKey || memberKey === normalizedReactor) return;
            if (!recipientByKey.has(memberKey)) {
                recipientByKey.set(memberKey, rawMember);
            }
        });
        membersToNotify = Array.from(recipientByKey.values());
        
        const adminByKey = new Map();
        const adminCandidates = [
            ...(groupRecord && Array.isArray(groupRecord.admins) ? groupRecord.admins : []),
            ...(Array.isArray(groupAdmins) ? groupAdmins : []),
            (groupRecord && groupRecord.createdBy) ? groupRecord.createdBy : '',
            groupCreatedBy || ''
        ];
        adminCandidates.forEach((candidate) => {
            const rawAdmin = String(candidate || '').trim();
            const adminKey = normalizeUserKey(rawAdmin);
            if (!adminKey || adminKey === normalizedReactor) return;
            if (!adminByKey.has(adminKey)) {
                adminByKey.set(adminKey, rawAdmin || adminKey);
            }
        });
        adminMembersToNotify = Array.from(adminByKey.values());

        const resolvedGroupName = (groupRecord && groupRecord.name) || String(groupName || '').trim() || 'קבוצה';
        const resolvedGroupMembers = groupRecord && Array.isArray(groupRecord.members) ? groupRecord.members : providedMembers;
        const resolvedGroupCreatedBy = (groupRecord && groupRecord.createdBy) || groupCreatedBy || null;
        const resolvedGroupUpdatedAt = (groupRecord && groupRecord.updatedAt) || groupUpdatedAt || Date.now();
        const resolvedGroupType = groupRecord ? groupRecord.type : normalizeGroupType(groupType || 'group');
        
        notificationData.title = resolvedGroupName || 'הודעה חדשה';
        Object.assign(notificationData.data, {
            groupId, groupName: resolvedGroupName, groupMembers: resolvedGroupMembers,
            groupCreatedBy: resolvedGroupCreatedBy, groupAdmins: groupRecord && Array.isArray(groupRecord.admins) ? groupRecord.admins : undefined,
            groupUpdatedAt: resolvedGroupUpdatedAt, groupType: resolvedGroupType
        });
        
        Object.assign(reactionRecord, {
            sender: groupId,
            groupId, groupName: resolvedGroupName, groupMembers: resolvedGroupMembers,
            groupCreatedBy: resolvedGroupCreatedBy, groupAdmins: groupRecord && Array.isArray(groupRecord.admins) ? groupRecord.admins : undefined,
            groupUpdatedAt: resolvedGroupUpdatedAt, groupType: resolvedGroupType
        });
    } else {
        if (normalizedTargetUser !== normalizedReactor) {
            membersToNotify = [normalizedTargetUser];
            adminMembersToNotify = [normalizedTargetUser];
        }
        reactionRecord.sender = normalizedReactor;
        notificationData.title = \`תגובה מ-\${resolvedReactorName}\`;
    }

    if (!membersToNotify.length) {
        return { status: 'success', details: { success: 0, failed: 0 } };
    }

    await addToQueue(membersToNotify, reactionRecord);
    const result = adminMembersToNotify.length
        ? await sendPushNotificationToUser(adminMembersToNotify, notificationData, groupId || normalizedReactor, {
            messageId: reactionId,
            skipBadge: true,
            singlePerUser: true,
            allowSecondAttempt: false
        })
        : { success: 0, failed: 0 };
    return { status: 'success', details: result };
}`;

// Use indexof or similar since the text might differ slightly
const startIndex = content.indexOf("async function processReactionPayload(rawPayload = {}, resolvedUser = '') {");
if (startIndex !== -1) {
    let endIndex = content.indexOf("async function processReplyPayload", startIndex);
    if (endIndex === -1) {
       endIndex = content.indexOf("function normalizeDeliveryTelemetryValue", startIndex);
    }
    
    if (endIndex !== -1) {
        content = content.substring(0, startIndex) + newFunc + "\n\n" + content.substring(endIndex);
        fs.writeFileSync(path, content, 'utf8');
        console.log("Patched successfully!");
    } else {
        console.log("Could not find endIndex");
    }
} else {
    console.log("Could not find startIndex");
}
