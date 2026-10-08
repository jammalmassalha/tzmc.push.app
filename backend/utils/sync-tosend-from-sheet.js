#!/usr/bin/env node

/**
 * Migration script to sync ToSend messages from Google Sheets to MySQL database
 * 
 * Usage:
 *   node backend/utils/sync-tosend-from-sheet.js [--delete]
 * 
 * Environment variables:
 *   GOOGLE_SHEET_URL, APP_SERVER_TOKEN or GOOGLE_SHEET_APP_SERVER_TOKEN
 *   LOGS_DB_HOST, LOGS_DB_PORT, LOGS_DB_USER, LOGS_DB_PASSWORD, LOGS_DB_NAME
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

const { createDatabasePool } = require('../config/db');
const { ToSendQueueService } = require('../dist/services/tosend-queue.service');
const { createSheetIntegrationServiceFromEnv } = require('../dist/services');

async function normalizeSheetPhone(value) {
    const text = String(value || '').trim();
    if (text.charAt(0) === "'") return text.substring(1);
    if (!text) return '';
    if (/^\d+$/.test(text) && text.charAt(0) !== '0') {
        return '0' + text;
    }
    return text;
}

async function syncFromGoogleSheet() {
    const pool = createDatabasePool();
    
    try {
        const sheetService = createSheetIntegrationServiceFromEnv(process.env);
        const toSendService = new ToSendQueueService(pool);
        
        console.log('[SYNC] Ensuring ToSendQueue table exists...');
        await toSendService.ensureTableExists();
        
        console.log('[SYNC] Fetching messages from Google Sheet...');
        const token = String(
            process.env.APP_SERVER_TOKEN ||
            process.env.GOOGLE_SHEET_APP_SERVER_TOKEN ||
            process.env.CHECK_QUEUE_SERVER_TOKEN ||
            ''
        ).trim();
        
        const url = sheetService.buildGoogleSheetGetUrl(
            { action: 'check_queue' },
            { token }
        );
        
        const response = await fetch(url);
        const data = await response.json();
        const messages = Array.isArray(data && data.messages) ? data.messages : [];
        
        if (messages.length === 0) {
            console.log('[SYNC] No messages found in Google Sheet ToSend queue.');
            console.log('[SYNC] Migration completed successfully!');
            return;
        }
        
        console.log(`[SYNC] Found ${messages.length} messages in Google Sheet.`);
        
        // Format messages for database
        const formattedMessages = messages
            .filter(msg => msg && msg.recipient && msg.message_content)
            .map(msg => ({
                recipient: normalizeSheetPhone(msg.recipient),
                sender: String(msg.sender || 'System').trim(),
                message_content: String(msg.message_content).trim()
            }))
            .filter(msg => msg.recipient && msg.message_content);
        
        if (formattedMessages.length === 0) {
            console.log('[SYNC] No valid messages after filtering.');
            console.log('[SYNC] Migration completed successfully!');
            return;
        }
        
        console.log(`[SYNC] Adding ${formattedMessages.length} messages to MySQL database...`);
        const count = await toSendService.addMessages(formattedMessages);
        console.log(`[SYNC] Successfully added ${count} messages to database.`);
        
        // Delete from sheet after successful sync
        if (process.argv.includes('--delete')) {
            console.log('[SYNC] Deleting messages from Google Sheet (not implemented in this script)');
            console.log('[SYNC] Note: Messages were already deleted by the check_queue call');
        }
        
        console.log('[SYNC] Migration completed successfully!');
        
    } catch (error) {
        console.error('[SYNC] Error during migration:', error.message);
        if (error.stack) {
            console.error(error.stack);
        }
        process.exit(1);
    } finally {
        await pool.end();
        process.exit(0);
    }
}

// Add fetch polyfill if needed
const fetch = (() => {
    if (typeof globalThis.fetch === 'function') {
        return globalThis.fetch;
    }
    return require('node-fetch');
})();

syncFromGoogleSheet();
