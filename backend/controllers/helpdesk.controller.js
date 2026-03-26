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
    await pool.execute(`
        CREATE TABLE IF NOT EXISTS \`helpdesk_tickets\` (
            \`id\` INT UNSIGNED NOT NULL AUTO_INCREMENT,
            \`creator_username\` VARCHAR(64) NOT NULL,
            \`department\` VARCHAR(64) NOT NULL,
            \`title\` VARCHAR(255) NOT NULL,
            \`description\` TEXT NOT NULL,
            \`status\` VARCHAR(32) NOT NULL DEFAULT 'open',
            \`handler_username\` VARCHAR(64) NULL DEFAULT NULL,
            \`created_at\` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            \`updated_at\` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            PRIMARY KEY (\`id\`),
            INDEX \`idx_creator\` (\`creator_username\`),
            INDEX \`idx_status\` (\`status\`),
            INDEX \`idx_department\` (\`department\`)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    await pool.execute(`
        CREATE TABLE IF NOT EXISTS \`helpdesk_notes\` (
            \`id\` INT UNSIGNED NOT NULL AUTO_INCREMENT,
            \`ticket_id\` INT UNSIGNED NOT NULL,
            \`author_username\` VARCHAR(64) NOT NULL,
            \`note_text\` TEXT NOT NULL,
            \`created_at\` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (\`id\`),
            INDEX \`idx_ticket\` (\`ticket_id\`),
            CONSTRAINT \`fk_helpdesk_notes_ticket\`
                FOREIGN KEY (\`ticket_id\`) REFERENCES \`helpdesk_tickets\` (\`id\`) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
}

function mapTicketRow(row) {
    return {
        id: row.id,
        creatorUsername: row.creator_username,
        department: row.department,
        title: row.title,
        description: row.description,
        status: row.status,
        handlerUsername: row.handler_username || null,
        createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at || ''),
        updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at || '')
    };
}

function registerHelpdeskController(app, deps = {}) {
    const { requireAuthorizedUser, env = {} } = deps;

    const pool = createHelpdeskPool(env);

    // Initialize tables on startup, log but don't crash on failure
    ensureHelpdeskTables(pool).catch((error) => {
        console.error('[HELPDESK] Failed to ensure tables:', error && error.message ? error.message : error);
    });

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

    // Per-user rate limiting middleware factory
    function helpdeskRateLimit(maxAttempts, windowMs) {
        return function (req, res, next) {
            const user = toTrimmedString(req.resolvedUser || req.body && req.body.user || '');
            if (!consumeHelpdeskRateLimit(user, maxAttempts, windowMs).allowed) {
                return res.status(429).json({ result: 'error', message: 'יותר מדי בקשות. נסה שוב בעוד דקה.' });
            }
            return next();
        };
    }

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

        if (!VALID_DEPARTMENTS.includes(department)) {
            return res.status(400).json({ result: 'error', message: 'מחלקה לא תקינה' });
        }
        if (!title) {
            return res.status(400).json({ result: 'error', message: 'יש להזין כותרת לקריאה' });
        }
        if (!description) {
            return res.status(400).json({ result: 'error', message: 'יש להזין תיאור לקריאה' });
        }

        try {
            const [result] = await pool.execute(
                'INSERT INTO `helpdesk_tickets` (`creator_username`, `department`, `title`, `description`, `status`) VALUES (?, ?, ?, ?, ?)',
                [user, department, title, description, 'open']
            );
            const insertId = result.insertId;
            const [rows] = await pool.query(
                'SELECT * FROM `helpdesk_tickets` WHERE `id` = ?',
                [insertId]
            );
            const ticket = rows[0] ? mapTicketRow(rows[0]) : null;
            return res.status(201).json({ result: 'success', ticket });
        } catch (error) {
            const message = error && error.message ? error.message : 'Failed to create ticket';
            console.error('[HELPDESK] Create ticket error:', message);
            return res.status(500).json({ result: 'error', message: 'שגיאה ביצירת הקריאה' });
        }
    });

    // GET /helpdesk/tickets/user - Get current user's tickets (dashboard)
    app.get(['/helpdesk/tickets/user', '/notify/helpdesk/tickets/user'], requireUser, helpdeskRateLimit(30, 60 * 1000), async (req, res) => {
        const user = toTrimmedString(req.resolvedUser || '');
        if (!user) {
            return res.status(401).json({ result: 'error', message: 'Authentication required' });
        }
        try {
            const [rows] = await pool.query(
                'SELECT * FROM `helpdesk_tickets` WHERE `creator_username` = ? ORDER BY `created_at` DESC LIMIT 100',
                [user]
            );
            const tickets = rows.map(mapTicketRow);
            const ongoing = tickets.filter((t) => ONGOING_STATUSES.has(t.status));
            const past = tickets.filter((t) => !ONGOING_STATUSES.has(t.status));
            return res.json({ result: 'success', ongoing, past });
        } catch (error) {
            const message = error && error.message ? error.message : 'Failed to load tickets';
            console.error('[HELPDESK] Load user tickets error:', message);
            return res.status(500).json({ result: 'error', message: 'שגיאה בטעינת הקריאות' });
        }
    });

    // POST /helpdesk/tickets/:id/notes - Add a note to a ticket
    app.post(['/helpdesk/tickets/:id/notes', '/notify/helpdesk/tickets/:id/notes'], requireUser, helpdeskRateLimit(20, 60 * 1000), async (req, res) => {
        const user = toTrimmedString(req.resolvedUser || '');
        if (!user) {
            return res.status(401).json({ result: 'error', message: 'Authentication required' });
        }
        if (!consumeHelpdeskRateLimit(user, 20, 60 * 1000).allowed) {
            return res.status(429).json({ result: 'error', message: 'יותר מדי בקשות. נסה שוב בעוד דקה.' });
        }
        const ticketId = toPositiveInteger(req.params && req.params.id, 0);
        if (!ticketId) {
            return res.status(400).json({ result: 'error', message: 'מזהה קריאה לא תקין' });
        }
        const body = req.body && typeof req.body === 'object' ? req.body : {};
        const noteText = toTrimmedString(body.note_text || '');
        if (!noteText) {
            return res.status(400).json({ result: 'error', message: 'יש להזין טקסט הערה' });
        }

        try {
            // Verify the ticket exists and belongs to the user (or user is handler)
            const [ticketRows] = await pool.query(
                'SELECT `id`, `creator_username`, `handler_username` FROM `helpdesk_tickets` WHERE `id` = ?',
                [ticketId]
            );
            if (!ticketRows.length) {
                return res.status(404).json({ result: 'error', message: 'קריאה לא נמצאה' });
            }
            const ticket = ticketRows[0];
            const isAuthorized = ticket.creator_username === user || ticket.handler_username === user;
            if (!isAuthorized) {
                return res.status(403).json({ result: 'error', message: 'אין הרשאה להוסיף הערה לקריאה זו' });
            }

            const [result] = await pool.execute(
                'INSERT INTO `helpdesk_notes` (`ticket_id`, `author_username`, `note_text`) VALUES (?, ?, ?)',
                [ticketId, user, noteText]
            );
            return res.status(201).json({ result: 'success', noteId: result.insertId });
        } catch (error) {
            const message = error && error.message ? error.message : 'Failed to add note';
            console.error('[HELPDESK] Add note error:', message);
            return res.status(500).json({ result: 'error', message: 'שגיאה בהוספת ההערה' });
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
            const [ticketRows] = await pool.query(
                'SELECT `id`, `creator_username` FROM `helpdesk_tickets` WHERE `id` = ?',
                [ticketId]
            );
            if (!ticketRows.length) {
                return res.status(404).json({ result: 'error', message: 'קריאה לא נמצאה' });
            }
            if (ticketRows[0].creator_username !== user) {
                return res.status(403).json({ result: 'error', message: 'רק יוצר הקריאה יכול לשנות את הסטטוס' });
            }

            await pool.execute(
                'UPDATE `helpdesk_tickets` SET `status` = ? WHERE `id` = ?',
                [status, ticketId]
            );
            return res.json({ result: 'success' });
        } catch (error) {
            const message = error && error.message ? error.message : 'Failed to update status';
            console.error('[HELPDESK] Update status error:', message);
            return res.status(500).json({ result: 'error', message: 'שגיאה בעדכון הסטטוס' });
        }
    });
}

module.exports = { registerHelpdeskController };
