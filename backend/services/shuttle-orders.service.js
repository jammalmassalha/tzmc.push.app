/**
 * Shuttle Orders Database Helper
 * Handles initialization and queries for the shuttle_orders table
 */

const fs = require('fs');
const path = require('path');

/**
 * Initialize the shuttle_orders table
 * Executes the SQL migration if the table doesn't exist
 * @param {Object} dbPool - MySQL connection pool
 * @returns {Promise<void>}
 */
async function initializeShuttleOrdersTable(dbPool) {
  try {
    const migrationPath = path.join(__dirname, '../migrations/01-shuttle-orders.sql');
    const sql = fs.readFileSync(migrationPath, 'utf8');
    
    const connection = await dbPool.getConnection();
    try {
      // Split by semicolon and execute each statement
      const statements = sql.split(';').filter(stmt => stmt.trim());
      for (const statement of statements) {
        if (statement.trim()) {
          await connection.execute(statement);
        }
      }
      console.log('[ShuttleOrders] Table initialized successfully');
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('[ShuttleOrders] Failed to initialize table:', error.message);
    throw error;
  }
}

/**
 * Save a shuttle booking order to the database
 * @param {Object} dbPool - MySQL connection pool
 * @param {Object} orderData - Order data object
 * @returns {Promise<number>} The inserted order ID
 */
async function saveShuttleOrder(dbPool, orderData) {
  const {
    userId = null,
    userName = null,
    phone = null,
    pickupLocation,
    dropoffLocation,
    pickupTime,
    passengersCount = 1,
    notes = null,
    rawPayload = null
  } = orderData;

  const sql = `
    INSERT INTO shuttle_orders 
    (user_id, user_name, phone, pickup_location, dropoff_location, pickup_time, passengers_count, notes, raw_payload, sync_status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING')
  `;

  const connection = await dbPool.getConnection();
  try {
    const [result] = await connection.execute(sql, [
      userId,
      userName,
      phone,
      pickupLocation,
      dropoffLocation,
      pickupTime,
      passengersCount,
      notes,
      rawPayload ? JSON.stringify(rawPayload) : null
    ]);

    return result.insertId;
  } finally {
    connection.release();
  }
}

/**
 * Get pending and failed shuttle orders for sync
 * @param {Object} dbPool - MySQL connection pool
 * @param {number} limit - Number of records to fetch
 * @returns {Promise<Array>} Array of shuttle orders
 */
async function getPendingShuttleOrders(dbPool, limit = 20) {
  const sql = `
    SELECT * FROM shuttle_orders 
    WHERE sync_status IN ('PENDING', 'FAILED')
    ORDER BY id ASC 
    LIMIT ?
  `;

  const connection = await dbPool.getConnection();
  try {
    const [orders] = await connection.execute(sql, [limit]);
    return orders || [];
  } finally {
    connection.release();
  }
}

/**
 * Update shuttle order to PROCESSING status
 * @param {Object} dbPool - MySQL connection pool
 * @param {number} orderId - Order ID
 * @returns {Promise<void>}
 */
async function markOrderProcessing(dbPool, orderId) {
  const sql = `
    UPDATE shuttle_orders 
    SET sync_status = 'PROCESSING' 
    WHERE id = ?
  `;

  const connection = await dbPool.getConnection();
  try {
    await connection.execute(sql, [orderId]);
  } finally {
    connection.release();
  }
}

/**
 * Mark shuttle order as successfully synced
 * @param {Object} dbPool - MySQL connection pool
 * @param {number} orderId - Order ID
 * @returns {Promise<void>}
 */
async function markOrderSynced(dbPool, orderId) {
  const sql = `
    UPDATE shuttle_orders 
    SET sync_status = 'SYNCED', 
        synced_at = NOW(), 
        last_error = NULL 
    WHERE id = ?
  `;

  const connection = await dbPool.getConnection();
  try {
    await connection.execute(sql, [orderId]);
  } finally {
    connection.release();
  }
}

/**
 * Mark shuttle order as failed with error message
 * @param {Object} dbPool - MySQL connection pool
 * @param {number} orderId - Order ID
 * @param {string} errorMessage - Error message (truncated to 500 chars)
 * @returns {Promise<void>}
 */
async function markOrderFailed(dbPool, orderId, errorMessage) {
  const sql = `
    UPDATE shuttle_orders 
    SET sync_status = 'FAILED', 
        retry_count = retry_count + 1, 
        last_error = ? 
    WHERE id = ?
  `;

  const connection = await dbPool.getConnection();
  try {
    const truncatedError = (errorMessage || 'Unknown error').substring(0, 500);
    await connection.execute(sql, [truncatedError, orderId]);
  } finally {
    connection.release();
  }
}

/**
 * Get shuttle order by ID
 * @param {Object} dbPool - MySQL connection pool
 * @param {number} orderId - Order ID
 * @returns {Promise<Object|null>} Shuttle order or null
 */
async function getShuttleOrderById(dbPool, orderId) {
  const sql = `SELECT * FROM shuttle_orders WHERE id = ?`;

  const connection = await dbPool.getConnection();
  try {
    const [orders] = await connection.execute(sql, [orderId]);
    return orders && orders.length > 0 ? orders[0] : null;
  } finally {
    connection.release();
  }
}

module.exports = {
  initializeShuttleOrdersTable,
  saveShuttleOrder,
  getPendingShuttleOrders,
  markOrderProcessing,
  markOrderSynced,
  markOrderFailed,
  getShuttleOrderById
};
