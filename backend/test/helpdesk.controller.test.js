const test = require('node:test');
const assert = require('node:assert/strict');

const {
  __test__: {
    getHelpdeskRoleDepartments,
    canViewDepartmentTickets,
    canManageDepartmentTickets,
  },
} = require('../controllers/helpdesk.controller');

test('helpdesk department helpers resolve multi-department membership', () => {
  assert.deepEqual(
    getHelpdeskRoleDepartments({
      role: 'Editor',
      department: 'Legacy',
      departments: [' מערכות מידע ', '', 'אחזקה'],
    }),
    ['מערכות מידע', 'אחזקה'],
  );

  assert.deepEqual(
    getHelpdeskRoleDepartments({
      role: 'Editor',
      department: 'מערכות מידע',
      departments: [],
    }),
    ['מערכות מידע'],
  );
});

test('helpdesk department helpers enforce view/manage role rules', () => {
  const admin = { role: 'Admin', department: '', departments: [] };
  const editor = { role: 'Editor', department: '', departments: ['מערכות מידע'] };
  const viewer = { role: 'Viewer', department: '', departments: ['מערכות מידע'] };

  assert.equal(canViewDepartmentTickets(admin, 'מחסן'), true);
  assert.equal(canManageDepartmentTickets(admin, 'מחסן'), true);

  assert.equal(canViewDepartmentTickets(editor, 'מערכות מידע'), true);
  assert.equal(canManageDepartmentTickets(editor, 'מערכות מידע'), true);
  assert.equal(canViewDepartmentTickets(editor, 'מחסן'), false);
  assert.equal(canManageDepartmentTickets(editor, 'מחסן'), false);

  assert.equal(canViewDepartmentTickets(viewer, 'מערכות מידע'), true);
  assert.equal(canManageDepartmentTickets(viewer, 'מערכות מידע'), false);
});
