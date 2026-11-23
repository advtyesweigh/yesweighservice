/**
 * Staff permission resolution shared by Cloud Functions.
 * Keep in sync with src/types/staff-access.ts and src/lib/staffAccess.ts.
 */

export const SYSTEM_STAFF_ROLE_IDS = {
  sales: 'role-sales',
  service: 'role-service',
  logistics: 'role-logistics',
  admin: 'role-admin',
  hrManager: 'role-hr-manager',
  invoiceAccess: 'role-invoice-access',
};

const SALES_DEFAULT_PERMS = new Set([
  'dealers.view',
  'leads.view',
  'leads.manage',
  'catalog.view',
  'invoices.view',
  'orders.view',
  'orders.manage',
  'loyalty.view',
  'tasks.view',
  'advertisements.view',
]);

const SERVICE_DEFAULT_PERMS = new Set([
  'support.view',
  'support.manage',
  'support.service',
  'support.complaint',
  'verification.view',
  'verification.manage',
  'catalog.view',
]);

const LOGISTICS_DEFAULT_PERMS = new Set([
  'orders.view',
  'orders.manage',
  'support.view',
  'support.return',
  'invoices.view',
  'logistics.view',
  'loyalty.view',
  'catalog.view',
]);

const HR_MANAGER_PERMS = new Set([
  'hr.view',
  'hr.manage',
  'staff.manage',
  'dealers.view',
  'dealers.edit',
  'tasks.view',
  'catalog.view',
  'invoices.view',
]);

const INVOICE_ACCESS_PERMS = new Set([
  'catalog.view',
  'invoices.view',
  'logistics.view',
]);

/** null = all permissions (admin system role / admin department). */
const SYSTEM_ROLE_PERMS = {
  [SYSTEM_STAFF_ROLE_IDS.sales]: SALES_DEFAULT_PERMS,
  [SYSTEM_STAFF_ROLE_IDS.service]: SERVICE_DEFAULT_PERMS,
  [SYSTEM_STAFF_ROLE_IDS.logistics]: LOGISTICS_DEFAULT_PERMS,
  [SYSTEM_STAFF_ROLE_IDS.admin]: null,
  [SYSTEM_STAFF_ROLE_IDS.hrManager]: HR_MANAGER_PERMS,
  [SYSTEM_STAFF_ROLE_IDS.invoiceAccess]: INVOICE_ACCESS_PERMS,
};

const DEPARTMENT_PERMS = {
  sales: SALES_DEFAULT_PERMS,
  service: SERVICE_DEFAULT_PERMS,
  logistics: LOGISTICS_DEFAULT_PERMS,
  admin: null,
};

function setAllows(set, permission) {
  return set == null || set.has(permission);
}

/**
 * @param {string} role
 * @param {object} data user document
 * @param {string} permission
 * @param {{ viewOnlySuperAdminDenied?: boolean }} [options]
 */
export function staffUserHasPermission(role, data, permission, options = {}) {
  if (role === 'super_admin') {
    if (options.viewOnlySuperAdminDenied && data?.superAdminAccess === 'view_only') {
      return false;
    }
    return true;
  }
  if (role !== 'staff') return false;

  const mode = String(data?.staffAccessMode ?? 'role');
  const roleId = String(data?.staffRoleId ?? '');
  if (mode !== 'custom' && Object.prototype.hasOwnProperty.call(SYSTEM_ROLE_PERMS, roleId)) {
    return setAllows(SYSTEM_ROLE_PERMS[roleId], permission);
  }

  const perms = Array.isArray(data?.staffPermissions)
    ? data.staffPermissions.map(String)
    : [];
  if ((mode === 'custom' || mode === 'role') && perms.length > 0) {
    return perms.includes(permission);
  }

  const dept = String(data?.staffDepartment ?? 'admin');
  return setAllows(DEPARTMENT_PERMS[dept] ?? DEPARTMENT_PERMS.admin, permission);
}
