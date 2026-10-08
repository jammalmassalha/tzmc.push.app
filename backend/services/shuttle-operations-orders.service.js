/**
 * Shuttle Operations Orders Service
 * Handles saving and managing shuttle operations orders in the database
 * These are different from shuttle bookings (ENTRY_STATION orders)
 */

/**
 * Save a shuttle operations order to the database
 * @param {Object} dbPool - MySQL connection pool
 * @param {Object} orderData - Order data object
 * @returns {Promise<number>} The inserted order ID
 */
async function saveShuttleOperationsOrder(dbPool, orderData) {
  const {
    employee,
    date,
    dateAlt,
    shift,
    station,
    status,
    userId = null
  } = orderData;

  const sql = `
    INSERT INTO shuttle_operations_orders 
    (employee, date, date_alt, shift, station, status, user_id, sync_status)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'PENDING')
  `;

  const connection = await dbPool.getConnection();
  try {
    const [result] = await connection.execute(sql, [
      employee,
      date,
      dateAlt,
      shift,
      station,
      status,
      userId
    ]);

    return result.insertId;
  } finally {
    connection.release();
  }
}

/**
 * Get pending and failed shuttle operations orders for sync
 * @param {Object} dbPool - MySQL connection pool
 * @param {number} limit - Number of records to fetch
 * @returns {Promise<Array>} Array of shuttle operations orders
 */
async function getPendingShuttleOperationsOrders(dbPool, limit = 20) {
  const sql = `
    SELECT * FROM shuttle_operations_orders 
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
 * Update shuttle operations order to PROCESSING status
 * @param {Object} dbPool - MySQL connection pool
 * @param {number} orderId - Order ID
 * @returns {Promise<void>}
 */
async function markOperationsOrderProcessing(dbPool, orderId) {
  const sql = `
    UPDATE shuttle_operations_orders 
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
 * Mark shuttle operations order as successfully synced
 * @param {Object} dbPool - MySQL connection pool
 * @param {number} orderId - Order ID
 * @returns {Promise<void>}
 */
async function markOperationsOrderSynced(dbPool, orderId) {
  const sql = `
    UPDATE shuttle_operations_orders 
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
 * Mark shuttle operations order as failed with error message
 * @param {Object} dbPool - MySQL connection pool
 * @param {number} orderId - Order ID
 * @param {string} errorMessage - Error message (truncated to 500 chars)
 * @returns {Promise<void>}
 */
async function markOperationsOrderFailed(dbPool, orderId, errorMessage) {
  const sql = `
    UPDATE shuttle_operations_orders 
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
 * Get shuttle operations order by ID
 * @param {Object} dbPool - MySQL connection pool
 * @param {number} orderId - Order ID
 * @returns {Promise<Object|null>} Shuttle operations order or null
 */
async function getShuttleOperationsOrderById(dbPool, orderId) {
  const sql = `SELECT * FROM shuttle_operations_orders WHERE id = ?`;

  const connection = await dbPool.getConnection();
  try {
    const [orders] = await connection.execute(sql, [orderId]);
    return orders && orders.length > 0 ? orders[0] : null;
  } finally {
    connection.release();
  }
}

/**
 * Initialize the shuttle_operations_orders table
 * Executes the SQL migration if the table doesn't exist
 * @param {Object} dbPool - MySQL connection pool
 * @returns {Promise<void>}
 */
async function initializeShuttleOperationsOrdersTable(dbPool) {
  try {
    const fs = require('fs');
    const path = require('path');
    
    const migrationPath = path.join(__dirname, '../migrations/02-shuttle-operations-orders.sql');
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
      console.log('[ShuttleOperationsOrders] Table initialized successfully');
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('[ShuttleOperationsOrders] Failed to initialize table:', error.message);
    throw error;
  }
}

module.exports = {
  initializeShuttleOperationsOrdersTable,
  saveShuttleOperationsOrder,
  getPendingShuttleOperationsOrders,
  markOperationsOrderProcessing,
  markOperationsOrderSynced,
  markOperationsOrderFailed,
  getShuttleOperationsOrderById
};
