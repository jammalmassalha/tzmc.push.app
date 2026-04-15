type QueryParamValue = string | number | boolean | null | undefined;

export interface SheetIntegrationConfig {
  googleSheetUrl: string;
  logsBackupSheetUrl?: string;
  shuttleUserOrdersUrl: string;
  defaultToken?: string;
}

export interface BuildUrlOptions {
  token?: string;
}

function toTrimmedString(value: unknown): string {
  return String(value ?? '').trim();
}

function normalizeUrl(value: unknown): string {
  return toTrimmedString(value);
}

export class SheetIntegrationService {
  readonly googleSheetUrl: string;
  readonly logsBackupSheetUrl: string;
  readonly shuttleUserOrdersUrl: string;
  readonly defaultToken: string;

  constructor(config: SheetIntegrationConfig) {
    this.googleSheetUrl = normalizeUrl(config.googleSheetUrl);
    this.logsBackupSheetUrl = normalizeUrl(config.logsBackupSheetUrl) || this.googleSheetUrl;
    this.shuttleUserOrdersUrl = normalizeUrl(config.shuttleUserOrdersUrl);
    this.defaultToken = toTrimmedString(config.defaultToken);
  }

  buildGoogleSheetGetUrl(queryParams: Record<string, QueryParamValue> = {}, options: BuildUrlOptions = {}): string {
    if (!this.googleSheetUrl) {
      throw new Error('GOOGLE_SHEET_URL is not configured');
    }
    const url = new URL(this.googleSheetUrl);
    for (const [key, rawValue] of Object.entries(queryParams)) {
      if (rawValue === null || rawValue === undefined) continue;
      const value = toTrimmedString(rawValue);
      if (!value) continue;
      url.searchParams.set(key, value);
    }

    const token = toTrimmedString(Object.prototype.hasOwnProperty.call(options, 'token') ? options.token : this.defaultToken);
    if (token) {
      url.searchParams.set('token', token);
    }
    return url.toString();
  }

  buildLogsBackupSheetGetUrl(queryParams: Record<string, QueryParamValue> = {}, options: BuildUrlOptions = {}): string {
    if (!this.logsBackupSheetUrl) {
      throw new Error('LOGS_BACKUP_SHEET_URL is not configured');
    }
    const url = new URL(this.logsBackupSheetUrl);
    for (const [key, rawValue] of Object.entries(queryParams)) {
      if (rawValue === null || rawValue === undefined) continue;
      const value = toTrimmedString(rawValue);
      if (!value) continue;
      url.searchParams.set(key, value);
    }

    const token = toTrimmedString(Object.prototype.hasOwnProperty.call(options, 'token') ? options.token : this.defaultToken);
    if (token) {
      url.searchParams.set('token', token);
    }
    return url.toString();
  }

  buildShuttleUserOrdersUrl(queryParams: Record<string, QueryParamValue> = {}): string {
    if (!this.shuttleUserOrdersUrl) {
      return '';
    }
    const url = new URL(this.shuttleUserOrdersUrl);
    for (const [key, rawValue] of Object.entries(queryParams)) {
      if (rawValue === null || rawValue === undefined) continue;
      const value = toTrimmedString(rawValue);
      if (!value) continue;
      url.searchParams.set(key, value);
    }
    return url.toString();
  }
}

export function createSheetIntegrationServiceFromEnv(env: NodeJS.ProcessEnv = process.env): SheetIntegrationService {
  const googleSheetUrl = toTrimmedString(env.GOOGLE_SHEET_URL)
    || 'https://script.google.com/macros/s/AKfycbx8mOmuevYdT8MV1gOvaF6HsD8rfCYy-xlhioJEx6W672YniaSS6W0S1lDyNJkfFkFt1Q/exec';
  const logsBackupSheetUrl = toTrimmedString(env.LOGS_BACKUP_SHEET_URL)
    || 'https://script.google.com/macros/s/AKfycbx8mOmuevYdT8MV1gOvaF6HsD8rfCYy-xlhioJEx6W672YniaSS6W0S1lDyNJkfFkFt1Q/exec';
  const shuttleUserOrdersUrl = toTrimmedString(env.SHUTTLE_USER_ORDERS_URL)
    || 'https://script.google.com/macros/s/AKfycbxbT0U2U5c0s4LAVPca8XsC8KwPIBIIgtKo1jfmHhUcE7yoF3SqaiC-Ki1vYSDj24ET/exec';
  const defaultToken = toTrimmedString(
    env.APP_SERVER_TOKEN ||
    env.GOOGLE_SHEET_APP_SERVER_TOKEN ||
    env.CHECK_QUEUE_SERVER_TOKEN ||
    env.GOOGLE_SHEET_CHECK_QUEUE_TOKEN ||
    ''
  );

  return new SheetIntegrationService({
    googleSheetUrl,
    logsBackupSheetUrl,
    shuttleUserOrdersUrl,
    defaultToken
  });
}
