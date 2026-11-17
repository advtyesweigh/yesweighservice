import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { doc, getDoc } from 'firebase/firestore';
import { Navigate, useLocation, useNavigate, useParams } from 'react-router-dom';
import { db } from '../../firebase';
import { useAuth } from '../../context/AuthContext';
import { useCatalogPageHeader } from '../../context/PageHeaderContext';
import { FetchingLoader } from '../../components/FetchingLoader';
import { DealerTeamRoster, type DealerTeamAccess } from '../../components/dealers/DealerTeamRoster';
import { peekCachedDealers } from '../../lib/dealer-cache';
import { zohoDealerDisplayName } from '../../lib/logisticsDealers';
import { dealerErrorMessage, fetchDealerById } from '../../lib/dealers';
import { canSuperAdminWrite } from '../../lib/staffAccess';
import { homePathForRole, type FirestoreUserDoc } from '../../types';
import type { ZohoDealer } from '../../types/dealers';

function dealerFromCache(dealerId: string, preview: ZohoDealer | null | undefined): ZohoDealer | null {
  if (preview?.id === dealerId) return preview;
  return peekCachedDealers()?.find(row => row.id === dealerId) ?? null;
}

export const AdminDealerTeamPage: React.FC = () => {
  const { dealerId } = useParams<{ dealerId: string }>();
  const location = useLocation();
  const { user } = useAuth();
  const navigate = useNavigate();
  const home = user ? homePathForRole(user.role) : '/super-admin';
  const dealerPath = dealerId ? `${home}/dealers/${dealerId}` : `${home}/dealers`;
  const preview = (location.state as { dealer?: ZohoDealer } | null)?.dealer;

  const [dealerName, setDealerName] = useState(() => {
    if (!dealerId) return '';
    const cached = dealerFromCache(dealerId, preview);
    return cached ? zohoDealerDisplayName(cached) : '';
  });
  const [portalUserId, setPortalUserId] = useState<string | null>(() => {
    if (!dealerId) return null;
    return dealerFromCache(dealerId, preview)?.portalUserId?.trim() || null;
  });
  const [dealerAccess, setDealerAccess] = useState<DealerTeamAccess | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    if (!dealerId) return;
    setLoading(true);
    setError('');
    try {
      const cached = dealerFromCache(dealerId, preview);
      const dealer = cached ?? await fetchDealerById(dealerId);
      const name = zohoDealerDisplayName(dealer);
      const portalId = dealer.portalUserId?.trim() || null;
      setDealerName(name);
      setPortalUserId(portalId);
      if (!portalId) {
        setDealerAccess(null);
        return;
      }
      const snap = await getDoc(doc(db, 'users', portalId));
      if (!snap.exists()) {
        setDealerAccess(null);
        return;
      }
      const data = snap.data() as FirestoreUserDoc;
      setDealerAccess({
        dealerTier: data.dealerTier ?? 'standard',
        dealerAccessMode: data.dealerAccessMode ?? 'tier',
        dealerPermissions: data.dealerPermissions ?? [],
      });
    } catch (err) {
      setError(dealerErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [dealerId, preview]);

  useEffect(() => {
    void load();
  }, [load]);

  const onBack = useMemo(() => () => navigate(dealerPath), [dealerPath, navigate]);
  useCatalogPageHeader({
    title: 'Team',
    subtitle: dealerName || undefined,
    showBack: true,
    onBack,
  });

  if (user && user.role !== 'super_admin') {
    return <Navigate to={dealerPath} replace />;
  }

  if (!dealerId) return null;

  if (loading && !dealerName && !error) {
    return <FetchingLoader label="Fetching team" />;
  }

  if (error && !dealerName) {
    return (
      <div className="page-content fade-in">
        <p className="text-muted">{error}</p>
      </div>
    );
  }

  const canManage = canSuperAdminWrite(user);

  return (
    <DealerTeamRoster
      dealerAccountUid={portalUserId}
      canManage={canManage}
      allowDelete={canManage}
      passwordReset="managed"
      dealerAccess={dealerAccess}
      blockedReason={portalUserId
        ? null
        : 'This dealer has no portal account. Create a dealer login first.'}
    />
  );
};
