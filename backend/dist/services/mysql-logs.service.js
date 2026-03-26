"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.MysqlLogsService = void 0;
exports.createMysqlLogsServiceFromEnv = createMysqlLogsServiceFromEnv;
const promise_1 = __importDefault(require("mysql2/promise"));
function toTrimmedString(value) {
    return String(value ?? '').trim();
}
function toPositiveInteger(value, fallbackValue) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        return fallbackValue;
    }
    return Math.floor(parsed);
}
function normalizePhone(value) {
    let text = toTrimmedString(value);
    if (!text)
        return '';
    // Strip non-digit characters (dashes, spaces, parentheses, etc.) for consistent matching
    text = text.replace(/\D/g, '');
    if (!text)
        return '';
    if (text.charAt(0) !== '0') {
        text = `0${text}`;
    }
    return text;
}
function normalizeGroupKey(value) {
    return toTrimmedString(value).toLowerCase();
}
function parseRecipientUsernames(recipientRawValue) {
    const parts = [];
    if (Array.isArray(recipientRawValue)) {
        recipientRawValue.forEach((value) => parts.push(toTrimmedString(value)));
    }
    else if (recipientRawValue && typeof recipientRawValue === 'object') {
        const record = recipientRawValue;
        const usernames = Array.isArray(record.usernames) ? record.usernames : (Array.isArray(record.users) ? record.users : []);
        usernames.forEach((value) => parts.push(toTrimmedString(value)));
    }
    else {
        const raw = toTrimmedString(recipientRawValue);
        if (!raw || raw.toLowerCase() === 'all' || raw === '*') {
            return [];
        }
        raw.split(',').forEach((value) => parts.push(toTrimmedString(value)));
    }
    const seen = new Set();
    const users = [];
    parts.forEach((part) => {
        const normalized = normalizePhone(part);
        if (!normalized || seen.has(normalized)) {
            return;
        }
        seen.add(normalized);
        users.push(normalized);
    });
    return users;
}
function parseRecipientsFromAuthJson(recipientAuthJsonRawValue) {
    const text = toTrimmedString(recipientAuthJsonRawValue);
    if (!text)
        return [];
    try {
        const parsed = JSON.parse(text);
        const addCandidate = (rawCandidate, target) => {
            const normalized = normalizePhone(rawCandidate);
            if (normalized) {
                target.add(normalized);
            }
        };
        const recipients = new Set();
        if (Array.isArray(parsed)) {
            parsed.forEach((item) => {
                if (item && typeof item === 'object') {
                    const record = item;
                    addCandidate(record.username ?? record.user, recipients);
                }
                else {
                    addCandidate(item, recipients);
                }
            });
            return Array.from(recipients);
        }
        if (parsed && typeof parsed === 'object') {
            const record = parsed;
            addCandidate(record.username ?? record.user, recipients);
            return Array.from(recipients);
        }
        addCandidate(parsed, recipients);
        return Array.from(recipients);
    }
    catch {
        return [];
    }
}
function parseFlexibleTimestamp(value) {
    if (value instanceof Date) {
        const timestamp = value.getTime();
        return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : 0;
    }
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric > 0) {
        return numeric;
    }
    const text = toTrimmedString(value);
    if (!text)
        return 0;
    const parsed = Date.parse(text);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}
function normalizeDateTimeForStorage(value) {
    const timestamp = parseFlexibleTimestamp(value);
    if (!timestamp || !Number.isFinite(timestamp)) {
        return new Date();
    }
    return new Date(Math.floor(timestamp / 1000) * 1000);
}
function normalizeDateTimeKey(value) {
    const timestamp = parseFlexibleTimestamp(value);
    if (!timestamp || !Number.isFinite(timestamp)) {
        return '0';
    }
    return String(Math.floor(timestamp / 1000) * 1000);
}
function parseLogDetailsMap(detailsRawValue) {
    const detailsText = toTrimmedString(detailsRawValue);
    if (!detailsText)
        return {};
    try {
        const parsed = JSON.parse(detailsText);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            return Object.entries(parsed).reduce((acc, [key, value]) => {
                acc[String(key)] = toTrimmedString(value);
                return acc;
            }, {});
        }
    }
    catch {
        // Fallback to key=value parser.
    }
    return detailsText
        .split('|')
        .map((segment) => toTrimmedString(segment))
        .filter(Boolean)
        .reduce((acc, segment) => {
        const separatorIndex = segment.indexOf('=');
        if (separatorIndex <= 0) {
            return acc;
        }
        const key = toTrimmedString(segment.slice(0, separatorIndex));
        const value = toTrimmedString(segment.slice(separatorIndex + 1));
        if (!key) {
            return acc;
        }
        acc[key] = value;
        return acc;
    }, {});
}
function resolveLogMessageId(explicitMsgId, detailsRawValue) {
    const direct = toTrimmedString(explicitMsgId);
    if (direct) {
        return direct;
    }
    const detailsMap = parseLogDetailsMap(detailsRawValue);
    return toTrimmedString(detailsMap.messageId ||
        detailsMap.message_id ||
        detailsMap.targetMessageId ||
        detailsMap.target_message_id);
}
function normalizeTableName(rawValue) {
    const fallback = 'Logs';
    const value = toTrimmedString(rawValue);
    if (!value)
        return fallback;
    if (!/^[A-Za-z0-9_]+$/.test(value)) {
        return fallback;
    }
    return value;
}
class MysqlLogsService {
    pool;
    tableName;
    insertQuery;
    imageUrlColumnReady = false;
    constructor(config) {
        this.tableName = normalizeTableName(config.table);
        this.insertQuery = `INSERT INTO \`${this.tableName}\` (\`DateTime\`, \`ToUser\`, \`From\`, \`MsgID\`, \`Message Preview\`, \`SuccessOrFailed\`, \`ErrorMessageOrSuccessCount\`, \`RecipientAuthJSON\`, \`ImageUrl\`)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;
        this.pool = promise_1.default.createPool({
            host: config.host,
            port: config.port,
            user: config.user,
            password: config.password,
            database: config.database,
            connectionLimit: config.connectionLimit,
            charset: 'utf8mb4'
        });
        void this.ensureImageUrlColumn();
    }
    async ensureImageUrlColumn() {
        if (this.imageUrlColumnReady)
            return;
        try {
            await this.pool.execute(`ALTER TABLE \`${this.tableName}\` ADD COLUMN \`ImageUrl\` TEXT NULL`);
        }
        catch (err) {
            const code = err.code;
            const message = String(err.message || '');
            // ER_DUP_FIELDNAME = column already exists — expected on subsequent restarts.
            if (code !== 'ER_DUP_FIELDNAME' && !message.includes('Duplicate column')) {
                console.warn('[MYSQL] ensureImageUrlColumn warning:', message);
            }
        }
        this.imageUrlColumnReady = true;
    }
    buildCompositeKeyFromPayload(payload) {
        return [
            normalizeDateTimeKey(payload.dateTime),
            toTrimmedString(payload.recipient),
            toTrimmedString(payload.sender) || 'System',
            toTrimmedString(payload.message)
        ].join('|');
    }
    buildCompositeKeyFromRow(row) {
        return [
            normalizeDateTimeKey(row.dateTime),
            toTrimmedString(row.toUser),
            toTrimmedString(row.fromUser) || 'System',
            toTrimmedString(row.messagePreview)
        ].join('|');
    }
    async insertLog(payload) {
        const sender = toTrimmedString(payload.sender) || 'System';
        const recipient = toTrimmedString(payload.recipient);
        const message = toTrimmedString(payload.message);
        const status = toTrimmedString(payload.status);
        const details = toTrimmedString(payload.details);
        const msgId = resolveLogMessageId(payload.msgId, details);
        const recipientAuthJson = toTrimmedString(payload.recipientAuthJson);
        const dateTime = normalizeDateTimeForStorage(payload.dateTime);
        const imageUrl = toTrimmedString(payload.imageUrl);
        await this.pool.execute(this.insertQuery, [dateTime, recipient, sender, msgId, message, status, details, recipientAuthJson, imageUrl || null]);
        return true;
    }
    async filterNewLogsByCompositeKey(payloads) {
        const normalizedPayloads = Array.isArray(payloads) ? payloads.filter(Boolean) : [];
        if (!normalizedPayloads.length) {
            return [];
        }
        const uniqueIncoming = new Map();
        normalizedPayloads.forEach((payload) => {
            const key = this.buildCompositeKeyFromPayload(payload);
            if (!uniqueIncoming.has(key)) {
                uniqueIncoming.set(key, payload);
            }
        });
        const dedupedIncoming = Array.from(uniqueIncoming.values());
        if (!dedupedIncoming.length) {
            return [];
        }
        const existingKeys = new Set();
        const chunkSize = 200;
        for (let start = 0; start < dedupedIncoming.length; start += chunkSize) {
            const chunk = dedupedIncoming.slice(start, start + chunkSize);
            if (!chunk.length)
                continue;
            const orClauses = [];
            const params = [];
            chunk.forEach((payload) => {
                orClauses.push('(`DateTime` = ? AND `ToUser` = ? AND `From` = ? AND `Message Preview` = ?)');
                params.push(normalizeDateTimeForStorage(payload.dateTime), toTrimmedString(payload.recipient), toTrimmedString(payload.sender) || 'System', toTrimmedString(payload.message));
            });
            const [rows] = await this.pool.query(`SELECT \`DateTime\` AS dateTime, \`ToUser\` AS toUser, \`From\` AS fromUser, \`Message Preview\` AS messagePreview
         FROM \`${this.tableName}\`
         WHERE ${orClauses.join(' OR ')}`, params);
            rows.forEach((row) => {
                existingKeys.add(this.buildCompositeKeyFromRow(row));
            });
        }
        return dedupedIncoming.filter((payload) => !existingKeys.has(this.buildCompositeKeyFromPayload(payload)));
    }
    async insertLogsBulk(payloads, options = {}) {
        const normalizedPayloads = Array.isArray(payloads) ? payloads.filter(Boolean) : [];
        if (!normalizedPayloads.length) {
            return 0;
        }
        const rowsToInsert = options.dedupeExisting
            ? await this.filterNewLogsByCompositeKey(normalizedPayloads)
            : normalizedPayloads;
        if (!rowsToInsert.length) {
            return 0;
        }
        const connection = await this.pool.getConnection();
        try {
            await connection.beginTransaction();
            for (const payload of rowsToInsert) {
                const sender = toTrimmedString(payload.sender) || 'System';
                const recipient = toTrimmedString(payload.recipient);
                const message = toTrimmedString(payload.message);
                const status = toTrimmedString(payload.status);
                const details = toTrimmedString(payload.details);
                const msgId = resolveLogMessageId(payload.msgId, details);
                const recipientAuthJson = toTrimmedString(payload.recipientAuthJson);
                const dateTime = normalizeDateTimeForStorage(payload.dateTime);
                const imageUrl = toTrimmedString(payload.imageUrl);
                await connection.execute(this.insertQuery, [
                    dateTime,
                    recipient,
                    sender,
                    msgId,
                    message,
                    status,
                    details,
                    recipientAuthJson,
                    imageUrl || null
                ]);
            }
            await connection.commit();
            return rowsToInsert.length;
        }
        catch (error) {
            await connection.rollback();
            throw error;
        }
        finally {
            connection.release();
        }
    }
    async truncateLogs() {
        await this.pool.query(`TRUNCATE TABLE \`${this.tableName}\``);
    }
    async getLogsMessagesForUser(user, options = {}) {
        const requestedUser = normalizePhone(user);
        if (!requestedUser) {
            return [];
        }
        const limit = Math.max(1, Math.min(toPositiveInteger(options.limit, 700), 200000));
        const offset = Math.max(0, toPositiveInteger(options.offset, 0));
        const excludeSystem = options.excludeSystem !== false;
        // OPTIMIZATION: Parse the 'since' timestamp into a Date object for MySQL
        const sinceTimestamp = Number(options.since) || 0;
        const sinceDate = sinceTimestamp > 0 ? new Date(sinceTimestamp) : null;
        const hardcodedGroupKeySet = new Set(Array.isArray(options.hardcodedGroupIds)
            ? options.hardcodedGroupIds.map((value) => normalizeGroupKey(value)).filter(Boolean)
            : []);
        // Build a map of restricted hardcoded groups to their normalized member lists.
        // Groups without explicit members are considered open to all users.
        const hardcodedGroupMembersMap = new Map();
        if (options.hardcodedGroupMembers && typeof options.hardcodedGroupMembers === 'object') {
            for (const [groupId, members] of Object.entries(options.hardcodedGroupMembers)) {
                const key = normalizeGroupKey(groupId);
                if (!key || !Array.isArray(members) || !members.length)
                    continue;
                hardcodedGroupMembersMap.set(key, new Set(members.map((m) => normalizePhone(m) || toTrimmedString(m).toLowerCase()).filter(Boolean)));
            }
        }
        const requiredMatches = offset + limit;
        const maxRawRowsToScan = Math.max(50000, Math.min(requiredMatches * 220, 5000000));
        let rawOffset = 0;
        let scannedRawRows = 0;
        let matchedCount = 0;
        const messages = [];
        while (messages.length < limit && scannedRawRows < maxRawRowsToScan && matchedCount < requiredMatches) {
            const remainingToCollect = Math.max(1, limit - messages.length);
            const remainingMatchesToScan = Math.max(1, requiredMatches - matchedCount);
            const remainingRawScan = Math.max(1, maxRawRowsToScan - scannedRawRows);
            const currentChunkSize = Math.max(3000, Math.min(25000, Math.min(remainingRawScan, Math.max(remainingToCollect * 12, remainingMatchesToScan * 6))));
            // MODIFIED QUERY: Inject the DateTime > ? filter to skip old messages at the DB level
            let sql = `SELECT 
          \`DateTime\` AS dateTime, 
          \`ToUser\` AS toUser, 
          \`From\` AS fromUser, 
          \`MsgID\` AS msgId, 
          \`Message Preview\` AS messagePreview, 
          \`SuccessOrFailed\` AS successOrFailed, 
          \`ErrorMessageOrSuccessCount\` AS errorMessageOrSuccessCount, 
          \`RecipientAuthJSON\` AS recipientAuthJson,
          \`UserReceivedTime\` AS userReceivedTime,
          \`ImageUrl\` AS imageUrl 
        FROM \`${this.tableName}\` 
        WHERE 1=1`;
            const params = [];
            if (sinceDate) {
                sql += ` AND \`DateTime\` > ?`;
                params.push(sinceDate);
            }
            sql += ` ORDER BY \`DateTime\` DESC LIMIT ?, ?`;
            params.push(rawOffset, currentChunkSize);
            const [rows] = await this.pool.query(sql, params);
            if (!rows.length) {
                break;
            }
            for (let rowIndex = 0; rowIndex < rows.length && messages.length < limit; rowIndex += 1) {
                const row = rows[rowIndex];
                // --- Preservation of your existing Sender/Recipient logic ---
                const senderRaw = toTrimmedString(row.fromUser);
                const sender = normalizePhone(senderRaw) || senderRaw;
                const senderPhone = normalizePhone(sender);
                const isOutgoingFromRequestedUser = Boolean(senderPhone && senderPhone === requestedUser);
                const isHardcodedGlobalGroupSender = hardcodedGroupKeySet.has(normalizeGroupKey(senderRaw));
                const rawToUser = toTrimmedString(row.toUser);
                const recipients = new Set([
                    ...parseRecipientUsernames(rawToUser),
                    ...parseRecipientsFromAuthJson(row.recipientAuthJson)
                ]);
                const toUserNormalizedPhone = normalizePhone(rawToUser);
                const resolvedToUser = toUserNormalizedPhone || rawToUser;
                const toUserLower = rawToUser.toLowerCase();
                const isGroupTargetRow = Boolean(rawToUser &&
                    !toUserNormalizedPhone &&
                    toUserLower !== 'system' &&
                    toUserLower !== 'all' &&
                    rawToUser !== '*');
                // Security/Filtering Check
                if (!recipients.has(requestedUser) && !isOutgoingFromRequestedUser) {
                    if (isHardcodedGlobalGroupSender) {
                        // Check membership for restricted hardcoded groups.
                        const senderGroupKey = normalizeGroupKey(senderRaw);
                        const restrictedMembers = hardcodedGroupMembersMap.get(senderGroupKey);
                        if (restrictedMembers && !restrictedMembers.has(requestedUser)) {
                            continue;
                        }
                    }
                    else if (isGroupTargetRow) {
                        // If the target is a restricted hardcoded group, verify membership.
                        const toGroupKey = normalizeGroupKey(rawToUser);
                        const restrictedMembers = hardcodedGroupMembersMap.get(toGroupKey);
                        if (restrictedMembers && !restrictedMembers.has(requestedUser)) {
                            continue;
                        }
                    }
                    else {
                        continue;
                    }
                }
                if (!sender)
                    continue;
                if (excludeSystem && sender.toLowerCase() === 'system') {
                    continue;
                }
                // Status Filtering
                const status = toTrimmedString(row.successOrFailed).toLowerCase();
                if (status.startsWith('fail') || status.startsWith('error')) {
                    continue;
                }
                // Action and Metadata Parsing
                const details = toTrimmedString(row.errorMessageOrSuccessCount);
                const detailsMap = parseLogDetailsMap(details);
                const actionTypeFromDetails = toTrimmedString(detailsMap.type || detailsMap.actionType || detailsMap.action_type).toLowerCase();
                const isDeletedStatus = status.startsWith('deleted');
                const resolvedActionType = isDeletedStatus ? 'delete-action' : actionTypeFromDetails;
                const body = toTrimmedString(row.messagePreview);
                const imageUrl = toTrimmedString(row.imageUrl);
                if (!resolvedActionType) {
                    if (!body && !imageUrl)
                        continue;
                    if (body.toLowerCase() === 'new notification') {
                        continue;
                    }
                }
                const timestamp = parseFlexibleTimestamp(row.dateTime) || Date.now();
                const msgIdFromRowOrDetails = toTrimmedString(row.msgId ||
                    detailsMap.messageId ||
                    detailsMap.message_id ||
                    detailsMap.targetMessageId);
                const messageId = msgIdFromRowOrDetails || `db-logs-${timestamp}-${rawOffset + rowIndex}`;
                const deletedAt = parseFlexibleTimestamp(detailsMap.deletedAt || detailsMap.deleted_at || timestamp) || timestamp;
                if (resolvedActionType === 'delete-action' && !msgIdFromRowOrDetails) {
                    continue;
                }
                // Pagination Logic
                const nextMatchedCount = matchedCount + 1;
                if (nextMatchedCount <= offset) {
                    matchedCount = nextMatchedCount;
                    continue;
                }
                // Data Mapping
                messages.push({
                    id: `db-logs-${timestamp}-${rawOffset + rowIndex}`,
                    messageId,
                    sender,
                    toUser: resolvedToUser || undefined,
                    body,
                    imageUrl: imageUrl || undefined,
                    timestamp,
                    recipient: requestedUser,
                    status,
                    details,
                    type: resolvedActionType || undefined,
                    deletedAt: resolvedActionType === 'delete-action' ? deletedAt : undefined,
                    groupId: toTrimmedString(detailsMap.groupId || detailsMap.group_id) || undefined,
                    messageIds: toTrimmedString(detailsMap.messageIds || detailsMap.message_ids) || undefined,
                    targetMessageId: toTrimmedString(detailsMap.targetMessageId || detailsMap.target_message_id || detailsMap.messageId || detailsMap.message_id) || undefined,
                    emoji: toTrimmedString(detailsMap.emoji || detailsMap.reaction) || undefined,
                    reactor: toTrimmedString(detailsMap.reactor || detailsMap.user) || undefined,
                    userReceivedTime: parseFlexibleTimestamp(row.userReceivedTime) || undefined
                });
                matchedCount = nextMatchedCount;
            }
            rawOffset += rows.length;
            scannedRawRows += rows.length;
            if (rows.length < currentChunkSize) {
                break;
            }
        }
        messages.reverse();
        return messages;
    }
    async updateUserReceivedTime(msgId, receivedAt) {
        const safeMsgId = toTrimmedString(msgId);
        if (!safeMsgId)
            return false;
        // Only update if not yet acknowledged: NULL means never set, DateTime equality means
        // the column still holds the default send-time and the real receive time is unknown.
        const sql = `UPDATE \`${this.tableName}\` SET \`UserReceivedTime\` = ? WHERE \`MsgID\` = ? AND (\`UserReceivedTime\` IS NULL OR \`UserReceivedTime\` = \`DateTime\`)`;
        const [result] = await this.pool.execute(sql, [receivedAt, safeMsgId]);
        return Boolean(result && result.affectedRows > 0);
    }
    async updateUserReceivedTimeBatch(entries) {
        if (!Array.isArray(entries) || entries.length === 0)
            return 0;
        const validEntries = entries
            .map((e) => ({ msgId: toTrimmedString(e.msgId), receivedAt: e.receivedAt }))
            .filter((e) => e.msgId);
        if (!validEntries.length)
            return 0;
        let totalAffected = 0;
        const chunkSize = 100;
        for (let i = 0; i < validEntries.length; i += chunkSize) {
            const chunk = validEntries.slice(i, i + chunkSize);
            const cases = [];
            const whenParams = [];
            const inParams = [];
            for (const entry of chunk) {
                cases.push('WHEN ? THEN ?');
                whenParams.push(entry.msgId, entry.receivedAt);
                inParams.push(entry.msgId);
            }
            const placeholders = chunk.map(() => '?').join(', ');
            // Same idempotent guard as single update — skip rows already acknowledged.
            const sql = `UPDATE \`${this.tableName}\` SET \`UserReceivedTime\` = CASE \`MsgID\` ${cases.join(' ')} END WHERE \`MsgID\` IN (${placeholders}) AND (\`UserReceivedTime\` IS NULL OR \`UserReceivedTime\` = \`DateTime\`)`;
            const params = [...whenParams, ...inParams];
            const [result] = await this.pool.execute(sql, params);
            totalAffected += result.affectedRows || 0;
        }
        return totalAffected;
    }
}
exports.MysqlLogsService = MysqlLogsService;
function createMysqlLogsServiceFromEnv(env = process.env) {
    const host = toTrimmedString(env.LOGS_DB_HOST || env.MYSQL_HOST || env.DB_HOST || '127.0.0.1');
    const port = toPositiveInteger(env.LOGS_DB_PORT || env.MYSQL_PORT || env.DB_PORT, 3306);
    const user = toTrimmedString(env.LOGS_DB_USER || env.MYSQL_USER || env.DB_USER || 'jmassalh_subscribes');
    const password = toTrimmedString(env.LOGS_DB_PASSWORD || env.MYSQL_PASSWORD || env.DB_PASSWORD || 'jmassalh_subscribes!!@@!!');
    const database = toTrimmedString(env.LOGS_DB_NAME || env.MYSQL_DATABASE || env.DB_NAME || 'jmassalh_subscribes');
    const table = normalizeTableName(env.LOGS_DB_TABLE || env.MYSQL_LOGS_TABLE || 'Logs');
    const connectionLimit = Math.max(1, Math.min(toPositiveInteger(env.LOGS_DB_CONNECTION_LIMIT || env.MYSQL_CONNECTION_LIMIT, 5), 30));
    return new MysqlLogsService({
        host,
        port,
        user,
        password,
        database,
        table,
        connectionLimit
    });
}
