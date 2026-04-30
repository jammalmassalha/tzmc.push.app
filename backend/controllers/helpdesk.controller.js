const mysql = require('mysql2/promise');

function toTrimmedString(value) {
    return String(value === null || value === undefined ? '' : value).trim();
}

function toPositiveInteger(value, fallbackValue) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) return fallbackValue;
    return Math.floor(parsed);
}

const VALID_DEPARTMENTS = ['מערכות מידע', 'אחזקה'];
const VALID_STATUSES = ['open', 'in_progress', 'resolved', 'closed'];
const VALID_ROLES = ['Admin', 'Editor'];
const ONGOING_STATUSES = new Set(['open', 'in_progress']);

// Simple rate limiting store (per-user, in-memory)
const helpdeskRateLimitStore = new Map();

function consumeHelpdeskRateLimit(user, maxAttempts, windowMs) {
    const now = Date.now();
    const key = toTrimmedString(user).toLowerCase();
    if (!key) return { allowed: true };

    const existing = Array.isArray(helpdeskRateLimitStore.get(key)) ? helpdeskRateLimitStore.get(key) : [];
    const threshold = now - windowMs;
    const recent = existing.filter((ts) => Number.isFinite(ts) && ts > threshold);

    if (recent.length >= maxAttempts) {
        helpdeskRateLimitStore.set(key, recent);
        return { allowed: false };
    }

    recent.push(now);
    helpdeskRateLimitStore.set(key, recent);
    return { allowed: true };
}

function createHelpdeskPool(env = {}) {
    return mysql.createPool({
        host: toTrimmedString(env.LOGS_DB_HOST || env.MYSQL_HOST || env.DB_HOST || '127.0.0.1'),
        port: toPositiveInteger(env.LOGS_DB_PORT || env.MYSQL_PORT || env.DB_PORT, 3306),
        user: toTrimmedString(env.LOGS_DB_USER || env.MYSQL_USER || env.DB_USER || 'jmassalh_subscribes'),
        password: toTrimmedString(env.LOGS_DB_PASSWORD || env.MYSQL_PASSWORD || env.DB_PASSWORD || 'jmassalh_subscribes!!@@!!'),
        database: toTrimmedString(env.LOGS_DB_NAME || env.MYSQL_DATABASE || env.DB_NAME || 'jmassalh_subscribes'),
        connectionLimit: 5,
        charset: 'utf8mb4'
    });
}

async function ensureHelpdeskTables(pool) {
    // Each CREATE TABLE is wrapped in its own try/catch so that a failure in
    // one table (e.g. a FK constraint issue on a first-time install) does not
    // prevent the remaining tables from being created.  MySQL error 1050
    // (ER_TABLE_EXISTS_ERROR) is silently ignored because CREATE TABLE IF NOT
    // EXISTS normally suppresses it, but some MySQL-compatible servers return
    // it anyway.
    async function safeCreateTable(sql, label) {
        try {
            await pool.execute(sql);
        } catch (err) {
            if (err && err.errno === 1050) return; // table already exists — ignore
            console.error(`[HELPDESK] Failed to create table ${label}:`, err && err.message ? err.message : err);
        }
    }

    await safeCreateTable(`
        CREATE TABLE IF NOT EXISTS \`helpdesk_tickets\` (
            \`id\` INT UNSIGNED NOT NULL AUTO_INCREMENT,
            \`creator_username\` VARCHAR(64) NOT NULL,
            \`department\` VARCHAR(64) NOT NULL,
            \`title\` VARCHAR(255) NOT NULL,
            \`description\` TEXT NOT NULL,
            \`location\` VARCHAR(255) NULL DEFAULT NULL,
            \`phone\` VARCHAR(32) NULL DEFAULT NULL,
            \`attachment_url\` VARCHAR(512) NULL DEFAULT NULL,
            \`status\` VARCHAR(32) NOT NULL DEFAULT 'open',
            \`handler_username\` VARCHAR(64) NULL DEFAULT NULL,
            \`created_at\` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            \`updated_at\` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            PRIMARY KEY (\`id\`),
            INDEX \`idx_creator\` (\`creator_username\`),
            INDEX \`idx_status\` (\`status\`),
            INDEX \`idx_department\` (\`department\`),
            INDEX \`idx_location\` (\`location\`)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `, 'helpdesk_tickets');

    // Migration: add location column to existing helpdesk_tickets tables
    try {
        await pool.execute(`ALTER TABLE \`helpdesk_tickets\` ADD COLUMN \`location\` VARCHAR(255) NULL DEFAULT NULL AFTER \`description\``);
    } catch (err) {
        // ER_DUP_FIELDNAME (1060) — column already exists, safe to ignore
        if (!(err && err.errno === 1060)) {
            console.error('[HELPDESK] Migration location column error:', err && err.message ? err.message : err);
        }
    }

    // Migration: add location index
    try {
        await pool.execute(`ALTER TABLE \`helpdesk_tickets\` ADD INDEX \`idx_location\` (\`location\`)`);
    } catch (err) {
        // ER_DUP_KEYNAME (1061) — index already exists, safe to ignore
        if (!(err && err.errno === 1061)) {
            console.error('[HELPDESK] Migration location index error:', err && err.message ? err.message : err);
        }
    }

    // Migration: add phone column to existing helpdesk_tickets tables
    try {
        await pool.execute(`ALTER TABLE \`helpdesk_tickets\` ADD COLUMN \`phone\` VARCHAR(32) NULL DEFAULT NULL AFTER \`location\``);
    } catch (err) {
        // ER_DUP_FIELDNAME (1060) — column already exists, safe to ignore
        if (!(err && err.errno === 1060)) {
            console.error('[HELPDESK] Migration phone column error:', err && err.message ? err.message : err);
        }
    }

    // Migration: add attachment_url column to existing helpdesk_tickets tables
    try {
        await pool.execute(`ALTER TABLE \`helpdesk_tickets\` ADD COLUMN \`attachment_url\` VARCHAR(512) NULL DEFAULT NULL AFTER \`phone\``);
    } catch (err) {
        // ER_DUP_FIELDNAME (1060) — column already exists, safe to ignore
        if (!(err && err.errno === 1060)) {
            console.error('[HELPDESK] Migration ticket attachment_url column error:', err && err.message ? err.message : err);
        }
    }

    await safeCreateTable(`
        CREATE TABLE IF NOT EXISTS \`helpdesk_notes\` (
            \`id\` INT UNSIGNED NOT NULL AUTO_INCREMENT,
            \`ticket_id\` INT UNSIGNED NOT NULL,
            \`author_username\` VARCHAR(64) NOT NULL,
            \`note_text\` TEXT NOT NULL,
            \`attachment_url\` VARCHAR(512) NULL DEFAULT NULL,
            \`created_at\` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (\`id\`),
            INDEX \`idx_ticket\` (\`ticket_id\`),
            CONSTRAINT \`fk_helpdesk_notes_ticket\`
                FOREIGN KEY (\`ticket_id\`) REFERENCES \`helpdesk_tickets\` (\`id\`) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `, 'helpdesk_notes');

    // Migration: add attachment_url column to existing helpdesk_notes tables
    try {
        await pool.execute(`ALTER TABLE \`helpdesk_notes\` ADD COLUMN \`attachment_url\` VARCHAR(512) NULL DEFAULT NULL AFTER \`note_text\``);
    } catch (err) {
        // ER_DUP_FIELDNAME (1060) — column already exists, safe to ignore
        if (!(err && err.errno === 1060)) {
            console.error('[HELPDESK] Migration attachment_url column error:', err && err.message ? err.message : err);
        }
    }

    await safeCreateTable(`
        CREATE TABLE IF NOT EXISTS \`helpdesk_users\` (
            \`id\` INT UNSIGNED NOT NULL AUTO_INCREMENT,
            \`username\` VARCHAR(64) NOT NULL,
            \`role\` VARCHAR(16) NOT NULL DEFAULT 'Editor',
            \`department\` VARCHAR(64) NOT NULL,
            \`created_at\` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (\`id\`),
            UNIQUE INDEX \`idx_username\` (\`username\`),
            INDEX \`idx_department\` (\`department\`),
            INDEX \`idx_role\` (\`role\`)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `, 'helpdesk_users');

    await safeCreateTable(`
        CREATE TABLE IF NOT EXISTS \`helpdesk_status_history\` (
            \`id\` INT UNSIGNED NOT NULL AUTO_INCREMENT,
            \`ticket_id\` INT UNSIGNED NOT NULL,
            \`old_status\` VARCHAR(32) NULL DEFAULT NULL,
            \`new_status\` VARCHAR(32) NOT NULL,
            \`changed_by\` VARCHAR(64) NOT NULL,
            \`created_at\` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (\`id\`),
            INDEX \`idx_ticket\` (\`ticket_id\`),
            CONSTRAINT \`fk_helpdesk_status_history_ticket\`
                FOREIGN KEY (\`ticket_id\`) REFERENCES \`helpdesk_tickets\` (\`id\`) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `, 'helpdesk_status_history');

    await safeCreateTable(`
        CREATE TABLE IF NOT EXISTS \`helpdesk_handler_history\` (
            \`id\` INT UNSIGNED NOT NULL AUTO_INCREMENT,
            \`ticket_id\` INT UNSIGNED NOT NULL,
            \`old_handler\` VARCHAR(64) NULL DEFAULT NULL,
            \`new_handler\` VARCHAR(64) NULL DEFAULT NULL,
            \`changed_by\` VARCHAR(64) NOT NULL,
            \`created_at\` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (\`id\`),
            INDEX \`idx_ticket\` (\`ticket_id\`),
            CONSTRAINT \`fk_helpdesk_handler_history_ticket\`
                FOREIGN KEY (\`ticket_id\`) REFERENCES \`helpdesk_tickets\` (\`id\`) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `, 'helpdesk_handler_history');
}

function mapTicketRow(row) {
    return {
        id: row.id,
        creatorUsername: row.creator_username,
        department: row.department,
        title: row.title,
        description: row.description,
        location: row.location || null,
        phone: row.phone || null,
        attachmentUrl: row.attachment_url || null,
        status: row.status,
        handlerUsername: row.handler_username || null,
        createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at || ''),
        updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at || '')
    };
}

async function getHelpdeskUserRole(pool, username) {
    if (!username) return null;
    try {
        const [rows] = await pool.query(
            'SELECT `username`, `role`, `department` FROM `helpdesk_users` WHERE `username` = ? LIMIT 1',
            [username]
        );
        if (!rows.length) return null;
        return { username: rows[0].username, role: rows[0].role, department: rows[0].department };
    } catch (err) {
        // ER_NO_SUCH_TABLE (1146) — table doesn't exist yet, treat as no role.
        if (err && err.errno === 1146) return null;
        throw err;
    }
}

function registerHelpdeskController(app, deps = {}) {
    const { requireAuthorizedUser, env = {}, buildGoogleSheetGetUrl, fetchWithRetry, sendPushNotificationToUser, notifyRealtimeClients } = deps;

    const pool = createHelpdeskPool(env);

    // Store the table-initialization promise so every endpoint handler can await
    // it before running queries.  This eliminates the startup race (request
    // arriving before tables exist) and enables automatic retry when the first
    // attempt failed (e.g. DB temporarily unreachable at process start).
    let _tablesReady = ensureHelpdeskTables(pool);
    _tablesReady.catch((error) => {
        console.error('[HELPDESK] Failed to ensure tables:', error && error.message ? error.message : error);
        // Reset so the next endpoint call triggers a fresh attempt.
        _tablesReady = null;
    });

    // Returns a promise that resolves once all helpdesk tables exist.
    // If the previous attempt failed, a new attempt is started automatically.
    function getTablesReady() {
        if (!_tablesReady) {
            _tablesReady = ensureHelpdeskTables(pool);
            _tablesReady.catch((err) => {
                console.error('[HELPDESK] Retry to ensure tables failed:', err && err.message ? err.message : err);
                _tablesReady = null;
            });
        }
        return _tablesReady;
    }

    const requireUser = typeof requireAuthorizedUser === 'function'
        ? requireAuthorizedUser({
            required: true,
            candidateKeys: ['user'],
            onError: (_req, res, resolution) =>
                res.status(resolution.status || 401).json({
                    result: 'error',
                    message: resolution.error || 'Authentication required'
                })
        })
        : (_req, _res, next) => next();

    // Per-user-per-endpoint rate limiting middleware factory.
    // The key combines the user identity with the normalised route path so that
    // each endpoint maintains its own independent quota.  Previously the key was
    // user-only, which meant that GET poll-timer requests (30 req/min limit)
    // accumulated timestamps that were then counted against the stricter PUT
    // status-update endpoint (10 req/min limit), causing spurious 429 errors.
    function helpdeskRateLimit(maxAttempts, windowMs) {
        return function (req, res, next) {
            const user = toTrimmedString(req.resolvedUser || req.body && req.body.user || '');
            const routeKey = toTrimmedString(req.route && req.route.path || req.path || '');
            const limitKey = user ? `${user}:${routeKey}` : '';
            if (!consumeHelpdeskRateLimit(limitKey, maxAttempts, windowMs).allowed) {
                return res.status(429).json({ result: 'error', message: 'יותר מדי בקשות. נסה שוב בעוד דקה.' });
            }
            return next();
        };
    }

    // GET /helpdesk/locations - Fetch locations from Google Sheet (HelpDeskLocation sheet, column A)
    app.get(['/helpdesk/locations', '/notify/helpdesk/locations'], requireUser, helpdeskRateLimit(30, 60 * 1000), async (req, res) => {
        if (typeof buildGoogleSheetGetUrl !== 'function' || typeof fetchWithRetry !== 'function') {
            console.error('[HELPDESK] Missing buildGoogleSheetGetUrl or fetchWithRetry dependency');
            return res.status(500).json({ result: 'error', message: 'שגיאה בטעינת המיקומים' });
        }
        try {
            const url = buildGoogleSheetGetUrl({ action: 'get_helpdesk_locations' });
            const response = await fetchWithRetry(url, {}, { timeoutMs: 10000, retries: 1, backoffMs: 500 });
            if (!response.ok) {
                console.error('[HELPDESK] Failed to fetch locations from sheet, status:', response.status);
                return res.status(502).json({ result: 'error', message: 'שגיאה בטעינת המיקומים מהגיליון' });
            }
            const payload = await response.json();
            // Expect { result: 'success', locations: string[] }
            const locations = Array.isArray(payload && payload.locations)
                ? payload.locations.map(loc => toTrimmedString(loc)).filter(Boolean)
                : [];
            return res.json({ result: 'success', locations });
        } catch (error) {
            const message = error && error.message ? error.message : 'Failed to fetch locations';
            console.error('[HELPDESK] Fetch locations error:', message);
            return res.status(500).json({ result: 'error', message: 'שגיאה בטעינת המיקומים' });
        }
    });

    // POST /helpdesk/tickets - Create a new ticket
    app.post(['/helpdesk/tickets', '/notify/helpdesk/tickets'], requireUser, helpdeskRateLimit(10, 60 * 1000), async (req, res) => {
        const user = toTrimmedString(req.resolvedUser || '');
        if (!user) {
            return res.status(401).json({ result: 'error', message: 'Authentication required' });
        }
        const body = req.body && typeof req.body === 'object' ? req.body : {};
        const department = toTrimmedString(body.department || '');
        const title = toTrimmedString(body.title || '');
        const description = toTrimmedString(body.description || '');
        const location = toTrimmedString(body.location || '') || null;
        const phone = toTrimmedString(body.phone || '') || null;
        const attachmentUrl = toTrimmedString(body.attachmentUrl || '') || null;

        if (!VALID_DEPARTMENTS.includes(department)) {
            return res.status(400).json({ result: 'error', message: 'מחלקה לא תקינה' });
        }
        if (!title) {
            return res.status(400).json({ result: 'error', message: 'יש להזין כותרת לקריאה' });
        }
        if (!description) {
            return res.status(400).json({ result: 'error', message: 'יש להזין תיאור לקריאה' });
        }
        if (!location) {
            return res.status(400).json({ result: 'error', message: 'יש לבחור מיקום' });
        }

        try {
            await getTablesReady();
            const [result] = await pool.execute(
                'INSERT INTO `helpdesk_tickets` (`creator_username`, `department`, `title`, `description`, `location`, `phone`, `attachment_url`, `status`) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
                [user, department, title, description, location, phone, attachmentUrl, 'open']
            );
            const insertId = result.insertId;
            // Record initial "open" status in history.  Awaited so the entry is
            // guaranteed to exist before the response is sent, even if this is the
            // only way the ticket gets a history entry (e.g. status is never changed).
            try {
                await pool.execute(
                    'INSERT INTO `helpdesk_status_history` (`ticket_id`, `old_status`, `new_status`, `changed_by`) VALUES (?, NULL, ?, ?)',
                    [insertId, 'open', user]
                );
            } catch (histErr) {
                console.error('[HELPDESK] Insert status history error:', histErr && histErr.message ? histErr.message : histErr);
            }
            const [rows] = await pool.query(
                'SELECT * FROM `helpdesk_tickets` WHERE `id` = ?',
                [insertId]
            );
            const ticket = rows[0] ? mapTicketRow(rows[0]) : null;

            // Send confirmation message to creator under 'מוקד איחוד' chat
            if (typeof sendPushNotificationToUser === 'function') {
                const ticketMsgText = `Ticket #${insertId} - ${title}`;
                void sendPushNotificationToUser(user, {
                    title: 'מוקד איחוד',
                    body: { shortText: ticketMsgText, longText: ticketMsgText },
                    data: { type: 'helpdesk_ticket', ticketId: String(insertId), messageText: ticketMsgText }
                }, 'מוקד איחוד', {
                    messageId: `helpdesk-ticket-${insertId}`,
                    skipBadge: false,
                    singlePerUser: true,
                    allowSecondAttempt: false
                }).catch((err) => {
                    console.warn('[HELPDESK] Ticket creation push failed:', err && err.message ? err.message : err);
                });
            }

            return res.status(201).json({ result: 'success', ticket });
        } catch (error) {
            const message = error && error.message ? error.message : 'Failed to create ticket';
            console.error('[HELPDESK] Create ticket error:', message);
            return res.status(500).json({ result: 'error', message: 'שגיאה ביצירת הקריאה' });
        }
    });

    // GET /helpdesk/tickets/user - Get current user's tickets + role context
    app.get(['/helpdesk/tickets/user', '/notify/helpdesk/tickets/user'], requireUser, helpdeskRateLimit(30, 60 * 1000), async (req, res) => {
        const user = toTrimmedString(req.resolvedUser || '');
        if (!user) {
            return res.status(401).json({ result: 'error', message: 'Authentication required' });
        }
        try {
            await getTablesReady();
            const [roleInfo, ticketRows, assignedRows] = await Promise.all([
                getHelpdeskUserRole(pool, user),
                pool.query(
                    'SELECT * FROM `helpdesk_tickets` WHERE `creator_username` = ? ORDER BY `created_at` DESC LIMIT 100',
                    [user]
                ),
                pool.query(
                    'SELECT * FROM `helpdesk_tickets` WHERE `handler_username` = ? AND `status` != ? ORDER BY `created_at` DESC LIMIT 100',
                    [user, 'closed']
                )
            ]);

            const myTickets = ticketRows[0].map(mapTicketRow);
            const ongoing = myTickets.filter((t) => ONGOING_STATUSES.has(t.status));
            const past = myTickets.filter((t) => !ONGOING_STATUSES.has(t.status));
            const assigned = assignedRows[0].map(mapTicketRow);

            const myRole = roleInfo ? { role: roleInfo.role, department: roleInfo.department } : null;

            // If user is an Editor or Admin, also fetch their department's tickets and available handlers
            let editorTickets = null;
            let handlers = null;
            if (roleInfo) {
                const [editorTicketRows, handlerRows] = await Promise.all([
                    pool.query(
                        'SELECT * FROM `helpdesk_tickets` WHERE `department` = ? ORDER BY `created_at` DESC LIMIT 200',
                        [roleInfo.department]
                    ),
                    pool.query(
                        'SELECT `username`, `role`, `department` FROM `helpdesk_users` WHERE `department` = ? ORDER BY `username` ASC',
                        [roleInfo.department]
                    )
                ]);
                editorTickets = editorTicketRows[0].map(mapTicketRow);
                handlers = handlerRows[0].map((r) => ({ username: r.username, role: r.role, department: r.department }));
            }

            return res.json({ result: 'success', ongoing, past, assigned, myRole, editorTickets, handlers });
        } catch (error) {
            const message = error && error.message ? error.message : 'Failed to load tickets';
            console.error('[HELPDESK] Load user tickets error:', message);
            return res.status(500).json({ result: 'error', message: 'שגיאה בטעינת הקריאות' });
        }
    });

    // PUT/POST /helpdesk/tickets/:id/handler - Editor/Admin assigns a handler to a ticket
    // POST is accepted alongside PUT so that browser clients behind reverse proxies that
    // strip PUT from CORS preflight Allow-Methods responses can still reach this endpoint.
    async function assignHandlerHandler(req, res) {
        const user = toTrimmedString(req.resolvedUser || '');
        if (!user) {
            return res.status(401).json({ result: 'error', message: 'Authentication required' });
        }
        const ticketId = toPositiveInteger(req.params && req.params.id, 0);
        if (!ticketId) {
            return res.status(400).json({ result: 'error', message: 'מזהה קריאה לא תקין' });
        }
        const body = req.body && typeof req.body === 'object' ? req.body : {};
        // handler_username may be null to unassign
        const handlerUsername = body.handler_username === null ? null : toTrimmedString(body.handler_username || '');

        try {
            await getTablesReady();
            // Verify editor role for this user
            const editorRole = await getHelpdeskUserRole(pool, user);
            if (!editorRole) {
                return res.status(403).json({ result: 'error', message: 'אין הרשאת עורך' });
            }

            // Verify ticket exists and belongs to editor's department
            const [ticketRows] = await pool.query(
                'SELECT `id`, `title`, `department`, `handler_username` FROM `helpdesk_tickets` WHERE `id` = ?',
                [ticketId]
            );
            if (!ticketRows.length) {
                return res.status(404).json({ result: 'error', message: 'קריאה לא נמצאה' });
            }
            if (ticketRows[0].department !== editorRole.department) {
                return res.status(403).json({ result: 'error', message: 'אין הרשאה לקריאה ממחלקה אחרת' });
            }

            // If assigning a handler, verify handler is an Editor in the same department
            if (handlerUsername) {
                const handlerRole = await getHelpdeskUserRole(pool, handlerUsername);
                if (!handlerRole || handlerRole.department !== editorRole.department) {
                    return res.status(400).json({ result: 'error', message: 'המטפל חייב להיות עורך באותה מחלקה' });
                }
            }

            const oldHandler = ticketRows[0].handler_username || null;

            await pool.execute(
                'UPDATE `helpdesk_tickets` SET `handler_username` = ? WHERE `id` = ?',
                [handlerUsername || null, ticketId]
            );

            // Record handler change in history (fire-and-forget so it never blocks the response).
            pool.execute(
                'INSERT INTO `helpdesk_handler_history` (`ticket_id`, `old_handler`, `new_handler`, `changed_by`) VALUES (?, ?, ?, ?)',
                [ticketId, oldHandler, handlerUsername || null, user]
            ).catch((histErr) => {
                console.error('[HELPDESK] Insert handler history error:', histErr && histErr.message ? histErr.message : histErr);
            });

            // Fire-and-forget push notification to the newly assigned handler.
            // Only sent when a handler is being assigned (not unassigned) and only
            // when the handler is a different user from the assigning editor.
            if (handlerUsername && handlerUsername !== user && typeof sendPushNotificationToUser === 'function') {
                const ticketTitle = toTrimmedString(ticketRows[0].title || '');
                const assignMsgText = `שויכת לקריאה מספר #${ticketId} ${ticketTitle}`.trim();
                const notificationData = {
                    title: 'מוקד איחוד',
                    body: {
                        shortText: assignMsgText,
                        longText: assignMsgText
                    },
                    data: {
                        type: 'helpdesk_ticket',
                        ticketId: String(ticketId),
                        ticketTitle: ticketTitle,
                        messageText: assignMsgText
                    }
                };
                void sendPushNotificationToUser(handlerUsername, notificationData, 'מוקד איחוד', {
                    messageId: `helpdesk-handler-${ticketId}-${Date.now()}`,
                    skipBadge: false,
                    singlePerUser: true,
                    allowSecondAttempt: false
                }).catch((err) => {
                    console.warn('[HELPDESK] Push notification to handler failed:', err && err.message ? err.message : err);
                });
            }

            return res.json({ result: 'success' });
        } catch (error) {
            const message = error && error.message ? error.message : 'Failed to assign handler';
            console.error('[HELPDESK] Assign handler error:', message);
            return res.status(500).json({ result: 'error', message: 'שגיאה בשיוך מטפל' });
        }
    }
    app.put(['/helpdesk/tickets/:id/handler', '/notify/helpdesk/tickets/:id/handler'], requireUser, helpdeskRateLimit(20, 60 * 1000), assignHandlerHandler);
    app.post(['/helpdesk/tickets/:id/handler', '/notify/helpdesk/tickets/:id/handler'], requireUser, helpdeskRateLimit(20, 60 * 1000), assignHandlerHandler);

    // POST /helpdesk/tickets/:id/notes - Add a note to a ticket
    app.post(['/helpdesk/tickets/:id/notes', '/notify/helpdesk/tickets/:id/notes'], requireUser, helpdeskRateLimit(20, 60 * 1000), async (req, res) => {
        const user = toTrimmedString(req.resolvedUser || '');
        if (!user) {
            return res.status(401).json({ result: 'error', message: 'Authentication required' });
        }
        const ticketId = toPositiveInteger(req.params && req.params.id, 0);
        if (!ticketId) {
            return res.status(400).json({ result: 'error', message: 'מזהה קריאה לא תקין' });
        }
        const body = req.body && typeof req.body === 'object' ? req.body : {};
        const noteText = toTrimmedString(body.note_text || '');
        const attachmentUrl = toTrimmedString(body.attachment_url || '');
        if (!noteText && !attachmentUrl) {
            return res.status(400).json({ result: 'error', message: 'יש להזין טקסט הערה או לצרף קובץ' });
        }

        // Validate attachment_url if provided: must be a relative /notify/uploads/ path with safe characters
        if (attachmentUrl && !/^\/notify\/uploads\/[\w\-\.]+$/.test(attachmentUrl)) {
            return res.status(400).json({ result: 'error', message: 'כתובת קובץ לא תקינה' });
        }

        try {
            await getTablesReady();
            // Verify the ticket exists and the user is authorized (creator, handler, or Editor of same dept)
            const [ticketRows] = await pool.query(
                'SELECT `id`, `title`, `creator_username`, `handler_username`, `department` FROM `helpdesk_tickets` WHERE `id` = ?',
                [ticketId]
            );
            if (!ticketRows.length) {
                return res.status(404).json({ result: 'error', message: 'קריאה לא נמצאה' });
            }
            const ticket = ticketRows[0];
            const isDirectUser = ticket.creator_username === user || ticket.handler_username === user;
            let isAuthorized = isDirectUser;
            if (!isAuthorized) {
                const editorRole = await getHelpdeskUserRole(pool, user);
                isAuthorized = Boolean(editorRole && editorRole.department === ticket.department);
            }
            if (!isAuthorized) {
                return res.status(403).json({ result: 'error', message: 'אין הרשאה להוסיף הערה לקריאה זו' });
            }

            const [result] = await pool.execute(
                'INSERT INTO `helpdesk_notes` (`ticket_id`, `author_username`, `note_text`, `attachment_url`) VALUES (?, ?, ?, ?)',
                [ticketId, user, noteText, attachmentUrl || null]
            );
            const noteId = result.insertId;
            const [[noteRow]] = await pool.query(
                'SELECT `id`, `ticket_id`, `author_username`, `note_text`, `attachment_url`, `created_at` FROM `helpdesk_notes` WHERE `id` = ?',
                [noteId]
            );
            const note = noteRow ? {
                id: noteRow.id,
                ticketId: noteRow.ticket_id,
                authorUsername: noteRow.author_username,
                noteText: noteRow.note_text,
                attachmentUrl: noteRow.attachment_url || null,
                createdAt: noteRow.created_at instanceof Date ? noteRow.created_at.toISOString() : String(noteRow.created_at || '')
            } : { id: noteId, ticketId, authorUsername: user, noteText, attachmentUrl: attachmentUrl || null, createdAt: new Date().toISOString() };

            // ── Notify handler ──────────────────────────────────────────────────
            // When a note is added by someone other than the handler, deliver the
            // note to the handler via both FCM push and real-time SSE/socket so it
            // appears in the 'מוקד איחוד' tab without delay.
            const handlerUsername = ticket.handler_username;
            if (handlerUsername && handlerUsername !== user) {
                const ticketTitle = String(ticket.title || ticket.description || '').trim().substring(0, 80);
                const shortNote = noteText.substring(0, 200);
                const noteMsgText = `Ticket #${ticketId} - ${ticketTitle}: ${shortNote}`;
                const notificationData = {
                    messageId: `helpdesk-note-${noteId}`,
                    title: 'מוקד איחוד',
                    body: {
                        shortText: noteMsgText,
                        longText: noteMsgText
                    },
                    data: {
                        type: 'helpdesk_ticket',
                        ticketId: String(ticketId),
                        noteId: String(noteId),
                        noteText: shortNote,
                        messageText: noteMsgText
                    }
                };

                // FCM push (fire-and-forget)
                if (typeof sendPushNotificationToUser === 'function') {
                    void sendPushNotificationToUser(handlerUsername, notificationData, 'מוקד איחוד', {
                        messageId: `helpdesk-note-${noteId}`,
                        skipBadge: false,
                        singlePerUser: true,
                        allowSecondAttempt: false
                    }).catch((err) => {
                        console.warn('[HELPDESK] Note push to handler failed:', err && err.message ? err.message : err);
                    });
                }

                // Real-time SSE/socket delivery (fire-and-forget)
                if (typeof notifyRealtimeClients === 'function') {
                    try {
                        notifyRealtimeClients(handlerUsername, {
                            type: 'helpdesk',
                            ticketId: String(ticketId),
                            noteId: String(noteId),
                            noteText: shortNote,
                            title: notificationData.title,
                            timestamp: Date.now()
                        });
                    } catch (notifyErr) {
                        console.warn('[HELPDESK] notifyRealtimeClients error:', notifyErr && notifyErr.message ? notifyErr.message : notifyErr);
                    }
                }
            }

            return res.status(201).json({ result: 'success', noteId, note });
        } catch (error) {
            const message = error && error.message ? error.message : 'Failed to add note';
            console.error('[HELPDESK] Add note error:', message);
            return res.status(500).json({ result: 'error', message: 'שגיאה בהוספת ההערה' });
        }
    });

    // GET /helpdesk/tickets/:id/notes - Get notes for a ticket
    app.get(['/helpdesk/tickets/:id/notes', '/notify/helpdesk/tickets/:id/notes'], requireUser, helpdeskRateLimit(30, 60 * 1000), async (req, res) => {
        const user = toTrimmedString(req.resolvedUser || '');
        if (!user) {
            return res.status(401).json({ result: 'error', message: 'Authentication required' });
        }
        const ticketId = toPositiveInteger(req.params && req.params.id, 0);
        if (!ticketId) {
            return res.status(400).json({ result: 'error', message: 'מזהה קריאה לא תקין' });
        }

        try {
            await getTablesReady();
            // Verify the ticket exists and the user is authorized
            const [ticketRows] = await pool.query(
                'SELECT `id`, `creator_username`, `handler_username`, `department` FROM `helpdesk_tickets` WHERE `id` = ?',
                [ticketId]
            );
            if (!ticketRows.length) {
                return res.status(404).json({ result: 'error', message: 'קריאה לא נמצאה' });
            }
            const ticket = ticketRows[0];
            const isDirectUser = ticket.creator_username === user || ticket.handler_username === user;
            let isAuthorized = isDirectUser;
            if (!isAuthorized) {
                const editorRole = await getHelpdeskUserRole(pool, user);
                isAuthorized = Boolean(editorRole && editorRole.department === ticket.department);
            }
            if (!isAuthorized) {
                return res.status(403).json({ result: 'error', message: 'אין הרשאה לצפות בהערות קריאה זו' });
            }

            const [noteRows] = await pool.query(
                'SELECT `id`, `ticket_id`, `author_username`, `note_text`, `attachment_url`, `created_at` FROM `helpdesk_notes` WHERE `ticket_id` = ? ORDER BY `created_at` ASC',
                [ticketId]
            );
            const notes = noteRows.map((r) => ({
                id: r.id,
                ticketId: r.ticket_id,
                authorUsername: r.author_username,
                noteText: r.note_text,
                attachmentUrl: r.attachment_url || null,
                createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at || '')
            }));
            return res.json({ result: 'success', notes });
        } catch (error) {
            const message = error && error.message ? error.message : 'Failed to load notes';
            console.error('[HELPDESK] Load notes error:', message);
            return res.status(500).json({ result: 'error', message: 'שגיאה בטעינת ההערות' });
        }
    });

    // PUT /helpdesk/tickets/:id/status - Change ticket status
    app.put(['/helpdesk/tickets/:id/status', '/notify/helpdesk/tickets/:id/status'], requireUser, helpdeskRateLimit(10, 60 * 1000), async (req, res) => {
        const user = toTrimmedString(req.resolvedUser || '');
        if (!user) {
            return res.status(401).json({ result: 'error', message: 'Authentication required' });
        }
        const ticketId = toPositiveInteger(req.params && req.params.id, 0);
        if (!ticketId) {
            return res.status(400).json({ result: 'error', message: 'מזהה קריאה לא תקין' });
        }
        const body = req.body && typeof req.body === 'object' ? req.body : {};
        const status = toTrimmedString(body.status || '');
        if (!VALID_STATUSES.includes(status)) {
            return res.status(400).json({ result: 'error', message: 'סטטוס לא תקין' });
        }

        try {
            await getTablesReady();
            const [ticketRows] = await pool.query(
                'SELECT `id`, `title`, `creator_username`, `handler_username`, `department`, `status` FROM `helpdesk_tickets` WHERE `id` = ?',
                [ticketId]
            );
            if (!ticketRows.length) {
                return res.status(404).json({ result: 'error', message: 'קריאה לא נמצאה' });
            }
            const ticket = ticketRows[0];
            // Allow creator, assigned handler, or Editor of the same department to change status
            let isAuthorized = ticket.creator_username === user || ticket.handler_username === user;
            if (!isAuthorized) {
                const editorRole = await getHelpdeskUserRole(pool, user);
                isAuthorized = Boolean(editorRole && editorRole.department === ticket.department);
            }
            if (!isAuthorized) {
                return res.status(403).json({ result: 'error', message: 'אין הרשאה לשנות את הסטטוס' });
            }

            const previousStatus = ticket.status;
            await pool.execute(
                'UPDATE `helpdesk_tickets` SET `status` = ? WHERE `id` = ?',
                [status, ticketId]
            );
            // Record status change in history (awaited so the entry is visible when client refreshes)
            try {
                await pool.execute(
                    'INSERT INTO `helpdesk_status_history` (`ticket_id`, `old_status`, `new_status`, `changed_by`) VALUES (?, ?, ?, ?)',
                    [ticketId, previousStatus || null, status, user]
                );
            } catch (histErr) {
                console.error('[HELPDESK] Insert status history error:', histErr && histErr.message ? histErr.message : histErr);
            }

            // Notify creator and/or handler of the status change under 'מוקד איחוד' chat
            if (typeof sendPushNotificationToUser === 'function') {
                const statusLabels = { open: 'פתוח', in_progress: 'בתהליך', resolved: 'פתור', closed: 'סגור' };
                const statusLabel = statusLabels[status] || status;
                const ticketTitle = toTrimmedString(ticket.title || '');
                const statusMsgText = `Ticket #${ticketId}${ticketTitle ? ' - ' + ticketTitle : ''}: סטטוס → ${statusLabel}`;
                const statusNotifData = {
                    title: 'מוקד איחוד',
                    body: { shortText: statusMsgText, longText: statusMsgText },
                    data: { type: 'helpdesk_ticket', ticketId: String(ticketId), messageText: statusMsgText }
                };
                const statusMsgId = `helpdesk-status-${ticketId}-${Date.now()}`;
                const statusNotifOpts = { messageId: statusMsgId, skipBadge: false, singlePerUser: true, allowSecondAttempt: false };
                const toNotify = [...new Set([ticket.creator_username, ticket.handler_username].filter(Boolean))];
                for (const recipient of toNotify) {
                    if (recipient === user) continue; // skip self
                    void sendPushNotificationToUser(recipient, statusNotifData, 'מוקד איחוד', statusNotifOpts).catch((err) => {
                        console.warn('[HELPDESK] Status change push failed:', err && err.message ? err.message : err);
                    });
                }
            }

            return res.json({ result: 'success' });
        } catch (error) {
            const message = error && error.message ? error.message : 'Failed to update status';
            console.error('[HELPDESK] Update status error:', message);
            return res.status(500).json({ result: 'error', message: 'שגיאה בעדכון הסטטוס' });
        }
    });

    // GET /helpdesk/tickets/:id/history - Get status change history for a ticket
    app.get(['/helpdesk/tickets/:id/history', '/notify/helpdesk/tickets/:id/history'], requireUser, helpdeskRateLimit(30, 60 * 1000), async (req, res) => {
        const user = toTrimmedString(req.resolvedUser || '');
        if (!user) {
            return res.status(401).json({ result: 'error', message: 'Authentication required' });
        }
        const ticketId = toPositiveInteger(req.params && req.params.id, 0);
        if (!ticketId) {
            return res.status(400).json({ result: 'error', message: 'מזהה קריאה לא תקין' });
        }

        try {
            await getTablesReady();
            // Verify the ticket exists and the user is authorized
            const [ticketRows] = await pool.query(
                'SELECT `id`, `creator_username`, `handler_username`, `department`, `status`, `created_at` FROM `helpdesk_tickets` WHERE `id` = ?',
                [ticketId]
            );
            if (!ticketRows.length) {
                return res.status(404).json({ result: 'error', message: 'קריאה לא נמצאה' });
            }
            const ticket = ticketRows[0];
            const isDirectUser = ticket.creator_username === user || ticket.handler_username === user;
            let isAuthorized = isDirectUser;
            if (!isAuthorized) {
                const editorRole = await getHelpdeskUserRole(pool, user);
                isAuthorized = Boolean(editorRole && editorRole.department === ticket.department);
            }
            if (!isAuthorized) {
                return res.status(403).json({ result: 'error', message: 'אין הרשאה לצפות בהיסטוריית הקריאה' });
            }

            const [historyRows] = await pool.query(
                'SELECT `id`, `ticket_id`, `old_status`, `new_status`, `changed_by`, `created_at` FROM `helpdesk_status_history` WHERE `ticket_id` = ? ORDER BY `created_at` ASC',
                [ticketId]
            );
            let history = historyRows.map((r) => ({
                id: r.id,
                ticketId: r.ticket_id,
                oldStatus: r.old_status || null,
                newStatus: r.new_status,
                changedBy: r.changed_by,
                createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at || '')
            }));
            // If no history rows exist (e.g. ticket predates history tracking or insert failed),
            // synthesize a creation entry so the timeline is never empty.
            if (history.length === 0) {
                const createdAt = ticket.created_at instanceof Date
                    ? ticket.created_at.toISOString()
                    : String(ticket.created_at || '');
                history = [{
                    id: 0,
                    ticketId: ticketId,
                    oldStatus: null,
                    newStatus: 'open',
                    changedBy: ticket.creator_username,
                    createdAt
                }];
            }
            return res.json({ result: 'success', history });
        } catch (error) {
            const message = error && error.message ? error.message : 'Failed to load history';
            console.error('[HELPDESK] Load history error:', message);
            return res.status(500).json({ result: 'error', message: 'שגיאה בטעינת ההיסטוריה' });
        }
    });

    // GET /helpdesk/tickets/:id/handler-history - Get handler assignment history for a ticket
    // Accessible to the ticket creator, assigned handler, and any Editor in the same department.
    app.get(['/helpdesk/tickets/:id/handler-history', '/notify/helpdesk/tickets/:id/handler-history'], requireUser, helpdeskRateLimit(30, 60 * 1000), async (req, res) => {
        const user = toTrimmedString(req.resolvedUser || '');
        if (!user) {
            return res.status(401).json({ result: 'error', message: 'Authentication required' });
        }
        const ticketId = toPositiveInteger(req.params && req.params.id, 0);
        if (!ticketId) {
            return res.status(400).json({ result: 'error', message: 'מזהה קריאה לא תקין' });
        }

        try {
            await getTablesReady();
            const [ticketRows] = await pool.query(
                'SELECT `id`, `creator_username`, `handler_username`, `department` FROM `helpdesk_tickets` WHERE `id` = ?',
                [ticketId]
            );
            if (!ticketRows.length) {
                return res.status(404).json({ result: 'error', message: 'קריאה לא נמצאה' });
            }
            const ticket = ticketRows[0];
            const isDirectUser = ticket.creator_username === user || ticket.handler_username === user;
            let isAuthorized = isDirectUser;
            if (!isAuthorized) {
                const editorRole = await getHelpdeskUserRole(pool, user);
                isAuthorized = Boolean(editorRole && editorRole.department === ticket.department);
            }
            if (!isAuthorized) {
                return res.status(403).json({ result: 'error', message: 'אין הרשאה לצפות בהיסטוריית המטפלים' });
            }

            const [historyRows] = await pool.query(
                'SELECT `id`, `ticket_id`, `old_handler`, `new_handler`, `changed_by`, `created_at` FROM `helpdesk_handler_history` WHERE `ticket_id` = ? ORDER BY `created_at` ASC',
                [ticketId]
            );
            const history = historyRows.map((r) => ({
                id: r.id,
                ticketId: r.ticket_id,
                oldHandler: r.old_handler || null,
                newHandler: r.new_handler || null,
                changedBy: r.changed_by,
                createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at || '')
            }));
            return res.json({ result: 'success', history });
        } catch (error) {
            const message = error && error.message ? error.message : 'Failed to load handler history';
            console.error('[HELPDESK] Load handler history error:', message);
            return res.status(500).json({ result: 'error', message: 'שגיאה בטעינת היסטוריית המטפלים' });
        }
    });

    // GET /helpdesk/users - Admin: list all helpdesk_users; Editor: list users in own department
    app.get(['/helpdesk/users', '/notify/helpdesk/users'], requireUser, helpdeskRateLimit(20, 60 * 1000), async (req, res) => {
        const user = toTrimmedString(req.resolvedUser || '');
        if (!user) {
            return res.status(401).json({ result: 'error', message: 'Authentication required' });
        }
        try {
            await getTablesReady();
            const editorRole = await getHelpdeskUserRole(pool, user);
            if (!editorRole) {
                return res.status(403).json({ result: 'error', message: 'אין הרשאה' });
            }
            let rows;
            if (editorRole.role === 'Admin') {
                [rows] = await pool.query(
                    'SELECT `id`, `username`, `role`, `department`, `created_at` FROM `helpdesk_users` ORDER BY `department`, `username`'
                );
            } else {
                [rows] = await pool.query(
                    'SELECT `id`, `username`, `role`, `department`, `created_at` FROM `helpdesk_users` WHERE `department` = ? ORDER BY `username`',
                    [editorRole.department]
                );
            }
            const users = rows.map((r) => ({
                id: r.id,
                username: r.username,
                role: r.role,
                department: r.department,
                createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at || '')
            }));
            return res.json({ result: 'success', users });
        } catch (error) {
            const message = error && error.message ? error.message : 'Failed to load users';
            console.error('[HELPDESK] Load users error:', message);
            return res.status(500).json({ result: 'error', message: 'שגיאה בטעינת המשתמשים' });
        }
    });

    // POST /helpdesk/users - Admin: add a user to helpdesk_users
    app.post(['/helpdesk/users', '/notify/helpdesk/users'], requireUser, helpdeskRateLimit(10, 60 * 1000), async (req, res) => {
        const user = toTrimmedString(req.resolvedUser || '');
        if (!user) {
            return res.status(401).json({ result: 'error', message: 'Authentication required' });
        }
        const body = req.body && typeof req.body === 'object' ? req.body : {};
        const targetUsername = toTrimmedString(body.username || '');
        const role = toTrimmedString(body.role || '');
        const department = toTrimmedString(body.department || '');

        if (!targetUsername) return res.status(400).json({ result: 'error', message: 'יש להזין שם משתמש' });
        if (!VALID_ROLES.includes(role)) return res.status(400).json({ result: 'error', message: 'תפקיד לא תקין' });
        if (!VALID_DEPARTMENTS.includes(department)) return res.status(400).json({ result: 'error', message: 'מחלקה לא תקינה' });

        try {
            await getTablesReady();
            const editorRole = await getHelpdeskUserRole(pool, user);
            if (!editorRole || editorRole.role !== 'Admin') {
                return res.status(403).json({ result: 'error', message: 'רק מנהל יכול להוסיף משתמשים' });
            }
            await pool.execute(
                'INSERT INTO `helpdesk_users` (`username`, `role`, `department`) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE `role` = VALUES(`role`), `department` = VALUES(`department`)',
                [targetUsername, role, department]
            );
            return res.status(201).json({ result: 'success' });
        } catch (error) {
            const message = error && error.message ? error.message : 'Failed to add user';
            console.error('[HELPDESK] Add user error:', message);
            return res.status(500).json({ result: 'error', message: 'שגיאה בהוספת המשתמש' });
        }
    });

    // DELETE /helpdesk/users/:username - Admin: remove a user from helpdesk_users
    app.delete(['/helpdesk/users/:username', '/notify/helpdesk/users/:username'], requireUser, helpdeskRateLimit(10, 60 * 1000), async (req, res) => {
        const user = toTrimmedString(req.resolvedUser || '');
        if (!user) {
            return res.status(401).json({ result: 'error', message: 'Authentication required' });
        }
        const targetUsername = toTrimmedString(req.params && req.params.username || '');
        if (!targetUsername) {
            return res.status(400).json({ result: 'error', message: 'יש לציין שם משתמש' });
        }
        try {
            await getTablesReady();
            const editorRole = await getHelpdeskUserRole(pool, user);
            if (!editorRole || editorRole.role !== 'Admin') {
                return res.status(403).json({ result: 'error', message: 'רק מנהל יכול להסיר משתמשים' });
            }
            await pool.execute('DELETE FROM `helpdesk_users` WHERE `username` = ?', [targetUsername]);
            return res.json({ result: 'success' });
        } catch (error) {
            const message = error && error.message ? error.message : 'Failed to remove user';
            console.error('[HELPDESK] Remove user error:', message);
            return res.status(500).json({ result: 'error', message: 'שגיאה בהסרת המשתמש' });
        }
    });
}

module.exports = { registerHelpdeskController };
