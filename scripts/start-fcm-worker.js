#!/usr/bin/env node

/**
 * FCM Worker Startup Script
 * 
 * Runs the FCM notification worker in a separate process.
 * This worker consumes from the BullMQ 'fcm-notifications' queue
 * and delivers Firebase Cloud Messaging notifications.
 * 
 * Usage:
 *   node scripts/start-fcm-worker.js
 * 
 * Environment Variables:
 *   - MYSQL_HOST, MYSQL_PORT, MYSQL_USER, MYSQL_PASSWORD, MYSQL_DATABASE
 *   - REDIS_HOST, REDIS_PORT, REDIS_PASSWORD
 *   - FCM_WORKER_CONCURRENCY (default: 5)
 *   - FIREBASE_SERVICE_ACCOUNT_JSON
 */

require('dotenv').config();

const redis = require('redis');
const firebaseAdmin = require('firebase-admin');
const { createDatabasePool } = require('../backend/config/db');
const { createFcmWorker } = require('../backend/workers/fcm.worker');
const { createRedisStreamsManager } = require('../backend/services/redis-streams');

/**
 * Initialize Firebase Admin SDK
 */
function initializeFirebase() {
    const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    
    if (!serviceAccountJson) {
        console.error('[FCM Worker] FIREBASE_SERVICE_ACCOUNT_JSON not set');
        process.exit(1);
    }

    try {
        const serviceAccount = JSON.parse(serviceAccountJson);
        const app = firebaseAdmin.initializeApp({
            credential: firebaseAdmin.credential.cert(serviceAccount)
        });
        console.log('[FCM Worker] Firebase initialized');
        return app;
    } catch (error) {
        console.error('[FCM Worker] Firebase initialization failed:', error.message);
        process.exit(1);
    }
}

/**
 * Initialize Redis client
 */
function initializeRedis() {
    const redisHost = process.env.REDIS_HOST || 'localhost';
    const redisPort = parseInt(process.env.REDIS_PORT || '6379');
    const redisPassword = process.env.REDIS_PASSWORD;

    const client = redis.createClient({
        host: redisHost,
        port: redisPort,
        password: redisPassword,
        retryStrategy: (times) => {
            const delay = Math.min(times * 50, 2000);
            return delay;
        }
    });

    client.on('error', (err) => {
        console.error('[FCM Worker] Redis error:', err.message);
    });

    client.on('connect', () => {
        console.log('[FCM Worker] Redis connected');
    });

    return client;
}

/**
 * Start the FCM worker
 */
async function startWorker() {
    console.log('[FCM Worker] Starting...');
    console.log('[FCM Worker] PID:', process.pid);
    console.log('[FCM Worker] Environment:');
    console.log('  - REDIS_HOST:', process.env.REDIS_HOST || 'localhost');
    console.log('  - MYSQL_HOST:', process.env.MYSQL_HOST || 'localhost');
    console.log('  - FCM_WORKER_CONCURRENCY:', process.env.FCM_WORKER_CONCURRENCY || '5');

    try {
        // Initialize connections
        const redisClient = initializeRedis();
        const dbPool = createDatabasePool();
        const firebaseApp = initializeFirebase();
        const redisStreams = createRedisStreamsManager(redisClient);

        // Wait for Redis connection
        await new Promise((resolve, reject) => {
            redisClient.on('ready', resolve);
            redisClient.on('error', reject);
            setTimeout(() => reject(new Error('Redis connection timeout')), 10000);
        });

        // Initialize Redis Streams
        await redisStreams.initializeConsumerGroup();

        // Create and start FCM worker
        const fcmWorker = createFcmWorker({
            redis: redisClient,
            redisStreams,
            dbPool,
            firebaseApp,
            concurrency: parseInt(process.env.FCM_WORKER_CONCURRENCY || '5')
        });

        console.log('[FCM Worker] ✓ Ready to process jobs');

        // Handle graceful shutdown
        process.on('SIGINT', async () => {
            console.log('[FCM Worker] Received SIGINT, shutting down...');
            try {
                await fcmWorker.close();
                await redisClient.quit();
                await dbPool.end();
                console.log('[FCM Worker] Shutdown complete');
                process.exit(0);
            } catch (error) {
                console.error('[FCM Worker] Shutdown error:', error.message);
                process.exit(1);
            }
        });

        process.on('SIGTERM', async () => {
            console.log('[FCM Worker] Received SIGTERM, shutting down...');
            try {
                await fcmWorker.close();
                await redisClient.quit();
                await dbPool.end();
                console.log('[FCM Worker] Shutdown complete');
                process.exit(0);
            } catch (error) {
                console.error('[FCM Worker] Shutdown error:', error.message);
                process.exit(1);
            }
        });

        // Log periodic stats
        setInterval(async () => {
            try {
                const queue = fcmWorker.queue || { name: 'fcm-notifications' };
                // Optionally log stats here
                console.log(`[FCM Worker] Uptime: ${Math.floor(process.uptime())}s`);
            } catch (error) {
                console.warn('[FCM Worker] Stats error:', error.message);
            }
        }, 60000); // Every minute

    } catch (error) {
        console.error('[FCM Worker] Startup failed:', error.message);
        process.exit(1);
    }
}

// Start worker
startWorker().catch((error) => {
    console.error('[FCM Worker] Fatal error:', error.message);
    process.exit(1);
});
