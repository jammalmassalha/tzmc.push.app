"use strict";
/**
 * Validates that all required environment variables are present at startup.
 * Call this early in server.js to fail fast with a clear error message
 * instead of crashing mid-request.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.validateEnv = validateEnv;
exports.validateEnvOrExit = validateEnvOrExit;
const ENV_RULES = [
    // Google Sheets integration
    { name: 'GOOGLE_SHEET_URL', required: true },
    { name: 'LOGS_BACKUP_SHEET_URL', required: false },
    { name: 'SHUTTLE_USER_ORDERS_URL', required: false },
    // Auth tokens
    { name: 'APP_SERVER_TOKEN', required: true },
    { name: 'CHECK_QUEUE_SERVER_TOKEN', required: true },
    // MySQL
    { name: 'LOGS_DB_HOST', required: true },
    { name: 'LOGS_DB_PORT', required: true },
    { name: 'LOGS_DB_USER', required: true },
    { name: 'LOGS_DB_PASSWORD', required: true },
    { name: 'LOGS_DB_NAME', required: true },
    // Redis (optional – app can run without it)
    { name: 'REDIS_URL', required: false },
    // Session encryption
    { name: 'SESSION_SIGNING_SECRET', required: true },
    { name: 'SESSION_JWE_SECRET', required: true },
    // VAPID keys for web push
    { name: 'VAPID_PUBLIC_KEY', required: true },
    { name: 'VAPID_PRIVATE_KEY', required: true },
];
function validateEnv(env = process.env) {
    const missing = [];
    const warnings = [];
    for (const rule of ENV_RULES) {
        const value = env[rule.name];
        if (!value || value.trim() === '') {
            if (rule.required) {
                missing.push(rule.name);
            }
            else {
                warnings.push(rule.name);
            }
        }
    }
    return {
        valid: missing.length === 0,
        missing,
        warnings,
    };
}
/**
 * Validates environment variables and logs results. Exits the process if
 * required variables are missing.
 */
function validateEnvOrExit(env = process.env) {
    const result = validateEnv(env);
    if (result.warnings.length > 0) {
        console.warn(`[ENV] Optional variables not set: ${result.warnings.join(', ')}. Some features may be disabled.`);
    }
    if (!result.valid) {
        console.error(`[ENV] Missing required environment variables:\n` +
            result.missing.map((v) => `  - ${v}`).join('\n') +
            `\n\nCopy backend/.env.example to .env and fill in the values.`);
        process.exit(1);
    }
    console.log('[ENV] All required environment variables are set.');
}
