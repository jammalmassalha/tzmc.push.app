"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.normalizeIsraeliPhoneNumberToLocal = normalizeIsraeliPhoneNumberToLocal;
exports.toIsraeliInternationalPhoneDigits = toIsraeliInternationalPhoneDigits;
exports.maskPhoneForLogs = maskPhoneForLogs;
exports.formatAuthCodeSmsMessage = formatAuthCodeSmsMessage;
exports.buildInforuSmsXmlPayload = buildInforuSmsXmlPayload;
exports.extractInforuStatusCode = extractInforuStatusCode;
exports.extractInforuStatusDescription = extractInforuStatusDescription;
function digitsOnly(value) {
    return String(value ?? '').replace(/\D/g, '');
}
function normalizeIsraeliPhoneNumberToLocal(value) {
    const rawDigits = digitsOnly(value);
    if (!rawDigits)
        return '';
    if (/^0\d{9}$/.test(rawDigits))
        return rawDigits;
    if (/^5\d{8}$/.test(rawDigits))
        return `0${rawDigits}`;
    const digits = rawDigits.startsWith('00') ? rawDigits.slice(2) : rawDigits;
    if (!digits.startsWith('972'))
        return '';
    let localDigits = digits.slice(3);
    if (localDigits.startsWith('0')) {
        localDigits = localDigits.slice(1);
    }
    if (!/^5\d{8}$/.test(localDigits))
        return '';
    return `0${localDigits}`;
}
function toIsraeliInternationalPhoneDigits(value) {
    const local = normalizeIsraeliPhoneNumberToLocal(value);
    if (local) {
        return `972${local.slice(1)}`;
    }
    const rawDigits = digitsOnly(value);
    if (!rawDigits)
        return '';
    return rawDigits.startsWith('00') ? rawDigits.slice(2) : rawDigits;
}
function maskPhoneForLogs(value) {
    const candidate = normalizeIsraeliPhoneNumberToLocal(value) || digitsOnly(value) || String(value ?? '').trim();
    if (!candidate)
        return '';
    if (candidate.length <= 4)
        return '*'.repeat(candidate.length);
    return `***${candidate.slice(-4)}`;
}
function formatAuthCodeSmsMessage(template, code) {
    const normalizedTemplate = String(template || '').trim() || 'קוד אימות לכניסה לאפליקציה: {{code}}';
    if (normalizedTemplate.includes('{{code}}')) {
        return normalizedTemplate.replace(/\{\{code\}\}/g, String(code || ''));
    }
    return `${normalizedTemplate} ${code}`;
}
function escapeXmlValue(value) {
    return String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}
function buildInforuSmsXmlPayload({ username, apiToken, message, phone, sender, includeSender, }) {
    const escapedUsername = escapeXmlValue(username);
    const escapedToken = escapeXmlValue(apiToken);
    const escapedMessage = escapeXmlValue(message);
    const escapedPhone = escapeXmlValue(phone);
    const escapedSender = escapeXmlValue(sender || '');
    const xmlParts = [
        '<?xml version="1.0" encoding="utf-8"?>',
        '<Inforu>',
        '<User>',
        `<Username>${escapedUsername}</Username>`,
        `<ApiToken>${escapedToken}</ApiToken>`,
        '</User>',
        '<Content Type="sms">',
        `<Message>${escapedMessage}</Message>`,
        '</Content>',
        '<Recipients>',
        `<PhoneNumber>${escapedPhone}</PhoneNumber>`,
        '</Recipients>',
        '<Settings>',
    ];
    if (includeSender && escapedSender) {
        xmlParts.push(`<Sender>${escapedSender}</Sender>`);
    }
    xmlParts.push('<MessageInterval>0</MessageInterval>', '<TimeToSend></TimeToSend>', '</Settings>', '</Inforu>');
    return xmlParts.join('');
}
function extractInforuStatusCode(rawResponse) {
    const match = String(rawResponse || '').match(/<Status>\s*([^<\s]+)\s*<\/Status>/i);
    return match ? String(match[1] || '').trim() : '';
}
function extractInforuStatusDescription(rawResponse) {
    const source = String(rawResponse || '');
    const candidateTags = ['Description', 'StatusDescription', 'ErrorDescription', 'Error', 'Message'];
    for (const tag of candidateTags) {
        const expression = new RegExp(`<${tag}>\\s*([^<]+?)\\s*<\\/${tag}>`, 'i');
        const match = source.match(expression);
        if (match && String(match[1] || '').trim()) {
            return String(match[1] || '').trim();
        }
    }
    return '';
}
