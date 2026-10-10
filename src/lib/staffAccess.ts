import type { SupportRequestType } from '../types/dealer-support';
import type { User, Role } from '../types';
import { normalizeSuperAdminAccess } from '../types';
import {
  ALL_STAFF_PERMISSIONS,
  DEPARTMENT_DEFAULT_PERMISSIONS,
  DEPARTMENT_SUPPORT_TYPES,
  DEFAULT_STAFF_ACCESS,
  INVOICE_ACCESS_PERMISSIONS,
  STAFF_DEPARTMENT_LABELS,
  SYSTEM_STAFF_ROLE_PERMISSIONS,
  type StaffAccessProfile,
  type StaffDepartment,
  type StaffPermission,
} from '../types/staff-access';
import { SYSTEM_STAFF_ROLE_IDS } from '../types/staff-role';

/** Staff permissions that imply mutation / sync (denied for view-only super admins). */
const SUPER_ADMIN_WRITE_PERMISSIONS = new Set<StaffPermission>([
  'dealers.edit',
  'dealers.sync',
  'yesgatc.rc_link',
  'leads.manage',
  'support.manage',
  'support.service',
  'support.return',
  'support.complaint',
  'orders.manage',
  'catalog.manage',
  'catalog.sync',
  'staff.manage',
  'hr.manage',
  'verification.manage',
]);

export function isStaffUser(user: Pick<User, 'role'> | null | undefined): boolean {
  return user?.role === 'staff';
}

/** HR Sales staff (KAM) — dashboard and roster are limited to their assigned dealers. */
export function isSalesKamStaff(
  user: Pick<User, 'role' | 'staffDepartment' | 'staffRoleId'> | null | undefined,
): boolean {
  if (user?.role !== 'staff') return false;
  return (user.staffDepartment ?? 'admin') === 'sales'
    || user.staffRoleId === SYSTEM_STAFF_ROLE_IDS.sales;
}

export function isPlatformAdmin(user: Pick<User, 'role'> | null | undefined): boolean {
  return user?.role === 'super_admin';
}

/** Super admin with full write access (missing tier → full). */
export function isFullSuperAdmin(
  user: Pick<User, 'role' | 'superAdminAccess'> | null | undefined,
): boolean {
  return user?.role === 'super_admin'
    && normalizeSuperAdminAccess(user.superAdminAccess) === 'full';
}

/** Alias — use for any mutate/sync UI that currently checks super_admin. */
export function canSuperAdminWrite(
  user: Pick<User, 'role' | 'superAdminAccess'> | null | undefined,
): boolean {
  return isFullSuperAdmin(user);
}

/** Inbox: every staff account, and super admins with full access. */
export function canUseWhatsApp(
  user: Pick<User, 'role' | 'superAdminAccess'> | null | undefined,
): boolean {
  if (user?.role === 'staff') return true;
  return isFullSuperAdmin(user);
}

export function isViewOnlySuperAdmin(
  user: Pick<User, 'role' | 'superAdminAccess'> | null | undefined,
): boolean {
  return user?.role === 'super_admin'
    && normalizeSuperAdminAccess(user.superAdminAccess) === 'view_only';
}

/** Purchase order list / PDF — any super admin (including view-only). */
export function canViewPurchaseOrders(
  user: Pick<User, 'role'> | null | undefined,
): boolean {
  return isPlatformAdmin(user);
}

/** Purchase order sync / mutate — full-access super admin only. */
export function canUpdatePurchaseOrders(
  user: Pick<User, 'role' | 'superAdminAccess'> | null | undefined,
): boolean {
  return isFullSuperAdmin(user);
}

export function readStaffAccessProfile(user: User | null | undefined): StaffAccessProfile {
  if (!user || user.role !== 'staff') return DEFAULT_STAFF_ACCESS;
  return {
    department: user.staffDepartment ?? 'admin',
    accessMode: user.staffAccessMode ?? 'role',
    roleId: user.staffRoleId ?? null,
    permissions: user.staffPermissions ?? [],
    teamId: user.staffTeamId ?? null,
  };
}

export function resolveStaffPermissions(user: User | null | undefined): StaffPermission[] {
  if (!user) return [];
  if (user.role === 'super_admin') {
    if (isFullSuperAdmin(user)) return ALL_STAFF_PERMISSIONS;
    // View-only: keep view / non-mutating permissions for nav + screens.
    return ALL_STAFF_PERMISSIONS.filter(p => !SUPER_ADMIN_WRITE_PERMISSIONS.has(p));
  }
  if (user.role !== 'staff') return [];

  const profile = readStaffAccessProfile(user);
  // System roles always use the code template so HR / trainee edits (and stale
  // snapshots on the user doc) cannot strip orders/invoice access.
  if (profile.accessMode !== 'custom') {
    const systemPerms = profile.roleId
      ? SYSTEM_STAFF_ROLE_PERMISSIONS[profile.roleId]
      : undefined;
    if (systemPerms) return [...systemPerms];
  }
  if (
    (profile.accessMode === 'custom' || profile.accessMode === 'role')
    && profile.permissions.length > 0
  ) {
    const set = new Set(profile.permissions);
    return ALL_STAFF_PERMISSIONS.filter(permission => set.has(permission));
  }
  return DEPARTMENT_DEFAULT_PERMISSIONS[profile.department];
}

export function hasStaffPermission(
  user: User | null | undefined,
  permission: StaffPermission,
): boolean {
  return resolveStaffPermissions(user).includes(permission);
}

export function canLinkYesGatcRc(user: User | null | undefined): boolean {
  return isFullSuperAdmin(user) || hasStaffPermission(user, 'yesgatc.rc_link');
}

const YESGATC_FILTER_ADMIN_NAMES = ['developer', 'shalima', 'faisal'] as const;

function yesGatcFilterIdentityParts(user: Pick<User, 'displayName' | 'loginId' | 'email'>): string[] {
  return [user.displayName, user.loginId, user.email]
    .flatMap(value => String(value ?? '').toLowerCase().split(/[\s@._-]+/))
    .map(part => part.trim())
    .filter(Boolean);
}

/** GATC list filters: only these three super admins may change RC / period / link. */
export function canUseYesGatcFilters(user: User | null | undefined): boolean {
  if (user?.role !== 'super_admin') return false;
  const login = String(user.loginId ?? user.email ?? '').trim().toLowerCase();
  if (login === 'admin@yesweigh.in') return true;
  const parts = new Set(yesGatcFilterIdentityParts(user));
  return YESGATC_FILTER_ADMIN_NAMES.some(name => parts.has(name));
}

const VOID_INVOICE_ADMIN_NAMES = ['faisal', 'shalima'] as const;

/** Void invoice in Zoho: Faisal and Shalima only (full super admin). */
export function canVoidAdminInvoice(user: User | null | undefined): boolean {
  if (!isFullSuperAdmin(user) || !user) return false;
  const parts = new Set(yesGatcFilterIdentityParts(user));
  return VOID_INVOICE_ADMIN_NAMES.some(name => parts.has(name));
}

export function canViewHr(user: User | null | undefined): boolean {
  if (!user) return false;
  if (user.role === 'super_admin') return true;
  if (user.role !== 'staff') return false;
  return hasStaffPermission(user, 'hr.view') || hasStaffPermission(user, 'hr.manage');
}

export function canManageHr(user: User | null | undefined): boolean {
  if (!user) return false;
  if (user.role === 'super_admin') return canSuperAdminWrite(user);
  if (user.role !== 'staff') return false;
  return hasStaffPermission(user, 'hr.manage');
}

export function canManageWarehouseUsers(user: User | null | undefined): boolean {
  return canManageHr(user);
}

/** Assign staff / super admins as spare incharge (HR manage). */
export function canManageSpareIncharge(user: User | null | undefined): boolean {
  return canManageHr(user);
}

export function canManageStaffRolesInHr(user: User | null | undefined): boolean {
  return canSuperAdminWrite(user);
}

/** Open Super Admins page (view-only can browse; writes gated in UI). */
export function canManageSuperAdminsInHr(user: User | null | undefined): boolean {
  return user?.role === 'super_admin';
}

/** Salary calculation role gate (super-admin). Tab also requires localhost / isLocalhostDev(). */
export function canViewHrSalary(user: User | null | undefined): boolean {
  return user?.role === 'super_admin';
}

/** Persist salary / share mutations (full super admin only). */
export function canEditHrSalary(user: User | null | undefined): boolean {
  return canSuperAdminWrite(user);
}

export function canViewDealersInHr(user: User | null | undefined): boolean {
  if (!user) return false;
  if (user.role === 'super_admin') return true;
  if (user.role !== 'staff') return false;
  return hasStaffPermission(user, 'dealers.view') || hasStaffPermission(user, 'dealers.edit');
}

export function hasAnyStaffPermission(
  user: User | null | undefined,
  permissions: StaffPermission[],
): boolean {
  const resolved = resolveStaffPermissions(user);
  return permissions.some(permission => resolved.includes(permission));
}

/** Staff or super admin with access to internal ops features. */
export function isInternalOpsUser(user: User | null | undefined): boolean {
  if (!user) return false;
  if (user.role === 'super_admin') return true;
  return user.role === 'staff';
}

export function canManageSupportOps(user: User | null | undefined): boolean {
  if (!user) return false;
  if (user.role === 'super_admin') return canSuperAdminWrite(user);
  return hasStaffPermission(user, 'support.manage');
}

export function canCreateSupportOnBehalf(user: User | null | undefined): boolean {
  if (!user) return false;
  if (user.role === 'super_admin') return canSuperAdminWrite(user);
  if (user.role !== 'staff') return false;
  return hasAnyStaffPermission(user, [
    'support.view',
    'support.manage',
    'support.service',
    'support.return',
    'support.complaint',
  ]);
}

export function allowedSupportTypesForUser(user: User | null | undefined): SupportRequestType[] | 'all' {
  if (!user) return [];
  if (user.role === 'super_admin') return 'all';
  if (user.role !== 'staff') return [];

  const profile = readStaffAccessProfile(user);
  const deptTypes = DEPARTMENT_SUPPORT_TYPES[profile.department];
  if (deptTypes === 'all') return 'all';

  const allowed = new Set<SupportRequestType>(deptTypes);
  if (hasStaffPermission(user, 'support.service')) allowed.add('service');
  if (hasStaffPermission(user, 'support.return')) allowed.add('return');
  if (hasStaffPermission(user, 'support.complaint')) allowed.add('complaint');
  if (
    hasStaffPermission(user, 'support.complaint')
    || hasStaffPermission(user, 'support.service')
    || hasStaffPermission(user, 'support.manage')
  ) {
    allowed.add('chat');
  }

  if (!hasStaffPermission(user, 'support.view') && !hasStaffPermission(user, 'support.manage')) {
    return [];
  }

  return [...allowed];
}

export function filterSupportRequestsForUser<T extends { type: SupportRequestType }>(
  user: User | null | undefined,
  requests: T[],
): T[] {
  const allowed = allowedSupportTypesForUser(user);
  if (allowed === 'all') return requests;
  if (allowed.length === 0) return [];
  const set = new Set(allowed);
  return requests.filter(request => set.has(request.type));
}

export type StaffNavFeature =
  | 'dashboard'
  | 'tasks'
  | 'dealers'
  | 'leads'
  | 'catalog'
  | 'orders'
  | 'warranty-support'
  | 'verification'
  | 'advertisements'
  | 'invoices'
  | 'sales-orders'
  | 'purchase-orders'
  | 'goods-receipts'
  | 'spare-indents'
  | 'logistics'
  | 'loyalty'
  | 'ai-assistant'
  | 'training'
  | 'reports'
  | 'staff'
  | 'whatsapp';

const NAV_FEATURE_PERMISSIONS: Record<StaffNavFeature, StaffPermission[] | 'always'> = {
  dashboard: 'always',
  tasks: ['tasks.view'],
  dealers: ['dealers.view'],
  leads: ['leads.view'],
  catalog: ['catalog.view'],
  orders: ['orders.view'],
  'warranty-support': ['support.view', 'support.manage'],
  verification: ['verification.view'],
  advertisements: ['advertisements.view'],
  invoices: ['invoices.view'],
  // Do not unlock via invoices.view — Invoice access staff must not see SOs.
  'sales-orders': ['orders.view', 'orders.manage'],
  // Purchase orders are super-admin only — staff must not see this nav/feature.
  'purchase-orders': [],
  // Same gate as Invoice — Invoice access role and anyone with invoices.view.
  'goods-receipts': ['invoices.view'],
  'spare-indents': ['catalog.view'],
  logistics: ['logistics.view'],
  loyalty: ['loyalty.view'],
  'ai-assistant': 'always',
  training: 'always',
  reports: 'always',
  whatsapp: 'always',
  staff: ['staff.manage', 'hr.view', 'hr.manage'],
};

const INVOICE_ACCESS_PERMISSION_SET = new Set<string>(INVOICE_ACCESS_PERMISSIONS);

/** Staff whose resolved perms are only Invoice access (dashboard + invoices + logistics + profile). */
export function isInvoiceAccessOnlyStaff(user: User | null | undefined): boolean {
  if (!user || user.role !== 'staff') return false;
  const perms = resolveStaffPermissions(user);
  if (!perms.length) return false;
  return perms.every(permission => INVOICE_ACCESS_PERMISSION_SET.has(permission));
}

export function canAccessNavFeature(user: User | null | undefined, feature: StaffNavFeature): boolean {
  if (!user) return false;
  if (feature === 'purchase-orders') return canViewPurchaseOrders(user);
  if (user.role === 'super_admin') return feature !== 'staff' || true;
  if (user.role === 'dealer' || user.role === 'dealer_staff') return true;
  if (user.role !== 'staff') return false;

  const rule = NAV_FEATURE_PERMISSIONS[feature];
  if (rule === 'always') {
    // Invoice-only staff: Dashboard and WhatsApp stay; hide AI / training / reports.
    if (feature === 'dashboard' || feature === 'whatsapp') return true;
    if (isInvoiceAccessOnlyStaff(user)) return false;
    return true;
  }
  return hasAnyStaffPermission(user, rule);
}

export function staffDepartmentLabel(department: StaffDepartment | undefined): string {
  if (!department) return STAFF_DEPARTMENT_LABELS.admin;
  return STAFF_DEPARTMENT_LABELS[department];
}

export function effectivePermissionSet(
  accessMode: 'role' | 'custom' | 'department',
  department: StaffDepartment,
  permissions: StaffPermission[],
): StaffPermission[] {
  if ((accessMode === 'custom' || accessMode === 'role') && permissions.length > 0) {
    const custom = new Set(permissions);
    return ALL_STAFF_PERMISSIONS.filter(permission => custom.has(permission));
  }
  return DEPARTMENT_DEFAULT_PERMISSIONS[department];
}

export function roleCanAccessStaffAdmin(role: Role): boolean {
  return role === 'super_admin' || role === 'staff';
}
