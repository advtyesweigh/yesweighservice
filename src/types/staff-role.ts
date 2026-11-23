import type { StaffDepartment, StaffPermission } from './staff-access';

export const SYSTEM_STAFF_ROLE_IDS = {
  sales: 'role-sales',
  service: 'role-service',
  logistics: 'role-logistics',
  admin: 'role-admin',
  hrManager: 'role-hr-manager',
  /** Dashboard, products, invoices, logistics, and profile. */
  invoiceAccess: 'role-invoice-access',
} as const;

export interface StaffRoleDoc {
  name: string;
  description?: string;
  /** Used for HR filters and sales KAM scoping */
  department: StaffDepartment;
  permissions: StaffPermission[];
  isSystem?: boolean;
  createdAt: string;
  updatedAt?: string;
  createdByUid?: string;
}

export interface StaffRoleTemplate extends StaffRoleDoc {
  id: string;
}
