import React, { useEffect, useMemo } from 'react';
import { Link, Outlet, useLocation, useNavigate } from 'react-router-dom';
import {
  Box,
  CalendarRange,
  GraduationCap,
  Hash,
  IdCard,
  Layers,
  Package,
  Percent,
  Plug,
  Printer,
  Scale,
  Tag,
  Truck,
  UserCircle,
  Users,
  Webhook,
} from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { isLocalhostDev } from '../../lib/isLocalhost';
import { canAccessNavFeature, canUsePhone, canUseWhatsApp, canViewDealersInHr, canViewHr } from '../../lib/staffAccess';

type SettingsTab = {
  id: string;
  label: string;
  path: string;
  icon: React.ReactNode;
};

function homePrefixFromPath(pathname: string): '/super-admin' | '/staff' {
  return pathname.startsWith('/staff') ? '/staff' : '/super-admin';
}

export const SettingsLayout: React.FC = () => {
  const { user } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const home = homePrefixFromPath(location.pathname);
  const isSuperAdmin = user?.role === 'super_admin';
  const showSkuCorrection = isSuperAdmin && isLocalhostDev();
  const showHr = Boolean(user && (isSuperAdmin || canViewHr(user)));
  const showTraining = Boolean(user && (isSuperAdmin || canAccessNavFeature(user, 'training')));
  const showPriceLevel = Boolean(user && (isSuperAdmin || canViewDealersInHr(user)));
  const showIntegration = canUseWhatsApp(user) || canUsePhone(user);

  const tabs = useMemo((): SettingsTab[] => {
    const profile: SettingsTab = {
      id: 'profile',
      label: 'Profile',
      path: `${home}/settings/profile`,
      icon: <UserCircle size={16} />,
    };
    const people: SettingsTab[] = [];
    if (showHr) {
      people.push({
        id: 'hr',
        label: 'HR',
        path: `${home}/settings/hr`,
        icon: <Users size={16} />,
      });
    }
    if (showTraining) {
      people.push({
        id: 'training',
        label: 'Trainings',
        path: `${home}/settings/training`,
        icon: <GraduationCap size={16} />,
      });
    }

    if (!isSuperAdmin) {
      if (showPriceLevel) {
        people.push({
          id: 'price-level',
          label: 'Price level',
          path: `${home}/settings/price-level`,
          icon: <Percent size={16} />,
        });
      }
      return [profile, ...people];
    }

    const ops: SettingsTab[] = [
      { id: 'warehouse', label: 'Warehouse', path: `${home}/settings/warehouse`, icon: <Layers size={16} /> },
      { id: 'store-room', label: 'Store room', path: `${home}/settings/store-room`, icon: <Box size={16} /> },
      { id: 'audit-cycles', label: 'Audit', path: `${home}/settings/audit-cycles`, icon: <CalendarRange size={16} /> },
      { id: 'product', label: 'Product settings', path: `${home}/settings/product`, icon: <Package size={16} /> },
      { id: 'price-level', label: 'Price level', path: `${home}/settings/price-level`, icon: <Percent size={16} /> },
      { id: 'sanoft', label: 'Sanoft', path: `${home}/settings/sanoft`, icon: <Scale size={16} /> },
      { id: 'serial-numbers', label: 'Serial numbers', path: `${home}/settings/serial-numbers`, icon: <Hash size={16} /> },
    ];
    if (showSkuCorrection) {
      ops.push({
        id: 'sku-correction',
        label: 'SKU correction',
        path: `${home}/settings/sku-correction`,
        icon: <Tag size={16} />,
      });
    }
    ops.push(
      { id: 'logistics', label: 'Logistics', path: `${home}/settings/logistics`, icon: <Truck size={16} /> },
      { id: 'local-printers', label: 'Label printing', path: `${home}/settings/local-printers`, icon: <Printer size={16} /> },
      ...(showIntegration
        ? [{ id: 'integration', label: 'Integration', path: `${home}/settings/integration`, icon: <Plug size={16} /> }]
        : []),
      { id: 'webhook', label: 'Webhook', path: `${home}/settings/webhook`, icon: <Webhook size={16} /> },
      { id: 'rc-details', label: 'RC details', path: `${home}/settings/rc-details`, icon: <IdCard size={16} /> },
    );
    return [profile, ...people, ...ops];
  }, [home, isSuperAdmin, showHr, showIntegration, showPriceLevel, showSkuCorrection, showTraining]);

  useEffect(() => {
    if (location.pathname === `${home}/settings` || location.pathname === `${home}/settings/`) {
      navigate(`${home}/settings/profile`, { replace: true });
      return;
    }
    if (
      !isLocalhostDev()
      && location.pathname.startsWith(`${home}/settings/sku-correction`)
    ) {
      navigate(`${home}/settings/profile`, { replace: true });
    }
  }, [home, location.pathname, navigate]);

  const isTabActive = (path: string) =>
    location.pathname === path || location.pathname.startsWith(`${path}/`);

  return (
    <div className="settings-hub page-content fade-in">
      <header className="settings-hub__header panel glass">
        <h2>Settings</h2>
      </header>

      <nav className="settings-hub__tabs panel glass" aria-label="Settings sections">
        {tabs.map(tab => (
          <Link
            key={tab.id}
            to={tab.path}
            className={`settings-hub__tab ${isTabActive(tab.path) ? 'is-active' : ''}`}
          >
            {tab.icon}
            {tab.label}
          </Link>
        ))}
      </nav>

      <Outlet />
    </div>
  );
};
