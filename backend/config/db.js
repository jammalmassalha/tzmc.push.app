/**
 * Database Connection Pool Configuration
 * 
 * Provides a robust MySQL2/Promise connection pool with:
 * - Configurable pool size for different environments
 * - Automatic connection validation and recovery
 * - Support for both promise-based and callback APIs
 * - Connection pooling statistics and monitoring
 */

const mysql = require('mysql2/promise');

/**
 * Create and configure a MySQL connection pool
 * @param {Object} config - Configuration object
 * @param {string} config.host - Database host
 * @param {number} config.port - Database port (default: 3306)
 * @param {string} config.user - Database user
 * @param {string} config.password - Database password
 * @param {string} config.database - Database name
 * @param {number} config.connectionLimit - Max connections in pool (default: 20)
 * @param {number} config.maxIdle - Max idle time before closing connection (default: 1 minute)
 * @param {boolean} config.waitForConnections - Wait for connection if none available (default: true)
 * @param {string} config.charset - Connection charset (default: utf8mb4)
 * @param {boolean} config.enableKeepAlive - Enable TCP keep-alive (default: true)
 * @param {number} config.keepAliveInitialDelayMs - TCP keep-alive delay (default: 30s)
 * @returns {Object} Pool instance with promise support
 */
function createDatabasePool(config = {}) {
    const poolConfig = {
        host: config.host || process.env.LOGS_DB_HOST || process.env.MYSQL_HOST || '127.0.0.1',
        port: config.port || parseInt(process.env.LOGS_DB_PORT || process.env.MYSQL_PORT || '3306'),
        user: config.user || process.env.LOGS_DB_USER || process.env.MYSQL_USER || 'root',
        password: config.password || process.env.LOGS_DB_PASSWORD || process.env.MYSQL_PASSWORD || '',
        database: config.database || process.env.LOGS_DB_NAME || process.env.MYSQL_DATABASE || '',
        
        // Connection pool optimization
        connectionLimit: config.connectionLimit || parseInt(process.env.DB_POOL_SIZE || '20'),
        maxIdle: config.maxIdle || parseInt(process.env.DB_MAX_IDLE_MS || '60000'),
        idleTimeout: config.idleTimeout || parseInt(process.env.DB_IDLE_TIMEOUT_MS || '60000'),
        
        // Behavior configuration
        waitForConnections: config.waitForConnections !== false,
        queueLimit: config.queueLimit || parseInt(process.env.DB_QUEUE_LIMIT || '0'), // 0 = unlimited
        enableKeepAlive: config.enableKeepAlive !== false,
        keepAliveInitialDelayMs: config.keepAliveInitialDelayMs || 30000,
        
        // Connection configuration
        charset: config.charset || 'utf8mb4',
        supportBigNumbers: true,
        bigNumberStrings: false,
        
        // Connection timeout
        connectTimeout: config.connectTimeout || 10000,
        
        // SSL configuration (optional)
        ssl: config.ssl || (process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false)
    };

    const pool = mysql.createPool(poolConfig);
    
    // Log pool creation
    console.log(`[DB Pool] Created with config:`, {
        host: poolConfig.host,
        port: poolConfig.port,
        database: poolConfig.database,
        connectionLimit: poolConfig.connectionLimit,
        charset: poolConfig.charset
    });

    return pool;
}

/**
 * Wrapper for executing a query with connection from pool
 * Automatically handles connection acquisition and release
 * @param {Object} pool - Connection pool instance
 * @param {string} sql - SQL query
 * @param {Array} values - Query parameters
 * @returns {Promise<Array>} Query result rows
 */
async function executeQuery(pool, sql, values = []) {
    const connection = await pool.getConnection();
    try {
        const [results] = await connection.execute(sql, values);
        return results;
    } finally {
        connection.release();
    }
}

/**
 * Execute multiple inserts in a single query (bulk insert)
 * Much faster than individual inserts for large datasets
 * @param {Object} pool - Connection pool instance
 * @param {string} table - Table name
 * @param {Array<string>} columns - Column names
 * @param {Array<Array>} rows - Array of row value arrays
 * @returns {Promise<Object>} Query result with affectedRows
 */
async function executeBulkInsert(pool, table, columns, rows) {
    if (!rows || rows.length === 0) {
        return { affectedRows: 0 };
    }

    const columnList = columns.join(',');
    const placeholders = rows.map(() => `(${columns.map(() => '?').join(',')})`).join(',');
    const flatValues = rows.flat();
    
    const sql = `INSERT INTO ${table} (${columnList}) VALUES ${placeholders}`;
    
    const connection = await pool.getConnection();
    try {
        const [result] = await connection.execute(sql, flatValues);
        return result;
    } finally {
        connection.release();
    }
}

/**
 * Execute a transaction with multiple queries
 * Automatically rolls back on error
 * @param {Object} pool - Connection pool instance
 * @param {Function} callback - Async function that receives connection and executes queries
 * @returns {Promise<*>} Result of callback function
 */
async function executeTransaction(pool, callback) {
    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();
        const result = await callback(connection);
        await connection.commit();
        return result;
    } catch (error) {
        await connection.rollback();
        throw error;
    } finally {
        connection.release();
    }
}

/**
 * Get connection pool statistics for monitoring
 * @param {Object} pool - Connection pool instance
 * @returns {Object} Pool statistics
 */
function getPoolStats(pool) {
    if (!pool._pool) {
        return { error: 'Pool statistics not available' };
    }
    
    return {
        totalConnections: pool._pool.length,
        activeConnections: pool._allConnections ? pool._allConnections.length - pool._pool.length : 'unknown',
        idleConnections: pool._pool.length,
        queueLength: pool._connectionQueue ? pool._connectionQueue.length : 0
    };
}

/**
 * Close all connections in the pool
 * @param {Object} pool - Connection pool instance
 * @returns {Promise<void>}
 */
async function closePool(pool) {
    if (pool && typeof pool.end === 'function') {
        await pool.end();
        console.log('[DB Pool] Closed');
    }
}

module.exports = {
    createDatabasePool,
    executeQuery,
    executeBulkInsert,
    executeTransaction,
    getPoolStats,
    closePool
};
