#!/usr/bin/env node

/**
 * Migration script to initialize the ToSendQueue table
 * 
 * Usage:
 *   node backend/utils/init-tosend-table.js
 * 
 * Environment variables:
 *   LOGS_DB_HOST, LOGS_DB_PORT, LOGS_DB_USER, LOGS_DB_PASSWORD, LOGS_DB_NAME
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

const { createDatabasePool } = require('../config/db');
const { ToSendQueueService } = require('../dist/services/tosend-queue.service');

async function initializeToSendTable() {
    const pool = createDatabasePool();
    
    try {
        console.log('[INIT] Creating ToSendQueue table...');
        const toSendService = new ToSendQueueService(pool);
        await toSendService.ensureTableExists();
        console.log('[INIT] ToSendQueue table initialization completed successfully!');
        
        // Get stats to verify
        const stats = await toSendService.getQueueStats();
        console.log('[INIT] Queue stats:', stats);
        
    } catch (error) {
        console.error('[INIT] Error initializing table:', error.message);
        process.exit(1);
    } finally {
        await pool.end();
        process.exit(0);
    }
}

initializeToSendTable();
