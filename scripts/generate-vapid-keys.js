#!/usr/bin/env node
'use strict';

// This script intentionally prints VAPID keys to stdout so the user can
// copy them into their .env file. The output is only shown in the terminal
// and is never stored or transmitted by this script.
const webpush = require('web-push');

const vapidKeys = webpush.generateVAPIDKeys();

console.log('Add the following to your .env file:\n');
// lgtm[js/clear-text-logging]
console.log(`VAPID_PUBLIC_KEY=${vapidKeys.publicKey}`);
// lgtm[js/clear-text-logging]
console.log(`VAPID_PRIVATE_KEY=${vapidKeys.privateKey}`);
