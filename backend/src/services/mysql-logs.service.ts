import mysql, { Pool, RowDataPacket } from 'mysql2/promise';

export interface MysqlLogsConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  table: string;
  connectionLimit: number;
}

export interface MysqlLogInsertPayload {
  sender: string;
  recipient: string;
  message: string;
  status: string;
  details: string;
  msgId?: string;
  recipientAuthJson?: string;
  dateTime?: Date;
  imageUrl?: string;
  fileUrl?: string;
}

export interface MysqlLogsReadOptions {
  limit?: number;
  excludeSystem?: boolean;
  offset?: number;
  hardcodedGroupIds?: string[];
  hardcodedGroupMembers?: Record<string, string[]>;
  /** Dynamic (non-hardcoded) group IDs the user belongs to, e.g. group:grp_xxx */
  dynamicGroupIds?: string[];
  since?: number;
}

export interface MysqlLogsInsertBulkOptions {
  dedupeExisting?: boolean;
}

export interface CommunityGroupDbConfig {
  groupId: string;
  groupName: string;
  members: string[];
  writers: string[];
}

export interface ChatGroupDbRecord {
  groupId: string;
  groupName: string;
  members: string[];
  admins: string[];
  createdBy: string | null;
  type: string;
  createdAt: number;
  updatedAt: number;
}

interface MysqlLogRow extends RowDataPacket {
  dateTime: Date | string | number | null;
  toUser: string | null;
  fromUser: string | null;
  msgId: string | null;
  messagePreview: string | null;
  successOrFailed: string | null;
  errorMessageOrSuccessCount: string | null;
  recipientAuthJson: string | null;
  userReceivedTime: Date | string | number | null;
  imageUrl: string | null;
  fileUrl: string | null;
  seenTime: Date | string | number | null;
}

function toTrimmedString(value: unknown): string {
  return String(value ?? '').trim();
}

function toPositiveInteger(value: unknown, fallbackValue: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallbackValue;
  }
  return Math.floor(parsed);
}

function normalizePhone(value: unknown): string {
  let text = toTrimmedString(value);
  if (!text) return '';
  // Group identifiers (e.g. "group:grp_xxx") must never be treated as phone numbers.
  // They contain hex digits that would be extracted into a meaningless number string.
  if (text.includes(':')) return '';
  // Strip non-digit characters (dashes, spaces, parentheses, etc.) for consistent matching
  text = text.replace(/\D/g, '');
  if (!text) return '';
  if (text.charAt(0) !== '0') {
    text = `0${text}`;
  }
  return text;
}

function normalizeGroupKey(value: unknown): string {
  return toTrimmedString(value).toLowerCase();
}

function parseRecipientUsernames(recipientRawValue: unknown): string[] {
  const parts: string[] = [];
  if (Array.isArray(recipientRawValue)) {
    recipientRawValue.forEach((value) => parts.push(toTrimmedString(value)));
  } else if (recipientRawValue && typeof recipientRawValue === 'object') {
    const record = recipientRawValue as Record<string, unknown>;
    const usernames = Array.isArray(record.usernames) ? record.usernames : (Array.isArray(record.users) ? record.users : []);
    usernames.forEach((value) => parts.push(toTrimmedString(value)));
  } else {
    const raw = toTrimmedString(recipientRawValue);
    if (!raw || raw.toLowerCase() === 'all' || raw === '*') {
      return [];
    }
    raw.split(',').forEach((value) => parts.push(toTrimmedString(value)));
  }

  const seen = new Set<string>();
  const users: string[] = [];
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

function parseRecipientsFromAuthJson(recipientAuthJsonRawValue: unknown): string[] {
  const text = toTrimmedString(recipientAuthJsonRawValue);
  if (!text) return [];
  try {
    const parsed = JSON.parse(text) as unknown;
    const addCandidate = (rawCandidate: unknown, target: Set<string>) => {
      const normalized = normalizePhone(rawCandidate);
      if (normalized) {
        target.add(normalized);
      }
    };
    const recipients = new Set<string>();
    if (Array.isArray(parsed)) {
      parsed.forEach((item) => {
        if (item && typeof item === 'object') {
          const record = item as Record<string, unknown>;
          addCandidate(record.username ?? record.user, recipients);
        } else {
          addCandidate(item, recipients);
        }
      });
      return Array.from(recipients);
    }
    if (parsed && typeof parsed === 'object') {
      const record = parsed as Record<string, unknown>;
      addCandidate(record.username ?? record.user, recipients);
      return Array.from(recipients);
    }
    addCandidate(parsed, recipients);
    return Array.from(recipients);
  } catch {
    return [];
  }
}

function parseFlexibleTimestamp(value: unknown): number {
  if (value instanceof Date) {
    const timestamp = value.getTime();
    return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : 0;
  }
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) {
    return numeric;
  }
  const text = toTrimmedString(value);
  if (!text) return 0;
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function normalizeDateTimeForStorage(value: unknown): Date {
  const timestamp = parseFlexibleTimestamp(value);
  if (!timestamp || !Number.isFinite(timestamp)) {
    return new Date();
  }
  return new Date(Math.floor(timestamp / 1000) * 1000);
}

function normalizeDateTimeKey(value: unknown): string {
  const timestamp = parseFlexibleTimestamp(value);
  if (!timestamp || !Number.isFinite(timestamp)) {
    return '0';
  }
  return String(Math.floor(timestamp / 1000) * 1000);
}

function parseLogDetailsMap(detailsRawValue: unknown): Record<string, string> {
  const detailsText = toTrimmedString(detailsRawValue);
  if (!detailsText) return {};
  try {
    const parsed = JSON.parse(detailsText) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return Object.entries(parsed as Record<string, unknown>).reduce<Record<string, string>>((acc, [key, value]) => {
        acc[String(key)] = toTrimmedString(value);
        return acc;
      }, {});
    }
  } catch {
    // Fallback to key=value parser.
  }

  return detailsText
    .split('|')
    .map((segment) => toTrimmedString(segment))
    .filter(Boolean)
    .reduce<Record<string, string>>((acc, segment) => {
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

function resolveLogMessageId(explicitMsgId: unknown, detailsRawValue: unknown): string {
  const direct = toTrimmedString(explicitMsgId);
  if (direct) {
    return direct;
  }
  const detailsMap = parseLogDetailsMap(detailsRawValue);
  return toTrimmedString(
    detailsMap.messageId ||
    detailsMap.message_id ||
    detailsMap.targetMessageId ||
    detailsMap.target_message_id
  );
}

function normalizeTableName(rawValue: unknown): string {
  const fallback = 'Logs';
  const value = toTrimmedString(rawValue);
  if (!value) return fallback;
  if (!/^[A-Za-z0-9_]+$/.test(value)) {
    return fallback;
  }
  return value;
}

export class MysqlLogsService {
  private readonly pool: Pool;
  private readonly tableName: string;
  private readonly insertQuery: string;
  private imageUrlColumnReady = false;
  private fileUrlColumnReady = false;
  private seenTimeColumnReady = false;
  private msgIdIndexReady = false;
  private communityGroupsTablesReady = false;
  private chatGroupsTablesReady = false;

  constructor(config: MysqlLogsConfig) {
    this.tableName = normalizeTableName(config.table);
    // 10 columns / 10 parameters — keep in sync with insertLog() and insertLogsBulk()
    this.insertQuery = `INSERT INTO \`${this.tableName}\` (\`DateTime\`, \`ToUser\`, \`From\`, \`MsgID\`, \`Message Preview\`, \`SuccessOrFailed\`, \`ErrorMessageOrSuccessCount\`, \`RecipientAuthJSON\`, \`ImageUrl\`, \`FileUrl\`)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
    this.pool = mysql.createPool({
      host: config.host,
      port: config.port,
      user: config.user,
      password: config.password,
      database: config.database,
      connectionLimit: config.connectionLimit,
      charset: 'utf8mb4'
    });
    void this.ensureImageUrlColumn();
    void this.ensureFileUrlColumn();
    void this.ensureSeenTimeColumn();
  }

  private async ensureImageUrlColumn(): Promise<void> {
    if (this.imageUrlColumnReady) return;
    try {
      await this.pool.execute(
        `ALTER TABLE \`${this.tableName}\` ADD COLUMN \`ImageUrl\` TEXT NULL`
      );
    } catch (err: unknown) {
      const code = (err as { code?: string }).code;
      const message = String((err as { message?: string }).message || '');
      // ER_DUP_FIELDNAME = column already exists — expected on subsequent restarts.
      if (code !== 'ER_DUP_FIELDNAME' && !message.includes('Duplicate column')) {
        console.warn('[MYSQL] ensureImageUrlColumn warning:', message);
      }
    }
    this.imageUrlColumnReady = true;
  }

  private async ensureFileUrlColumn(): Promise<void> {
    if (this.fileUrlColumnReady) return;
    try {
      await this.pool.execute(
        `ALTER TABLE \`${this.tableName}\` ADD COLUMN \`FileUrl\` TEXT NULL`
      );
    } catch (err: unknown) {
      const code = (err as { code?: string }).code;
      const message = String((err as { message?: string }).message || '');
      if (code !== 'ER_DUP_FIELDNAME' && !message.includes('Duplicate column')) {
        console.warn('[MYSQL] ensureFileUrlColumn warning:', message);
      }
    }
    this.fileUrlColumnReady = true;
  }

  private async ensureSeenTimeColumn(): Promise<void> {
    if (this.seenTimeColumnReady) return;
    try {
      await this.pool.execute(
        `ALTER TABLE \`${this.tableName}\` ADD COLUMN \`SeenTime\` DATETIME NULL DEFAULT NULL`
      );
    } catch (err: unknown) {
      const code = (err as { code?: string }).code;
      const message = String((err as { message?: string }).message || '');
      if (code !== 'ER_DUP_FIELDNAME' && !message.includes('Duplicate column')) {
        console.warn('[MYSQL] ensureSeenTimeColumn warning:', message);
      }
    }
    this.seenTimeColumnReady = true;
  }

  private async ensureMsgIdIndex(): Promise<void> {
    if (this.msgIdIndexReady) return;
    try {
      await this.pool.execute(
        `CREATE INDEX \`idx_msgid_touser\` ON \`${this.tableName}\` (\`MsgID\`(100), \`ToUser\`(50))`
      );
    } catch (err: unknown) {
      const code = (err as { code?: string }).code;
      const message = String((err as { message?: string }).message || '');
      // ER_DUP_KEYNAME = index already exists — expected on subsequent restarts.
      if (code !== 'ER_DUP_KEYNAME' && !message.includes('Duplicate key name')) {
        console.warn('[MYSQL] ensureMsgIdIndex warning:', message);
      }
    }
    this.msgIdIndexReady = true;
  }

  private buildCompositeKeyFromPayload(payload: MysqlLogInsertPayload): string {
    return [
      normalizeDateTimeKey(payload.dateTime),
      toTrimmedString(payload.recipient),
      toTrimmedString(payload.sender) || 'System',
      toTrimmedString(payload.message)
    ].join('|');
  }

  private buildCompositeKeyFromRow(row: {
    dateTime: unknown;
    toUser: unknown;
    fromUser: unknown;
    messagePreview: unknown;
  }): string {
    return [
      normalizeDateTimeKey(row.dateTime),
      toTrimmedString(row.toUser),
      toTrimmedString(row.fromUser) || 'System',
      toTrimmedString(row.messagePreview)
    ].join('|');
  }

  async insertLog(payload: MysqlLogInsertPayload): Promise<boolean> {
    const sender = toTrimmedString(payload.sender) || 'System';
    const recipient = toTrimmedString(payload.recipient);
    const message = toTrimmedString(payload.message);
    const status = toTrimmedString(payload.status);
    const details = toTrimmedString(payload.details);
    const msgId = resolveLogMessageId(payload.msgId, details);
    const recipientAuthJson = toTrimmedString(payload.recipientAuthJson);
    const dateTime = normalizeDateTimeForStorage(payload.dateTime);
    const imageUrl = toTrimmedString(payload.imageUrl);
    const fileUrl = toTrimmedString(payload.fileUrl);

    await this.pool.execute(this.insertQuery, [dateTime, recipient, sender, msgId, message, status, details, recipientAuthJson, imageUrl || null, fileUrl || null]);
    return true;
  }

  /**
   * Insert a log entry only if no row with the same MsgID already exists.
   * Used for queue-originated messages to prevent duplicate DB rows.
   * Returns true if a new row was inserted, false if it was a duplicate.
   */
  async insertLogIfNotDuplicate(payload: MysqlLogInsertPayload): Promise<boolean> {
    await this.ensureMsgIdIndex();
    const sender = toTrimmedString(payload.sender) || 'System';
    const recipient = toTrimmedString(payload.recipient);
    const message = toTrimmedString(payload.message);
    const status = toTrimmedString(payload.status);
    const details = toTrimmedString(payload.details);
    const msgId = resolveLogMessageId(payload.msgId, details);
    const recipientAuthJson = toTrimmedString(payload.recipientAuthJson);
    const dateTime = normalizeDateTimeForStorage(payload.dateTime);
    const imageUrl = toTrimmedString(payload.imageUrl);
    const fileUrl = toTrimmedString(payload.fileUrl);

    if (!msgId) {
      // No MsgID → fall back to normal insert (cannot deduplicate without an ID)
      await this.pool.execute(this.insertQuery, [dateTime, recipient, sender, msgId, message, status, details, recipientAuthJson, imageUrl || null, fileUrl || null]);
      return true;
    }

    const sql = `INSERT INTO \`${this.tableName}\` (\`DateTime\`, \`ToUser\`, \`From\`, \`MsgID\`, \`Message Preview\`, \`SuccessOrFailed\`, \`ErrorMessageOrSuccessCount\`, \`RecipientAuthJSON\`, \`ImageUrl\`, \`FileUrl\`)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
       FROM DUAL
       WHERE NOT EXISTS (
         SELECT 1 FROM \`${this.tableName}\` WHERE \`MsgID\` = ? AND \`ToUser\` = ? LIMIT 1
       )`;
    const [result] = await this.pool.execute(sql, [
      dateTime, recipient, sender, msgId, message, status, details, recipientAuthJson, imageUrl || null, fileUrl || null,
      msgId, recipient
    ]);
    const affectedRows = (result as { affectedRows?: number }).affectedRows ?? 0;
    return affectedRows > 0;
  }

  /**
   * Check if a log entry with the given MsgID and recipient already exists.
   */
  async hasLogWithMsgId(msgId: string, recipient: string): Promise<boolean> {
    await this.ensureMsgIdIndex();
    const normalizedMsgId = toTrimmedString(msgId);
    const normalizedRecipient = toTrimmedString(recipient);
    if (!normalizedMsgId) return false;
    const sql = `SELECT 1 FROM \`${this.tableName}\` WHERE \`MsgID\` = ? AND \`ToUser\` = ? LIMIT 1`;
    const [rows] = await this.pool.query(sql, [normalizedMsgId, normalizedRecipient]);
    return Array.isArray(rows) && rows.length > 0;
  }

  async filterNewLogsByCompositeKey(payloads: MysqlLogInsertPayload[]): Promise<MysqlLogInsertPayload[]> {
    const normalizedPayloads = Array.isArray(payloads) ? payloads.filter(Boolean) : [];
    if (!normalizedPayloads.length) {
      return [];
    }

    const uniqueIncoming = new Map<string, MysqlLogInsertPayload>();
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

    const existingKeys = new Set<string>();
    const chunkSize = 200;
    for (let start = 0; start < dedupedIncoming.length; start += chunkSize) {
      const chunk = dedupedIncoming.slice(start, start + chunkSize);
      if (!chunk.length) continue;
      const orClauses: string[] = [];
      const params: Array<string | Date> = [];
      chunk.forEach((payload) => {
        orClauses.push('(`DateTime` = ? AND `ToUser` = ? AND `From` = ? AND `Message Preview` = ?)');
        params.push(
          normalizeDateTimeForStorage(payload.dateTime),
          toTrimmedString(payload.recipient),
          toTrimmedString(payload.sender) || 'System',
          toTrimmedString(payload.message)
        );
      });
      const [rows] = await this.pool.query<Array<RowDataPacket & {
        dateTime: Date | string | number | null;
        toUser: string | null;
        fromUser: string | null;
        messagePreview: string | null;
      }>>(
        `SELECT \`DateTime\` AS dateTime, \`ToUser\` AS toUser, \`From\` AS fromUser, \`Message Preview\` AS messagePreview
         FROM \`${this.tableName}\`
         WHERE ${orClauses.join(' OR ')}`,
        params
      );
      rows.forEach((row) => {
        existingKeys.add(this.buildCompositeKeyFromRow(row));
      });
    }

    return dedupedIncoming.filter((payload) => !existingKeys.has(this.buildCompositeKeyFromPayload(payload)));
  }

  async insertLogsBulk(payloads: MysqlLogInsertPayload[], options: MysqlLogsInsertBulkOptions = {}): Promise<number> {
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
        const fileUrl = toTrimmedString(payload.fileUrl);
        await connection.execute(this.insertQuery, [
          dateTime,
          recipient,
          sender,
          msgId,
          message,
          status,
          details,
          recipientAuthJson,
          imageUrl || null,
          fileUrl || null
        ]);
      }
      await connection.commit();
      return rowsToInsert.length;
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async truncateLogs(): Promise<void> {
    await this.pool.query(`TRUNCATE TABLE \`${this.tableName}\``);
  }

  async getLogsMessagesForUser(user: string, options: MysqlLogsReadOptions = {}): Promise<Record<string, unknown>[]> {
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

    const hardcodedGroupKeySet = new Set(
      Array.isArray(options.hardcodedGroupIds)
        ? options.hardcodedGroupIds.map((value) => normalizeGroupKey(value)).filter(Boolean)
        : []
    );

    // Build a map of restricted hardcoded groups to their normalized member lists.
    // Groups without explicit members are considered open to all users.
    const hardcodedGroupMembersMap = new Map<string, Set<string>>();
    if (options.hardcodedGroupMembers && typeof options.hardcodedGroupMembers === 'object') {
      for (const [groupId, members] of Object.entries(options.hardcodedGroupMembers)) {
        const key = normalizeGroupKey(groupId);
        if (!key || !Array.isArray(members) || !members.length) continue;
        hardcodedGroupMembersMap.set(
          key,
          new Set(members.map((m) => normalizePhone(m) || toTrimmedString(m).toLowerCase()).filter(Boolean))
        );
      }
    }

    // Dynamic (non-hardcoded) groups the requesting user belongs to.
    // Messages whose sender or toUser matches a dynamic group ID are allowed through.
    const dynamicGroupKeySet = new Set(
      Array.isArray(options.dynamicGroupIds)
        ? options.dynamicGroupIds.map((value) => normalizeGroupKey(value)).filter(Boolean)
        : []
    );

    const requiredMatches = offset + limit;
    const maxRawRowsToScan = Math.max(50000, Math.min(requiredMatches * 220, 5000000));
    let rawOffset = 0;
    let scannedRawRows = 0;
    let matchedCount = 0;
    const messages: Record<string, unknown>[] = [];

    while (messages.length < limit && scannedRawRows < maxRawRowsToScan && matchedCount < requiredMatches) {
      const remainingToCollect = Math.max(1, limit - messages.length);
      const remainingMatchesToScan = Math.max(1, requiredMatches - matchedCount);
      const remainingRawScan = Math.max(1, maxRawRowsToScan - scannedRawRows);
      const currentChunkSize = Math.max(
        3000,
        Math.min(25000, Math.min(remainingRawScan, Math.max(remainingToCollect * 12, remainingMatchesToScan * 6)))
      );

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
          \`ImageUrl\` AS imageUrl,
          \`FileUrl\` AS fileUrl,
          \`SeenTime\` AS seenTime 
        FROM \`${this.tableName}\` 
        WHERE 1=1`;

      const params: any[] = [];
      if (sinceDate) {
        sql += ` AND \`DateTime\` > ?`;
        params.push(sinceDate);
      }

      sql += ` ORDER BY \`DateTime\` DESC LIMIT ?, ?`;
      params.push(rawOffset, currentChunkSize);

      const [rows] = await this.pool.query<MysqlLogRow[]>(sql, params);

      if (!rows.length) {
        break;
      }

      for (let rowIndex = 0; rowIndex < rows.length && messages.length < limit; rowIndex += 1) {
        const row = rows[rowIndex];

        // --- Preservation of your existing Sender/Recipient logic ---
        const senderRaw = toTrimmedString(row.fromUser);
        const senderLower = senderRaw.toLowerCase();
        const sender = normalizePhone(senderRaw) || senderRaw;
        const senderPhone = normalizePhone(sender);
        const isOutgoingFromRequestedUser = Boolean(senderPhone && senderPhone === requestedUser);
        const isHardcodedGlobalGroupSender = hardcodedGroupKeySet.has(normalizeGroupKey(senderRaw));
        // Dynamic group: sender or toUser is a "group:xxx" identifier
        const isDynamicGroupSender = senderLower.startsWith('group:');

        const rawToUser = toTrimmedString(row.toUser);
        const recipients = new Set<string>([
          ...parseRecipientUsernames(rawToUser),
          ...parseRecipientsFromAuthJson(row.recipientAuthJson)
        ]);

        const toUserNormalizedPhone = normalizePhone(rawToUser);
        const resolvedToUser = toUserNormalizedPhone || rawToUser;
        const toUserLower = rawToUser.toLowerCase();
        const isDynamicGroupToUser = toUserLower.startsWith('group:');

        const isGroupTargetRow = Boolean(
          rawToUser &&
          !toUserNormalizedPhone &&
          toUserLower !== 'system' &&
          toUserLower !== 'all' &&
          rawToUser !== '*'
        );

        // Security/Filtering Check
        if (!recipients.has(requestedUser) && !isOutgoingFromRequestedUser) {
          if (isHardcodedGlobalGroupSender) {
            // Sender is a hardcoded group (e.g. 'דוברות').
            // Groups with an explicit members list are restricted; others are open to all.
            const senderGroupKey = normalizeGroupKey(senderRaw);
            const restrictedMembers = hardcodedGroupMembersMap.get(senderGroupKey);
            if (restrictedMembers && !restrictedMembers.has(requestedUser)) {
              continue;
            }
          } else if (isDynamicGroupSender && dynamicGroupKeySet.has(senderLower)) {
            // Sender is a dynamic group (e.g. "group:grp_xxx") the user belongs to — allow.
          } else if (isDynamicGroupToUser && dynamicGroupKeySet.has(toUserLower)) {
            // ToUser is a dynamic group the user belongs to — allow.
          } else if (isGroupTargetRow) {
            // ToUser is a group name (non-phone).
            const toGroupKey = normalizeGroupKey(rawToUser);
            const restrictedMembers = hardcodedGroupMembersMap.get(toGroupKey);
            if (restrictedMembers) {
              // Hardcoded group with explicit members – check membership.
              if (!restrictedMembers.has(requestedUser)) {
                continue;
              }
            } else if (hardcodedGroupKeySet.has(toGroupKey)) {
              // Hardcoded group without explicit members (e.g. 'דוברות') – open to all.
            } else {
              // Non-hardcoded group – user is not a listed recipient, skip.
              continue;
            }
          } else {
            continue;
          }
        }

        if (!sender) continue;
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
        const actionTypeFromDetails = toTrimmedString(
          detailsMap.type || detailsMap.actionType || detailsMap.action_type
        ).toLowerCase();
        const isDeletedStatus = status.startsWith('deleted');
        const resolvedActionType = isDeletedStatus ? 'delete-action' : actionTypeFromDetails;

        const body = toTrimmedString(row.messagePreview);
        const imageUrl = toTrimmedString(row.imageUrl);
        const fileUrl = toTrimmedString(row.fileUrl);
        if (!resolvedActionType) {
          if (!body && !imageUrl && !fileUrl) continue;
          if (body.toLowerCase() === 'new notification') {
            continue;
          }
        }

        const timestamp = parseFlexibleTimestamp(row.dateTime) || Date.now();
        const msgIdFromRowOrDetails = toTrimmedString(
          row.msgId ||
          detailsMap.messageId ||
          detailsMap.message_id ||
          detailsMap.targetMessageId
        );

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
          fileUrl: fileUrl || undefined,
          timestamp,
          recipient: requestedUser,
          status,
          details,
          type: resolvedActionType || undefined,
          deletedAt: resolvedActionType === 'delete-action' ? deletedAt : undefined,
          groupId: toTrimmedString(detailsMap.groupId || detailsMap.group_id)
            || (isDynamicGroupSender ? senderRaw : undefined)
            || (isDynamicGroupToUser ? rawToUser : undefined),
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

  async updateUserReceivedTime(msgId: string, receivedAt: Date): Promise<boolean> {
    const safeMsgId = toTrimmedString(msgId);
    if (!safeMsgId) return false;
    // Only update if not yet acknowledged: NULL means never set, DateTime equality means
    // the column still holds the default send-time and the real receive time is unknown.
    const sql = `UPDATE \`${this.tableName}\` SET \`UserReceivedTime\` = ? WHERE \`MsgID\` = ? AND (\`UserReceivedTime\` IS NULL OR \`UserReceivedTime\` = \`DateTime\`)`;
    const [result] = await this.pool.execute(sql, [receivedAt, safeMsgId]);
    return Boolean(result && (result as any).affectedRows > 0);
  }

  async updateUserReceivedTimeBatch(entries: Array<{ msgId: string; receivedAt: Date }>): Promise<number> {
    if (!Array.isArray(entries) || entries.length === 0) return 0;
    const validEntries = entries
      .map((e) => ({ msgId: toTrimmedString(e.msgId), receivedAt: e.receivedAt }))
      .filter((e) => e.msgId);
    if (!validEntries.length) return 0;

    let totalAffected = 0;
    const chunkSize = 100;
    for (let i = 0; i < validEntries.length; i += chunkSize) {
      const chunk = validEntries.slice(i, i + chunkSize);
      const cases: string[] = [];
      const whenParams: Array<string | Date> = [];
      const inParams: string[] = [];
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
      totalAffected += (result as any).affectedRows || 0;
    }
    return totalAffected;
  }

  /**
   * Mark messages as seen for a specific user.
   * Sets SeenTime = NOW() for messages directed to the user in the given chat
   * that have not yet been seen (SeenTime IS NULL).
   */
  async markMessagesSeen(user: string, chatId: string): Promise<number> {
    await this.ensureSeenTimeColumn();
    const safeUser = toTrimmedString(user).toLowerCase();
    const safeChatId = toTrimmedString(chatId);
    if (!safeUser || !safeChatId) return 0;
    try {
      // For group/community messages the ToUser column holds the groupId,
      // and `From` is the sender. For direct messages ToUser is the recipient.
      // A message is "for this user in this chat" when:
      //   (ToUser = chatId AND From != user)  — group msgs received
      //   (ToUser = user AND From = chatId)   — DMs received from chatId
      const sql = `UPDATE \`${this.tableName}\`
        SET \`SeenTime\` = NOW()
        WHERE \`SeenTime\` IS NULL
          AND (
            (LOWER(\`ToUser\`) = ? AND LOWER(\`From\`) != ?)
            OR
            (LOWER(\`ToUser\`) = ? AND LOWER(\`From\`) = ?)
          )`;
      const [result] = await this.pool.execute(sql, [
        safeChatId, safeUser,
        safeUser, safeChatId
      ]);
      return (result as any).affectedRows || 0;
    } catch (err: unknown) {
      const message = String((err as { message?: string }).message || '');
      console.warn('[MYSQL] markMessagesSeen error:', message);
      return 0;
    }
  }

  /**
   * Backfill SeenTime for all existing rows that have SeenTime IS NULL.
   * Sets SeenTime = DateTime (the send time) so they count as "already seen".
   * This should be called once during migration.
   */
  async backfillSeenTimeWithSendTime(): Promise<number> {
    await this.ensureSeenTimeColumn();
    try {
      const [result] = await this.pool.execute(
        `UPDATE \`${this.tableName}\` SET \`SeenTime\` = \`DateTime\` WHERE \`SeenTime\` IS NULL`
      );
      const affected = (result as any).affectedRows || 0;
      if (affected > 0) {
        console.log(`[MYSQL] Backfilled SeenTime for ${affected} existing log row(s).`);
      }
      return affected;
    } catch (err: unknown) {
      const message = String((err as { message?: string }).message || '');
      console.warn('[MYSQL] backfillSeenTimeWithSendTime error:', message);
      return 0;
    }
  }

  /**
   * Get unseen message counts per chat for a given user.
   * Returns a map of chatId → count of messages where SeenTime IS NULL.
   */
  async getUnseenCountsByUser(user: string): Promise<Record<string, number>> {
    await this.ensureSeenTimeColumn();
    const safeUser = toTrimmedString(user).toLowerCase();
    if (!safeUser) return {};
    try {
      // Group messages: ToUser = groupId, From != user
      // DM messages: ToUser = user, From = sender
      const sql = `SELECT
          CASE
            WHEN LOWER(\`ToUser\`) = ? THEN LOWER(\`From\`)
            ELSE LOWER(\`ToUser\`)
          END AS chatId,
          COUNT(*) AS cnt
        FROM \`${this.tableName}\`
        WHERE \`SeenTime\` IS NULL
          AND (
            LOWER(\`ToUser\`) = ?
            OR (LOWER(\`ToUser\`) != ? AND LOWER(\`From\`) != ?)
          )
        GROUP BY chatId`;
      const [rows] = await this.pool.query<RowDataPacket[]>(sql, [
        safeUser, safeUser, safeUser, safeUser
      ]);
      const result: Record<string, number> = {};
      for (const row of rows) {
        const chatId = toTrimmedString(row.chatId);
        const cnt = Number(row.cnt) || 0;
        if (chatId && cnt > 0) {
          result[chatId] = cnt;
        }
      }
      return result;
    } catch (err: unknown) {
      const message = String((err as { message?: string }).message || '');
      console.warn('[MYSQL] getUnseenCountsByUser error:', message);
      return {};
    }
  }

  async ensureCommunityGroupsTables(): Promise<void> {
    if (this.communityGroupsTablesReady) return;
    try {
      await this.pool.execute(`
        CREATE TABLE IF NOT EXISTS \`CommunityGroups\` (
          \`GroupId\` VARCHAR(255) NOT NULL,
          \`GroupName\` VARCHAR(255) NOT NULL,
          \`CreatedAt\` DATETIME DEFAULT CURRENT_TIMESTAMP,
          \`UpdatedAt\` DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          PRIMARY KEY (\`GroupId\`)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
      `);
      await this.pool.execute(`
        CREATE TABLE IF NOT EXISTS \`CommunityGroupMembers\` (
          \`GroupId\` VARCHAR(255) NOT NULL,
          \`Phone\` VARCHAR(50) NOT NULL,
          PRIMARY KEY (\`GroupId\`, \`Phone\`),
          FOREIGN KEY (\`GroupId\`) REFERENCES \`CommunityGroups\`(\`GroupId\`) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
      `);
      await this.pool.execute(`
        CREATE TABLE IF NOT EXISTS \`CommunityGroupWriters\` (
          \`GroupId\` VARCHAR(255) NOT NULL,
          \`Phone\` VARCHAR(50) NOT NULL,
          PRIMARY KEY (\`GroupId\`, \`Phone\`),
          FOREIGN KEY (\`GroupId\`) REFERENCES \`CommunityGroups\`(\`GroupId\`) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
      `);
      this.communityGroupsTablesReady = true;
      console.log('[MYSQL] Community groups tables ensured.');
    } catch (err: unknown) {
      const message = String((err as { message?: string }).message || '');
      console.warn('[MYSQL] ensureCommunityGroupsTables warning:', message);
    }
  }

  async loadCommunityGroups(): Promise<CommunityGroupDbConfig[]> {
    await this.ensureCommunityGroupsTables();
    try {
      const [groupRows] = await this.pool.execute<RowDataPacket[]>(
        'SELECT `GroupId`, `GroupName` FROM `CommunityGroups` ORDER BY `GroupId`'
      );
      if (!groupRows.length) return [];

      const [memberRows] = await this.pool.execute<RowDataPacket[]>(
        'SELECT `GroupId`, `Phone` FROM `CommunityGroupMembers` ORDER BY `GroupId`, `Phone`'
      );
      const [writerRows] = await this.pool.execute<RowDataPacket[]>(
        'SELECT `GroupId`, `Phone` FROM `CommunityGroupWriters` ORDER BY `GroupId`, `Phone`'
      );

      const membersMap = new Map<string, string[]>();
      for (const row of memberRows) {
        const gid = toTrimmedString(row.GroupId);
        const phone = toTrimmedString(row.Phone);
        if (!gid || !phone) continue;
        if (!membersMap.has(gid)) membersMap.set(gid, []);
        membersMap.get(gid)!.push(phone);
      }

      const writersMap = new Map<string, string[]>();
      for (const row of writerRows) {
        const gid = toTrimmedString(row.GroupId);
        const phone = toTrimmedString(row.Phone);
        if (!gid || !phone) continue;
        if (!writersMap.has(gid)) writersMap.set(gid, []);
        writersMap.get(gid)!.push(phone);
      }

      return groupRows.map((row) => {
        const groupId = toTrimmedString(row.GroupId);
        return {
          groupId,
          groupName: toTrimmedString(row.GroupName),
          members: membersMap.get(groupId) ?? [],
          writers: writersMap.get(groupId) ?? []
        };
      }).filter((g) => g.groupId && g.groupName);
    } catch (err: unknown) {
      const message = String((err as { message?: string }).message || '');
      console.error('[MYSQL] loadCommunityGroups error:', message);
      return [];
    }
  }

  async seedCommunityGroupIfEmpty(config: CommunityGroupDbConfig): Promise<boolean> {
    await this.ensureCommunityGroupsTables();
    try {
      const [existing] = await this.pool.execute<RowDataPacket[]>(
        'SELECT `GroupId` FROM `CommunityGroups` WHERE `GroupId` = ?',
        [config.groupId]
      );
      if (existing.length > 0) return false;

      await this.pool.execute(
        'INSERT INTO `CommunityGroups` (`GroupId`, `GroupName`) VALUES (?, ?)',
        [config.groupId, config.groupName]
      );
      for (const phone of config.members) {
        await this.pool.execute(
          'INSERT IGNORE INTO `CommunityGroupMembers` (`GroupId`, `Phone`) VALUES (?, ?)',
          [config.groupId, phone]
        );
      }
      for (const phone of config.writers) {
        await this.pool.execute(
          'INSERT IGNORE INTO `CommunityGroupWriters` (`GroupId`, `Phone`) VALUES (?, ?)',
          [config.groupId, phone]
        );
      }
      console.log(`[MYSQL] Seeded community group: ${config.groupId}`);
      return true;
    } catch (err: unknown) {
      const message = String((err as { message?: string }).message || '');
      console.warn(`[MYSQL] seedCommunityGroupIfEmpty(${config.groupId}) warning:`, message);
      return false;
    }
  }

  // ── Chat Groups (all groups) MySQL persistence ──

  async ensureChatGroupsTables(): Promise<void> {
    if (this.chatGroupsTablesReady) return;
    try {
      await this.pool.execute(`
        CREATE TABLE IF NOT EXISTS \`ChatGroups\` (
          \`GroupId\` VARCHAR(255) NOT NULL,
          \`GroupName\` VARCHAR(255) NOT NULL,
          \`CreatedBy\` VARCHAR(100) DEFAULT NULL,
          \`Type\` VARCHAR(50) DEFAULT 'group',
          \`CreatedAt\` BIGINT DEFAULT NULL,
          \`UpdatedAt\` BIGINT DEFAULT NULL,
          PRIMARY KEY (\`GroupId\`)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
      `);
      await this.pool.execute(`
        CREATE TABLE IF NOT EXISTS \`ChatGroupMembers\` (
          \`GroupId\` VARCHAR(255) NOT NULL,
          \`Phone\` VARCHAR(100) NOT NULL,
          PRIMARY KEY (\`GroupId\`, \`Phone\`),
          FOREIGN KEY (\`GroupId\`) REFERENCES \`ChatGroups\`(\`GroupId\`) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
      `);
      await this.pool.execute(`
        CREATE TABLE IF NOT EXISTS \`ChatGroupAdmins\` (
          \`GroupId\` VARCHAR(255) NOT NULL,
          \`Phone\` VARCHAR(100) NOT NULL,
          PRIMARY KEY (\`GroupId\`, \`Phone\`),
          FOREIGN KEY (\`GroupId\`) REFERENCES \`ChatGroups\`(\`GroupId\`) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
      `);
      this.chatGroupsTablesReady = true;
      console.log('[MYSQL] Chat groups tables ensured.');
    } catch (err: unknown) {
      const message = String((err as { message?: string }).message || '');
      console.warn('[MYSQL] ensureChatGroupsTables warning:', message);
    }
  }

  async loadAllChatGroups(): Promise<ChatGroupDbRecord[]> {
    await this.ensureChatGroupsTables();
    try {
      const [groupRows] = await this.pool.execute<RowDataPacket[]>(
        'SELECT `GroupId`, `GroupName`, `CreatedBy`, `Type`, `CreatedAt`, `UpdatedAt` FROM `ChatGroups` ORDER BY `GroupId`'
      );
      if (!groupRows.length) return [];

      const [memberRows] = await this.pool.execute<RowDataPacket[]>(
        'SELECT `GroupId`, `Phone` FROM `ChatGroupMembers` ORDER BY `GroupId`, `Phone`'
      );
      const [adminRows] = await this.pool.execute<RowDataPacket[]>(
        'SELECT `GroupId`, `Phone` FROM `ChatGroupAdmins` ORDER BY `GroupId`, `Phone`'
      );

      const membersMap = new Map<string, string[]>();
      for (const row of memberRows) {
        const gid = toTrimmedString(row.GroupId);
        const phone = toTrimmedString(row.Phone);
        if (!gid || !phone) continue;
        if (!membersMap.has(gid)) membersMap.set(gid, []);
        membersMap.get(gid)!.push(phone);
      }

      const adminsMap = new Map<string, string[]>();
      for (const row of adminRows) {
        const gid = toTrimmedString(row.GroupId);
        const phone = toTrimmedString(row.Phone);
        if (!gid || !phone) continue;
        if (!adminsMap.has(gid)) adminsMap.set(gid, []);
        adminsMap.get(gid)!.push(phone);
      }

      return groupRows.map((row) => {
        const groupId = toTrimmedString(row.GroupId);
        return {
          groupId,
          groupName: toTrimmedString(row.GroupName),
          members: membersMap.get(groupId) ?? [],
          admins: adminsMap.get(groupId) ?? [],
          createdBy: toTrimmedString(row.CreatedBy) || null,
          type: toTrimmedString(row.Type) || 'group',
          createdAt: Number(row.CreatedAt) || 0,
          updatedAt: Number(row.UpdatedAt) || 0
        };
      }).filter((g) => g.groupId && g.groupName);
    } catch (err: unknown) {
      const message = String((err as { message?: string }).message || '');
      console.error('[MYSQL] loadAllChatGroups error:', message);
      return [];
    }
  }

  async upsertChatGroup(group: ChatGroupDbRecord): Promise<boolean> {
    await this.ensureChatGroupsTables();
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();

      // Preserve existing real group name when the incoming name equals the GroupId.
      // This prevents ID-like values (e.g. "group:grp_xyz") from overwriting real names.
      await conn.execute(
        `INSERT INTO \`ChatGroups\` (\`GroupId\`, \`GroupName\`, \`CreatedBy\`, \`Type\`, \`CreatedAt\`, \`UpdatedAt\`)
         VALUES (?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           \`GroupName\` = IF(VALUES(\`GroupName\`) != \`GroupId\`, VALUES(\`GroupName\`), \`GroupName\`),
           \`CreatedBy\` = COALESCE(VALUES(\`CreatedBy\`), \`CreatedBy\`),
           \`Type\` = VALUES(\`Type\`),
           \`UpdatedAt\` = VALUES(\`UpdatedAt\`)`,
        [
          group.groupId,
          group.groupName,
          group.createdBy || null,
          group.type || 'group',
          group.createdAt || Date.now(),
          group.updatedAt || Date.now()
        ]
      );

      // Replace members
      await conn.execute(
        'DELETE FROM `ChatGroupMembers` WHERE `GroupId` = ?',
        [group.groupId]
      );
      const validMembers = group.members.filter(Boolean);
      if (validMembers.length > 0) {
        const placeholders = validMembers.map(() => '(?, ?)').join(', ');
        const params = validMembers.flatMap((phone) => [group.groupId, phone]);
        await conn.execute(
          `INSERT IGNORE INTO \`ChatGroupMembers\` (\`GroupId\`, \`Phone\`) VALUES ${placeholders}`,
          params
        );
      }

      // Replace admins
      await conn.execute(
        'DELETE FROM `ChatGroupAdmins` WHERE `GroupId` = ?',
        [group.groupId]
      );
      const validAdmins = group.admins.filter(Boolean);
      if (validAdmins.length > 0) {
        const placeholders = validAdmins.map(() => '(?, ?)').join(', ');
        const params = validAdmins.flatMap((phone) => [group.groupId, phone]);
        await conn.execute(
          `INSERT IGNORE INTO \`ChatGroupAdmins\` (\`GroupId\`, \`Phone\`) VALUES ${placeholders}`,
          params
        );
      }

      await conn.commit();
      return true;
    } catch (err: unknown) {
      await conn.rollback().catch(() => undefined);
      const message = String((err as { message?: string }).message || '');
      console.warn(`[MYSQL] upsertChatGroup(${group.groupId}) warning:`, message);
      return false;
    } finally {
      conn.release();
    }
  }

  async seedChatGroupsFromRuntime(groups: ChatGroupDbRecord[]): Promise<number> {
    await this.ensureChatGroupsTables();
    let seeded = 0;
    try {
      const [existingRows] = await this.pool.execute<RowDataPacket[]>(
        'SELECT `GroupId` FROM `ChatGroups`'
      );
      if (existingRows.length > 0) {
        // DB already has groups – skip seeding
        return 0;
      }
      for (const group of groups) {
        if (!group.groupId || !group.groupName) continue;
        const ok = await this.upsertChatGroup(group);
        if (ok) seeded++;
      }
      if (seeded > 0) {
        console.log(`[MYSQL] Seeded ${seeded} chat group(s) from runtime into DB.`);
      }
    } catch (err: unknown) {
      const message = String((err as { message?: string }).message || '');
      console.warn('[MYSQL] seedChatGroupsFromRuntime warning:', message);
    }
    return seeded;
  }

}

export function createMysqlLogsServiceFromEnv(env: NodeJS.ProcessEnv = process.env): MysqlLogsService {
  const host = toTrimmedString(env.LOGS_DB_HOST || env.MYSQL_HOST || env.DB_HOST || '127.0.0.1');
  const port = toPositiveInteger(env.LOGS_DB_PORT || env.MYSQL_PORT || env.DB_PORT, 3306);
  const user = toTrimmedString(env.LOGS_DB_USER || env.MYSQL_USER || env.DB_USER || 'jmassalh_subscribes');
  const password = toTrimmedString(
    env.LOGS_DB_PASSWORD || env.MYSQL_PASSWORD || env.DB_PASSWORD || 'jmassalh_subscribes!!@@!!'
  );
  const database = toTrimmedString(env.LOGS_DB_NAME || env.MYSQL_DATABASE || env.DB_NAME || 'jmassalh_subscribes');
  const table = normalizeTableName(env.LOGS_DB_TABLE || env.MYSQL_LOGS_TABLE || 'Logs');
  const connectionLimit = Math.max(
    1,
    Math.min(
      toPositiveInteger(env.LOGS_DB_CONNECTION_LIMIT || env.MYSQL_CONNECTION_LIMIT, 5),
      30
    )
  );

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
