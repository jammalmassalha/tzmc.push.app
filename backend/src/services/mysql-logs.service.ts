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
  recipientAuthJson?: string;
  dateTime?: Date;
}

export interface MysqlLogsReadOptions {
  limit?: number;
  excludeSystem?: boolean;
}

interface MysqlLogRow extends RowDataPacket {
  dateTime: Date | string | number | null;
  toUser: string | null;
  fromUser: string | null;
  messagePreview: string | null;
  successOrFailed: string | null;
  errorMessageOrSuccessCount: string | null;
  recipientAuthJson: string | null;
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
  if (/^\d+$/.test(text) && text.charAt(0) !== '0') {
    text = `0${text}`;
  }
  return text;
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

  constructor(config: MysqlLogsConfig) {
    this.tableName = normalizeTableName(config.table);
    this.insertQuery = `INSERT INTO \`${this.tableName}\` (\`DateTime\`, \`ToUser\`, \`From\`, \`Message Preview\`, \`SuccessOrFailed\`, \`ErrorMessageOrSuccessCount\`, \`RecipientAuthJSON\`)
       VALUES (?, ?, ?, ?, ?, ?, ?)`;
    this.pool = mysql.createPool({
      host: config.host,
      port: config.port,
      user: config.user,
      password: config.password,
      database: config.database,
      connectionLimit: config.connectionLimit,
      charset: 'utf8mb4'
    });
  }

  async insertLog(payload: MysqlLogInsertPayload): Promise<boolean> {
    const sender = toTrimmedString(payload.sender) || 'System';
    const recipient = toTrimmedString(payload.recipient);
    const message = toTrimmedString(payload.message);
    const status = toTrimmedString(payload.status);
    const details = toTrimmedString(payload.details);
    const recipientAuthJson = toTrimmedString(payload.recipientAuthJson);
    const dateTime = payload.dateTime instanceof Date ? payload.dateTime : new Date();

    await this.pool.execute(this.insertQuery, [dateTime, recipient, sender, message, status, details, recipientAuthJson]);
    return true;
  }

  async insertLogsBulk(payloads: MysqlLogInsertPayload[]): Promise<number> {
    const normalizedPayloads = Array.isArray(payloads) ? payloads.filter(Boolean) : [];
    if (!normalizedPayloads.length) {
      return 0;
    }

    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      for (const payload of normalizedPayloads) {
        const sender = toTrimmedString(payload.sender) || 'System';
        const recipient = toTrimmedString(payload.recipient);
        const message = toTrimmedString(payload.message);
        const status = toTrimmedString(payload.status);
        const details = toTrimmedString(payload.details);
        const recipientAuthJson = toTrimmedString(payload.recipientAuthJson);
        const dateTime = payload.dateTime instanceof Date ? payload.dateTime : new Date();
        await connection.execute(this.insertQuery, [
          dateTime,
          recipient,
          sender,
          message,
          status,
          details,
          recipientAuthJson
        ]);
      }
      await connection.commit();
      return normalizedPayloads.length;
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

    const limit = Math.max(1, Math.min(toPositiveInteger(options.limit, 700), 2000));
    const excludeSystem = options.excludeSystem !== false;
    const queryFetchLimit = Math.max(2000, Math.min(limit * 8, 20000));

    const [rows] = await this.pool.query<MysqlLogRow[]>(
      `SELECT
        \`DateTime\` AS dateTime,
        \`ToUser\` AS toUser,
        \`From\` AS fromUser,
        \`Message Preview\` AS messagePreview,
        \`SuccessOrFailed\` AS successOrFailed,
        \`ErrorMessageOrSuccessCount\` AS errorMessageOrSuccessCount,
        \`RecipientAuthJSON\` AS recipientAuthJson
      FROM \`${this.tableName}\`
      ORDER BY \`DateTime\` DESC
      LIMIT ?`,
      [queryFetchLimit]
    );

    const messages: Record<string, unknown>[] = [];
    for (let rowIndex = 0; rowIndex < rows.length && messages.length < limit; rowIndex += 1) {
      const row = rows[rowIndex];
      const recipients = parseRecipientUsernames(row.toUser);
      if (!recipients.includes(requestedUser)) {
        continue;
      }

      const senderRaw = toTrimmedString(row.fromUser);
      const sender = normalizePhone(senderRaw) || senderRaw;
      if (!sender) continue;
      if (excludeSystem && sender.toLowerCase() === 'system') {
        continue;
      }

      const status = toTrimmedString(row.successOrFailed).toLowerCase();
      if (status.startsWith('fail') || status.startsWith('error')) {
        continue;
      }

      const details = toTrimmedString(row.errorMessageOrSuccessCount);
      const detailsMap = parseLogDetailsMap(details);
      const actionTypeFromDetails = toTrimmedString(
        detailsMap.type || detailsMap.actionType || detailsMap.action_type
      ).toLowerCase();
      const isDeletedStatus = status.startsWith('deleted');
      const resolvedActionType = isDeletedStatus ? 'delete-action' : actionTypeFromDetails;

      const body = toTrimmedString(row.messagePreview);
      if (!resolvedActionType) {
        if (!body) continue;
        if (body.toLowerCase() === 'new notification') {
          continue;
        }
      }

      const timestamp = parseFlexibleTimestamp(row.dateTime) || Date.now();
      const messageId = toTrimmedString(
        detailsMap.messageId || detailsMap.message_id || detailsMap.targetMessageId
      ) || `db-logs-${timestamp}-${rowIndex}`;
      const deletedAt = parseFlexibleTimestamp(detailsMap.deletedAt || detailsMap.deleted_at || timestamp) || timestamp;

      messages.push({
        id: `db-logs-${timestamp}-${rowIndex}`,
        messageId,
        sender,
        body,
        timestamp,
        recipient: requestedUser,
        status,
        details,
        type: resolvedActionType || undefined,
        deletedAt: resolvedActionType === 'delete-action' ? deletedAt : undefined,
        groupId: toTrimmedString(detailsMap.groupId || detailsMap.group_id) || undefined,
        messageIds: toTrimmedString(detailsMap.messageIds || detailsMap.message_ids) || undefined
      });
    }

    messages.reverse();
    return messages;
  }
}

export function createMysqlLogsServiceFromEnv(env: NodeJS.ProcessEnv = process.env): MysqlLogsService {
  const host = toTrimmedString(env.LOGS_DB_HOST || env.MYSQL_HOST || env.DB_HOST || '127.0.0.1');
  const port = toPositiveInteger(env.LOGS_DB_PORT || env.MYSQL_PORT || env.DB_PORT, 3306);
  const user = toTrimmedString(env.LOGS_DB_USER || env.MYSQL_USER || env.DB_USER || 'jmassalh_subscribes');
  const password = toTrimmedString(
    env.LOGS_DB_PASSWORD || env.MYSQL_PASSWORD || env.DB_PASSWORD || 'jmassalh_subscribes!!'
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
