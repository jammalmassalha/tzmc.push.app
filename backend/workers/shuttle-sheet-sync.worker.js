/**
 * Shuttle Sheet Sync Worker
 * Background worker that continuously processes pending shuttle orders and syncs to Google Sheets
 * 
 * This worker implements the Transactional Outbox Pattern:
 * 1. Orders are saved to MySQL with PENDING status
 * 2. Worker continuously polls for PENDING/FAILED orders
 * 3. Attempts to sync each order to Google Sheets
 * 4. Updates status to SYNCED on success or FAILED on error
 * 5. Retries failed orders with exponential backoff
 */

const { postOrderToGoogleSheet } = require('./sheet-integration-shuttle.service');
const {
  getPendingShuttleOrders,
  markOrderProcessing,
  markOrderSynced,
  markOrderFailed
} = require('./shuttle-orders.service');

const BATCH_SIZE = parseInt(process.env.SHUTTLE_SYNC_BATCH_SIZE || '20');
const POLL_INTERVAL_MS = parseInt(process.env.SHUTTLE_SYNC_POLL_INTERVAL_MS || '10000');
const MAX_RETRIES = parseInt(process.env.SHUTTLE_SYNC_MAX_RETRIES || '10');
const GOOGLE_SHEET_WEBHOOK_URL = process.env.GOOGLE_SHEET_WEBHOOK_URL;

let syncWorkerRunning = false;
let syncWorkerInterval = null;

/**
 * Process a single shuttle order
 * @param {Object} dbPool - MySQL connection pool
 * @param {Object} order - Shuttle order from database
 * @returns {Promise<boolean>} True if successful, false otherwise
 */
async function processSingleOrder(dbPool, order) {
  try {
    // Mark as processing
    await markOrderProcessing(dbPool, order.id);

    // Attempt to sync to Google Sheets
    await postOrderToGoogleSheet(order, GOOGLE_SHEET_WEBHOOK_URL);

    // Success: Mark as SYNCED
    await markOrderSynced(dbPool, order.id);

    console.log(`[ShuttleSync] Successfully synced order #${order.id} to Google Sheet.`);
    return true;
  } catch (error) {
    // Failure: Mark as FAILED and increment retry count
    const errorMessage = error && error.message ? error.message : 'Unknown error';
    console.error(`[ShuttleSync] Failed to sync order #${order.id}:`, errorMessage);

    await markOrderFailed(dbPool, order.id, errorMessage);
    return false;
  }
}

/**
 * Main processing loop for pending shuttle orders
 * Fetches pending orders in batches and attempts to sync them
 * @param {Object} dbPool - MySQL connection pool
 * @returns {Promise<void>}
 */
async function processPendingShuttleOrders(dbPool) {
  if (!dbPool) {
    console.warn('[ShuttleSync Worker] Database pool is not available');
    return;
  }

  try {
    // Fetch pending or recoverable failed orders
    const orders = await getPendingShuttleOrders(dbPool, BATCH_SIZE);

    if (!orders || orders.length === 0) {
      return;
    }

    console.log(`[ShuttleSync] Processing ${orders.length} pending/failed orders...`);

    let successCount = 0;
    let failureCount = 0;

    for (const order of orders) {
      // Check if we've exceeded max retries
      if (order.retry_count >= MAX_RETRIES) {
        console.warn(`[ShuttleSync] Order #${order.id} exceeded max retries (${order.retry_count}/${MAX_RETRIES}), skipping`);
        failureCount++;
        continue;
      }

      const success = await processSingleOrder(dbPool, order);
      if (success) {
        successCount++;
      } else {
        failureCount++;
      }

      // Add slight delay between orders to avoid overwhelming Google Sheets API
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    console.log(`[ShuttleSync] Batch complete: ${successCount} synced, ${failureCount} failed`);
  } catch (error) {
    console.error('[ShuttleSync Worker] Fatal error in processing loop:', error.message);
  }
}

/**
 * Start the background shuttle sync worker
 * Sets up the polling interval to continuously process pending orders
 * @param {Object} dbPool - MySQL connection pool
 * @returns {Object} Worker control object with stop method
 */
function startShuttleSyncWorker(dbPool) {
  if (syncWorkerRunning) {
    console.warn('[ShuttleSync Worker] Worker is already running');
    return { stop: stopShuttleSyncWorker };
  }

  if (!dbPool) {
    console.error('[ShuttleSync Worker] Cannot start: database pool is required');
    return { stop: () => {} };
  }

  if (!GOOGLE_SHEET_WEBHOOK_URL) {
    console.warn('[ShuttleSync Worker] GOOGLE_SHEET_WEBHOOK_URL is not configured, worker will not sync orders');
  }

  syncWorkerRunning = true;
  console.log('[ShuttleSync Worker] Started background sheet syncer.');
  console.log(`[ShuttleSync Worker] Configuration: batch_size=${BATCH_SIZE}, poll_interval=${POLL_INTERVAL_MS}ms, max_retries=${MAX_RETRIES}`);

  // Execute immediately on startup
  processPendingShuttleOrders(dbPool)
    .catch(error => console.error('[ShuttleSync Worker] Error on startup sync:', error.message));

  // Set up polling interval
  syncWorkerInterval = setInterval(() => {
    processPendingShuttleOrders(dbPool)
      .catch(error => console.error('[ShuttleSync Worker] Error in polling loop:', error.message));
  }, POLL_INTERVAL_MS);

  return {
    stop: stopShuttleSyncWorker
  };
}

/**
 * Stop the background shuttle sync worker
 * Clears the polling interval and allows graceful shutdown
 */
function stopShuttleSyncWorker() {
  if (syncWorkerInterval) {
    clearInterval(syncWorkerInterval);
    syncWorkerInterval = null;
  }
  syncWorkerRunning = false;
  console.log('[ShuttleSync Worker] Stopped');
}

/**
 * Get current worker status
 * @returns {Object} Worker status information
 */
function getShuttleSyncWorkerStatus() {
  return {
    running: syncWorkerRunning,
    pollIntervalMs: POLL_INTERVAL_MS,
    batchSize: BATCH_SIZE,
    maxRetries: MAX_RETRIES,
    webhookConfigured: Boolean(GOOGLE_SHEET_WEBHOOK_URL)
  };
}

module.exports = {
  startShuttleSyncWorker,
  stopShuttleSyncWorker,
  getShuttleSyncWorkerStatus,
  processPendingShuttleOrders,
  processSingleOrder
};
