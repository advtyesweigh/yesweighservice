import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  AlertTriangle,
  Ban,
  Building2,
  Check,
  ChevronRight,
  ClipboardList,
  Clock,
  Loader2,
  PackagePlus,
  Shield,
  Truck,
  UserCheck,
  UserMinus,
} from 'lucide-react';
import { DashboardPeriodFilter } from './DashboardPeriodFilter';
import { useAuth } from '../../context/AuthContext';
import { useTopBarAction } from '../../context/PageHeaderContext';
import { loadAdminInvoiceKpis } from '../../lib/admin-invoices';
import { countAdminPurchaseOrders } from '../../lib/admin-purchase-orders';
import {
  countAdminSalesOrdersByYesOneStages,
  fetchStaffCreatedCloudSpareSalesOrders,
  tallyCreatorCloudSpareOutsideScope,
} from '../../lib/admin-sales-orders';
import {
  defaultDashboardCustomRange,
  formatDashboardPeriodLabel,
  resolveDashboardPeriodBounds,
  type DashboardPeriodPreset,
} from '../../lib/dashboardPeriod';
import { playDealerSuccessSound, unlockDealerActionAudio } from '../../lib/dealerActionSound';
import { dealerErrorMessage, fetchDealerStats } from '../../lib/dealers';
import { countOpsSupportRequestsInRange } from '../../lib/dealerSupport';
import {
  ensureDealersCached,
  peekCachedDealers,
  subscribeDealerCache,
} from '../../lib/dealer-cache';
import { computeDealerStats } from '../../lib/dealerRosterQuery';
import { salespersonScopeForUser } from '../../lib/salespersonScope';
import {
  KotakUncategorizedPopup,
  type KotakPopupPhase,
} from './KotakUncategorizedPopup';
import {
  fetchKotakBankFeedSummary,
  fetchKotakBankFeeds,
  refreshKotakBankFeeds,
  type KotakBankFeed,
} from '../../lib/kotakBankFeeds';
import kotakBankLogo from '../../assets/kotak-mahindra-bank.jpg';
import type { DealerStats } from '../../types/dealers';

const EMPTY_OPS_COUNTS = {
  newOrders: 0,
  pendingApproval: 0,
  toDispatch: 0,
  warrantySupport: 0,
  openComplaints: 0,
  purchaseOrders: 0,
};

export type OpsDealerDashboardProps = {
  basePath: string;
  variant: 'org' | 'kam';
};

export function OpsDealerDashboard({ basePath, variant }: OpsDealerDashboardProps) {
  const navigate = useNavigate();
  const { user } = useAuth();
  const kamScoped = variant === 'kam';
  const salespersonIds = useMemo(
    () => (kamScoped ? salespersonScopeForUser(user) ?? [] : undefined),
    [kamScoped, user],
  );

  const [dealerStats, setDealerStats] = useState<DealerStats | null>(null);
  const [assignedDealerIds, setAssignedDealerIds] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [opsLoading, setOpsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [opsPeriod, setOpsPeriod] = useState<DashboardPeriodPreset>('month');
  const [customRange, setCustomRange] = useState(defaultDashboardCustomRange);
  const [opsCounts, setOpsCounts] = useState(EMPTY_OPS_COUNTS);
  const [kotakPhase, setKotakPhase] = useState<'idle' | 'working' | 'ok' | 'fail'>('idle');
  const [kotakMessage, setKotakMessage] = useState<string | null>(null);
  const [kotakUncategorized, setKotakUncategorized] = useState<number | null>(null);
  const [kotakCountLoading, setKotakCountLoading] = useState(!kamScoped);
  const [kotakLastRefresh, setKotakLastRefresh] = useState<string | null>(null);
  const [kotakPopupOpen, setKotakPopupOpen] = useState(false);
  const [kotakPopupPhase, setKotakPopupPhase] = useState<KotakPopupPhase>('refreshing');
  const [kotakPopupError, setKotakPopupError] = useState<string | null>(null);
  const [kotakFeeds, setKotakFeeds] = useState<KotakBankFeed[]>([]);
  const [kotakFetchedAt, setKotakFetchedAt] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (kamScoped) {
      const applyRoster = (dealers: import('../../types/dealers').ZohoDealer[]) => {
        const mine = dealers.filter(dealer => dealer.assignedStaffUid === user?.uid);
        setDealerStats(computeDealerStats(mine));
        setAssignedDealerIds(mine.map(dealer => dealer.id).filter(Boolean));
        setLoading(false);
      };
      applyRoster(peekCachedDealers() ?? []);
      const unsub = subscribeDealerCache(dealers => {
        if (!cancelled) applyRoster(dealers);
      });
      void ensureDealersCached()
        .catch(err => {
          if (!cancelled) setError(err instanceof Error ? err.message : dealerErrorMessage(err));
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
      return () => {
        cancelled = true;
        unsub();
      };
    }

    const load = async () => {
      setLoading(true);
      setError(null);
      try {
        const stats = await fetchDealerStats();
        if (!cancelled) setDealerStats(stats);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : dealerErrorMessage(err));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [kamScoped, user?.uid]);

  useEffect(() => {
    if (kamScoped) return;
    let cancelled = false;
    const loadKotakCount = async () => {
      setKotakCountLoading(true);
      try {
        const summary = await fetchKotakBankFeedSummary();
        if (!cancelled) {
          setKotakUncategorized(summary.uncategorizedCount);
          setKotakLastRefresh(summary.lastRefreshDate);
        }
      } catch {
        if (!cancelled) setKotakUncategorized(null);
      } finally {
        if (!cancelled) setKotakCountLoading(false);
      }
    };
    void loadKotakCount();
    return () => {
      cancelled = true;
    };
  }, [kamScoped]);

  const periodBounds = useMemo(
    () => resolveDashboardPeriodBounds(opsPeriod, customRange.start, customRange.end),
    [customRange.end, customRange.start, opsPeriod],
  );
  const periodLabel = useMemo(
    () => formatDashboardPeriodLabel(periodBounds.start, periodBounds.end),
    [periodBounds.end, periodBounds.start],
  );

  useEffect(() => {
    let cancelled = false;
    const loadOps = async () => {
      setOpsLoading(true);
      try {
        const [stages, createdOrders, invoiceKpi, warrantySupport, openComplaints, purchaseOrders] = await Promise.all([
          countAdminSalesOrdersByYesOneStages({
            dateStart: periodBounds.start,
            dateEnd: periodBounds.end,
            salespersonIds,
          }),
          kamScoped && user?.uid
            ? fetchStaffCreatedCloudSpareSalesOrders(user.uid)
            : Promise.resolve([]),
          loadAdminInvoiceKpis({
            dateStart: periodBounds.start,
            dateEnd: periodBounds.end,
            category: 'all',
            salespersonIds,
          }),
          countOpsSupportRequestsInRange(periodBounds.start, periodBounds.end, {
            types: ['service', 'return', 'chat'],
            ...(kamScoped ? { dealerIds: assignedDealerIds } : {}),
          }),
          countOpsSupportRequestsInRange(periodBounds.start, periodBounds.end, {
            types: ['complaint'],
            ...(kamScoped ? { dealerIds: assignedDealerIds } : {}),
          }),
          kamScoped
            ? Promise.resolve(0)
            : countAdminPurchaseOrders({
              dateStart: periodBounds.start,
              dateEnd: periodBounds.end,
              status: '',
            }),
        ]);
        if (cancelled) return;
        const createdOutside = tallyCreatorCloudSpareOutsideScope(createdOrders, salespersonIds, {
          dateStart: periodBounds.start,
          dateEnd: periodBounds.end,
        });
        const invoiceStatuses = invoiceKpi.byFilterStatus ?? {};
        setOpsCounts({
          newOrders: stages.review + createdOutside.review,
          pendingApproval: stages.payment_submitted + createdOutside.payment_submitted,
          toDispatch: invoiceStatuses.to_dispatch ?? 0,
          warrantySupport,
          openComplaints,
          purchaseOrders,
        });
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : dealerErrorMessage(err));
        }
      } finally {
        if (!cancelled) setOpsLoading(false);
      }
    };
    void loadOps();
    return () => {
      cancelled = true;
    };
  }, [
    assignedDealerIds,
    kamScoped,
    periodBounds.end,
    periodBounds.start,
    salespersonIds,
    user?.uid,
  ]);

  const periodFilter = useMemo(
    () => (
      <DashboardPeriodFilter
        preset={opsPeriod}
        customFrom={customRange.start}
        customTo={customRange.end}
        rangeLabel={periodLabel}
        onPresetChange={next => {
          setOpsPeriod(next);
          if (next === 'custom' && (!customRange.start || !customRange.end)) {
            setCustomRange(defaultDashboardCustomRange());
          }
        }}
        onCustomFromChange={start => setCustomRange(prev => ({ ...prev, start }))}
        onCustomToChange={end => setCustomRange(prev => ({ ...prev, end }))}
      />
    ),
    [customRange.end, customRange.start, opsPeriod, periodLabel],
  );

  useTopBarAction(periodFilter);

  const openKotakFeeds = async () => {
    if (kotakPhase === 'working') return;
    unlockDealerActionAudio();
    setKotakPhase('working');
    setKotakMessage(null);
    setKotakPopupOpen(true);
    setKotakPopupPhase('refreshing');
    setKotakPopupError(null);
    setKotakFeeds([]);
    setKotakFetchedAt(null);
    try {
      try {
        const refresh = await refreshKotakBankFeeds();
        if (typeof refresh.uncategorizedCount === 'number') {
          setKotakUncategorized(refresh.uncategorizedCount);
        }
        if (refresh.lastRefreshDate) setKotakLastRefresh(refresh.lastRefreshDate);
        await new Promise(resolve => window.setTimeout(resolve, 3000));
      } catch (err) {
        setKotakPopupError(err instanceof Error ? err.message : 'Refresh Feeds failed in Zoho.');
      }
      playDealerSuccessSound();
      setKotakPopupPhase('loading');
      const result = await fetchKotakBankFeeds({ skipRefresh: true });
      setKotakFeeds(result.feeds || []);
      setKotakFetchedAt(result.fetchedAt || null);
      setKotakUncategorized(result.count);
      setKotakPopupPhase('ready');
      setKotakPhase('ok');
      window.setTimeout(() => {
        setKotakPhase(current => (current === 'ok' ? 'idle' : current));
      }, 2500);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Could not load Kotak bank transactions.';
      setKotakPopupPhase('error');
      setKotakPopupError(message);
      setKotakPhase('fail');
      setKotakMessage(message);
    }
  };

  const opsKpis = [
    {
      id: 'to-dispatch',
      label: 'To dispatch',
      value: opsLoading ? '…' : String(opsCounts.toDispatch),
      path: `${basePath}/invoices`,
      tone: 'orange' as const,
      icon: <Truck size={22} strokeWidth={2.5} />,
    },
    {
      id: 'pending-approval',
      label: 'Pending approval',
      value: opsLoading ? '…' : String(opsCounts.pendingApproval),
      path: `${basePath}/sales-orders`,
      tone: 'orange' as const,
      icon: <Clock size={22} strokeWidth={2.5} />,
    },
    {
      id: 'new-orders',
      label: 'New orders',
      value: opsLoading ? '…' : String(opsCounts.newOrders),
      path: `${basePath}/sales-orders`,
      tone: 'blue' as const,
      icon: <PackagePlus size={22} strokeWidth={2.5} />,
    },
    ...(!kamScoped ? [{
      id: 'purchase-orders',
      label: 'Purchase orders',
      value: opsLoading ? '…' : String(opsCounts.purchaseOrders),
      path: `${basePath}/purchase-orders`,
      tone: 'blue' as const,
      icon: <ClipboardList size={22} strokeWidth={2.5} />,
    }] : []),
    {
      id: 'warranty-support',
      label: 'Warranty support',
      value: opsLoading ? '…' : String(opsCounts.warrantySupport),
      path: `${basePath}/warranty-support`,
      tone: 'green' as const,
      icon: <Shield size={22} strokeWidth={2.5} />,
    },
    {
      id: 'open-complaints',
      label: 'Open complaints',
      value: opsLoading ? '…' : String(opsCounts.openComplaints),
      path: `${basePath}/warranty-support`,
      tone: 'red' as const,
      icon: <AlertTriangle size={22} strokeWidth={2.5} />,
    },
  ];

  const dealerKpis = [
    {
      id: 'dealers-total',
      label: 'Total Dealers',
      value: loading ? '…' : dealerStats ? String(dealerStats.total) : '—',
      path: `${basePath}/dealers`,
      tone: 'blue' as const,
      icon: <Building2 size={22} strokeWidth={2.5} />,
    },
    {
      id: 'dealers-active',
      label: 'Active Dealers',
      value: loading ? '…' : dealerStats ? String(dealerStats.active) : '—',
      path: `${basePath}/dealers`,
      tone: 'green' as const,
      icon: <UserCheck size={22} strokeWidth={2.5} />,
    },
    {
      id: 'dealers-non-active',
      label: 'Non Active Dealers',
      value: loading ? '…' : dealerStats ? String(dealerStats.nonActive) : '—',
      path: `${basePath}/dealers`,
      tone: 'orange' as const,
      icon: <UserMinus size={22} strokeWidth={2.5} />,
    },
    {
      id: 'dealers-blacklisted',
      label: 'Blacklisted Dealers',
      value: loading ? '…' : dealerStats ? String(dealerStats.blacklisted) : '—',
      path: `${basePath}/dealers`,
      tone: 'red' as const,
      icon: <Ban size={22} strokeWidth={2.5} />,
    },
  ];

  return (
    <div className="page-content fade-in dealer-dashboard">
      {error && (
        <p className="dealer-dash__error" role="alert">
          {error}
        </p>
      )}

      <section className="dealer-dash__kpis-layout" aria-label="Key metrics">
        <section className="dealer-dash-period-panel" aria-label="Orders and support">
          <div className="dealer-dash__kpis-grid dealer-dash__kpis-grid--pairs">
            {opsKpis.map(card => (
              <button
                key={card.id}
                type="button"
                className={`dealer-dash-kpi dealer-dash-kpi--${card.tone}`}
                onClick={() => navigate(card.path)}
              >
                <div className="dealer-dash-kpi__icon">{card.icon}</div>
                <div className="dealer-dash-kpi__body">
                  <span className="dealer-dash-kpi__label">{card.label}</span>
                  <strong className="dealer-dash-kpi__value">{card.value}</strong>
                </div>
                <ChevronRight size={18} className="dealer-dash-kpi__chevron" aria-hidden />
              </button>
            ))}
          </div>
        </section>

        <div className="dealer-dash__kpis-grid dealer-dash__kpis-grid--dealer-stages">
          {dealerKpis.map(card => (
            <button
              key={card.id}
              type="button"
              className={`dealer-dash-kpi dealer-dash-kpi--${card.tone}`}
              onClick={() => navigate(card.path)}
            >
              <div className="dealer-dash-kpi__icon">{card.icon}</div>
              <div className="dealer-dash-kpi__body">
                <span className="dealer-dash-kpi__label">{card.label}</span>
                <strong className="dealer-dash-kpi__value">{card.value}</strong>
              </div>
              <ChevronRight size={18} className="dealer-dash-kpi__chevron" aria-hidden />
            </button>
          ))}
          {!kamScoped ? (
            <button
              type="button"
              className={`dealer-dash-kpi dealer-dash-kpi--kotak-tile${kotakPhase === 'working' ? ' is-busy' : ''}${kotakPhase === 'ok' ? ' is-ok' : ''}${kotakPhase === 'fail' ? ' is-fail' : ''}`}
              onClick={() => void openKotakFeeds()}
              disabled={kotakPhase === 'working'}
              aria-label={
                kotakUncategorized != null
                  ? `Refresh Kotak bank feeds and show ${kotakUncategorized} uncategorised transactions.`
                  : 'Refresh Kotak bank feeds and show uncategorised transactions'
              }
              title={
                kotakUncategorized != null
                  ? `${kotakUncategorized} uncategorised · tap to refresh and view`
                  : 'Refresh Kotak bank feeds and view uncategorised transactions'
              }
            >
              <span className="dealer-dash-kpi__kotak-logo-wrap">
                {kotakPhase === 'working' ? (
                  <Loader2 size={22} className="spin-icon" />
                ) : kotakPhase === 'ok' ? (
                  <Check size={22} strokeWidth={3} />
                ) : (
                  <img
                    src={kotakBankLogo}
                    alt=""
                    className="dealer-dash-kpi__kotak-logo"
                  />
                )}
                {kotakUncategorized != null ? (
                  <span className="dealer-dash-kpi__kotak-badge" aria-hidden>
                    {kotakUncategorized > 99 ? '99+' : kotakUncategorized}
                  </span>
                ) : null}
              </span>
              <div className="dealer-dash-kpi__body">
                <span className="dealer-dash-kpi__label">Kotak</span>
                <strong className="dealer-dash-kpi__value">
                  {kotakCountLoading && kotakUncategorized == null
                    ? '…'
                    : kotakUncategorized != null
                      ? String(kotakUncategorized)
                      : '—'}
                </strong>
              </div>
            </button>
          ) : null}
        </div>
        {kotakMessage && !kotakPopupOpen ? (
          <p
            className={`dealer-dash__kotak-status${kotakPhase === 'fail' ? ' is-fail' : ''}${kotakPhase === 'ok' ? ' is-ok' : ''}`}
            role="status"
          >
            {kotakMessage}
          </p>
        ) : null}
      </section>
      {kotakPopupOpen ? (
        <KotakUncategorizedPopup
          feeds={kotakFeeds}
          fetchedAt={kotakFetchedAt}
          lastRefreshDate={kotakLastRefresh}
          phase={kotakPopupPhase}
          error={kotakPopupError}
          onRefresh={() => void openKotakFeeds()}
          onClose={() => {
            setKotakPopupOpen(false);
            if (kotakPhase === 'working' || kotakPhase === 'fail') return;
            setKotakPhase('idle');
          }}
        />
      ) : null}
    </div>
  );
}
