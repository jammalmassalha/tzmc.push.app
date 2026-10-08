/**
 * Shuttle Operations Orders Sync Worker
 * Background worker that continuously processes pending shuttle operations orders
 * and syncs them to Google Sheets via the existing shuttle user orders URL
 */

const {
  getPendingShuttleOperationsOrders,
  markOperationsOrderProcessing,
  markOperationsOrderSynced,
  markOperationsOrderFailed
} = require('../services/shuttle-operations-orders.service');

const BATCH_SIZE = parseInt(process.env.SHUTTLE_OPS_SYNC_BATCH_SIZE || '20');
const POLL_INTERVAL_MS = parseInt(process.env.SHUTTLE_OPS_SYNC_POLL_INTERVAL_MS || '10000');
const MAX_RETRIES = parseInt(process.env.SHUTTLE_OPS_SYNC_MAX_RETRIES || '10');

let syncWorkerRunning = false;
let syncWorkerInterval = null;

// These will be injected when the worker starts
let fetchWithRetry = null;
let buildShuttleUserOrdersUrl = null;
const SHUTTLE_ENTRY_EMPLOYEE = 'entry.1035269960';
const SHUTTLE_ENTRY_DATE = 'entry.794242217';
const SHUTTLE_ENTRY_DATE_ALT = 'entry.794242217_22';
const SHUTTLE_ENTRY_SHIFT = 'entry.1992732561';
const SHUTTLE_ENTRY_STATION = 'entry.1096369604';
const SHUTTLE_ENTRY_STATUS = 'entry.798637322';

/**
 * Process a single shuttle operations order
 * @param {Object} dbPool - MySQL connection pool
 * @param {Object} order - Shuttle operations order from database
 * @returns {Promise<boolean>} True if successful, false otherwise
 */
async function processSingleOperationsOrder(dbPool, order) {
  try {
    // Mark as processing
    await markOperationsOrderProcessing(dbPool, order.id);

    // Build the Google Sheets URL with the order data
    const requestUrl = buildShuttleUserOrdersUrl({
      [SHUTTLE_ENTRY_EMPLOYEE]: order.employee,
      [SHUTTLE_ENTRY_DATE]: order.date,
      [SHUTTLE_ENTRY_DATE_ALT]: order.date_alt,
      [SHUTTLE_ENTRY_SHIFT]: order.shift,
      [SHUTTLE_ENTRY_STATION]: order.station,
      [SHUTTLE_ENTRY_STATUS]: order.status,
      _ts: Date.now()
    });

    // Send to Google Sheets
    const response = await fetchWithRetry(
      requestUrl,
      { cache: 'no-store' },
      { timeoutMs: 20000, retries: 2, backoffMs: 700 }
    );

    const bodyText = String(await response.text() || '').trim();

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${bodyText || 'No response'}`);
    }

    // Success: Mark as SYNCED
    await markOperationsOrderSynced(dbPool, order.id);

    console.log(`[ShuttleOpsSync] Successfully synced order #${order.id} (${order.employee}) to Google Sheet.`);
    return true;
  } catch (error) {
    // Failure: Mark as FAILED and increment retry count
    const errorMessage = error && error.message ? error.message : 'Unknown error';
    console.error(`[ShuttleOpsSync] Failed to sync order #${order.id}:`, errorMessage);

    await markOperationsOrderFailed(dbPool, order.id, errorMessage);
    return false;
  }
}

/**
 * Main processing loop for pending shuttle operations orders
 * Fetches pending orders in batches and attempts to sync them
 * @param {Object} dbPool - MySQL connection pool
 * @returns {Promise<void>}
 */
async function processPendingShuttleOperationsOrders(dbPool) {
  if (!dbPool) {
    console.warn('[ShuttleOpsSync Worker] Database pool is not available');
    return;
  }

  try {
    // Fetch pending or recoverable failed orders
    const orders = await getPendingShuttleOperationsOrders(dbPool, BATCH_SIZE);

    if (!orders || orders.length === 0) {
      return;
    }

    console.log(`[ShuttleOpsSync] Processing ${orders.length} pending/failed operations orders...`);

    let successCount = 0;
    let failureCount = 0;

    for (const order of orders) {
      // Check if we've exceeded max retries
      if (order.retry_count >= MAX_RETRIES) {
        console.warn(`[ShuttleOpsSync] Order #${order.id} exceeded max retries (${order.retry_count}/${MAX_RETRIES}), skipping`);
        failureCount++;
        continue;
      }

      const success = await processSingleOperationsOrder(dbPool, order);
      if (success) {
        successCount++;
      } else {
        failureCount++;
      }

      // Add slight delay between orders to avoid overwhelming Google Sheets API
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    console.log(`[ShuttleOpsSync] Batch complete: ${successCount} synced, ${failureCount} failed`);
  } catch (error) {
    console.error('[ShuttleOpsSync Worker] Fatal error in processing loop:', error.message);
  }
}

/**
 * Start the background shuttle operations sync worker
 * Sets up the polling interval to continuously process pending orders
 * @param {Object} dbPool - MySQL connection pool
 * @param {Function} fetchWithRetryFn - The fetchWithRetry function from server.js
 * @param {Function} buildUrlFn - The buildShuttleUserOrdersUrl function
 * @returns {Object} Worker control object with stop method
 */
function startShuttleOperationsSyncWorker(dbPool, fetchWithRetryFn, buildUrlFn) {
  if (syncWorkerRunning) {
    console.warn('[ShuttleOpsSync Worker] Worker is already running');
    return { stop: stopShuttleOperationsSyncWorker };
  }

  if (!dbPool) {
    console.error('[ShuttleOpsSync Worker] Cannot start: database pool is required');
    return { stop: () => {} };
  }

  if (!fetchWithRetryFn || !buildUrlFn) {
    console.error('[ShuttleOpsSync Worker] Cannot start: fetchWithRetry and buildShuttleUserOrdersUrl are required');
    return { stop: () => {} };
  }

  // Store the dependencies
  fetchWithRetry = fetchWithRetryFn;
  buildShuttleUserOrdersUrl = buildUrlFn;

  syncWorkerRunning = true;
  console.log('[ShuttleOpsSync Worker] Started background sheet syncer.');
  console.log(`[ShuttleOpsSync Worker] Configuration: batch_size=${BATCH_SIZE}, poll_interval=${POLL_INTERVAL_MS}ms, max_retries=${MAX_RETRIES}`);

  // Execute immediately on startup
  processPendingShuttleOperationsOrders(dbPool)
    .catch(error => console.error('[ShuttleOpsSync Worker] Error on startup sync:', error.message));

  // Set up polling interval
  syncWorkerInterval = setInterval(() => {
    processPendingShuttleOperationsOrders(dbPool)
      .catch(error => console.error('[ShuttleOpsSync Worker] Error in polling loop:', error.message));
  }, POLL_INTERVAL_MS);

  return {
    stop: stopShuttleOperationsSyncWorker
  };
}

/**
 * Stop the background shuttle operations sync worker
 * Clears the polling interval and allows graceful shutdown
 */
function stopShuttleOperationsSyncWorker() {
  if (syncWorkerInterval) {
    clearInterval(syncWorkerInterval);
    syncWorkerInterval = null;
  }
  syncWorkerRunning = false;
  console.log('[ShuttleOpsSync Worker] Stopped');
}

/**
 * Get current worker status
 * @returns {Object} Worker status information
 */
function getShuttleOperationsSyncWorkerStatus() {
  return {
    running: syncWorkerRunning,
    pollIntervalMs: POLL_INTERVAL_MS,
    batchSize: BATCH_SIZE,
    maxRetries: MAX_RETRIES
  };
}

module.exports = {
  startShuttleOperationsSyncWorker,
  stopShuttleOperationsSyncWorker,
  getShuttleOperationsSyncWorkerStatus,
  processPendingShuttleOperationsOrders,
  processSingleOperationsOrder
};
