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

    await pool.execute(`
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

async function getHelpdeskUserRole(pool, username) {
    if (!username) return null;
    const [rows] = await pool.query(
        'SELECT `username`, `role`, `department` FROM `helpdesk_users` WHERE `username` = ? LIMIT 1',
        [username]
    );
    if (!rows.length) return null;
    return { username: rows[0].username, role: rows[0].role, department: rows[0].department };
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

    // GET /helpdesk/tickets/user - Get current user's tickets + role context
    app.get(['/helpdesk/tickets/user', '/notify/helpdesk/tickets/user'], requireUser, helpdeskRateLimit(30, 60 * 1000), async (req, res) => {
        const user = toTrimmedString(req.resolvedUser || '');
        if (!user) {
            return res.status(401).json({ result: 'error', message: 'Authentication required' });
        }
        try {
            const [roleInfo, ticketRows, assignedRows] = await Promise.all([
                getHelpdeskUserRole(pool, user),
                pool.query(
                    'SELECT * FROM `helpdesk_tickets` WHERE `creator_username` = ? ORDER BY `created_at` DESC LIMIT 100',
                    [user]
                ),
                pool.query(
                    'SELECT * FROM `helpdesk_tickets` WHERE `handler_username` = ? ORDER BY `created_at` DESC LIMIT 100',
                    [user]
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

    // PUT /helpdesk/tickets/:id/handler - Editor/Admin assigns a handler to a ticket
    app.put(['/helpdesk/tickets/:id/handler', '/notify/helpdesk/tickets/:id/handler'], requireUser, helpdeskRateLimit(20, 60 * 1000), async (req, res) => {
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
            // Verify editor role for this user
            const editorRole = await getHelpdeskUserRole(pool, user);
            if (!editorRole) {
                return res.status(403).json({ result: 'error', message: 'אין הרשאת עורך' });
            }

            // Verify ticket exists and belongs to editor's department
            const [ticketRows] = await pool.query(
                'SELECT `id`, `department` FROM `helpdesk_tickets` WHERE `id` = ?',
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

            await pool.execute(
                'UPDATE `helpdesk_tickets` SET `handler_username` = ? WHERE `id` = ?',
                [handlerUsername || null, ticketId]
            );
            return res.json({ result: 'success' });
        } catch (error) {
            const message = error && error.message ? error.message : 'Failed to assign handler';
            console.error('[HELPDESK] Assign handler error:', message);
            return res.status(500).json({ result: 'error', message: 'שגיאה בשיוך מטפל' });
        }
    });

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
        if (!noteText) {
            return res.status(400).json({ result: 'error', message: 'יש להזין טקסט הערה' });
        }

        try {
            // Verify the ticket exists and the user is authorized (creator, handler, or Editor of same dept)
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
                'SELECT `id`, `ticket_id`, `author_username`, `note_text`, `created_at` FROM `helpdesk_notes` WHERE `ticket_id` = ? ORDER BY `created_at` ASC',
                [ticketId]
            );
            const notes = noteRows.map((r) => ({
                id: r.id,
                ticketId: r.ticket_id,
                authorUsername: r.author_username,
                noteText: r.note_text,
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
            const [ticketRows] = await pool.query(
                'SELECT `id`, `creator_username`, `handler_username`, `department` FROM `helpdesk_tickets` WHERE `id` = ?',
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

    // GET /helpdesk/users - Admin: list all helpdesk_users; Editor: list users in own department
    app.get(['/helpdesk/users', '/notify/helpdesk/users'], requireUser, helpdeskRateLimit(20, 60 * 1000), async (req, res) => {
        const user = toTrimmedString(req.resolvedUser || '');
        if (!user) {
            return res.status(401).json({ result: 'error', message: 'Authentication required' });
        }
        try {
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
