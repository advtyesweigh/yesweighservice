import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import {
  AlertCircle,
  ChevronRight,
  ClipboardList,
  Plus,
  Search,
  SlidersHorizontal,
  X,
} from 'lucide-react';
import type { DocumentData, DocumentSnapshot, QueryDocumentSnapshot } from 'firebase/firestore';
import { FetchingLoader } from '../../components/FetchingLoader';
import { ListTileKam } from '../../components/list/ListTileKam';
import {
  InvoiceCategoryBadgeList,
  SalesOrderTileLeadIcon,
} from '../../components/invoices/InvoiceCategoryVisual';
import { SalesOrderStageSeal } from '../../components/salesOrders/SalesOrderStageSeal';
import { SalesOrderCategoryFilterBlocks } from '../../components/salesOrders/SalesOrderCategoryFilterBlocks';
import {
  EMPTY_STAGE_COUNTS,
  SalesOrderStageFilterBlocks,
} from '../../components/salesOrders/SalesOrderStageFilterBlocks';
import { useAuth } from '../../context/AuthContext';
import { useCatalogPageHeader, usePageHeaderSlot } from '../../context/PageHeaderContext';
import {
  DealerMultiFilterPicker,
  type DealerFilterSelection,
} from '../../components/dealers/DealerMultiFilterPicker';
import { hasStaffPermission, isInternalOpsUser } from '../../lib/staffAccess';
import { resolveDealerKamName } from '../../lib/dealerKamDisplay';
import { useDealerStaffById } from '../../lib/useDealerStaffById';
import {
  aggregateAdminSalesOrdersByDealer,
  countAdminSalesOrdersByCategory,
  countAdminSalesOrdersByYesOneStages,
  countZohoRowsByCategory,
  fetchAdminSalesOrderDealerLifetimeAggregates,
  fetchAdminSalesOrdersForCustomers,
  creatorCloudSpareOrderVisible,
  fetchAdminSalesOrdersPageDetailed,
  fetchAllAdminSalesOrdersInRange,
  fetchStaffCreatedCloudSpareSalesOrders,
  isCreatorCloudOrSpareSalesOrder,
  mergeSalesOrderRows,
  salesOrderInSalespersonScope,
  tallyCreatorCloudSpareOutsideScope,
  filterAdminSalesOrders,
  loadAdminSalesOrderCursorDocs,
  toSalesOrderDateKey,
  type AdminFirestoreSalesOrder,
  type AdminSalesOrderCategoryCounts,
  type AdminSalesOrderSort,
} from '../../lib/admin-sales-orders';
import { YESONE_STAGE_FILTERS } from '../../lib/salesOrderWorkflow';
import {
  fetchAdminCustomerLocations,
  formatAdminCustomerLocation,
} from '../../lib/admin-invoices';
import { formatCurrency } from '../../lib/catalog';
import { fetchDealerById } from '../../lib/dealers';
import { salespersonScopeForUser } from '../../lib/salespersonScope';
import {
  formatInvoiceDateTime,
  formatInvoiceItemQuantity,
  getInvoicePeriodBounds,
  invoiceErrorMessage,
} from '../../lib/invoices';
import { useRevealScrollbarOnScroll } from '../../lib/useRevealScrollbarOnScroll';
import { preventMouseFocusScroll } from '../../lib/preventMouseFocusScroll';
import {
  compareSalesOrderNumberDesc,
  filterUnifiedSalesOrders,
  mapZohoOrderToUnified,
  countYesOneStages,
  type UnifiedSalesOrderRow,
} from '../../lib/unified-sales-orders';
import {
  FROM_SALES_ORDER_LIST_STATE,
  clearSalesOrderListOpenedRow,
  peekSalesOrderListReturn,
  rememberSalesOrderListReturn,
} from '../../lib/salesOrderListReturnFocus';
import type { InvoiceCategory, SalesRangePreset } from '../../types/invoices';
import { SALES_RANGE_OPTIONS } from '../../types/invoices';
import type { YesOneStageFilter } from '../../lib/salesOrderWorkflow';
import type { SalesOrderStageCounts } from '../../components/salesOrders/SalesOrderStageFilterBlocks';

const LIST_PAGE_SIZE = 25;
const SEARCH_FETCH_SIZE = 100;

const DEFAULT_RANGE: SalesRangePreset = 'financial_year';
const DEFAULT_SORT: AdminSalesOrderSort = 'latest';
const DEFAULT_CATEGORY: InvoiceCategory | 'all' = 'all';
const DEFAULT_STAGE: YesOneStageFilter | 'all' = 'payment_submitted';

const EMPTY_CATEGORY_COUNTS: AdminSalesOrderCategoryCounts = {
  all: 0,
  product: 0,
  spare: 0,
  software_key: 0,
  service: 0,
  gatc: 0,
};

const SORT_OPTIONS: Array<{ value: AdminSalesOrderSort; label: string }> = [
  { value: 'latest', label: 'Latest first' },
  { value: 'oldest', label: 'Oldest first' },
];

function UnifiedFilterSheet({
  open,
  rangePreset,
  sort,
  dealers,
  aggregate,
  aggregateAllowed,
  lifetimeAggregateAllowed,
  onClose,
  onApply,
}: {
  open: boolean;
  rangePreset: SalesRangePreset;
  sort: AdminSalesOrderSort;
  dealers: DealerFilterSelection[];
  aggregate: boolean;
  aggregateAllowed: boolean;
  lifetimeAggregateAllowed: boolean;
  onClose: () => void;
  onApply: (next: {
    rangePreset: SalesRangePreset;
    sort: AdminSalesOrderSort;
    dealers: DealerFilterSelection[];
    aggregate: boolean;
  }) => void;
}) {
  const [draftRange, setDraftRange] = useState(rangePreset);
  const [draftSort, setDraftSort] = useState(sort);
  const [draftDealers, setDraftDealers] = useState<DealerFilterSelection[]>(dealers);
  const [draftAggregate, setDraftAggregate] = useState(aggregate);

  useEffect(() => {
    if (!open) return;
    setDraftRange(rangePreset);
    setDraftSort(sort);
    setDraftDealers(dealers);
    setDraftAggregate(aggregate);
  }, [open, rangePreset, sort, dealers, aggregate]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  const draftDirty = draftRange !== DEFAULT_RANGE
    || draftSort !== DEFAULT_SORT
    || draftDealers.length > 0
    || draftAggregate;

  return createPortal(
    <>
      <button
        type="button"
        className="catalog-filter-dropdown__backdrop"
        aria-label="Close filters"
        onClick={onClose}
      />
      <div
        className="catalog-filter-dropdown panel glass"
        role="dialog"
        aria-modal="true"
        aria-label="Filter sales orders"
      >
        <div className="catalog-spares-multi-filters catalog-spares-multi-filters--dropdown">
          <div className="catalog-spares-multi-filters__header">
            <span className="catalog-spares-multi-filters__title">Filters</span>
            <div className="catalog-spares-multi-filters__header-actions">
              <button
                type="button"
                className="catalog-spares-multi-filters__close"
                onClick={onClose}
                aria-label="Close"
              >
                <X size={18} />
              </button>
            </div>
          </div>

          <div className="catalog-spares-multi-filters__body">
            <div className="catalog-spares-multi-filters__group">
              <span className="catalog-spares-multi-filters__label">Dealers</span>
              <DealerMultiFilterPicker value={draftDealers} onChange={setDraftDealers} />
            </div>

            <div className="catalog-spares-multi-filters__group">
              <span className="catalog-spares-multi-filters__label">Date range</span>
              <div className="catalog-spares-multi-filters__options" role="radiogroup" aria-label="Date range">
                {SALES_RANGE_OPTIONS.map(option => {
                  const id = `unified-so-range-${String(option.value)}`;
                  return (
                    <label key={String(option.value)} className="catalog-spares-multi-filters__option" htmlFor={id}>
                      <input
                        id={id}
                        type="radio"
                        className="catalog-spares-multi-filters__checkbox"
                        name="unified-so-date-range"
                        checked={draftRange === option.value}
                        onChange={() => setDraftRange(option.value)}
                      />
                      <span className="catalog-spares-multi-filters__option-label">{option.label}</span>
                    </label>
                  );
                })}
              </div>
            </div>

            <div className="catalog-spares-multi-filters__group">
              <span className="catalog-spares-multi-filters__label">Sorting</span>
              <div className="catalog-spares-multi-filters__options" role="radiogroup" aria-label="Sort by">
                {SORT_OPTIONS.map(option => {
                  const id = `unified-so-sort-${option.value}`;
                  return (
                    <label key={option.value} className="catalog-spares-multi-filters__option" htmlFor={id}>
                      <input
                        id={id}
                        type="radio"
                        className="catalog-spares-multi-filters__checkbox"
                        name="unified-so-sort"
                        checked={draftSort === option.value}
                        onChange={() => setDraftSort(option.value)}
                      />
                      <span className="catalog-spares-multi-filters__option-label">{option.label}</span>
                    </label>
                  );
                })}
              </div>
            </div>

            <div className="catalog-spares-multi-filters__group">
              <div className="logistics-filter-supermode">
                <div className="logistics-filter-supermode__copy">
                  <strong>Aggregate</strong>
                  <span className="text-muted text-sm">
                    {aggregateAllowed
                      ? (lifetimeAggregateAllowed
                        ? 'One row per dealer — Lifetime uses precomputed dealer totals'
                        : 'One row per dealer for the selected period')
                      : 'Pick a date range (or dealers) to enable'}
                  </span>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={draftAggregate}
                  aria-label="Aggregate sales orders by dealer"
                  disabled={!aggregateAllowed && !draftAggregate}
                  className={[
                    'logistics-filter-supermode__switch',
                    draftAggregate ? 'logistics-filter-supermode__switch--on' : '',
                  ].filter(Boolean).join(' ')}
                  onClick={() => {
                    if (!aggregateAllowed && !draftAggregate) return;
                    setDraftAggregate(prev => !prev);
                  }}
                >
                  <span className="logistics-filter-supermode__knob" />
                </button>
              </div>
            </div>
          </div>

          <div className="catalog-spares-multi-filters__footer">
            <button
              type="button"
              className="catalog-spares-multi-filters__apply"
              onClick={() => {
                onApply({
                  rangePreset: draftRange,
                  sort: draftSort,
                  dealers: draftDealers,
                  aggregate: draftAggregate && aggregateAllowed,
                });
                onClose();
              }}
            >
              Apply
            </button>
            <button
              type="button"
              className="catalog-spares-multi-filters__clear-btn"
              disabled={!draftDirty}
              onClick={() => {
                setDraftRange(DEFAULT_RANGE);
                setDraftSort(DEFAULT_SORT);
                setDraftDealers([]);
                setDraftAggregate(false);
              }}
            >
              Clear
            </button>
          </div>
        </div>
      </div>
    </>,
    document.body,
  );
}


export const AdminUnifiedSalesOrdersPage: React.FC = () => {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const { user } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const showKam = isInternalOpsUser(user);
  const dealerStaffById = useDealerStaffById(showKam);
  const dealerFilterFromUrl = searchParams.get('dealerId')?.trim() || '';
  const dealersParam = searchParams.get('dealers') || '';
  const dealersFromUrl = useMemo(
    () => dealersParam.split(',').map(id => id.trim()).filter(Boolean),
    [dealersParam],
  );
  const basePath = pathname.startsWith('/staff') ? '/staff' : '/super-admin';
  const listKey = basePath;
  const pendingReturnRef = useRef((() => {
    const focus = peekSalesOrderListReturn(listKey);
    // Only restore list UI when returning from an opened order. Otherwise stage
    // (and related paging) would stick on stale sessionStorage values like "all".
    return focus?.openedOrderId ? focus : null;
  })());
  const returnFocusAppliedRef = useRef(false);
  const canCreateStaffOrder = hasStaffPermission(user, 'orders.manage');
  const salespersonIds = useMemo(() => salespersonScopeForUser(user), [user]);
  const salespersonScopeKey = salespersonIds?.slice().sort().join(',') ?? '';
  const scrollRef = useRevealScrollbarOnScroll();

  const restored = pendingReturnRef.current;
  const restoredClientPaged = Boolean(
    restored?.search?.trim()
    || (restored?.dealers.length ?? 0) > 0
    || restored?.aggregate,
  );
  const [cursorsReady, setCursorsReady] = useState(
    () => restoredClientPaged || !restored || restored.page <= 1,
  );

  const [zohoOrders, setZohoOrders] = useState<AdminFirestoreSalesOrder[]>([]);
  const [zohoLoading, setZohoLoading] = useState(true);
  const [countsLoading, setCountsLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState(() => restored?.search ?? '');
  const [sort, setSort] = useState<AdminSalesOrderSort>(restored?.sort ?? DEFAULT_SORT);
  const [rangePreset, setRangePreset] = useState<SalesRangePreset>(
    restored?.rangePreset ?? DEFAULT_RANGE,
  );
  const [category, setCategory] = useState<InvoiceCategory | 'all'>(
    restored?.category ?? DEFAULT_CATEGORY,
  );
  const [stageFilter, setStageFilter] = useState<YesOneStageFilter | 'all'>(
    restored?.stageFilter ?? DEFAULT_STAGE,
  );
  const [selectedDealers, setSelectedDealers] = useState<DealerFilterSelection[]>(
    () => restored?.dealers ?? [],
  );
  const [aggregate, setAggregate] = useState(() => Boolean(restored?.aggregate));
  const [truncated, setTruncated] = useState(false);
  const [filterOpen, setFilterOpen] = useState(false);
  const [page, setPage] = useState(() => restored?.page ?? 1);
  const [highlightedOrderId, setHighlightedOrderId] = useState<string | null>(
    () => restored?.openedOrderId ?? null,
  );
  const [zohoTotal, setZohoTotal] = useState(0);
  const [zohoCategoryCounts, setZohoCategoryCounts] = useState<AdminSalesOrderCategoryCounts>(
    EMPTY_CATEGORY_COUNTS,
  );
  const [serverStageCounts, setServerStageCounts] = useState<SalesOrderStageCounts>(EMPTY_STAGE_COUNTS);
  const [customerLocations, setCustomerLocations] = useState(
    () => new Map<string, { district: string | null; state: string | null }>(),
  );
  const pageStartCursors = useRef<Array<DocumentSnapshot<DocumentData> | QueryDocumentSnapshot<DocumentData> | null>>([null]);
  const prevFilterKeyRef = useRef<string | null>(null);
  const [pageCursorVersion, setPageCursorVersion] = useState(0);
  const urlSeedDone = useRef(Boolean(restored?.dealers.length));

  const bounds = getInvoicePeriodBounds(rangePreset);
  const dateStart = bounds ? toSalesOrderDateKey(bounds.start) : null;
  const dateEnd = bounds ? toSalesOrderDateKey(bounds.end) : null;
  const searchActive = Boolean(search.trim());
  const dealerScoped = selectedDealers.length > 0;
  const orgWide = salespersonIds == null;
  const lifetimeAggregateAllowed = rangePreset === 'lifetime' && orgWide && !dealerScoped;
  const aggregateAllowed = Boolean(dateStart && dateEnd) || dealerScoped || lifetimeAggregateAllowed;
  const useAggregate = aggregate && aggregateAllowed;
  const useLifetimeDealerRollups = useAggregate && lifetimeAggregateAllowed;
  const attachFollowOnOrders = useCallback(async (rows: AdminFirestoreSalesOrder[]) => {
    if (salespersonIds == null || !user?.uid) return rows;
    if (page !== 1 && !searchActive && !useAggregate) return rows;
    const extra = await fetchStaffCreatedCloudSpareSalesOrders(user.uid);
    const visible = extra.filter(row => creatorCloudSpareOrderVisible(row, {
      dateStart,
      dateEnd,
      category,
      stageFilter,
    }));
    return mergeSalesOrderRows(rows, visible);
  }, [
    salespersonIds,
    user?.uid,
    page,
    searchActive,
    useAggregate,
    dateStart,
    dateEnd,
    category,
    stageFilter,
  ]);
  const selectedCustomerIds = useMemo(
    () => selectedDealers.map(d => d.id),
    [selectedDealers],
  );
  const selectedCustomerKey = selectedCustomerIds.join('|');

  useEffect(() => {
    if (aggregate && !aggregateAllowed) setAggregate(false);
  }, [aggregate, aggregateAllowed]);

  // Seed selection from ?dealerId= / ?dealers=
  useEffect(() => {
    if (urlSeedDone.current) return;
    const ids = dealersFromUrl.length
      ? dealersFromUrl
      : (dealerFilterFromUrl ? [dealerFilterFromUrl] : []);
    if (!ids.length) {
      urlSeedDone.current = true;
      return;
    }
    urlSeedDone.current = true;
    let cancelled = false;
    void Promise.all(
      ids.map(id => fetchDealerById(id).catch(() => null)),
    ).then(rows => {
      if (cancelled) return;
      const next: DealerFilterSelection[] = [];
      for (let i = 0; i < ids.length; i += 1) {
        const dealer = rows[i];
        next.push({
          id: ids[i],
          label: dealer?.companyName?.trim()
            || dealer?.contactName?.trim()
            || ids[i],
          portalUserId: dealer?.portalUserId ?? null,
        });
      }
      setSelectedDealers(next);
    });
    return () => {
      cancelled = true;
    };
  }, [dealerFilterFromUrl, dealersFromUrl]);

  const syncDealerParams = useCallback((dealers: DealerFilterSelection[]) => {
    const next = new URLSearchParams(searchParams);
    next.delete('dealerId');
    if (dealers.length === 0) {
      next.delete('dealers');
    } else if (dealers.length === 1) {
      next.set('dealerId', dealers[0].id);
      next.delete('dealers');
    } else {
      next.set('dealers', dealers.map(d => d.id).join(','));
    }
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);

  // Reset pagination when the user changes filters — not on restore or Strict Mode re-run.
  useEffect(() => {
    const currentKey = [
      search,
      rangePreset,
      stageFilter,
      category,
      sort,
      selectedCustomerKey,
      useAggregate ? '1' : '0',
      salespersonScopeKey,
    ].join('\0');
    const prev = prevFilterKeyRef.current;
    prevFilterKeyRef.current = currentKey;
    if (prev === null || prev === currentKey) return;
    setPage(1);
    pageStartCursors.current = [null];
    setPageCursorVersion(v => v + 1);
  }, [
    search,
    rangePreset,
    stageFilter,
    category,
    sort,
    selectedCustomerKey,
    useAggregate,
    salespersonScopeKey,
  ]);

  useEffect(() => {
    const focus = pendingReturnRef.current;
    if (!focus || restoredClientPaged || focus.page <= 1) {
      setCursorsReady(true);
      return;
    }
    let cancelled = false;
    const yesOneStage = stageFilter !== 'all' ? stageFilter : null;
    const yesOneStages = stageFilter === 'all' ? YESONE_STAGE_FILTERS : null;

    const hydrate = async () => {
      const ids = focus.pageCursorIds;
      const savedStartId = ids[focus.page - 1];
      if (savedStartId) {
        const snaps = await loadAdminSalesOrderCursorDocs(ids);
        if (cancelled) return;
        pageStartCursors.current = snaps.length ? snaps : [null];
        if (pageStartCursors.current[focus.page - 1]) {
          setCursorsReady(true);
          setPageCursorVersion(v => v + 1);
          return;
        }
      }

      let cursor: DocumentSnapshot<DocumentData> | QueryDocumentSnapshot<DocumentData> | null = null;
      const cursors: Array<DocumentSnapshot<DocumentData> | QueryDocumentSnapshot<DocumentData> | null> = [null];
      for (let p = 1; p < focus.page; p += 1) {
        const result = await fetchAdminSalesOrdersPageDetailed({
          sort,
          pageSize: LIST_PAGE_SIZE,
          cursor,
          category,
          dateStart,
          dateEnd,
          statusIn: null,
          yesOneStage,
          yesOneStages,
          salespersonIds,
        });
        if (cancelled) return;
        cursor = result.lastDoc;
        cursors[p] = result.lastDoc;
        if (!result.lastDoc) break;
      }
      if (cancelled) return;
      pageStartCursors.current = cursors;
      if (!cursors[focus.page - 1]) setPage(1);
      setCursorsReady(true);
      setPageCursorVersion(v => v + 1);
    };

    void hydrate().catch(() => {
      if (cancelled) return;
      setPage(1);
      pageStartCursors.current = [null];
      setCursorsReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, [
    restoredClientPaged,
    sort,
    category,
    dateStart,
    dateEnd,
    stageFilter,
    salespersonIds,
  ]);

  // Server category + YesOne stage counts — same date window (and YesOne universe).
  useEffect(() => {
    let cancelled = false;
    if (dealerScoped) {
      setCountsLoading(false);
      return;
    }
    setCountsLoading(true);
    const yesOneStage = stageFilter !== 'all' ? stageFilter : null;
    const yesOneStages = stageFilter === 'all' ? YESONE_STAGE_FILTERS : null;
    void Promise.all([
      countAdminSalesOrdersByCategory({
        dateStart,
        dateEnd,
        salespersonIds,
        yesOneStage,
        yesOneStages,
      }),
      countAdminSalesOrdersByYesOneStages({
        dateStart,
        dateEnd,
        category,
        salespersonIds,
      }),
      salespersonIds != null && user?.uid
        ? fetchStaffCreatedCloudSpareSalesOrders(user.uid)
        : Promise.resolve([] as AdminFirestoreSalesOrder[]),
    ])
      .then(([categoryCounts, stages, created]) => {
        if (cancelled) return;
        const outside = tallyCreatorCloudSpareOutsideScope(created, salespersonIds, {
          dateStart,
          dateEnd,
        });
        const nextStages = {
          review: stages.review + outside.review,
          ready_for_payment: stages.ready_for_payment + outside.ready_for_payment,
          payment_submitted: stages.payment_submitted + outside.payment_submitted,
          completed: stages.completed + outside.completed,
        };
        const visibleCreated = created.filter(row => (
          creatorCloudSpareOrderVisible(row, {
            dateStart,
            dateEnd,
            category: 'all',
            stageFilter,
          })
          && !salesOrderInSalespersonScope(row, salespersonIds)
        ));
        const extraCategories = countZohoRowsByCategory(visibleCreated);
        const nextCategories = {
          all: categoryCounts.all + extraCategories.all,
          product: categoryCounts.product + extraCategories.product,
          spare: categoryCounts.spare + extraCategories.spare,
          software_key: categoryCounts.software_key + extraCategories.software_key,
          service: categoryCounts.service + extraCategories.service,
          gatc: categoryCounts.gatc + extraCategories.gatc,
        };
        setZohoCategoryCounts(nextCategories);
        setZohoTotal(category === 'all' ? nextCategories.all : nextCategories[category]);
        setServerStageCounts(nextStages);
      })
      .catch(err => {
        if (!cancelled) setError(invoiceErrorMessage(err));
      })
      .finally(() => {
        if (!cancelled) setCountsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [
    dealerScoped,
    dateStart,
    dateEnd,
    category,
    stageFilter,
    salespersonIds,
    salespersonScopeKey,
    user?.uid,
  ]);

  // Dealer-scoped: load full date window for selected customers (newest-first).
  useEffect(() => {
    let cancelled = false;
    if (!dealerScoped) return;
    setZohoLoading(true);
    setError('');
    void fetchAdminSalesOrdersForCustomers({
      customerIds: selectedCustomerIds,
      dateStart,
      dateEnd,
      category: 'all',
      statusIn: null,
      sort,
      // Dealer drill-down: any ops staff may see that dealer's full SO history.
      salespersonIds: null,
    })
      .then(rows => {
        if (cancelled) return;
        setZohoOrders(rows);
      })
      .catch(err => {
        if (!cancelled) {
          setError(invoiceErrorMessage(err));
          setZohoOrders([]);
          setZohoCategoryCounts(EMPTY_CATEGORY_COUNTS);
          setZohoTotal(0);
        }
      })
      .finally(() => {
        if (!cancelled) setZohoLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [
    dealerScoped,
    selectedCustomerKey,
    sort,
    dateStart,
    dateEnd,
  ]);

  // Dealer-scoped sector counts: same date window + YesOne stage universe as status row.
  useEffect(() => {
    if (!dealerScoped) return;
    const stageSet = new Set<string>(
      stageFilter === 'all' ? YESONE_STAGE_FILTERS : [stageFilter],
    );
    const scoped = zohoOrders.filter(row => {
      const stage = String(row.yesOneStage || '').trim();
      return Boolean(stage && stageSet.has(stage));
    });
    const counts = countZohoRowsByCategory(scoped);
    setZohoCategoryCounts(counts);
    setZohoTotal(category === 'all' ? counts.all : counts[category]);
  }, [dealerScoped, zohoOrders, stageFilter, category]);

  // Org-wide: server-paged Zoho feed (or bounded aggregate scan).
  useEffect(() => {
    let cancelled = false;
    if (dealerScoped) return;
    if (!cursorsReady) return;

    setZohoLoading(true);
    setError('');
    setTruncated(false);

    if (useAggregate) {
      const load = useLifetimeDealerRollups
        ? fetchAdminSalesOrderDealerLifetimeAggregates().then(rows => ({
          rows,
          truncated: false,
        }))
        : fetchAllAdminSalesOrdersInRange({
          sort,
          category: 'all',
          dateStart,
          dateEnd,
          statusIn: null,
          salespersonIds,
        });

      void load
        .then(async ({ rows, truncated: wasTruncated }) => {
          if (cancelled) return;
          setZohoOrders(await attachFollowOnOrders(rows));
          setTruncated(wasTruncated);
        })
        .catch(err => {
          if (!cancelled) {
            setError(invoiceErrorMessage(err));
            setZohoOrders([]);
          }
        })
        .finally(() => {
          if (!cancelled) setZohoLoading(false);
        });
      return () => {
        cancelled = true;
      };
    }

    const cursor = pageStartCursors.current[page - 1] ?? null;
    const yesOneStage = stageFilter !== 'all' ? stageFilter : null;
    const yesOneStages = stageFilter === 'all' ? YESONE_STAGE_FILTERS : null;

    void fetchAdminSalesOrdersPageDetailed({
      sort,
      pageSize: searchActive ? SEARCH_FETCH_SIZE : LIST_PAGE_SIZE,
      cursor: searchActive ? null : cursor,
      category,
      dateStart,
      dateEnd,
      statusIn: null,
      yesOneStage,
      yesOneStages,
      salespersonIds,
    })
      .then(async result => {
        if (cancelled) return;
        setZohoOrders(await attachFollowOnOrders(result.rows));
        if (!searchActive && result.lastDoc) {
          pageStartCursors.current[page] = result.lastDoc;
        }
      })
      .catch(err => {
        if (!cancelled) {
          setError(invoiceErrorMessage(err));
          setZohoOrders([]);
        }
      })
      .finally(() => {
        if (!cancelled) setZohoLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [
    useAggregate,
    useLifetimeDealerRollups,
    page,
    pageCursorVersion,
    sort,
    category,
    dateStart,
    dateEnd,
    searchActive,
    stageFilter,
    salespersonIds,
    salespersonScopeKey,
    cursorsReady,
    attachFollowOnOrders,
  ]);

  const loading = zohoLoading || countsLoading;

  const mappedRows = useMemo(() => {
    let source = zohoOrders;
    if (useAggregate && !dealerScoped && !useLifetimeDealerRollups) {
      const prefiltered = filterAdminSalesOrders(zohoOrders, search, category);
      source = aggregateAdminSalesOrdersByDealer(prefiltered, sort);
    } else if (useAggregate && useLifetimeDealerRollups && (search.trim() || category !== 'all')) {
      source = filterAdminSalesOrders(zohoOrders, search, category);
    }

    let rows = source.map(order => mapZohoOrderToUnified(order, basePath, 'admin'));
    if (dealerScoped) {
      rows = filterUnifiedSalesOrders(rows, {
        search,
        source: 'zoho',
        statusChip: 'all',
        category,
        period: undefined,
      });
    } else if (searchActive && !useAggregate) {
      rows = filterUnifiedSalesOrders(rows, {
        search,
        source: 'zoho',
        statusChip: 'all',
        category: 'all',
        period: undefined,
      });
    }
    const oldest = sort === 'oldest';
    return [...rows].sort((a, b) => {
      const byDate = oldest ? a.sortAt - b.sortAt : b.sortAt - a.sortAt;
      if (byDate) return byDate;
      const byNumber = compareSalesOrderNumberDesc(a.primaryNumber, b.primaryNumber);
      return oldest ? -byNumber : byNumber;
    });
  }, [
    zohoOrders,
    basePath,
    search,
    searchActive,
    dealerScoped,
    category,
    useAggregate,
    useLifetimeDealerRollups,
    sort,
  ]);

  /** Server stage query already applied for org list; keep client filter for dealer/aggregate. */
  const serverStageQuery = !dealerScoped && !useAggregate && stageFilter !== 'all';

  const stageCounts = useMemo(() => {
    if (searchActive || dealerScoped || useAggregate) {
      return mappedRows.length ? countYesOneStages(mappedRows) : EMPTY_STAGE_COUNTS;
    }
    return serverStageCounts;
  }, [searchActive, dealerScoped, useAggregate, mappedRows, serverStageCounts]);

  const zohoRows = useMemo(() => {
    if (serverStageQuery || stageFilter === 'all') return mappedRows;
    return filterUnifiedSalesOrders(mappedRows, { yesOneStage: stageFilter });
  }, [mappedRows, stageFilter, serverStageQuery]);

  const clientPaged = searchActive || dealerScoped || useAggregate;

  const pageRows = useMemo(() => {
    if (clientPaged) {
      const start = (page - 1) * LIST_PAGE_SIZE;
      return zohoRows.slice(start, start + LIST_PAGE_SIZE);
    }
    return zohoRows;
  }, [clientPaged, page, zohoRows]);

  const creatorExtraOnPage = useMemo(() => {
    if (salespersonIds == null || !serverStageQuery) return 0;
    return zohoOrders.filter(row => {
      if (!isCreatorCloudOrSpareSalesOrder(row)) return false;
      if (salesOrderInSalespersonScope(row, salespersonIds)) return false;
      return String(row.yesOneStage || '').trim() !== stageFilter;
    }).length;
  }, [salespersonIds, serverStageQuery, zohoOrders, stageFilter]);

  const filteredTotal = useMemo(() => {
    if (clientPaged) return zohoRows.length;
    const base = serverStageQuery ? (stageCounts[stageFilter] || 0) : zohoTotal;
    return base + creatorExtraOnPage;
  }, [
    clientPaged,
    zohoRows.length,
    zohoTotal,
    serverStageQuery,
    stageCounts,
    stageFilter,
    creatorExtraOnPage,
  ]);

  const totalPages = useMemo(() => {
    if (filteredTotal <= 0) return 1;
    return Math.max(1, Math.ceil(filteredTotal / LIST_PAGE_SIZE));
  }, [filteredTotal]);

  useEffect(() => {
    if (loading) return;
    if (page > totalPages) setPage(totalPages);
  }, [loading, page, totalPages]);

  useEffect(() => {
    if (returnFocusAppliedRef.current || loading) return;
    const focus = pendingReturnRef.current;
    if (!focus) return;
    returnFocusAppliedRef.current = true;
    if (focus.dealers.length) syncDealerParams(focus.dealers);

    const openedId = focus.openedOrderId?.trim() || '';
    if (openedId) {
      setHighlightedOrderId(openedId);
      window.setTimeout(() => {
        setHighlightedOrderId(null);
        clearSalesOrderListOpenedRow(listKey);
      }, 4500);
    }

    window.requestAnimationFrame(() => {
      window.setTimeout(() => {
        if (openedId) {
          const el = document.querySelector(
            `[data-so-id="${CSS.escape(openedId)}"]`,
          ) as HTMLElement | null;
          if (el) {
            el.scrollIntoView({ block: 'center', behavior: 'smooth' });
            return;
          }
        }
        if (scrollRef.current && Number.isFinite(focus.scrollTop) && focus.scrollTop > 0) {
          scrollRef.current.scrollTop = focus.scrollTop;
        }
      }, 80);
    });
  }, [loading, pageRows, listKey, syncDealerParams]);

  useEffect(() => {
    const customerIds = pageRows
      .map(row => row.customerId)
      .filter((id): id is string => Boolean(id));
    if (!customerIds.length) {
      setCustomerLocations(new Map());
      return;
    }

    let cancelled = false;
    void fetchAdminCustomerLocations(customerIds).then(map => {
      if (!cancelled) setCustomerLocations(map);
    });

    return () => {
      cancelled = true;
    };
  }, [pageRows]);

  const hasActiveFilters = rangePreset !== DEFAULT_RANGE
    || stageFilter !== DEFAULT_STAGE
    || category !== DEFAULT_CATEGORY
    || sort !== DEFAULT_SORT
    || selectedDealers.length > 0
    || aggregate;

  const openAggregatedDealer = useCallback((row: UnifiedSalesOrderRow) => {
    if (!row.customerId) return;
    const dealer: DealerFilterSelection = {
      id: row.customerId,
      label: row.partyName || row.customerId,
      portalUserId: null,
    };
    setAggregate(false);
    setSelectedDealers([dealer]);
    syncDealerParams([dealer]);
  }, [syncDealerParams]);

  const openRow = (row: UnifiedSalesOrderRow) => {
    if (useAggregate && row.customerId && String(row.id).startsWith('agg-')) {
      openAggregatedDealer(row);
      return;
    }
    rememberSalesOrderListReturn(listKey, {
      search,
      stageFilter,
      category,
      rangePreset,
      sort,
      dealers: selectedDealers,
      aggregate: useAggregate,
      page,
      pageCursorIds: Array.from({ length: Math.max(page, pageStartCursors.current.length) }, (_, i) => (
        pageStartCursors.current[i]?.id ?? null
      )),
      scrollTop: scrollRef.current?.scrollTop ?? 0,
      openedOrderId: row.id,
    });
    navigate(row.href, { state: FROM_SALES_ORDER_LIST_STATE });
  };

  const headerTools = useMemo(
    () => (
      <div className="invoices-header-tools">
        <div className="catalog-search invoices-header-search">
          <Search size={15} aria-hidden />
          <input
            type="search"
            placeholder="Search SO #, customer…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            aria-label="Search sales orders"
          />
          {search && (
            <button
              type="button"
              className="invoices-header-search__clear"
              onClick={() => setSearch('')}
              aria-label="Clear search"
            >
              <X size={16} />
            </button>
          )}
        </div>
        {canCreateStaffOrder ? (
          <button
            type="button"
            className="catalog-header-filter-btn unified-so-create-header-btn"
            onClick={() => navigate(`${basePath}/sales-orders/new`)}
            aria-label="Create sales order"
            title="Create sales order"
          >
            <Plus size={20} strokeWidth={2.25} />
          </button>
        ) : null}
        <button
          type="button"
          className={[
            'catalog-header-filter-btn',
            filterOpen ? 'catalog-header-filter-btn--open' : '',
            hasActiveFilters ? 'catalog-header-filter-btn--active' : '',
          ].filter(Boolean).join(' ')}
          onClick={() => setFilterOpen(open => !open)}
          aria-expanded={filterOpen}
          aria-haspopup="dialog"
          aria-label="Filter sales orders"
          title="Filters"
        >
          <SlidersHorizontal size={20} strokeWidth={2.25} />
        </button>
      </div>
    ),
    [search, filterOpen, hasActiveFilters, canCreateStaffOrder, navigate, basePath],
  );

  useCatalogPageHeader({ mobileCompactHeader: true, title: 'Sales orders' }, true);
  usePageHeaderSlot(headerTools);

  return (
    <div className="page-content fade-in admin-invoices-page invoices-page unified-sales-orders-page">
      {canCreateStaffOrder ? (
        <div className="unified-so-create-bar">
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={() => navigate(`${basePath}/sales-orders/new`)}
          >
            <Plus size={16} strokeWidth={2.5} aria-hidden />
            New sales order
          </button>
        </div>
      ) : null}
      {canCreateStaffOrder ? (
        <button
          type="button"
          className="unified-so-create-fab"
          onClick={() => navigate(`${basePath}/sales-orders/new`)}
          aria-label="Create sales order"
          title="Create sales order"
        >
          <Plus size={24} strokeWidth={2.5} aria-hidden />
        </button>
      ) : null}
      <section className="invoices-summary" aria-label="Sales order summary">
        {(selectedDealers.length > 0 || useAggregate || truncated) && (
          <p className="unified-so-dealer-filter-note text-muted text-sm">
            {[
              selectedDealers.length > 0
                ? `Filtered to ${selectedDealers.length === 1
                  ? selectedDealers[0].label
                  : `${selectedDealers.length} dealers`}`
                : null,
              useAggregate ? 'Showing one row per dealer' : null,
              truncated ? 'Amount scan truncated at cap' : null,
            ].filter(Boolean).join(' · ')}.
          </p>
        )}

        <SalesOrderStageFilterBlocks
          audience="admin"
          value={stageFilter}
          counts={stageCounts}
          loading={loading}
          onChange={setStageFilter}
        />
        <SalesOrderCategoryFilterBlocks
          value={category}
          counts={zohoCategoryCounts}
          loading={loading}
          onChange={setCategory}
        />
      </section>

      <div ref={scrollRef} className="invoices-page__scroll">
        {error && (
          <div className="products-inline-error panel glass admin-invoices-error" role="alert">
            <AlertCircle size={18} />
            <span>{error}</span>
          </div>
        )}

        {loading && pageRows.length === 0 ? (
          <FetchingLoader label="Loading sales orders…" />
        ) : pageRows.length === 0 ? (
          <div className="invoices-empty panel glass">
            <ClipboardList size={40} className="text-muted" aria-hidden />
            <p>No sales orders match these filters.</p>
          </div>
        ) : (
          <>
            {totalPages > 1 && (
              <div className="invoices-pagination invoices-pagination--top" role="navigation" aria-label="List pagination">
                <span className="invoices-pagination__info text-muted text-sm">
                  {pageRows.length
                    ? `${(page - 1) * LIST_PAGE_SIZE + 1}–${(page - 1) * LIST_PAGE_SIZE + pageRows.length}`
                    : '0'}
                  {' of '}
                  {filteredTotal.toLocaleString('en-IN')}
                  {searchActive ? ' (search sample)' : ''}
                </span>
                <div className="invoices-pagination__btns">
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    disabled={page <= 1 || loading}
                    onClick={() => setPage(p => p - 1)}
                  >
                    Prev
                  </button>
                  <span className="invoices-pagination__page text-sm">
                    {page} / {totalPages}
                  </span>
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    disabled={page >= totalPages || loading}
                    onClick={() => setPage(p => p + 1)}
                  >
                    Next
                  </button>
                </div>
              </div>
            )}

            <div className="panel glass invoices-table-panel admin-invoices-table-panel">
              <div className="invoices-table-wrap invoices-table-wrap--desktop">
                <table className="invoices-table">
                  <thead>
                    <tr>
                      <th>Order</th>
                      <th>Party</th>
                      <th className="invoices-table__num">Qty</th>
                      <th className="invoices-table__num">Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pageRows.map(row => {
                      const locationLabel = formatAdminCustomerLocation(
                        row.customerId ? customerLocations.get(row.customerId) : undefined,
                      );
                      return (
                      <tr
                        key={row.key}
                        data-so-id={row.id}
                        className={[
                          'invoices-table__row--clickable',
                          row.sealKind ? 'unified-so-row--with-seal' : '',
                          highlightedOrderId === row.id ? 'invoices-table__row--return-focus' : '',
                        ].filter(Boolean).join(' ')}
                        onClick={() => openRow(row)}
                        onMouseDown={preventMouseFocusScroll}
                        onKeyDown={e => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            openRow(row);
                          }
                        }}
                        role="button"
                        tabIndex={0}
                        aria-label={`View ${row.primaryNumber}`}
                      >
                        <td>
                          <div className="unified-so-order-cell">
                            <strong>{row.primaryNumber}</strong>
                            <span className="invoices-table__ref text-muted text-sm">
                              {formatInvoiceDateTime(row.date, row.createdTime)}
                            </span>
                            <span className="unified-so-order-cell__badges">
                              <InvoiceCategoryBadgeList
                                categories={row.categories}
                                invoiceCategory={row.category}
                              />
                              {row.priceCustomized ? (
                                <span className="unified-so-price-badge" title="Custom prices on this order">
                                  Custom price
                                </span>
                              ) : null}
                              {row.sealKind ? (
                                <SalesOrderStageSeal kind={row.sealKind} size="inline" />
                              ) : null}
                              <span className={row.statusClass}>{row.statusLabel}</span>
                            </span>
                          </div>
                        </td>
                        <td>
                          <div className="unified-so-order-cell">
                            <span>{row.partyName}</span>
                            {showKam ? (
                              <ListTileKam
                                name={resolveDealerKamName({
                                  zohoCustomerId: row.customerId,
                                  documentSalespersonName: row.salespersonName,
                                  dealerStaffById,
                                })}
                              />
                            ) : null}
                            {locationLabel ? (
                              <span className="invoices-table__ref text-muted text-sm">
                                {locationLabel}
                              </span>
                            ) : null}
                          </div>
                        </td>
                        <td className="invoices-table__num">{formatInvoiceItemQuantity(row.qty)}</td>
                        <td className="invoices-table__num">
                          {formatCurrency(
                            category === 'all'
                              ? row.amount
                              : Number(row.categoryAmounts[category] ?? row.amount ?? 0),
                            row.currencyCode,
                          )}
                        </td>
                      </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              <div className="invoices-mobile-list admin-invoices-mobile-list">
                <div className="invoices-mobile-list__head" aria-hidden>
                  <span>Order</span>
                  <span>Amount</span>
                </div>
                {pageRows.map(row => {
                  const locationLabel = formatAdminCustomerLocation(
                    row.customerId ? customerLocations.get(row.customerId) : undefined,
                  );
                  return (
                  <button
                    key={row.key}
                    type="button"
                    data-so-id={row.id}
                    className={[
                      'invoices-mobile-row',
                      'invoices-mobile-row--po-stack',
                      'unified-so-mobile-row',
                      row.sealKind ? 'unified-so-mobile-row--with-seal' : '',
                      highlightedOrderId === row.id ? 'invoices-mobile-row--return-focus' : '',
                    ].filter(Boolean).join(' ')}
                    onClick={() => openRow(row)}
                    onMouseDown={preventMouseFocusScroll}
                    aria-label={`View ${row.primaryNumber}${row.sealKind ? `, ${row.sealKind.replace(/_/g, ' ')}` : ''}`}
                  >
                    <SalesOrderTileLeadIcon
                      category={row.category}
                      categories={row.categories}
                      freightSku={row.freightSku}
                    />
                    <span className="invoices-mobile-row__body">
                      <span className="invoices-mobile-row__invoice">
                        <span className="invoices-mobile-row__title">
                          <strong>{row.primaryNumber}</strong>
                          <span className="invoices-mobile-row__meta unified-so-mobile-row__date">
                            {formatInvoiceDateTime(row.date, row.createdTime)}
                          </span>
                        </span>
                        <strong className="invoices-mobile-row__company">
                          {row.partyName}
                        </strong>
                        <span className="invoices-mobile-row__pair unified-so-mobile-row__kam-line">
                          {showKam ? (
                            <ListTileKam
                              name={resolveDealerKamName({
                                zohoCustomerId: row.customerId,
                                documentSalespersonName: row.salespersonName,
                                dealerStaffById,
                              })}
                            />
                          ) : null}
                          <strong className="invoices-mobile-row__amount-value">
                            {formatCurrency(
                              category === 'all'
                                ? row.amount
                                : Number(row.categoryAmounts[category] ?? row.amount ?? 0),
                              row.currencyCode,
                            )}
                          </strong>
                        </span>
                        <span className="invoices-mobile-row__pair unified-so-mobile-row__footer">
                          <span className="invoices-mobile-row__meta">
                            {locationLabel ? (
                              <>
                                {locationLabel}
                                {' • '}
                              </>
                            ) : null}
                            Qty {formatInvoiceItemQuantity(row.qty)}
                          </span>
                          <span className={row.statusClass}>{row.statusLabel}</span>
                        </span>
                      </span>
                    </span>
                    {row.sealKind ? (
                      <SalesOrderStageSeal kind={row.sealKind} size="tile" />
                    ) : null}
                    <span className="invoices-mobile-row__chevron" aria-hidden>
                      <ChevronRight size={18} />
                    </span>
                  </button>
                  );
                })}
              </div>
            </div>

            {totalPages > 1 && (
              <footer className="invoices-pagination invoices-pagination--sticky">
                <span className="invoices-pagination__info text-muted text-sm">
                  {pageRows.length
                    ? `${(page - 1) * LIST_PAGE_SIZE + 1}–${(page - 1) * LIST_PAGE_SIZE + pageRows.length}`
                    : '0'}
                  {' of '}
                  {filteredTotal.toLocaleString('en-IN')}
                  {searchActive ? ' (search sample)' : ''}
                </span>
                <div className="invoices-pagination__btns">
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    disabled={page <= 1 || loading}
                    onClick={() => setPage(p => p - 1)}
                  >
                    Prev
                  </button>
                  <span className="invoices-pagination__page text-sm">
                    {page} / {totalPages}
                  </span>
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    disabled={page >= totalPages || loading}
                    onClick={() => setPage(p => p + 1)}
                  >
                    Next
                  </button>
                </div>
              </footer>
            )}
          </>
        )}
      </div>

      <UnifiedFilterSheet
        open={filterOpen}
        rangePreset={rangePreset}
        sort={sort}
        dealers={selectedDealers}
        aggregate={aggregate}
        aggregateAllowed={aggregateAllowed}
        lifetimeAggregateAllowed={lifetimeAggregateAllowed}
        onClose={() => setFilterOpen(false)}
        onApply={next => {
          setRangePreset(next.rangePreset);
          setSort(next.sort);
          setSelectedDealers(next.dealers);
          setAggregate(next.aggregate);
          syncDealerParams(next.dealers);
        }}
      />
    </div>
  );
};
