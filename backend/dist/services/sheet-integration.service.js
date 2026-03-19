"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SheetIntegrationService = void 0;
exports.createSheetIntegrationServiceFromEnv = createSheetIntegrationServiceFromEnv;
function toTrimmedString(value) {
    return String(value ?? '').trim();
}
function normalizeUrl(value) {
    return toTrimmedString(value);
}
class SheetIntegrationService {
    googleSheetUrl;
    logsBackupSheetUrl;
    shuttleUserOrdersUrl;
    defaultToken;
    constructor(config) {
        this.googleSheetUrl = normalizeUrl(config.googleSheetUrl);
        this.logsBackupSheetUrl = normalizeUrl(config.logsBackupSheetUrl) || this.googleSheetUrl;
        this.shuttleUserOrdersUrl = normalizeUrl(config.shuttleUserOrdersUrl);
        this.defaultToken = toTrimmedString(config.defaultToken);
    }
    buildGoogleSheetGetUrl(queryParams = {}, options = {}) {
        if (!this.googleSheetUrl) {
            throw new Error('GOOGLE_SHEET_URL is not configured');
        }
        const url = new URL(this.googleSheetUrl);
        for (const [key, rawValue] of Object.entries(queryParams)) {
            if (rawValue === null || rawValue === undefined)
                continue;
            const value = toTrimmedString(rawValue);
            if (!value)
                continue;
            url.searchParams.set(key, value);
        }
        const token = toTrimmedString(Object.prototype.hasOwnProperty.call(options, 'token') ? options.token : this.defaultToken);
        if (token) {
            url.searchParams.set('token', token);
        }
        return url.toString();
    }
    buildLogsBackupSheetGetUrl(queryParams = {}, options = {}) {
        if (!this.logsBackupSheetUrl) {
            throw new Error('LOGS_BACKUP_SHEET_URL is not configured');
        }
        const url = new URL(this.logsBackupSheetUrl);
        for (const [key, rawValue] of Object.entries(queryParams)) {
            if (rawValue === null || rawValue === undefined)
                continue;
            const value = toTrimmedString(rawValue);
            if (!value)
                continue;
            url.searchParams.set(key, value);
        }
        const token = toTrimmedString(Object.prototype.hasOwnProperty.call(options, 'token') ? options.token : this.defaultToken);
        if (token) {
            url.searchParams.set('token', token);
        }
        return url.toString();
    }
    buildShuttleUserOrdersUrl(queryParams = {}) {
        if (!this.shuttleUserOrdersUrl) {
            return '';
        }
        const url = new URL(this.shuttleUserOrdersUrl);
        for (const [key, rawValue] of Object.entries(queryParams)) {
            if (rawValue === null || rawValue === undefined)
                continue;
            const value = toTrimmedString(rawValue);
            if (!value)
                continue;
            url.searchParams.set(key, value);
        }
        return url.toString();
    }
}
exports.SheetIntegrationService = SheetIntegrationService;
function createSheetIntegrationServiceFromEnv(env = process.env) {
    const googleSheetUrl = toTrimmedString(env.GOOGLE_SHEET_URL)
        || 'https://script.google.com/macros/s/AKfycbxwGvC15zTXxqHnQP0E5NT1I5CRe6QE2SXKkU9NMnouhez0mZ_6YuJ_Bh0rxoxTOE1zQQ/exec';
    const logsBackupSheetUrl = toTrimmedString(env.LOGS_BACKUP_SHEET_URL)
        || 'https://script.google.com/macros/s/AKfycbzlnfZHiV1Wg6jt5VqbJ1HYViLr4s2vrJ63jUVfXAGBhTxbXh_5gDd5ADl-1V6NPxdhWw/exec';
    const shuttleUserOrdersUrl = toTrimmedString(env.SHUTTLE_USER_ORDERS_URL)
        || 'https://script.google.com/macros/s/AKfycbxbT0U2U5c0s4LAVPca8XsC8KwPIBIIgtKo1jfmHhUcE7yoF3SqaiC-Ki1vYSDj24ET/exec';
    const defaultToken = toTrimmedString(env.APP_SERVER_TOKEN ||
        env.GOOGLE_SHEET_APP_SERVER_TOKEN ||
        env.CHECK_QUEUE_SERVER_TOKEN ||
        env.GOOGLE_SHEET_CHECK_QUEUE_TOKEN ||
        '');
    return new SheetIntegrationService({
        googleSheetUrl,
        logsBackupSheetUrl,
        shuttleUserOrdersUrl,
        defaultToken
    });
}
