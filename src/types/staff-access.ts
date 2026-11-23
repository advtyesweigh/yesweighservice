import type { SupportRequestType } from './dealer-support';

export type StaffDepartment = 'sales' | 'service' | 'logistics' | 'admin';

export const STAFF_DEPARTMENTS: StaffDepartment[] = ['sales', 'service', 'logistics', 'admin'];

export const STAFF_DEPARTMENT_LABELS: Record<StaffDepartment, string> = {
  sales: 'Sales',
  service: 'Service',
  logistics: 'Logistics',
  admin: 'Admin',
};

export const STAFF_DEPARTMENT_DESCRIPTIONS: Record<StaffDepartment, string> = {
  sales: 'Dealers, leads, and account relationships',
  service: 'Repairs, complaints, and warranty support',
  logistics: 'Orders, RMA, and dispatch',
  admin: 'Catalog, staff, and organisation-wide operations',
};

export type StaffPermission =
  | 'dealers.view'
  | 'dealers.edit'
  | 'dealers.sync'
  | 'yesgatc.rc_link'
  | 'leads.view'
  | 'leads.manage'
  | 'support.view'
  | 'support.manage'
  | 'support.service'
  | 'support.return'
  | 'support.complaint'
  | 'orders.view'
  | 'orders.manage'
  | 'catalog.view'
  | 'catalog.manage'
  | 'catalog.sync'
  | 'staff.manage'
  | 'hr.view'
  | 'hr.manage'
  | 'tasks.view'
  | 'invoices.view'
  | 'logistics.view'
  | 'loyalty.view'
  | 'verification.view'
  | 'verification.manage'
  | 'advertisements.view';

export const ALL_STAFF_PERMISSIONS: StaffPermission[] = [
  'dealers.view',
  'dealers.edit',
  'dealers.sync',
  'yesgatc.rc_link',
  'leads.view',
  'leads.manage',
  'support.view',
  'support.manage',
  'support.service',
  'support.return',
  'support.complaint',
  'orders.view',
  'orders.manage',
  'catalog.view',
  'catalog.manage',
  'catalog.sync',
  'staff.manage',
  'hr.view',
  'hr.manage',
  'tasks.view',
  'invoices.view',
  'logistics.view',
  'loyalty.view',
  'verification.view',
  'verification.manage',
  'advertisements.view',
];

export const STAFF_PERMISSION_LABELS: Record<StaffPermission, string> = {
  'dealers.view': 'View dealers',
  'dealers.edit': 'Edit dealers',
  'dealers.sync': 'Sync dealers from Zoho',
  'yesgatc.rc_link': 'Link GATC regional centers to dealers',
  'leads.view': 'View leads',
  'leads.manage': 'Manage leads',
  'support.view': 'View support tickets',
  'support.manage': 'Manage ticket status & chat',
  'support.service': 'Service / repair tickets',
  'support.return': 'Replacement / RMA tickets',
  'support.complaint': 'Complaint tickets',
  'orders.view': 'View orders',
  'orders.manage': 'Manage orders',
  'catalog.view': 'Browse products',
  'catalog.manage': 'Edit products & spares',
  'catalog.sync': 'Sync products from Zoho',
  'staff.manage': 'Manage staff roles',
  'hr.view': 'View HR staff directory',
  'hr.manage': 'Manage HR staff & documents',
  'tasks.view': 'View tasks',
  'invoices.view': 'View invoices',
  'logistics.view': 'View logistics',
  'loyalty.view': 'View loyalty programs',
  'verification.view': 'View verifications',
  'verification.manage': 'Manage verifications',
  'advertisements.view': 'View advertisements',
};

export const STAFF_PERMISSION_GROUPS: Array<{
  id: string;
  label: string;
  permissions: StaffPermission[];
}> = [
  {
    id: 'dealers',
    label: 'Dealers',
    permissions: ['dealers.view', 'dealers.edit', 'dealers.sync', 'yesgatc.rc_link'],
  },
  {
    id: 'leads',
    label: 'Leads',
    permissions: ['leads.view', 'leads.manage'],
  },
  {
    id: 'support',
    label: 'Warranty & support',
    permissions: [
      'support.view',
      'support.manage',
      'support.service',
      'support.return',
      'support.complaint',
    ],
  },
  {
    id: 'orders',
    label: 'Orders & logistics',
    permissions: ['orders.view', 'orders.manage', 'logistics.view'],
  },
  {
    id: 'catalog',
    label: 'Products',
    permissions: ['catalog.view', 'catalog.manage', 'catalog.sync'],
  },
  {
    id: 'hr',
    label: 'Human resources',
    permissions: ['hr.view', 'hr.manage', 'staff.manage'],
  },
  {
    id: 'org',
    label: 'Organisation',
    permissions: ['tasks.view'],
  },
  {
    id: 'other',
    label: 'Other',
    permissions: [
      'invoices.view',
      'loyalty.view',
      'verification.view',
      'verification.manage',
      'advertisements.view',
    ],
  },
];

export const DEPARTMENT_DEFAULT_PERMISSIONS: Record<StaffDepartment, StaffPermission[]> = {
  sales: [
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
  ],
  service: [
    'support.view',
    'support.manage',
    'support.service',
    'support.complaint',
    'verification.view',
    'verification.manage',
    'catalog.view',
  ],
  logistics: [
    'orders.view',
    'orders.manage',
    'support.view',
    'support.return',
    'invoices.view',
    'logistics.view',
    'loyalty.view',
    'catalog.view',
  ],
  admin: [...ALL_STAFF_PERMISSIONS],
};

export const DEPARTMENT_SUPPORT_TYPES: Record<StaffDepartment, SupportRequestType[] | 'all'> = {
  sales: [],
  service: ['service', 'complaint', 'chat'],
  logistics: ['return'],
  admin: 'all',
};

export type StaffAccessMode = 'role' | 'custom' | 'department';

export type StaffAccessProfile = {
  department: StaffDepartment;
  accessMode: StaffAccessMode;
  roleId: string | null;
  permissions: StaffPermission[];
  teamId: string | null;
};

export const DEFAULT_STAFF_ACCESS: StaffAccessProfile = {
  department: 'admin',
  accessMode: 'role',
  roleId: null,
  permissions: [],
  teamId: null,
};

/** Invoice access: dashboard, products, invoices, logistics, profile. */
export const INVOICE_ACCESS_PERMISSIONS: StaffPermission[] = [
  'catalog.view',
  'invoices.view',
  'logistics.view',
];

export const HR_MANAGER_PERMISSIONS: StaffPermission[] = [
  'hr.view',
  'hr.manage',
  'staff.manage',
  'dealers.view',
  'dealers.edit',
  'tasks.view',
  'catalog.view',
  'invoices.view',
];

/** Code templates for system staff roles. Keys match SYSTEM_STAFF_ROLE_IDS. */
export const SYSTEM_STAFF_ROLE_PERMISSIONS: Record<string, StaffPermission[]> = {
  'role-sales': DEPARTMENT_DEFAULT_PERMISSIONS.sales,
  'role-service': DEPARTMENT_DEFAULT_PERMISSIONS.service,
  'role-logistics': DEPARTMENT_DEFAULT_PERMISSIONS.logistics,
  'role-admin': ALL_STAFF_PERMISSIONS,
  'role-hr-manager': HR_MANAGER_PERMISSIONS,
  'role-invoice-access': INVOICE_ACCESS_PERMISSIONS,
};
