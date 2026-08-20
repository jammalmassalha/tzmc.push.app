'use strict';

/**
 * Helpdesk Department-Level ACL Service
 *
 * Permission model:
 *   - If a department has NO entries in helpdesk_department_permissions it is
 *     "open": every authenticated helpdesk user can access it.
 *   - If a department HAS entries, only the listed users (and global Admins)
 *     can access it. The entry also carries a department-level role
 *     ('Admin' | 'Editor' | 'Viewer').
 */

const ALLOWED_ROLES = ['Admin', 'Editor', 'Viewer'];

/**
 * Return all user-permission rows for a department.
 * @param {import('mysql2/promise').Pool} pool
 * @param {number} departmentId
 * @returns {Promise<Array<{userId: string, role: string}>>}
 */
async function getDepartmentAllowedUsersWithRoles(pool, departmentId) {
    const [rows] = await pool.query(
        'SELECT `user_id`, `role` FROM `helpdesk_department_permissions` WHERE `department_id` = ? ORDER BY `user_id`',
        [departmentId]
    );
    return rows.map((r) => ({ userId: r.user_id, role: r.role }));
}

/**
 * Replace all permission rows for a department in a single transaction.
 * @param {import('mysql2/promise').Pool} pool
 * @param {number} departmentId
 * @param {Array<{userId: string, role: string}>} permissionsArray
 */
async function setDepartmentPermissionsWithRoles(pool, departmentId, permissionsArray) {
    if (!Array.isArray(permissionsArray)) {
        throw new Error('permissionsArray must be an array');
    }
    for (const entry of permissionsArray) {
        if (!entry || typeof entry.userId !== 'string' || !entry.userId.trim()) {
            throw new Error('Each permission entry must have a non-empty userId');
        }
        if (!ALLOWED_ROLES.includes(entry.role)) {
            throw new Error(`Invalid role "${entry.role}". Allowed: ${ALLOWED_ROLES.join(', ')}`);
        }
    }

    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();
        await conn.execute(
            'DELETE FROM `helpdesk_department_permissions` WHERE `department_id` = ?',
            [departmentId]
        );
        if (permissionsArray.length > 0) {
            const values = permissionsArray.map((e) => [departmentId, e.userId.trim(), e.role]);
            await conn.query(
                'INSERT INTO `helpdesk_department_permissions` (`department_id`, `user_id`, `role`) VALUES ?',
                [values]
            );
        }
        await conn.commit();
    } catch (err) {
        await conn.rollback();
        throw err;
    } finally {
        conn.release();
    }
}

/**
 * Return departments accessible to a user, annotated with the resolved role.
 *
 * - Global Admin → all active departments with resolvedRole 'Admin'.
 * - Others → active departments that either have no permission rows (open) OR
 *   have a row matching the userId. Open departments get resolvedRole 'Editor'.
 *
 * @param {import('mysql2/promise').Pool} pool
 * @param {string} userId
 * @param {string} globalRole   Value from helpdesk_users.role (e.g. 'Admin', 'Editor').
 * @returns {Promise<Array<{id: number, name: string, icon: string|null, status: string, sortOrder: number, resolvedRole: string}>>}
 */
async function getUserPermittedDepartmentsWithRole(pool, userId, globalRole) {
    if (globalRole === 'Admin') {
        const [rows] = await pool.query(
            'SELECT `id`, `name`, `icon`, `status`, `sort_order` FROM `helpdesk_departments` WHERE `status` = ? ORDER BY `sort_order`, `id`',
            ['active']
        );
        return rows.map((r) => ({
            id: r.id,
            name: r.name,
            icon: r.icon || null,
            status: r.status,
            sortOrder: r.sort_order,
            resolvedRole: 'Admin'
        }));
    }

    // For non-admins: departments with no ACL rows (open) OR with a matching row.
    const [rows] = await pool.query(
        `SELECT d.\`id\`, d.\`name\`, d.\`icon\`, d.\`status\`, d.\`sort_order\`,
                p.\`role\` AS dept_role,
                (SELECT COUNT(*) FROM \`helpdesk_department_permissions\` WHERE \`department_id\` = d.\`id\`) AS perm_count
         FROM \`helpdesk_departments\` d
         LEFT JOIN \`helpdesk_department_permissions\` p
             ON p.\`department_id\` = d.\`id\` AND p.\`user_id\` = ?
         WHERE d.\`status\` = ?
         HAVING perm_count = 0 OR dept_role IS NOT NULL
         ORDER BY d.\`sort_order\`, d.\`id\``,
        [userId, 'active']
    );

    return rows.map((r) => ({
        id: r.id,
        name: r.name,
        icon: r.icon || null,
        status: r.status,
        sortOrder: r.sort_order,
        resolvedRole: r.dept_role || 'Editor'
    }));
}

/**
 * Check whether a specific user can access a specific department.
 *
 * @param {import('mysql2/promise').Pool} pool
 * @param {string} userId
 * @param {string} globalRole
 * @param {number} departmentId
 * @returns {Promise<{allowed: boolean, role: string|null}>}
 */
async function canUserAccessDepartment(pool, userId, globalRole, departmentId) {
    if (globalRole === 'Admin') {
        return { allowed: true, role: 'Admin' };
    }

    const [permRows] = await pool.query(
        'SELECT COUNT(*) AS cnt FROM `helpdesk_department_permissions` WHERE `department_id` = ?',
        [departmentId]
    );
    const totalPerms = permRows[0] && permRows[0].cnt ? Number(permRows[0].cnt) : 0;

    if (totalPerms === 0) {
        // Open department
        return { allowed: true, role: 'Editor' };
    }

    const [userRow] = await pool.query(
        'SELECT `role` FROM `helpdesk_department_permissions` WHERE `department_id` = ? AND `user_id` = ? LIMIT 1',
        [departmentId, userId]
    );
    if (userRow.length > 0) {
        return { allowed: true, role: userRow[0].role };
    }
    return { allowed: false, role: null };
}

/**
 * Return all tickets whose department is accessible to the user.
 * This is a non-breaking helper — existing ticket routes are unmodified.
 *
 * @param {import('mysql2/promise').Pool} pool
 * @param {string} userId
 * @param {string} globalRole
 * @returns {Promise<Array<{ticketId: number, department: string, resolvedRole: string}>>}
 */
async function getPermittedTicketsForUser(pool, userId, globalRole) {
    const permittedDepts = await getUserPermittedDepartmentsWithRole(pool, userId, globalRole);
    if (permittedDepts.length === 0) return [];

    const deptNames = permittedDepts.map((d) => d.name);
    const roleByName = Object.fromEntries(permittedDepts.map((d) => [d.name, d.resolvedRole]));

    const placeholders = deptNames.map(() => '?').join(', ');
    const [rows] = await pool.query(
        `SELECT \`id\`, \`department\` FROM \`helpdesk_tickets\` WHERE \`department\` IN (${placeholders}) ORDER BY \`id\` DESC`,
        deptNames
    );
    return rows.map((r) => ({
        ticketId: r.id,
        department: r.department,
        resolvedRole: roleByName[r.department] || 'Editor'
    }));
}

module.exports = {
    ALLOWED_ROLES,
    getDepartmentAllowedUsersWithRoles,
    setDepartmentPermissionsWithRoles,
    getUserPermittedDepartmentsWithRole,
    canUserAccessDepartment,
    getPermittedTicketsForUser
};
