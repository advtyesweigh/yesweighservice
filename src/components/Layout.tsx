import React, { useState, useEffect, useRef } from 'react';
import { Outlet, useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import type { User } from '../types';
import { useCart } from '../context/useCart';
import { useCartFly } from '../context/useCartFly';
import { homePathForRole } from '../types';
import { canUseOrderCart, orderCartPathForUser } from '../lib/salesOrderSegments';
import { dealerStaffTeam, hideDealerStaffCommercials } from '../lib/dealerAccess';
import { navigateBack } from '../lib/navigation';
import { HrStaffPhoto } from './hr/HrStaffPhoto';
import {
  canAccessNavFeature,
  canUsePhone,
  canUseWhatsApp,
  canViewHr,
  isInvoiceAccessOnlyStaff,
  type StaffNavFeature,
} from '../lib/staffAccess';
import {
  ArrowLeft,
  ChevronDown,
  LayoutDashboard,
  Package,
  LifeBuoy,
  GraduationCap,
  Bot,
  Wrench,
  RotateCcw,
  MessageSquareWarning,
  FileText,
  ShoppingCart,
  UserCircle,
  Settings,
  Users,
  Building2,
  Menu,
  X,
  UserRoundPlus,
  ListTodo,
  Truck,
  Gift,
  BarChart3,
  ClipboardList,
  Phone,
  ShoppingBag,
  PackageCheck,
  PackagePlus,
  RefreshCw,
  Stamp,
  List,
  Percent,
  AppWindow,
} from 'lucide-react';
import { getAppVersionLabel } from '../lib/appVersion';
import { openMissedLast24h } from '../lib/phoneLog';
import { subscribePhoneEvents } from '../lib/phoneEvents';
import { refreshAppAndData } from '../lib/refreshApp';
import { PageHeaderProvider, usePageHeader } from '../context/PageHeaderContext';
import { ZohoApiQuotaBanner } from './admin/ZohoApiQuotaBanner';

type NavItem = {
  path: string;
  icon: React.ReactNode;
  label: string;
  badge?: number;
};

const OPS_PRIORITY_SUFFIXES = [
  '/logistics',
  '/warranty-support',
] as const;

/** Shown after Goods receipt, before Reports. */
const OPS_BEFORE_REPORTS_SUFFIXES = [
  '/loyalty',
] as const;

const OPS_REST_SUFFIXES = [
  ...OPS_BEFORE_REPORTS_SUFFIXES,
] as const;

const OPS_PATH_SUFFIXES = [...OPS_PRIORITY_SUFFIXES, ...OPS_REST_SUFFIXES] as const;

function SidebarWhatsAppIcon({ size = 18 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden className="nav-icon--whatsapp">
      <path
        fill="currentColor"
        d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.435 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"
      />
    </svg>
  );
}

function operationsNavItems(
  home: string,
  suffixes: readonly string[] = OPS_PATH_SUFFIXES,
): NavItem[] {
  return portalNavItems(home, 'dealer').filter(item =>
    suffixes.some(suffix => item.path === `${home}${suffix}`),
  );
}

function portalNavItems(
  home: string,
  order: 'dealer' | 'staff' | 'dealer_staff' = 'dealer',
): NavItem[] {
  const items: Record<string, NavItem> = {
    catalog: { path: `${home}/products`, icon: <Package size={20} />, label: 'Products' },
    priceList: { path: `${home}/price-list`, icon: <List size={20} />, label: 'Price list' },
    orders: {
      path: `${home}/sales-orders`,
      icon: <ClipboardList size={20} />,
      label: 'Sales orders',
    },
    complaints: { path: `${home}/complaints`, icon: <MessageSquareWarning size={20} />, label: 'Complaints' },
    warrantySupport: {
      path: `${home}/warranty-support`,
      icon: <LifeBuoy size={20} />,
      label: 'Warranty & Support',
    },
    reports: { path: `${home}/reports`, icon: <BarChart3 size={20} />, label: 'Reports' },
    services: { path: `${home}/services`, icon: <Wrench size={20} />, label: 'Services' },
    returns: { path: `${home}/returns`, icon: <RotateCcw size={20} />, label: 'Returns' },
    invoices: { path: `${home}/invoices`, icon: <FileText size={20} />, label: 'Invoice' },
    gatc: { path: `${home}/verification`, icon: <Stamp size={20} />, label: 'GATC' },
    goodsReceipts: {
      path: `${home}/goods-receipts`,
      icon: <PackageCheck size={20} />,
      label: 'Goods receipt',
    },
    spareIndents: {
      path: `${home}/spare-indents`,
      icon: <PackagePlus size={20} />,
      label: 'Spare Indent',
    },
    logistics: { path: `${home}/logistics`, icon: <Truck size={20} />, label: 'Logistics' },
    loyalty: { path: `${home}/loyalty`, icon: <Gift size={20} />, label: 'Loyalty' },
    rewardPoint: { path: `${home}/loyalty`, icon: <Gift size={20} />, label: 'Reward point' },
    scheme: { path: `${home}/scheme`, icon: <Percent size={20} />, label: 'Scheme' },
    aiAssistant: { path: `${home}/ai-assistant`, icon: <Bot size={20} />, label: 'AI assistance' },
    software: { path: `${home}/software`, icon: <AppWindow size={20} />, label: 'Software' },
    training: { path: `${home}/training`, icon: <GraduationCap size={20} />, label: 'Trainings' },
  };

  const sequence =
    order === 'staff'
      ? [
          'catalog',
          'logistics',
          'warrantySupport',
          'goodsReceipts',
          'spareIndents',
          'loyalty',
          'aiAssistant',
        ]
        : order === 'dealer_staff'
        ? [
            'catalog',
            'priceList',
            'orders',
            'logistics',
            'warrantySupport',
            'scheme',
            'rewardPoint',
            'training',
            'aiAssistant',
          ]
        : [
          'catalog',
          'priceList',
          'orders',
          'invoices',
          'logistics',
          'warrantySupport',
          'reports',
          'loyalty',
          'training',
          'aiAssistant',
        ];

  return sequence.map((key) => {
    const item = items[key];
    if (order !== 'dealer_staff') return item;
    if (key === 'catalog') return { ...item, label: 'Product' };
    if (key === 'orders') return { ...item, label: 'Sales order' };
    if (key === 'logistics') return { ...item, label: 'Logistic' };
    if (key === 'training') return { ...item, label: 'Training' };
    if (key === 'aiAssistant') return { ...item, label: 'AI' };
    return item;
  });
}

function staffPathToFeature(path: string): StaffNavFeature {
  if (path === '/staff') return 'dashboard';
  const suffix = path.replace(/^\/staff\/?/, '').split('/')[0];
  const map: Record<string, StaffNavFeature> = {
    tasks: 'tasks',
    dealers: 'dealers',
    leads: 'leads',
    catalog: 'catalog',
    products: 'catalog',
    orders: 'orders',
    spares: 'catalog',
    'warranty-support': 'warranty-support',
    verification: 'verification',
    advertisements: 'advertisements',
    certificate: 'dealers',
    invoices: 'invoices',
    'sales-orders': 'sales-orders',
    'purchase-orders': 'purchase-orders',
    'goods-receipts': 'goods-receipts',
    'spare-indents': 'spare-indents',
    logistics: 'logistics',
    loyalty: 'loyalty',
    'ai-assistant': 'ai-assistant',
    whatsapp: 'whatsapp',
    phone: 'phone',
    training: 'training',
    settings: 'dashboard',
    hr: 'staff',
    reports: 'reports',
  };
  return map[suffix] ?? 'dashboard';
}

function filterStaffNavItems(user: User, items: NavItem[]): NavItem[] {
  return items.filter(item => canAccessNavFeature(user, staffPathToFeature(item.path)));
}

export const Layout: React.FC = () => (
  <PageHeaderProvider>
    <LayoutShell />
  </PageHeaderProvider>
);

const LayoutShell: React.FC = () => {
  const { user } = useAuth();
  const { itemCount } = useCart();
  const { registerCartTarget, cartBump } = useCartFly();
  const { config: pageHeader, headerSlot, titleMeta, titleBelow, topBarAction } = usePageHeader();
  const cartBtnRef = useRef<HTMLButtonElement>(null);
  const navigate = useNavigate();
  const location = useLocation();
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [isMobile, setIsMobile] = useState(window.innerWidth <= 768);
  const [missedCalls, setMissedCalls] = useState(0);
  const [pageRefreshKey, setPageRefreshKey] = useState(0);
  const [appSyncing, setAppSyncing] = useState(false);

  useEffect(() => {
    const onResize = () => setIsMobile(window.innerWidth <= 768);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const topBarRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!canUsePhone(user)) {
      setMissedCalls(0);
      return undefined;
    }
    return subscribePhoneEvents(rows => {
      setMissedCalls(openMissedLast24h(rows));
    }, () => undefined);
  }, [user?.role, user?.superAdminAccess]);

  useEffect(() => {
    if (!isMobile || !headerSlot) return undefined;
    const bar = topBarRef.current;
    const main = bar?.closest('.main-content') as HTMLElement | null;
    if (!bar || !main) return undefined;

    const syncHeaderHeight = () => {
      main.style.setProperty('--header-height', `${Math.ceil(bar.getBoundingClientRect().height)}px`);
    };

    syncHeaderHeight();
    const observer = new ResizeObserver(syncHeaderHeight);
    observer.observe(bar);
    window.addEventListener('resize', syncHeaderHeight);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', syncHeaderHeight);
      main.style.removeProperty('--header-height');
    };
  }, [isMobile, headerSlot, topBarAction, location.pathname, pageHeader.mobileCompactHeader]);

  useEffect(() => {
    setMobileOpen(false);
  }, [location.pathname]);

  useEffect(() => {
    const openMenu = () => setMobileOpen(true);
    window.addEventListener('yesweigh:open-menu', openMenu);
    return () => window.removeEventListener('yesweigh:open-menu', openMenu);
  }, []);

  // Keep cart fly target even when pages inject topBarAction (e.g. spare filters/sync).
  const showCartFlyTarget = canUseOrderCart(user)
    && !/\/warranty-support(\/|$)/.test(location.pathname)
    && !/\/team(\/|$)/.test(location.pathname);
  const showProfileDp = false;

  useEffect(() => {
    if (showCartFlyTarget) {
      registerCartTarget(cartBtnRef.current);
    } else {
      registerCartTarget(null);
    }
    return () => registerCartTarget(null);
  }, [registerCartTarget, showCartFlyTarget, itemCount, topBarAction]);

  if (!user) return null;

  const getNavItems = (): NavItem[] => {
    switch (user.role) {
      case 'super_admin':
        return [
          { path: '/super-admin', icon: <LayoutDashboard size={20} />, label: 'Dashboard' },
          { path: '/super-admin/products', icon: <Package size={20} />, label: 'Products' },
          ...(canUseWhatsApp(user)
            ? [{ path: '/super-admin/whatsapp', icon: <SidebarWhatsAppIcon />, label: 'WhatsApp' }]
            : []),
          ...(canUsePhone(user)
            ? [{ path: '/super-admin/phone', icon: <Phone size={20} />, label: 'Phone', badge: missedCalls }]
            : []),
          { path: '/super-admin/sales-orders', icon: <ClipboardList size={20} />, label: 'Sales orders' },
          { path: '/super-admin/invoices', icon: <FileText size={20} />, label: 'Invoices' },
          ...operationsNavItems('/super-admin', OPS_PRIORITY_SUFFIXES),
          { path: '/super-admin/dealers', icon: <Building2 size={20} />, label: 'Dealers' },
          { path: '/super-admin/certificate', icon: <Stamp size={20} />, label: 'GATC' },
          { path: '/super-admin/purchase-orders', icon: <ShoppingBag size={20} />, label: 'Purchase order' },
          { path: '/super-admin/goods-receipts', icon: <PackageCheck size={20} />, label: 'Goods receipt' },
          { path: '/super-admin/spare-indents', icon: <PackagePlus size={20} />, label: 'Spare Indent' },
          ...operationsNavItems('/super-admin', OPS_BEFORE_REPORTS_SUFFIXES),
          { path: '/super-admin/reports', icon: <BarChart3 size={20} />, label: 'Reports' },
          { path: '/super-admin/software', icon: <AppWindow size={20} />, label: 'Software' },
        ];
      case 'staff': {
        const portal = portalNavItems('/staff', 'staff');
        const withExtras = [...portal];
        const productsIndex = withExtras.findIndex(item => item.path.endsWith('/products'));
        const insertAt = productsIndex >= 0 ? productsIndex + 1 : 0;
        withExtras.splice(
          insertAt,
          0,
          { path: '/staff/whatsapp', icon: <SidebarWhatsAppIcon />, label: 'WhatsApp' },
          { path: '/staff/phone', icon: <Phone size={20} />, label: 'Phone', badge: missedCalls },
          { path: '/staff/sales-orders', icon: <ClipboardList size={20} />, label: 'Sales orders' },
          { path: '/staff/invoices', icon: <FileText size={20} />, label: 'Invoices' },
        );
        const reportsAnchor = withExtras.findIndex(item => item.path.endsWith('/ai-assistant'));
        const reportsItem = { path: '/staff/reports', icon: <BarChart3 size={20} />, label: 'Reports' };
        if (reportsAnchor >= 0) {
          withExtras.splice(reportsAnchor + 1, 0, reportsItem);
        } else {
          withExtras.push(reportsItem);
        }
        const items: NavItem[] = [
          { path: '/staff', icon: <LayoutDashboard size={20} />, label: 'Dashboard' },
          ...withExtras,
          { path: '/staff/tasks', icon: <ListTodo size={20} />, label: 'Tasks' },
          { path: '/staff/dealers', icon: <Building2 size={20} />, label: 'Dealers' },
          { path: '/staff/certificate', icon: <Stamp size={20} />, label: 'GATC' },
          { path: '/staff/leads', icon: <UserRoundPlus size={20} />, label: 'Leads' },
        ];
        return filterStaffNavItems(user, items);
      }
      case 'dealer':
        return [
          ...portalNavItems('/dealer', 'dealer'),
          { path: '/dealer/team', icon: <Users size={20} />, label: 'Team' },
        ];
      case 'dealer_staff': {
        const items = [
          ...portalNavItems(
            '/dealer-staff',
            dealerStaffTeam(user) === 'admin' ? 'dealer' : 'dealer_staff',
          ),
          { path: '/dealer-staff/team', icon: <Users size={20} />, label: 'Team' },
        ];
        if (hideDealerStaffCommercials(user)) {
          return items.filter(item => !item.path.endsWith('/price-list'));
        }
        return items;
      }
      case 'media':
        return [
          { path: '/media', icon: <LayoutDashboard size={20} />, label: 'Home' },
          { path: '/media/products', icon: <Package size={20} />, label: 'Products' },
        ];
      default:
        return [];
    }
  };

  const navItems = getNavItems();
  const home = homePathForRole(user.role);
  const isSuperAdmin = user.role === 'super_admin';
  const compactTopNav = isInvoiceAccessOnlyStaff(user);
  const usesSettingsFooter = isSuperAdmin
    || (user.role === 'staff'
      && (canViewHr(user) || canAccessNavFeature(user, 'training')));
  const footerNavPath = usesSettingsFooter ? `${home}/settings` : `${home}/profile`;
  const footerLabel = usesSettingsFooter ? 'Settings' : 'Profile';
  const isFooterNavActive = usesSettingsFooter
    ? location.pathname === footerNavPath || location.pathname.startsWith(`${footerNavPath}/`)
    : location.pathname === footerNavPath;

  const currentNavItem = navItems.find(item => {
    if (location.pathname === item.path) return true;
    if (item.path === home) return false;
    return location.pathname.startsWith(`${item.path}/`);
  });

  const isCatalogSpareDetail = /\/(?:products|catalog)\/spare\/[^/]+$/.test(location.pathname);
  const isCatalogProductDetail = /\/(?:products|catalog)\/[^/]+$/.test(location.pathname)
    && !isCatalogSpareDetail
    && !/\/(?:products|catalog)\/map\//.test(location.pathname)
    && !location.pathname.endsWith('/products')
    && !location.pathname.endsWith('/catalog');
  const isProductDetail = isCatalogProductDetail
    || isCatalogSpareDetail
    || /\/spares\/[^/]+$/.test(location.pathname)
    || /^\/oc\/[^/]+$/.test(location.pathname);
  const isSpareMapDetail = /\/(?:products|catalog)\/map\/[^/]+$/.test(location.pathname)
    || /\/spares\/product\/[^/]+$/.test(location.pathname);
  const isDealerDetail = /\/dealers\/[^/]+$/.test(location.pathname);
  const dealerListPath = isDealerDetail
    ? location.pathname.replace(/\/[^/]+$/, '')
    : null;
  // Exclude list helpers like /invoices/import from "invoice detail" title handling.
  const isInvoiceDetail = /\/invoices\/(?!(?:sync|import)(?:\/|$))[^/]+(\/(invoice(\/view)?|payments|logistic|qc))?$/.test(
    location.pathname,
  );
  const isPurchaseOrderDetail = /\/purchase-orders\/(?!sync(?:\/|$))[^/]+(\/view)?$/.test(
    location.pathname,
  );
  const isGoodsReceiptDetail = /\/goods-receipts\/(?!sync(?:\/|$))[^/]+(\/view)?$/.test(
    location.pathname,
  );
  const isSalesOrderDetail = /\/sales-orders\/(?!sync(?:\/|$)|portal(?:\/|$))[^/]+(\/view)?$/.test(
    location.pathname,
  );
  const isSupportDetail = /\/warranty-support\/[^/]+$/.test(location.pathname)
    && !location.pathname.endsWith('/complaint-guidelines');
  const pageTitle = isFooterNavActive
    ? footerLabel
    : isDealerDetail
      ? 'Dealer'
    : isInvoiceDetail
      ? 'Invoice'
    : isSalesOrderDetail
      ? 'Sales order'
    : isPurchaseOrderDetail
      ? 'Purchase order'
    : isGoodsReceiptDetail
      ? 'Goods receipt'
    : isSupportDetail
      ? 'Complaint'
    : isSpareMapDetail
      ? 'Map spares'
    : isProductDetail
      ? 'Product Details'
      : (currentNavItem?.label ?? 'Dashboard');
  const displayTitle = pageHeader.title ?? pageTitle;
  const isDashboardHome = location.pathname === home;
  const showHeaderBack = Boolean(pageHeader.showBack && pageHeader.onBack);
  const mobileCompactHeader = Boolean(pageHeader.mobileCompactHeader && isMobile);
  const showTrailing = Boolean(topBarAction || showCartFlyTarget || showProfileDp);

  const versionControl = (
    <span className="top-bar__version-group">
      <button
        type="button"
        className="top-bar__sync-btn"
        onClick={() => {
          if (appSyncing) return;
          setAppSyncing(true);
          void refreshAppAndData().finally(() => setAppSyncing(false));
        }}
        disabled={appSyncing}
        aria-label="Update app and data"
        title="Update app and data"
      >
        <RefreshCw size={16} className={appSyncing ? 'spin-icon' : undefined} />
      </button>
      <span
        className="top-bar__version"
        title="App version. If a feature looks outdated, tap sync to update."
      >
        {getAppVersionLabel()}
      </span>
    </span>
  );

  const handleNavClick = (path: string) => {
    const isProductsRoot = path.endsWith('/products');
    if (location.pathname === path) {
      if (isProductsRoot && location.search) {
        navigate(path, { replace: true });
        window.scrollTo({ top: 0, behavior: 'smooth' });
      } else {
        setPageRefreshKey(k => k + 1);
        window.scrollTo({ top: 0, behavior: 'smooth' });
      }
    } else {
      navigate(path);
    }
    setMobileOpen(false);
  };

  const isActive = (path: string) => {
    if (path === home) return location.pathname === path;
    return location.pathname === path || location.pathname.startsWith(`${path}/`);
  };

  return (
    <div className="app-wrapper">
      {isMobile && mobileOpen && (
        <button
          type="button"
          className="sidebar-backdrop"
          aria-label="Close menu"
          onClick={() => setMobileOpen(false)}
        />
      )}

      <aside
        className={[
          'sidebar',
          isMobile ? 'sidebar--mobile' : '',
          collapsed && !isMobile ? 'collapsed' : '',
          isMobile && mobileOpen ? 'mobile-open' : '',
          compactTopNav ? 'sidebar--nav-top' : '',
        ]
          .filter(Boolean)
          .join(' ')}
      >
        <div className="sidebar-header sidebar-header--compact">
          {isMobile ? (
            <button
              type="button"
              className="collapse-btn"
              onClick={() => setMobileOpen(false)}
              aria-label="Close menu"
            >
              <X size={18} />
            </button>
          ) : (
            <button
              type="button"
              className="collapse-btn"
              onClick={() => setCollapsed(c => !c)}
              aria-label="Toggle sidebar"
            >
              {collapsed ? <Menu size={18} /> : <X size={18} />}
            </button>
          )}
        </div>

        <nav className="nav-menu">
          {navItems.map(item => (
            <button
              key={item.path}
              type="button"
              className={`nav-item ${isActive(item.path) ? 'active' : ''}`}
              onClick={() => handleNavClick(item.path)}
            >
              <span className="nav-icon">
                {item.icon}
                {item.badge !== undefined && item.badge > 0 && (
                  <span className="nav-badge" aria-label={`${item.badge} items in cart`}>
                    {item.badge > 99 ? '99+' : item.badge}
                  </span>
                )}
              </span>
              {!collapsed && <span className="nav-label">{item.label}</span>}
            </button>
          ))}
        </nav>

        {footerNavPath && (
          <div className="sidebar-profile">
            <button
              type="button"
              className={`nav-item ${isFooterNavActive ? 'active' : ''}`}
              onClick={() => handleNavClick(usesSettingsFooter ? `${home}/settings/profile` : footerNavPath)}
              aria-label={usesSettingsFooter ? 'Open settings' : 'Open profile'}
              title={footerLabel}
            >
              <span className="nav-icon">
                {usesSettingsFooter ? <Settings size={20} /> : <UserCircle size={20} />}
              </span>
              {!collapsed && (
                <span className="nav-label">{footerLabel}</span>
              )}
            </button>
          </div>
        )}
      </aside>

      <main className={`main-content ${collapsed && !isMobile ? 'expanded' : ''}`}>
        <header
          ref={topBarRef}
          className={[
            'top-bar',
            headerSlot && isMobile && !mobileCompactHeader ? 'top-bar--with-slot' : '',
            headerSlot && !isMobile ? 'top-bar--with-inline-slot' : '',
            mobileCompactHeader ? 'top-bar--compact-search' : '',
          ].filter(Boolean).join(' ')}
        >
          <div className="top-bar__primary">
          {isMobile && (
            <button
              type="button"
              className="mobile-menu-btn"
              onClick={() => setMobileOpen(true)}
              aria-label="Open menu"
            >
              <Menu size={22} />
              {missedCalls > 0 ? (
                <span className="nav-unread--menu">{missedCalls > 99 ? '99+' : missedCalls}</span>
              ) : null}
            </button>
          )}
          {showHeaderBack && (
            <button
              type="button"
              className="top-bar__back-btn"
              onClick={() => pageHeader.onBack?.()}
              aria-label="Back"
            >
              <ArrowLeft size={22} />
            </button>
          )}
          {mobileCompactHeader ? (
            <div className="top-bar__slot top-bar__slot--compact">
              {headerSlot}
            </div>
          ) : isDashboardHome ? (
            versionControl
          ) : dealerListPath ? (
            <button
              type="button"
              className={[
                'top-bar__title-block',
                'page-title',
                'page-title--nav-back',
                titleMeta ? 'top-bar__title-block--with-meta' : '',
              ].filter(Boolean).join(' ')}
              onClick={() => navigateBack(navigate, dealerListPath)}
            >
              <span className="page-title__copy">
                <span className={[
                  'page-title__text',
                  pageHeader.accentTitle ? 'page-title__text--accent' : '',
                ].filter(Boolean).join(' ')}>{displayTitle}</span>
                {pageHeader.subtitle && (
                  <span className="page-subtitle">{pageHeader.subtitle}</span>
                )}
                {titleBelow ? <span className="page-title__below">{titleBelow}</span> : null}
              </span>
              {titleMeta ? <span className="page-title__meta">{titleMeta}</span> : null}
            </button>
          ) : pageHeader.onTitleClick ? (
            <button
              type="button"
              className={[
                'top-bar__title-block',
                'top-bar__title-block--toggle',
                'page-title',
                titleMeta ? 'top-bar__title-block--with-meta' : '',
                pageHeader.titleExpanded ? 'is-expanded' : '',
              ].filter(Boolean).join(' ')}
              onClick={() => pageHeader.onTitleClick?.()}
              aria-expanded={pageHeader.titleExpanded === true}
              aria-label="Toggle request details"
            >
              <span className="page-title__copy">
                <span className="top-bar__title-row">
                  <span className={[
                    'page-title__text',
                    pageHeader.accentTitle ? 'page-title__text--accent' : '',
                  ].filter(Boolean).join(' ')}>{displayTitle}</span>
                  <ChevronDown size={18} className="top-bar__title-chevron" aria-hidden />
                </span>
                {pageHeader.subtitle && (
                  <span className="page-subtitle">{pageHeader.subtitle}</span>
                )}
                {titleBelow ? <span className="page-title__below">{titleBelow}</span> : null}
              </span>
              {titleMeta ? <span className="page-title__meta">{titleMeta}</span> : null}
            </button>
          ) : (
            <div
              className={[
                'top-bar__title-block',
                titleMeta ? 'top-bar__title-block--with-meta' : '',
              ].filter(Boolean).join(' ')}
            >
              <div className="page-title__copy">
                <h1 className="page-title">
                  <span className={[
                    'page-title__text',
                    pageHeader.accentTitle ? 'page-title__text--accent' : '',
                  ].filter(Boolean).join(' ')}>{displayTitle}</span>
                </h1>
                {pageHeader.subtitle && (
                  <p className="page-subtitle">{pageHeader.subtitle}</p>
                )}
                {titleBelow ? <div className="page-title__below">{titleBelow}</div> : null}
              </div>
              {titleMeta ? <div className="page-title__meta">{titleMeta}</div> : null}
            </div>
          )}
          {headerSlot && !isMobile && (
            <div className="top-bar__slot top-bar__slot--inline">
              {headerSlot}
            </div>
          )}
          {showTrailing && (
          <div className="top-bar__trailing">
            {topBarAction}
            {showCartFlyTarget ? (
              <button
                ref={cartBtnRef}
                id="cart-fly-target"
                type="button"
                className={`cart-header-btn ${cartBump ? 'cart-header-btn--bump' : ''} ${itemCount > 0 ? 'cart-header-btn--has-items' : ''}`}
                onClick={() => handleNavClick(orderCartPathForUser(user, home))}
                aria-label={itemCount > 0 ? `View cart, ${itemCount} items` : 'View cart'}
                title="View cart"
              >
                <ShoppingCart size={22} />
                {itemCount > 0 && (
                  <span className="cart-header-btn__badge">{itemCount > 99 ? '99+' : itemCount}</span>
                )}
              </button>
            ) : null}
            {showProfileDp ? (
              <button
                type="button"
                className={`top-bar__profile-dp${isFooterNavActive ? ' is-active' : ''}`}
                onClick={() => handleNavClick(footerNavPath)}
                aria-label="Open profile"
                title="Profile"
              >
                <HrStaffPhoto
                  userId={user.uid}
                  photo={user}
                  className="top-bar__profile-dp-img"
                  placeholderClassName="top-bar__profile-dp-img top-bar__profile-dp-img--placeholder"
                  iconSize={18}
                />
              </button>
            ) : null}
          </div>
          )}
          </div>
          {headerSlot && isMobile && !mobileCompactHeader && (
            <div className="top-bar__slot">
              {headerSlot}
            </div>
          )}
        </header>

        <div className="content-area">
          {(user.role === 'staff' || user.role === 'super_admin') ? <ZohoApiQuotaBanner /> : null}
          <Outlet key={pageRefreshKey} />
        </div>
      </main>
    </div>
  );
};
