#!/usr/bin/env node

const {
  createSheetIntegrationServiceFromEnv,
  createMysqlLogsServiceFromEnv
} = require('../backend/dist/services');

async function fetchJsonWithRetry(url, retries = 2, timeoutMs = 20000) {
  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let response;
      try {
        if (typeof globalThis.fetch === 'function') {
          response = await globalThis.fetch(url, { signal: controller.signal });
        } else {
          const nodeFetch = (await import('node-fetch')).default;
          response = await nodeFetch(url, { signal: controller.signal });
        }
      } finally {
        clearTimeout(timer);
      }

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const payload = await response.json();
      return payload;
    } catch (error) {
      lastError = error;
      if (attempt >= retries) break;
      const backoffMs = Math.min(5000, 700 * (attempt + 1));
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
    }
  }
  throw lastError || new Error('Fetch failed');
}

function parseBooleanArg(value, fallback = false) {
  if (typeof value === 'boolean') return value;
  const text = String(value || '').trim().toLowerCase();
  if (!text) return fallback;
  if (text === '1' || text === 'true' || text === 'yes' || text === 'y') return true;
  if (text === '0' || text === 'false' || text === 'no' || text === 'n') return false;
  return fallback;
}

function parsePositiveInt(value, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return fallback;
  return Math.floor(numeric);
}

function parseDateTime(value) {
  if (value instanceof Date) return value;
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) {
    return new Date(numeric);
  }
  const text = String(value || '').trim();
  if (!text) return new Date();
  const parsed = Date.parse(text);
  if (Number.isFinite(parsed) && parsed > 0) {
    return new Date(parsed);
  }
  return new Date();
}

function mapDumpRowToLogPayload(rawRow = {}) {
  if (!rawRow || typeof rawRow !== 'object') return null;
  return {
    dateTime: parseDateTime(rawRow.dateTime ?? rawRow.DateTime ?? ''),
    recipient: String(rawRow.toUser ?? rawRow.ToUser ?? rawRow.recipient ?? '').trim(),
    sender: String(rawRow.fromUser ?? rawRow.From ?? rawRow.sender ?? 'System').trim() || 'System',
    message: String(rawRow.messagePreview ?? rawRow['Message Preview'] ?? rawRow.message ?? '').trim(),
    status: String(rawRow.successOrFailed ?? rawRow.SuccessOrFailed ?? rawRow.status ?? '').trim(),
    details: String(rawRow.errorMessageOrSuccessCount ?? rawRow.ErrorMessageOrSuccessCount ?? rawRow.details ?? '').trim(),
    recipientAuthJson: String(rawRow.recipientAuthJson ?? rawRow.RecipientAuthJSON ?? '').trim()
  };
}

function parseArgs(argv) {
  const options = {
    batchSize: 1000,
    maxRows: 0,
    offset: 0,
    dryRun: false,
    truncate: false,
    dedupe: false
  };
  argv.forEach((arg) => {
    const text = String(arg || '').trim();
    if (!text) return;
    if (text === '--dry-run') {
      options.dryRun = true;
      return;
    }
    if (text === '--truncate') {
      options.truncate = true;
      return;
    }
    if (text === '--dedupe') {
      options.dedupe = true;
      return;
    }
    const [rawKey, ...rawValueParts] = text.replace(/^--/, '').split('=');
    const key = String(rawKey || '').trim();
    const rawValue = rawValueParts.join('=');
    if (!key) return;
    if (key === 'batch-size') {
      options.batchSize = Math.max(10, Math.min(parsePositiveInt(rawValue, options.batchSize), 5000));
      return;
    }
    if (key === 'max-rows') {
      options.maxRows = Math.max(0, parsePositiveInt(rawValue, options.maxRows));
      return;
    }
    if (key === 'offset') {
      options.offset = Math.max(0, parsePositiveInt(rawValue, options.offset));
      return;
    }
    if (key === 'dry-run') {
      options.dryRun = parseBooleanArg(rawValue, options.dryRun);
      return;
    }
    if (key === 'truncate') {
      options.truncate = parseBooleanArg(rawValue, options.truncate);
      return;
    }
    if (key === 'dedupe') {
      options.dedupe = parseBooleanArg(rawValue, options.dedupe);
    }
  });
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const sheetService = createSheetIntegrationServiceFromEnv(process.env);
  const mysqlLogsService = createMysqlLogsServiceFromEnv(process.env);

  if (options.truncate && !options.dryRun && options.offset === 0) {
    await mysqlLogsService.truncateLogs();
    console.log('[LOGS IMPORT] Truncated target table before import.');
  }

  let offset = options.offset;
  let scanned = 0;
  let imported = 0;
  let batches = 0;
  let skippedExisting = 0;
  let hasMore = true;

  while (hasMore) {
    const remaining = options.maxRows > 0 ? Math.max(0, options.maxRows - scanned) : options.batchSize;
    if (options.maxRows > 0 && remaining <= 0) {
      break;
    }
    const effectiveLimit = options.maxRows > 0
      ? Math.max(1, Math.min(options.batchSize, remaining))
      : options.batchSize;

    const url = sheetService.buildLogsBackupSheetGetUrl({
      action: 'get_logs_dump',
      offset: String(offset),
      limit: String(effectiveLimit)
    });
    const payload = await fetchJsonWithRetry(url, 2, 25000);
    const result = String(payload && payload.result ? payload.result : '').trim().toLowerCase();
    if (result && result !== 'success') {
      const errorMessage = String((payload && (payload.error || payload.message)) || 'Logs dump failed').trim();
      if (/usernames parameter is missing/i.test(errorMessage)) {
        throw new Error('Google Apps Script deployment is outdated (missing get_logs_dump action). Deploy latest code.gs first.');
      }
      throw new Error(errorMessage || 'Logs dump failed');
    }

    const rows = Array.isArray(payload && payload.rows) ? payload.rows : [];
    if (!rows.length) {
      hasMore = false;
      break;
    }

    const mappedRows = rows.map((row) => mapDumpRowToLogPayload(row)).filter(Boolean);
    if (!options.dryRun && mappedRows.length) {
      const insertedCount = await mysqlLogsService.insertLogsBulk(mappedRows, {
        dedupeExisting: options.dedupe
      });
      imported += insertedCount;
      if (options.dedupe) {
        skippedExisting += Math.max(0, mappedRows.length - insertedCount);
      }
    } else if (options.dryRun && options.dedupe && mappedRows.length) {
      const rowsToInsert = await mysqlLogsService.filterNewLogsByCompositeKey(mappedRows);
      imported += rowsToInsert.length;
      skippedExisting += Math.max(0, mappedRows.length - rowsToInsert.length);
    } else {
      imported += mappedRows.length;
    }
    scanned += rows.length;
    offset += rows.length;
    batches += 1;
    hasMore = Boolean(payload && payload.hasMore === true);

    console.log(`[LOGS IMPORT] batch=${batches} scanned=${scanned} imported=${imported} nextOffset=${offset}`);
  }

  console.log(JSON.stringify({
    result: 'success',
    dryRun: options.dryRun,
    dedupe: options.dedupe,
    truncated: options.truncate && options.offset === 0,
    scanned,
    imported,
    skippedExisting,
    batches,
    nextOffset: offset
  }, null, 2));
}

main().catch((error) => {
  console.error('[LOGS IMPORT] Failed:', error && error.message ? error.message : error);
  process.exit(1);
});
