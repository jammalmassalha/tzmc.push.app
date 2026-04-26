#!/usr/bin/env node
/* eslint-disable no-console */
//
// scripts/test-fcm-send.js
// ------------------------------------------------------------------
// Standalone tester that sends a Firebase Cloud Messaging (FCM)
// notification to every Flutter token registered for a given user
// (the username/phone number you store on the Google Sheet, e.g. the
// value the Flutter app logs in with). Use this to verify that:
//
//   1. The firebase-admin service account JSON on the server is valid
//      and accepted by Google.
//   2. The Flutter app has actually registered an FCM token for the
//      target user via /flutter/register-fcm.
//   3. The device receives the test notification.
//
// USAGE
//   # default: looks for tzmc-notifications-firebase-adminsdk-fbsvc-bb92594301.json
//   #         next to server.js, and reads data/flutter-fcm-tokens.json
//   node scripts/test-fcm-send.js <username>
//
//   # with explicit options
//   node scripts/test-fcm-send.js 0501234567 \
//       --title="בדיקת התראה" \
//       --body="זו התראת בדיקה מהשרת" \
//       --cred=/full/path/to/serviceAccount.json \
//       --tokens=/full/path/to/flutter-fcm-tokens.json
//
//   # send to a specific raw token (skips the registry lookup)
//   node scripts/test-fcm-send.js --token=<fcm-token-string>
//
// EXIT CODES
//   0  all sends succeeded
//   1  argument / file / credential error
//   2  some or all sends failed (per-token errors are printed)
// ------------------------------------------------------------------

const fs = require('fs');
const path = require('path');

const DEFAULT_CRED_FILENAME =
    'tzmc-notifications-firebase-adminsdk-fbsvc-bb92594301.json';

function parseArgs(argv) {
    const out = { _: [] };
    for (const arg of argv.slice(2)) {
        const m = /^--([^=]+)=(.*)$/.exec(arg);
        if (m) {
            out[m[1]] = m[2];
        } else if (arg.startsWith('--')) {
            out[arg.slice(2)] = true;
        } else {
            out._.push(arg);
        }
    }
    return out;
}

function die(code, message) {
    console.error(`ERROR: ${message}`);
    process.exit(code);
}

function resolveCredentialPath(args) {
    const explicit =
        args.cred ||
        process.env.FIREBASE_CREDENTIAL_FILE ||
        process.env.GOOGLE_APPLICATION_CREDENTIALS;
    if (explicit) return path.resolve(explicit);
    // default: alongside server.js (project root)
    return path.resolve(__dirname, '..', DEFAULT_CRED_FILENAME);
}

function loadServiceAccount(credPath) {
    if (!fs.existsSync(credPath)) {
        die(
            1,
            `Service-account JSON not found at ${credPath}\n` +
                `       Pass --cred=/path/to/file.json or set FIREBASE_CREDENTIAL_FILE.`
        );
    }
    let text;
    try {
        text = fs.readFileSync(credPath, 'utf8');
    } catch (err) {
        die(1, `Cannot read ${credPath}: ${err.message}`);
    }
    try {
        return JSON.parse(text);
    } catch (err) {
        die(1, `${credPath} is not valid JSON: ${err.message}`);
    }
    return null; // unreachable
}

function resolveTokensPath(args) {
    if (args.tokens) return path.resolve(args.tokens);
    return path.resolve(__dirname, '..', 'data', 'flutter-fcm-tokens.json');
}

function loadTokensForUser(tokensPath, username) {
    if (!fs.existsSync(tokensPath)) {
        die(
            1,
            `FCM token registry not found at ${tokensPath}\n` +
                `       (the file is created the first time the Flutter app calls /flutter/register-fcm).`
        );
    }
    let parsed;
    try {
        parsed = JSON.parse(fs.readFileSync(tokensPath, 'utf8'));
    } catch (err) {
        die(1, `${tokensPath} is not valid JSON: ${err.message}`);
    }
    const users = (parsed && parsed.users) || {};
    const key = String(username || '').trim().toLowerCase();
    const entries = users[key];
    if (!Array.isArray(entries) || entries.length === 0) {
        const known = Object.keys(users);
        die(
            1,
            `No FCM tokens registered for user "${username}".\n` +
                `       Known users in registry: ${
                    known.length ? known.join(', ') : '(none)'
                }`
        );
    }
    return entries;
}

async function main() {
    const args = parseArgs(process.argv);
    const title = args.title || 'בדיקת התראה';
    const body =
        args.body || `התראת בדיקה מהשרת — ${new Date().toLocaleString('he-IL')}`;

    const credPath = resolveCredentialPath(args);
    const serviceAccount = loadServiceAccount(credPath);

    let recipients;
    if (args.token && typeof args.token === 'string') {
        recipients = [
            { token: args.token, platform: 'unknown', username: '(explicit-token)' }
        ];
    } else {
        const username = args._[0];
        if (!username) {
            die(
                1,
                'Missing <username> argument.\n' +
                    'Usage: node scripts/test-fcm-send.js <username> ' +
                    '[--title=..] [--body=..] [--cred=..] [--tokens=..] [--token=..]'
            );
        }
        const tokensPath = resolveTokensPath(args);
        recipients = loadTokensForUser(tokensPath, username);
    }

    let admin;
    try {
        // eslint-disable-next-line global-require
        admin = require('firebase-admin');
    } catch (err) {
        die(
            1,
            `firebase-admin is not installed. Run \`npm install firebase-admin\` first. (${err.message})`
        );
    }

    try {
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount)
        });
    } catch (err) {
        // initializeApp throws if it has already been initialized in this process
        if (!/already exists/i.test(String(err && err.message))) {
            die(1, `firebase-admin init failed: ${err.message}`);
        }
    }

    console.log('--- FCM Test Send ----------------------------------------');
    console.log(`Credential file : ${credPath}`);
    console.log(`Project ID      : ${serviceAccount.project_id}`);
    console.log(`Client email    : ${serviceAccount.client_email}`);
    console.log(`Recipients      : ${recipients.length} token(s)`);
    console.log(`Title / Body    : ${title} / ${body}`);
    console.log('----------------------------------------------------------');

    let ok = 0;
    let bad = 0;
    for (const r of recipients) {
        const tokenPreview = `${r.token.slice(0, 12)}…${r.token.slice(-6)}`;
        const message = {
            token: r.token,
            notification: { title, body },
            data: {
                source: 'test-fcm-send.js',
                sentAt: new Date().toISOString()
            },
            android: {
                priority: 'high',
                notification: { channelId: 'high_importance_channel' }
            },
            apns: {
                payload: { aps: { sound: 'default' } }
            }
        };
        try {
            const id = await admin.messaging().send(message);
            ok += 1;
            console.log(
                `  ✓ user=${r.username} platform=${r.platform} token=${tokenPreview} → ${id}`
            );
        } catch (err) {
            bad += 1;
            const code = (err && err.errorInfo && err.errorInfo.code) || err.code || 'unknown';
            console.log(
                `  ✗ user=${r.username} platform=${r.platform} token=${tokenPreview} → ${code}: ${
                    err.message
                }`
            );
        }
    }

    console.log('----------------------------------------------------------');
    console.log(`Done. delivered=${ok} failed=${bad}`);
    process.exit(bad === 0 ? 0 : 2);
}

main().catch((err) => {
    console.error('FATAL:', err && err.stack ? err.stack : err);
    process.exit(1);
});
