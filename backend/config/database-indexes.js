/**
 * Database Optimization Indexes
 * 
 * This file contains SQL ALTER TABLE statements to create composite and single
 * indexes for optimal query performance on the messaging system.
 * 
 * Indexes optimize:
 * - Message retrieval by group (groupId, pts)
 * - Fast idempotency checks (clientMsgId)
 * - User notification delivery (userId, delivered)
 * - Activity queries (groupId, timestamp)
 */

/**
 * Returns an array of SQL ALTER TABLE statements for creating indexes
 * Each statement is safe to run multiple times (uses CREATE INDEX IF NOT EXISTS)
 * @returns {Array<string>} Array of SQL statements
 */
function getDatabaseIndexStatements() {
    return [
        // Index 1: Composite index on Logs table for message synchronization
        // Used when clients request messages for a specific group, sorted by sequence number
        // Typical query: SELECT * FROM Logs WHERE groupId = ? AND pts >= ? ORDER BY pts ASC
        `ALTER TABLE Logs ADD INDEX idx_groupid_pts (groupId, pts)`,
        
        // Index 2: Single index on clientMsgId for idempotency checks
        // Used to detect duplicate messages from the same client
        // Typical query: SELECT id FROM Logs WHERE clientMsgId = ?
        `ALTER TABLE Logs ADD INDEX idx_clientmsgid (clientMsgId)`,
        
        // Index 3: Composite index on userId + pts for user-specific message queries
        // Used when fetching messages for a specific user in notification contexts
        `ALTER TABLE Logs ADD INDEX idx_userid_pts (userId, pts)`,
        
        // Index 4: Composite index on groupId + timestamp for activity queries
        // Used for time-range queries and recent activity lookups
        `ALTER TABLE Logs ADD INDEX idx_groupid_timestamp (groupId, timestamp)`,
        
        // Index 5: Index on MessageActivities for fast activity lookup by user
        // Used in notification delivery and message status tracking
        `ALTER TABLE MessageActivities ADD INDEX idx_userid (userId)`,
        
        // Index 6: Composite index for message delivery tracking
        // Used to find undelivered messages for a user in a group
        `ALTER TABLE MessageActivities ADD INDEX idx_userid_groupid (userId, groupId)`,
        
        // Index 7: Index on delivered status for batch delivery checks
        // Used to find all undelivered messages
        `ALTER TABLE MessageActivities ADD INDEX idx_delivered (delivered)`,
        
        // Index 8: Composite index for user subscription queries
        // Used to find which groups a user is subscribed to
        `ALTER TABLE ChatGroupMembers ADD INDEX idx_userid_groupid (userId, groupId)`,
        
        // Index 9: Composite index for admin verification queries
        // Used to check user privileges in a group
        `ALTER TABLE ChatGroupAdmins ADD INDEX idx_userid_groupid (userId, groupId)`
    ];
}

/**
 * Execute all database optimization statements
 * @param {Object} pool - MySQL connection pool
 * @returns {Promise<Array>} Results of all index creation attempts
 */
async function createOptimizationIndexes(pool) {
    const statements = getDatabaseIndexStatements();
    const results = [];

    for (const statement of statements) {
        try {
            const connection = await pool.getConnection();
            try {
                await connection.execute(statement);
                console.log(`[DB Index] ✓ ${statement.slice(0, 80)}...`);
                results.push({ statement, success: true });
            } finally {
                connection.release();
            }
        } catch (error) {
            // Ignore "Duplicate key name" errors - index may already exist
            if (error.code === 'ER_DUP_KEYNAME' || error.message.includes('already exists')) {
                console.log(`[DB Index] ℹ Index already exists: ${statement.slice(0, 60)}...`);
                results.push({ statement, success: true, existing: true });
            } else {
                console.error(`[DB Index] ✗ Failed: ${statement.slice(0, 60)}...`, error.message);
                results.push({ statement, success: false, error: error.message });
            }
        }
    }

    return results;
}

/**
 * Get analysis of a table's current indexes
 * @param {Object} pool - MySQL connection pool
 * @param {string} tableName - Name of the table to analyze
 * @returns {Promise<Array>} Array of existing indexes
 */
async function getTableIndexes(pool, tableName) {
    const connection = await pool.getConnection();
    try {
        const [indexes] = await connection.execute(
            `SELECT INDEX_NAME, COLUMN_NAME, SEQ_IN_INDEX FROM INFORMATION_SCHEMA.STATISTICS 
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? 
             ORDER BY INDEX_NAME, SEQ_IN_INDEX`,
            [tableName]
        );
        return indexes;
    } finally {
        connection.release();
    }
}

/**
 * SQL statements for index creation that can also be used directly in MySQL
 * This is helpful for manual DDL execution or migration scripts
 */
const INDEX_DDL_STATEMENTS = `
-- ========================================
-- Chat Application Database Indexes
-- ========================================
-- These indexes significantly improve query performance for:
-- 1. Message synchronization (groupId + pts)
-- 2. Idempotency checks (clientMsgId)
-- 3. User activity tracking (userId)
-- 4. Notification delivery (delivery status)
-- 5. Subscription management (group members)
--
-- Run these commands on your production database to optimize performance
-- ========================================

-- Message retrieval by group with sequence ordering
ALTER TABLE Logs ADD INDEX idx_groupid_pts (groupId, pts);

-- Fast idempotency check for duplicate prevention
ALTER TABLE Logs ADD INDEX idx_clientmsgid (clientMsgId);

-- User-specific message queries
ALTER TABLE Logs ADD INDEX idx_userid_pts (userId, pts);

-- Time-range queries for activity
ALTER TABLE Logs ADD INDEX idx_groupid_timestamp (groupId, timestamp);

-- Activity lookup by user
ALTER TABLE MessageActivities ADD INDEX idx_userid (userId);

-- User activity in specific group
ALTER TABLE MessageActivities ADD INDEX idx_userid_groupid (userId, groupId);

-- Undelivered message queries
ALTER TABLE MessageActivities ADD INDEX idx_delivered (delivered);

-- Group membership queries
ALTER TABLE ChatGroupMembers ADD INDEX idx_userid_groupid (userId, groupId);

-- Admin verification queries
ALTER TABLE ChatGroupAdmins ADD INDEX idx_userid_groupid (userId, groupId);
`;

module.exports = {
    getDatabaseIndexStatements,
    createOptimizationIndexes,
    getTableIndexes,
    INDEX_DDL_STATEMENTS
};
