type QueryParamValue = string | number | boolean | null | undefined;

export interface SheetIntegrationConfig {
  googleSheetUrl: string;
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
  readonly shuttleUserOrdersUrl: string;
  readonly defaultToken: string;

  constructor(config: SheetIntegrationConfig) {
    this.googleSheetUrl = normalizeUrl(config.googleSheetUrl);
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
    || 'https://script.google.com/macros/s/AKfycbyPaGmKWjN-bITa9i96QVkqkeU71BidSvObzMw-klaFJ-8u7oJRv1_Ay5_wRQa8eKH2eA/exec';
  const shuttleUserOrdersUrl = toTrimmedString(env.SHUTTLE_USER_ORDERS_URL)
    || 'https://script.google.com/macros/s/AKfycbxwyCutkKSeZWExmMg5D2-d72lGFywevgbmVc2wIck1h30Omdww4a6RTYEiM_fd7D6S/exec';
  const defaultToken = toTrimmedString(env.APP_SERVER_TOKEN || env.GOOGLE_SHEET_APP_SERVER_TOKEN || '');

  return new SheetIntegrationService({
    googleSheetUrl,
    shuttleUserOrdersUrl,
    defaultToken
  });
}
