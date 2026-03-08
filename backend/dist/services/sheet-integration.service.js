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
    shuttleUserOrdersUrl;
    defaultToken;
    constructor(config) {
        this.googleSheetUrl = normalizeUrl(config.googleSheetUrl);
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
        || 'https://script.google.com/macros/s/AKfycbyPaGmKWjN-bITa9i96QVkqkeU71BidSvObzMw-klaFJ-8u7oJRv1_Ay5_wRQa8eKH2eA/exec';
    const shuttleUserOrdersUrl = toTrimmedString(env.SHUTTLE_USER_ORDERS_URL)
        || 'https://script.google.com/macros/s/AKfycbxpFfOokS0-DzisejboqjZtJW3OLjMmPvMt-sZqNwSU5ohN940811XulyDdHEpmDHsY/exec';
    const defaultToken = toTrimmedString(env.APP_SERVER_TOKEN || env.GOOGLE_SHEET_APP_SERVER_TOKEN || '');
    return new SheetIntegrationService({
        googleSheetUrl,
        shuttleUserOrdersUrl,
        defaultToken
    });
}
