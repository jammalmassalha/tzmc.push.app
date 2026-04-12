/**
 * Validates that all required environment variables are present at startup.
 * Call this early in server.js to fail fast with a clear error message
 * instead of crashing mid-request.
 */

interface EnvRule {
  /** Environment variable name */
  name: string;
  /** If true the variable MUST be set (non-empty). If false it is optional but logged as a warning when missing. */
  required: boolean;
}

const ENV_RULES: EnvRule[] = [
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

export interface EnvValidationResult {
  valid: boolean;
  missing: string[];
  warnings: string[];
}

export function validateEnv(env: Record<string, string | undefined> = process.env): EnvValidationResult {
  const missing: string[] = [];
  const warnings: string[] = [];

  for (const rule of ENV_RULES) {
    const value = env[rule.name];
    if (!value || value.trim() === '') {
      if (rule.required) {
        missing.push(rule.name);
      } else {
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
export function validateEnvOrExit(env: Record<string, string | undefined> = process.env): void {
  const result = validateEnv(env);

  if (result.warnings.length > 0) {
    console.warn(
      `[ENV] Optional variables not set: ${result.warnings.join(', ')}. Some features may be disabled.`
    );
  }

  if (!result.valid) {
    console.error(
      `[ENV] Missing required environment variables:\n` +
      result.missing.map((v) => `  - ${v}`).join('\n') +
      `\n\nCopy backend/.env.example to .env and fill in the values.`
    );
    process.exit(1);
  }

  console.log('[ENV] All required environment variables are set.');
}
