import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import { AlertCircle, Check, ChevronDown, Eye, EyeOff, Package, PackageCheck, Plus, Wrench, X } from 'lucide-react';
import { GoodsReceiptReceivedDialog } from '../../components/admin/GoodsReceiptReceivedDialog';
import { PoLineSerialFields } from '../../components/admin/PoLineSerialFields';
import { DocumentLineItemSpec } from '../../components/invoices/DocumentLineItemSpec';
import { ProductNcSelect } from '../../components/catalog/ProductNcSelect';
import { ProductPackageInfo } from '../../components/catalog/ProductPackageInfo';
import { PackageInfoIcon } from '../../components/catalog/PackageInfoIcon';
import { useAuth } from '../../context/AuthContext';
import { isFreightProductId, isFreightSku } from '../../constants/freightLines';
import {
  isHeadOfficeReceiveLocation,
  isReceivedBillStatus,
  markGoodsReceiptReceived,
  receiveLineLocations,
  saveGoodsReceiptReceiveCheck,
  setGoodsReceiptLineHidden,
  type AdminGoodsReceiptDetail,
  type GoodsReceiptReceiveLocation,
} from '../../lib/admin-goods-receipts';
import {
  catalogProductHasCompleteSingleBoxPackageInfo,
  catalogProductPackageNotRequired,
  expectsCatalogPackageInfo,
  isCatalogSparePartProduct,
  markCatalogProductPackageAsSpare,
  resolveCatalogProductsForLineItems,
} from '../../lib/catalog';
import { formatInvoiceDate, formatInvoiceDateTime, invoiceErrorMessage, moveFreightLinesToEnd } from '../../lib/invoices';
import {
  fetchPurchaseOrderSerialRangesByNumber,
  poLineShowsSerialRange,
  serialRangeInputsFromLines,
} from '../../lib/purchaseOrderSerials';
import { isFullSuperAdmin, isViewOnlySuperAdmin } from '../../lib/staffAccess';
import {
  listWarehouseZoneRows,
  listWarehouseZones,
} from '../../lib/warehouseLocations/data';
import type { CatalogPackageInfo, CatalogProduct } from '../../types/catalog';
import type { WarehouseZoneDoc, WarehouseZoneRowDoc } from '../../types/warehouse-locations';
import { BIN_NUMBERS, ROW_NUMBERS, VALID_RACK_LETTERS } from '../../types/yes-store';
import type { AdminGoodsReceiptDetailOutletContext } from './adminGoodsReceiptDetailContext';

function formatDiff(value: number): string {
  if (value === 0) return '0';
  return value > 0 ? `+${value}` : String(value);
}

function resolveCatalogForLine(
  line: { itemId?: string | null; sku?: string | null },
  catalogById: Record<string, CatalogProduct>,
): CatalogProduct | undefined {
  const itemId = line.itemId?.trim();
  if (itemId && catalogById[itemId]) return catalogById[itemId];
  const sku = line.sku?.trim();
  if (sku && catalogById[`sku:${sku}`]) return catalogById[`sku:${sku}`];
  return undefined;
}

type StorageScheme = 'cochin' | 'head_office';

type LocationDraft = {
  key: string;
  scheme: StorageScheme;
  zoneId: string;
  zoneRowNumber: string;
  rackId: string;
  rowNumber: string;
  binNumber: string;
  quantity: string;
};

type LineDraft = {
  locations: LocationDraft[];
};

function lineStorageScheme(
  catalogProduct: CatalogProduct | undefined,
  goodsReceipt: Pick<AdminGoodsReceiptDetail, 'inventorySite' | 'goodsReceiptCategory'>,
): StorageScheme {
  if (catalogProduct) {
    return isCatalogSparePartProduct(catalogProduct) ? 'head_office' : 'cochin';
  }
  if (goodsReceipt.inventorySite === 'head_office' || goodsReceipt.goodsReceiptCategory === 'spare') {
    return 'head_office';
  }
  return 'cochin';
}

function newLocationDraft(scheme: StorageScheme, defaultZoneId = ''): LocationDraft {
  return {
    key: crypto.randomUUID(),
    scheme,
    zoneId: scheme === 'cochin' ? defaultZoneId : '',
    zoneRowNumber: '',
    rackId: '',
    rowNumber: '',
    binNumber: '',
    quantity: '',
  };
}

function locationDraftFromSaved(loc: GoodsReceiptReceiveLocation): LocationDraft {
  const scheme: StorageScheme = isHeadOfficeReceiveLocation(loc) ? 'head_office' : 'cochin';
  return {
    key: crypto.randomUUID(),
    scheme,
    zoneId: loc.zoneId ?? '',
    zoneRowNumber: loc.zoneRowNumber != null ? String(loc.zoneRowNumber) : '',
    rackId: loc.rackId ?? '',
    rowNumber: loc.rowNumber != null ? String(loc.rowNumber) : '',
    binNumber: loc.binNumber != null ? String(loc.binNumber) : '',
    quantity: String(loc.quantity),
  };
}

function locationIdentity(loc: GoodsReceiptReceiveLocation): string {
  if (isHeadOfficeReceiveLocation(loc)) {
    return `ho:${String(loc.rackId).toLowerCase()}:${loc.rowNumber}:${loc.binNumber}:${loc.quantity}`;
  }
  return `cochin:${String(loc.zoneId || '').toLowerCase()}:${loc.zoneRowNumber ?? 0}:${loc.quantity}`;
}

function locationsEqual(
  a: GoodsReceiptReceiveLocation[],
  b: GoodsReceiptReceiveLocation[],
): boolean {
  if (a.length !== b.length) return false;
  return a.every((loc, i) => locationIdentity(loc) === locationIdentity(b[i]));
}

function parseDraftLocations(draft: LineDraft): {
  ok: true;
  locations: GoodsReceiptReceiveLocation[];
  empty: boolean;
} | {
  ok: false;
  error: string;
} {
  const prepared: GoodsReceiptReceiveLocation[] = [];
  let anyPartial = false;

  for (const row of draft.locations) {
    const qtyRaw = row.quantity.trim();
    const quantity = Number(qtyRaw);

    if (row.scheme === 'head_office') {
      const rackId = row.rackId.trim().toLowerCase();
      const rowRaw = row.rowNumber.trim();
      const binRaw = row.binNumber.trim();
      const blank = !rackId && !rowRaw && !binRaw && !qtyRaw;
      if (blank) continue;

      anyPartial = true;
      if (!rackId || !rowRaw || !binRaw) {
        return { ok: false, error: 'Each Head Office location needs a rack, row, and bin.' };
      }
      const rowNumber = Number(rowRaw);
      const binNumber = Number(binRaw);
      if (!Number.isFinite(rowNumber) || rowNumber < 1) {
        return { ok: false, error: 'Invalid Head Office row number.' };
      }
      if (!Number.isFinite(binNumber) || binNumber < 1) {
        return { ok: false, error: 'Invalid Head Office bin number.' };
      }
      if (qtyRaw === '' || !Number.isFinite(quantity) || quantity < 0) {
        return { ok: false, error: 'Enter a valid qty for each Head Office location.' };
      }
      if (quantity <= 0) continue;
      prepared.push({
        rackId,
        rowNumber: Math.floor(rowNumber),
        binNumber: Math.floor(binNumber),
        quantity: Math.floor(quantity),
      });
      continue;
    }

    const zoneId = row.zoneId.trim().toLowerCase();
    const rowRaw = row.zoneRowNumber.trim();
    const blank = !zoneId && !rowRaw && !qtyRaw;
    if (blank) continue;

    anyPartial = true;
    if (!zoneId || !rowRaw) {
      return { ok: false, error: 'Each warehouse location needs a zone and row.' };
    }
    const zoneRowNumber = Number(rowRaw);
    if (!Number.isFinite(zoneRowNumber) || zoneRowNumber < 1) {
      return { ok: false, error: 'Invalid row number.' };
    }
    if (qtyRaw === '' || !Number.isFinite(quantity) || quantity < 0) {
      return { ok: false, error: 'Enter a valid qty for each warehouse location.' };
    }
    if (quantity <= 0) continue;
    prepared.push({
      zoneId,
      zoneRowNumber: Math.floor(zoneRowNumber),
      quantity: Math.floor(quantity),
    });
  }

  return { ok: true, locations: prepared, empty: !anyPartial && prepared.length === 0 };
}

function locationDraftHasValue(loc: LocationDraft): boolean {
  if (loc.scheme === 'head_office') {
    return Boolean(
      loc.rackId.trim() || loc.rowNumber.trim() || loc.binNumber.trim() || loc.quantity.trim(),
    );
  }
  return Boolean(loc.zoneId.trim() || loc.zoneRowNumber.trim() || loc.quantity.trim());
}

function warehouseZoneLabel(zoneId: string, zones: WarehouseZoneDoc[]): string {
  const id = zoneId.trim();
  if (!id) return '—';
  const zone = zones.find(item => item.id === id);
  if (!zone) return id.toUpperCase();
  return zone.label ? `${zone.id.toUpperCase()} — ${zone.label}` : zone.id.toUpperCase();
}

function warehouseRowLabel(
  zoneId: string,
  rowNumber: string,
  rowsByZone: Record<string, WarehouseZoneRowDoc[]>,
): string {
  const n = rowNumber.trim();
  if (!n) return '—';
  const row = (rowsByZone[zoneId] ?? []).find(item => String(item.number) === n);
  if (!row) return n;
  return row.label ? `${row.number} — ${row.label}` : String(row.number);
}

export const AdminGoodsReceiptDocumentPage: React.FC = () => {
  const { user } = useAuth();
  const { goodsReceipt, setGoodsReceipt, goodsReceiptId } = useOutletContext<
    AdminGoodsReceiptDetailOutletContext
  >();

  const [lineDrafts, setLineDrafts] = useState<Record<string, LineDraft>>({});
  const [saveError, setSaveError] = useState('');
  const [saveOk, setSaveOk] = useState('');
  const [hidingLineId, setHidingLineId] = useState<string | null>(null);
  const [busy, setBusy] = useState<'draft' | 'post' | null>(null);
  const [receiveDialogOpen, setReceiveDialogOpen] = useState(false);
  const [serialDrafts, setSerialDrafts] = useState<Record<string, { startNumber: string; endNumber: string }>>({});
  const serialSeededForRef = useRef('');

  const [zones, setZones] = useState<WarehouseZoneDoc[]>([]);
  const [rowsByZone, setRowsByZone] = useState<Record<string, WarehouseZoneRowDoc[]>>({});
  const [loadingZones, setLoadingZones] = useState(true);
  const [catalogById, setCatalogById] = useState<Record<string, CatalogProduct>>({});
  const [expandedPackageIds, setExpandedPackageIds] = useState<Set<string>>(() => new Set());
  const [markingSpareProductId, setMarkingSpareProductId] = useState<string | null>(null);

  const canHideItems = isFullSuperAdmin(user);
  const canBackdateReceived = isFullSuperAdmin(user);
  const canMarkReceived = Boolean(user) && !isViewOnlySuperAdmin(user);
  const saving = Boolean(busy);

  const hiddenLineIds = useMemo(
    () => new Set(goodsReceipt?.receiveCheck?.hiddenLineIds ?? []),
    [goodsReceipt?.receiveCheck?.hiddenLineIds],
  );

  const lineItems = useMemo(
    () => (goodsReceipt ? moveFreightLinesToEnd(goodsReceipt.lineItems) : []),
    [goodsReceipt],
  );

  const visibleLineItems = useMemo(
    () => lineItems.filter(line => line.id && !hiddenLineIds.has(line.id)),
    [lineItems, hiddenLineIds],
  );

  const hiddenLineItems = useMemo(
    () => lineItems.filter(line => line.id && hiddenLineIds.has(line.id)),
    [lineItems, hiddenLineIds],
  );

  useEffect(() => {
    if (!goodsReceipt || serialSeededForRef.current === goodsReceiptId) return;
    const saved = goodsReceipt.serialRangesByLineId ?? {};
    if (Object.keys(saved).length) {
      setSerialDrafts(prev => {
        const next = { ...prev };
        const byItem = Object.values(saved);
        for (const line of goodsReceipt.lineItems) {
          if (!line.id || next[line.id]?.startNumber) continue;
          const row = saved[line.id]
            || byItem.find(item => item.itemId && item.itemId === line.itemId);
          if (!row) continue;
          next[line.id] = { startNumber: row.startNumber, endNumber: row.endNumber };
        }
        return next;
      });
    }
    const poNumber = String(goodsReceipt.purchaseOrderNumber || goodsReceipt.referenceNumber || '').trim();
    serialSeededForRef.current = goodsReceiptId;
    if (!poNumber) return;
    let cancelled = false;
    void fetchPurchaseOrderSerialRangesByNumber(poNumber)
      .then(({ ranges }) => {
        if (cancelled) return;
        setSerialDrafts(prev => {
          const next = { ...prev };
          const byItem = Object.values(ranges);
          for (const line of goodsReceipt.lineItems) {
            if (!line.id || next[line.id]?.startNumber) continue;
            const row = ranges[line.id]
              || byItem.find(item => item.itemId && item.itemId === line.itemId);
            if (!row) continue;
            next[line.id] = { startNumber: row.startNumber, endNumber: row.endNumber };
          }
          return next;
        });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [goodsReceipt, goodsReceiptId]);

  const defaultZoneId = zones[0]?.id ?? '';

  const emptyDraftForLine = (lineId: string, existing?: LocationDraft[]): LocationDraft => {
    const line = goodsReceipt?.lineItems.find(item => item.id === lineId);
    const fallback = line && goodsReceipt
      ? lineStorageScheme(resolveCatalogForLine(line, catalogById), goodsReceipt)
      : 'cochin';
    const scheme = existing?.[existing.length - 1]?.scheme ?? fallback;
    return newLocationDraft(scheme, defaultZoneId);
  };

  useEffect(() => {
    if (!goodsReceipt?.lineItems?.length) {
      setCatalogById({});
      return;
    }
    let active = true;
    void resolveCatalogProductsForLineItems(
      goodsReceipt.lineItems.map(line => ({
        itemId: line.itemId,
        sku: line.sku,
      })),
    )
      .then(next => {
        if (active) setCatalogById(next);
      })
      .catch(() => {
        if (active) setCatalogById({});
      });
    return () => {
      active = false;
    };
  }, [goodsReceipt?.lineItems]);

  useEffect(() => {
    let active = true;
    setLoadingZones(true);
    void listWarehouseZones()
      .then(async nextZones => {
        if (!active) return;
        const rowEntries = await Promise.all(
          nextZones.map(async zone => [zone.id, await listWarehouseZoneRows(zone.id)] as const),
        );
        if (!active) return;
        setZones(nextZones);
        setRowsByZone(Object.fromEntries(rowEntries));
      })
      .catch(() => {
        if (active) {
          setZones([]);
          setRowsByZone({});
        }
      })
      .finally(() => {
        if (active) setLoadingZones(false);
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!goodsReceipt) return;
    const next: Record<string, LineDraft> = {};
    const savedLines = goodsReceipt.receiveCheck?.lines ?? {};
    for (const line of goodsReceipt.lineItems) {
      if (!line.id) continue;
      const savedLocs = receiveLineLocations(savedLines[line.id]);
      const scheme = lineStorageScheme(undefined, goodsReceipt);
      next[line.id] = {
        locations: savedLocs.length > 0
          ? savedLocs.map(locationDraftFromSaved)
          : [newLocationDraft(scheme, defaultZoneId)],
      };
    }
    setLineDrafts(next);
    setSaveError('');
    setSaveOk('');
  }, [goodsReceipt, defaultZoneId]);

  useEffect(() => {
    if (!goodsReceipt || Object.keys(catalogById).length === 0) return;
    setLineDrafts(prev => {
      let changed = false;
      const next = { ...prev };
      const savedLines = goodsReceipt.receiveCheck?.lines ?? {};
      for (const line of goodsReceipt.lineItems) {
        if (!line.id) continue;
        if (receiveLineLocations(savedLines[line.id]).length > 0) continue;
        const current = next[line.id];
        if (!current || current.locations.some(locationDraftHasValue)) continue;
        const scheme = lineStorageScheme(resolveCatalogForLine(line, catalogById), goodsReceipt);
        if (current.locations.every(loc => loc.scheme === scheme)) continue;
        next[line.id] = { locations: [newLocationDraft(scheme, defaultZoneId)] };
        changed = true;
      }
      return changed ? next : prev;
    });
  }, [catalogById, goodsReceipt, defaultZoneId]);

  const dirty = useMemo(() => {
    if (!goodsReceipt) return false;
    const savedLines = goodsReceipt.receiveCheck?.lines ?? {};
    for (const line of goodsReceipt.lineItems) {
      if (!line.id || hiddenLineIds.has(line.id)) continue;
      const scheme = lineStorageScheme(resolveCatalogForLine(line, catalogById), goodsReceipt);
      const draft = lineDrafts[line.id] ?? { locations: [newLocationDraft(scheme, defaultZoneId)] };
      const parsed = parseDraftLocations(draft);
      if (!parsed.ok) return true;
      const saved = receiveLineLocations(savedLines[line.id]);
      if (parsed.empty && saved.length === 0) continue;
      if (!locationsEqual(parsed.locations, saved)) return true;
    }
    return false;
  }, [goodsReceipt, lineDrafts, hiddenLineIds, catalogById, defaultZoneId]);

  const missingPackageLines = useMemo(() => {
    if (!goodsReceipt) return [] as Array<{ lineId: string; name: string; productId: string }>;
    const missing: Array<{ lineId: string; name: string; productId: string }> = [];
    const seen = new Set<string>();
    for (const line of goodsReceipt.lineItems) {
      if (!line.id || hiddenLineIds.has(line.id)) continue;
      if (isFreightProductId(line.itemId) || isFreightSku(line.sku)) continue;
      const product = resolveCatalogForLine(line, catalogById);
      if (!product) continue;
      if (goodsReceipt.goodsReceiptCategory === 'spare' || goodsReceipt.inventorySite === 'head_office') {
        continue;
      }
      if (!expectsCatalogPackageInfo(product)) continue;
      if (catalogProductHasCompleteSingleBoxPackageInfo(product)) continue;
      if (seen.has(product.id)) continue;
      seen.add(product.id);
      missing.push({
        lineId: line.id,
        name: line.name || product.name || product.sku || product.id,
        productId: product.id,
      });
    }
    return missing;
  }, [goodsReceipt, catalogById, hiddenLineIds]);

  const packageDataReady = missingPackageLines.length === 0;

  if (!goodsReceipt) return null;

  const togglePackageExpanded = (lineId: string) => {
    setExpandedPackageIds(prev => {
      const next = new Set(prev);
      if (next.has(lineId)) next.delete(lineId);
      else next.add(lineId);
      return next;
    });
  };

  const onPackageInfoSaved = (productId: string, info: CatalogPackageInfo) => {
    setCatalogById(prev => {
      const existing = prev[productId];
      if (!existing) return prev;
      return { ...prev, [productId]: { ...existing, packageInfo: info } };
    });
  };

  const applyPackageNotRequired = (productId: string) => {
    setCatalogById(prev => {
      const patch = (product: CatalogProduct | undefined) => (
        product
          ? { ...product, packageNotRequired: true, packageNotRequiredReason: 'spare' as const }
          : product
      );
      const next = { ...prev };
      let changed = false;
      for (const [key, product] of Object.entries(prev)) {
        if (product.id !== productId && key !== productId) continue;
        next[key] = patch(product) ?? product;
        changed = true;
      }
      return changed ? next : prev;
    });
  };

  const handleToggleHidden = async (lineId: string, hidden: boolean) => {
    if (!user?.uid || !canHideItems) return;
    setHidingLineId(lineId);
    setSaveError('');
    try {
      const receiveCheck = await setGoodsReceiptLineHidden(
        goodsReceiptId,
        lineId,
        hidden,
        {
          lineItems: goodsReceipt.lineItems,
          previous: goodsReceipt.receiveCheck,
        },
        {
          uid: user.uid,
          displayName: user.displayName,
        },
      );
      setGoodsReceipt(prev => (prev ? { ...prev, receiveCheck } : prev));
      if (hidden) {
        setLineDrafts(prev => {
          const next = { ...prev };
          delete next[lineId];
          return next;
        });
      }
    } catch (err) {
      setSaveError(invoiceErrorMessage(err));
    } finally {
      setHidingLineId(null);
    }
  };

  const setLocationDraft = (
    lineId: string,
    locationKey: string,
    patch: Partial<Omit<LocationDraft, 'key'>>,
  ) => {
    setLineDrafts(prev => {
      const current = prev[lineId] ?? { locations: [emptyDraftForLine(lineId)] };
      return {
        ...prev,
        [lineId]: {
          locations: current.locations.map(loc => (
            loc.key === locationKey ? { ...loc, ...patch } : loc
          )),
        },
      };
    });
    setSaveOk('');
    setSaveError('');
  };

  const addLocation = (lineId: string) => {
    setLineDrafts(prev => {
      const current = prev[lineId] ?? { locations: [] };
      return {
        ...prev,
        [lineId]: {
          locations: [...current.locations, emptyDraftForLine(lineId, current.locations)],
        },
      };
    });
    setSaveOk('');
    setSaveError('');
  };

  const removeLocation = (lineId: string, locationKey: string) => {
    setLineDrafts(prev => {
      const current = prev[lineId] ?? { locations: [emptyDraftForLine(lineId)] };
      const nextLocations = current.locations.filter(loc => loc.key !== locationKey);
      return {
        ...prev,
        [lineId]: {
          locations: nextLocations.length > 0
            ? nextLocations
            : [emptyDraftForLine(lineId, nextLocations)],
        },
      };
    });
    setSaveOk('');
    setSaveError('');
  };

  const collectReceiveLines = (): Record<string, {
    locations: GoodsReceiptReceiveLocation[];
  }> | null => {
    const lines: Record<string, {
      locations: GoodsReceiptReceiveLocation[];
    }> = {};

    for (const line of goodsReceipt.lineItems) {
      if (!line.id || hiddenLineIds.has(line.id)) continue;
      const scheme = lineStorageScheme(resolveCatalogForLine(line, catalogById), goodsReceipt);
      const draft = lineDrafts[line.id] ?? { locations: [newLocationDraft(scheme, defaultZoneId)] };
      const parsed = parseDraftLocations(draft);
      if (!parsed.ok) {
        setSaveError(`${parsed.error} (${line.name})`);
        return null;
      }
      if (parsed.empty) continue;
      if (parsed.locations.length === 0) {
        setSaveError(`Enter qty for at least one warehouse location on ${line.name}.`);
        return null;
      }
      lines[line.id] = { locations: parsed.locations };
    }
    return lines;
  };

  const collectSerialRangeInputs = () => {
    if (!goodsReceipt) return [];
    return serialRangeInputsFromLines(
      goodsReceipt.lineItems
        .filter(line => poLineShowsSerialRange(line))
        .map(line => ({
          lineId: line.id,
          productId: String(line.itemId ?? '').trim(),
          name: line.name,
          sku: line.sku,
          imageUrl: line.imageUrl ?? null,
          startNumber: serialDrafts[line.id]?.startNumber,
          endNumber: serialDrafts[line.id]?.endNumber,
        })),
    );
  };

  const alreadyReceived = Boolean(goodsReceipt.opsReceivedAt);
  const zohoStillDraft = !isReceivedBillStatus(goodsReceipt.status);
  const receiveLocked = alreadyReceived || isReceivedBillStatus(goodsReceipt.status);
  const needsZohoOpen = alreadyReceived && zohoStillDraft;

  const handleMarkPackageAsSpare = async (productId: string) => {
    if (receiveLocked) return;
    setMarkingSpareProductId(productId);
    setSaveError('');
    try {
      await markCatalogProductPackageAsSpare(productId);
      applyPackageNotRequired(productId);
    } catch (err) {
      setSaveError(invoiceErrorMessage(err));
    } finally {
      setMarkingSpareProductId(null);
    }
  };

  const persistReceiveCheck = async (mode: 'draft' | 'post', auditedAt?: string | null) => {
    if (!user?.uid) {
      setSaveError('You must be signed in to save.');
      return null;
    }
    const lines = collectReceiveLines();
    if (!lines) return null;
    return saveGoodsReceiptReceiveCheck(
      goodsReceiptId,
      {
        lines,
        lineItems: goodsReceipt.lineItems,
        previous: goodsReceipt.receiveCheck,
        mode,
        auditedAt: mode === 'post' ? (auditedAt ?? null) : null,
        zohoAlreadyIncludesInbound: alreadyReceived || isReceivedBillStatus(goodsReceipt.status),
      },
      {
        uid: user.uid,
        displayName: user.displayName,
      },
    );
  };

  const handleSaveDraft = async () => {
    setBusy('draft');
    setSaveError('');
    setSaveOk('');
    try {
      const receiveCheck = await persistReceiveCheck('draft');
      if (!receiveCheck) return;
      setGoodsReceipt(prev => (prev ? { ...prev, receiveCheck } : prev));
      setSaveOk('Draft saved');
    } catch (err) {
      setSaveError(invoiceErrorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const openGoodsReceivedDialog = () => {
    if (!user || !canMarkReceived) return;

    if (!packageDataReady) {
      const sample = missingPackageLines
        .slice(0, 3)
        .map(row => row.name)
        .join(', ');
      setSaveError(
        `Fill single box package information (weight + L × B × H) before marking goods received${
          sample ? ` — ${sample}${missingPackageLines.length > 3 ? '…' : ''}` : ''
        }.`,
      );
      return;
    }

    if (!collectReceiveLines()) return;
    setSaveError('');
    setSaveOk('');
    setReceiveDialogOpen(true);
  };

  const handleGoodsReceived = async (receivedAtIso: string) => {
    if (!user || !canMarkReceived) return;

    setBusy('post');
    setSaveError('');
    setSaveOk('');
    try {
      const receiveCheck = await persistReceiveCheck('post', receivedAtIso);
      if (!receiveCheck) return;
      let nextStatus = goodsReceipt.status;
      let nextReceivedDate = goodsReceipt.receivedDate;
      let nextOpsReceivedAt = goodsReceipt.opsReceivedAt;
      let nextOpsReceivedByUid = goodsReceipt.opsReceivedByUid;
      let nextOpsReceivedByName = goodsReceipt.opsReceivedByName;
      const serialRanges = collectSerialRangeInputs();
      if (!alreadyReceived || zohoStillDraft || serialRanges.length) {
        const result = await markGoodsReceiptReceived(goodsReceiptId, receivedAtIso, serialRanges);
        if (serialRanges.length && result.serialAllotment?.skipped) {
          throw new Error('Serial numbers were not saved on this bill.');
        }
        nextStatus = result.status;
        nextReceivedDate = result.receivedDate;
        nextOpsReceivedAt = result.opsReceivedAt;
        nextOpsReceivedByUid = result.opsReceivedByUid;
        nextOpsReceivedByName = result.opsReceivedByName;
      }
      setGoodsReceipt(prev => (prev ? {
        ...prev,
        receiveCheck,
        status: nextStatus,
        receivedDate: nextReceivedDate,
        opsReceivedAt: nextOpsReceivedAt,
        opsReceivedByUid: nextOpsReceivedByUid,
        opsReceivedByName: nextOpsReceivedByName,
      } : prev));
      setReceiveDialogOpen(false);
      setSaveOk('Goods received');
    } catch (err) {
      setSaveError(invoiceErrorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const handleRetryZohoOpen = async () => {
    if (!user || !canMarkReceived || !needsZohoOpen) return;
    setBusy('post');
    setSaveError('');
    setSaveOk('');
    try {
      const result = await markGoodsReceiptReceived(
        goodsReceiptId,
        goodsReceipt.opsReceivedAt,
        collectSerialRangeInputs(),
      );
      setGoodsReceipt(prev => (prev ? {
        ...prev,
        status: result.status,
        receivedDate: result.receivedDate,
        opsReceivedAt: result.opsReceivedAt,
        opsReceivedByUid: result.opsReceivedByUid,
        opsReceivedByName: result.opsReceivedByName,
      } : prev));
      setSaveOk('Opened in Zoho');
    } catch (err) {
      setSaveError(invoiceErrorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const handleSaveSerialRanges = async () => {
    if (!user || !canMarkReceived) return;
    setBusy('post');
    setSaveError('');
    setSaveOk('');
    try {
      const serialRanges = collectSerialRangeInputs();
      const result = await markGoodsReceiptReceived(
        goodsReceiptId,
        goodsReceipt.opsReceivedAt,
        serialRanges,
      );
      if (serialRanges.length && result.serialAllotment?.skipped) {
        throw new Error('Serial numbers were not saved on this bill.');
      }
      const updated = Number(result.serialAllotment?.updated) || 0;
      setSaveOk(updated ? 'Serial numbers updated' : 'Serial numbers saved');
    } catch (err) {
      setSaveError(invoiceErrorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="goods-receipt-detail">
      <section className="goods-receipt-detail__meta">
        <div>
          <div className="text-muted text-sm">Vendor</div>
          <strong>{goodsReceipt.vendorName ?? '—'}</strong>
          {(goodsReceipt.vendorCity
            || goodsReceipt.vendorState
            || goodsReceipt.vendorCountry) && (
            <p className="text-muted text-sm mt-1 mb-0">
              {[
                goodsReceipt.vendorCity,
                goodsReceipt.vendorState,
                goodsReceipt.vendorCountry,
              ].filter(Boolean).join(', ')}
            </p>
          )}
        </div>
        <div className="goods-receipt-detail__dates">
          <div className="goods-receipt-detail__date goods-receipt-detail__date--po">
            <div className="text-muted text-sm">PO date</div>
            <strong>{formatInvoiceDate(goodsReceipt.poDate)}</strong>
          </div>
          <div className="goods-receipt-detail__date goods-receipt-detail__date--sailed">
            <div className="text-muted text-sm">Sailed date</div>
            <strong>{formatInvoiceDate(goodsReceipt.sailedDate)}</strong>
          </div>
          <div className="goods-receipt-detail__date goods-receipt-detail__date--received">
            <div className="text-muted text-sm">Received</div>
            <strong>
              {formatInvoiceDateTime(goodsReceipt.receivedDate, goodsReceipt.opsReceivedAt)}
            </strong>
            {alreadyReceived && goodsReceipt.opsReceivedByName && (
              <span className="text-muted text-sm">
                {goodsReceipt.opsReceivedByName}
              </span>
            )}
          </div>
        </div>
        {goodsReceipt.notes && (
          <p className="text-muted text-sm mb-0">{goodsReceipt.notes}</p>
        )}
      </section>

      <section className="invoice-detail-items goods-receipt-receive">
        <div className="goods-receipt-receive__header">
          <h3 className="invoice-detail-items__title mb-0">
            Items{visibleLineItems.length ? ` (${visibleLineItems.length})` : ''}
            {canHideItems && hiddenLineItems.length > 0
              ? ` · ${hiddenLineItems.length} hidden`
              : ''}
          </h3>
        </div>

        {visibleLineItems.length ? (
          <ul className="invoice-detail-item-list mt-3">
            {visibleLineItems.map(item => {
              const ordered = Number(item.quantity ?? 0);
              const catalogProduct = resolveCatalogForLine(item, catalogById);
              const scheme = lineStorageScheme(catalogProduct, goodsReceipt);
              const draft = lineDrafts[item.id] ?? {
                locations: [newLocationDraft(scheme, defaultZoneId)],
              };
              const receivedTotal = draft.locations.reduce((sum, loc) => {
                const n = Number(loc.quantity);
                return sum + (Number.isFinite(n) && n > 0 ? n : 0);
              }, 0);
              const hasAnyQty = draft.locations.some(loc => loc.quantity.trim() !== '');
              const diff = hasAnyQty ? receivedTotal - ordered : null;
              const diffClass = diff == null
                ? ''
                : diff === 0
                  ? 'is-match'
                  : diff > 0
                    ? 'is-over'
                    : 'is-under';
              const isFreight = isFreightProductId(item.itemId)
                || isFreightSku(item.sku);
              const showPackageInfo = Boolean(catalogProduct && !isFreight);
              const packageMarkedSpare = catalogProductPackageNotRequired(catalogProduct)
                || Boolean(catalogProduct && !expectsCatalogPackageInfo(catalogProduct));
              const packageRequired = Boolean(
                catalogProduct
                && expectsCatalogPackageInfo(catalogProduct)
                && goodsReceipt.goodsReceiptCategory !== 'spare'
                && goodsReceipt.inventorySite !== 'head_office',
              );
              const packageComplete = catalogProduct
                ? catalogProductHasCompleteSingleBoxPackageInfo(catalogProduct)
                : true;
              const packageStatus: 'ok' | 'spare' | 'missing' = !showPackageInfo || packageComplete
                ? 'ok'
                : (!packageRequired || packageMarkedSpare)
                  ? 'spare'
                  : 'missing';
              const packageMissing = packageStatus === 'missing';
              const showMarkAsSpare = Boolean(
                showPackageInfo
                && catalogProduct
                && !packageComplete
                && !catalogProductPackageNotRequired(catalogProduct)
                && !receiveLocked,
              );
              const postedLocations = draft.locations.filter(locationDraftHasValue);

              return (
                <li
                  key={item.id}
                  className={[
                    'invoice-detail-item',
                    'admin-invoice-detail-item',
                    'goods-receipt-receive__item',
                    packageMissing ? 'goods-receipt-receive__item--package-missing' : '',
                  ].filter(Boolean).join(' ')}
                >
                  {canHideItems && !receiveLocked && (
                    <button
                      type="button"
                      className="goods-receipt-receive__hide-btn"
                      disabled={saving || hidingLineId === item.id}
                      onClick={() => void handleToggleHidden(item.id, true)}
                      aria-label={`Hide ${item.name} from this goods receipt`}
                      title="Hide item"
                    >
                      <EyeOff size={15} aria-hidden />
                    </button>
                  )}
                  <div className="invoice-detail-item__image-wrap">
                    {item.imageUrl ? (
                      <img
                        src={item.imageUrl}
                        alt=""
                        className="invoice-detail-item__image"
                        loading="lazy"
                        decoding="async"
                      />
                    ) : (
                      <span className="invoice-detail-item__placeholder" aria-hidden>
                        <Package size={22} />
                      </span>
                    )}
                  </div>
                  <DocumentLineItemSpec
                    name={item.name}
                    sku={item.sku}
                  >
                    <div className="goods-receipt-receive__summary">
                      <label className="goods-receipt-receive__field">
                        <span className="goods-receipt-receive__label">Ordered qty</span>
                        {receiveLocked ? (
                          <span className="goods-receipt-receive__value">{String(ordered)}</span>
                        ) : (
                          <input
                            type="text"
                            className="goods-receipt-receive__input"
                            value={String(ordered)}
                            readOnly
                            tabIndex={-1}
                            aria-readonly="true"
                          />
                        )}
                      </label>
                      <label className="goods-receipt-receive__field">
                        <span className="goods-receipt-receive__label">Received qty</span>
                        {receiveLocked ? (
                          <span className="goods-receipt-receive__value">
                            {hasAnyQty ? String(receivedTotal) : '—'}
                          </span>
                        ) : (
                          <input
                            type="text"
                            className="goods-receipt-receive__input"
                            value={hasAnyQty ? String(receivedTotal) : ''}
                            placeholder="—"
                            readOnly
                            tabIndex={-1}
                            aria-readonly="true"
                            aria-label={`Received qty for ${item.name}`}
                          />
                        )}
                      </label>
                      <div className="goods-receipt-receive__diff-wrap">
                        <span className="goods-receipt-receive__label">Difference</span>
                        <strong
                          className={`goods-receipt-receive__diff ${diffClass}`.trim()}
                          aria-label="Difference received minus ordered"
                        >
                          {diff == null ? '—' : formatDiff(diff)}
                        </strong>
                      </div>
                      {showPackageInfo && catalogProduct && (
                        <button
                          type="button"
                          className={`goods-receipt-receive__package-toggle${
                            packageMissing ? ' is-missing' : ''
                          }`}
                          onClick={() => togglePackageExpanded(item.id)}
                          aria-expanded={expandedPackageIds.has(item.id)}
                        >
                          <span className="goods-receipt-receive__label">Package</span>
                          <span className="goods-receipt-receive__package-status">
                            {packageStatus === 'missing' ? (
                              <span className="goods-receipt-receive__package-alarm">
                                <PackageInfoIcon size={16} title="Package info missing" />
                                Missing
                              </span>
                            ) : packageStatus === 'spare' ? (
                              <span className="goods-receipt-receive__package-spare">Spare</span>
                            ) : (
                              <span className="goods-receipt-receive__package-ok">OK</span>
                            )}
                            <ChevronDown
                              size={14}
                              aria-hidden
                              className={`goods-receipt-receive__package-chevron${
                                expandedPackageIds.has(item.id) ? ' is-open' : ''
                              }`}
                            />
                          </span>
                        </button>
                      )}
                    </div>

                    {poLineShowsSerialRange(item) ? (
                      <PoLineSerialFields
                        startNumber={serialDrafts[item.id]?.startNumber ?? ''}
                        endNumber={serialDrafts[item.id]?.endNumber ?? ''}
                        lineQty={Number(item.quantity ?? 0)}
                        disabled={saving}
                        name={item.name}
                        productId={item.itemId}
                        onChange={next => {
                          setSerialDrafts(prev => ({ ...prev, [item.id]: next }));
                        }}
                      />
                    ) : null}

                    {showPackageInfo && catalogProduct && expandedPackageIds.has(item.id) && (
                      <div className="goods-receipt-receive__package is-open">
                        {showMarkAsSpare ? (
                          <div
                            className="goods-receipt-receive__package-spare-row"
                            onPointerDown={event => event.stopPropagation()}
                          >
                            <p className="goods-receipt-receive__package-hint">
                              Spare items do not need carton dimensions.
                            </p>
                            <button
                              type="button"
                              className="goods-receipt-receive__mark-spare"
                              disabled={saving || markingSpareProductId === catalogProduct.id}
                              onClick={() => void handleMarkPackageAsSpare(catalogProduct.id)}
                            >
                              <Wrench size={14} aria-hidden />
                              {markingSpareProductId === catalogProduct.id
                                ? 'Marking…'
                                : 'Mark as spare'}
                            </button>
                          </div>
                        ) : null}
                        {packageStatus === 'spare' && !showMarkAsSpare ? (
                          <p className="goods-receipt-receive__package-hint">
                            Spare — goods received does not need package info.
                          </p>
                        ) : null}
                        {!catalogProductPackageNotRequired(catalogProduct) ? (
                          <ProductPackageInfo
                            product={catalogProduct}
                            packageInfo={catalogProduct.packageInfo}
                            canEdit={!receiveLocked}
                            defaultEditing={packageMissing && !receiveLocked}
                            onPackageInfoChange={info => onPackageInfoSaved(catalogProduct.id, info)}
                          />
                        ) : null}
                      </div>
                    )}

                    <div className="goods-receipt-receive__locations">
                      <span className="goods-receipt-receive__label">
                        {scheme === 'head_office' ? 'Head Office locations' : 'Warehouse locations'}
                      </span>
                      {receiveLocked ? (
                        postedLocations.length === 0 ? (
                          <span className="goods-receipt-receive__value">—</span>
                        ) : (
                          postedLocations.map(loc => (
                            <div
                              key={loc.key}
                              className={[
                                'goods-receipt-receive__location-row',
                                'goods-receipt-receive__location-row--readonly',
                                loc.scheme === 'head_office'
                                  ? 'goods-receipt-receive__location-row--head-office'
                                  : '',
                              ].filter(Boolean).join(' ')}
                            >
                              {loc.scheme === 'head_office' ? (
                                <>
                                  <div className="goods-receipt-receive__field">
                                    <span className="goods-receipt-receive__label">Rack</span>
                                    <span className="goods-receipt-receive__value">
                                      {loc.rackId.trim() ? loc.rackId.toUpperCase() : '—'}
                                    </span>
                                  </div>
                                  <div className="goods-receipt-receive__field">
                                    <span className="goods-receipt-receive__label">Row</span>
                                    <span className="goods-receipt-receive__value">
                                      {loc.rowNumber.trim() || '—'}
                                    </span>
                                  </div>
                                  <div className="goods-receipt-receive__field">
                                    <span className="goods-receipt-receive__label">Bin</span>
                                    <span className="goods-receipt-receive__value">
                                      {loc.binNumber.trim() || '—'}
                                    </span>
                                  </div>
                                </>
                              ) : (
                                <>
                                  <div className="goods-receipt-receive__field">
                                    <span className="goods-receipt-receive__label">Zone</span>
                                    <span className="goods-receipt-receive__value">
                                      {warehouseZoneLabel(loc.zoneId, zones)}
                                    </span>
                                  </div>
                                  <div className="goods-receipt-receive__field">
                                    <span className="goods-receipt-receive__label">Row</span>
                                    <span className="goods-receipt-receive__value">
                                      {warehouseRowLabel(loc.zoneId, loc.zoneRowNumber, rowsByZone)}
                                    </span>
                                  </div>
                                </>
                              )}
                              <div className="goods-receipt-receive__field goods-receipt-receive__field--qty">
                                <span className="goods-receipt-receive__label">Qty</span>
                                <span className="goods-receipt-receive__value">
                                  {loc.quantity.trim() || '—'}
                                </span>
                              </div>
                            </div>
                          ))
                        )
                      ) : (
                        draft.locations.map((loc, locIndex) => {
                          const zoneRows = loc.zoneId ? (rowsByZone[loc.zoneId] ?? []) : [];
                          const isLast = locIndex === draft.locations.length - 1;
                          const isHeadOffice = loc.scheme === 'head_office';
                          return (
                            <div
                              key={loc.key}
                              className={[
                                'goods-receipt-receive__location-row',
                                isHeadOffice ? 'goods-receipt-receive__location-row--head-office' : '',
                              ].filter(Boolean).join(' ')}
                            >
                              {isHeadOffice ? (
                                <>
                                  <label className="goods-receipt-receive__field">
                                    <span className="goods-receipt-receive__label">Rack</span>
                                    <ProductNcSelect
                                      aria-label={`Rack for ${item.name}`}
                                      value={loc.rackId}
                                      disabled={saving}
                                      placeholder="Select rack"
                                      onChange={next => setLocationDraft(item.id, loc.key, {
                                        rackId: next,
                                        rowNumber: '',
                                        binNumber: '',
                                      })}
                                      options={VALID_RACK_LETTERS.map(letter => ({
                                        value: letter,
                                        label: letter.toUpperCase(),
                                      }))}
                                    />
                                  </label>
                                  <label className="goods-receipt-receive__field">
                                    <span className="goods-receipt-receive__label">Row</span>
                                    <ProductNcSelect
                                      aria-label={`Row for ${item.name}`}
                                      value={loc.rowNumber}
                                      disabled={saving || !loc.rackId}
                                      placeholder={!loc.rackId ? 'Select rack first' : 'Select row'}
                                      onChange={next => setLocationDraft(item.id, loc.key, {
                                        rowNumber: next,
                                        binNumber: '',
                                      })}
                                      options={ROW_NUMBERS.map(n => ({
                                        value: String(n),
                                        label: String(n),
                                      }))}
                                    />
                                  </label>
                                  <label className="goods-receipt-receive__field">
                                    <span className="goods-receipt-receive__label">Bin</span>
                                    <ProductNcSelect
                                      aria-label={`Bin for ${item.name}`}
                                      value={loc.binNumber}
                                      disabled={saving || !loc.rackId || !loc.rowNumber}
                                      placeholder={!loc.rowNumber ? 'Select row first' : 'Select bin'}
                                      onChange={next => setLocationDraft(item.id, loc.key, {
                                        binNumber: next,
                                      })}
                                      options={BIN_NUMBERS.map(n => ({
                                        value: String(n),
                                        label: String(n),
                                      }))}
                                    />
                                  </label>
                                </>
                              ) : (
                                <>
                                  <label className="goods-receipt-receive__field">
                                    <span className="goods-receipt-receive__label">Zone</span>
                                    <ProductNcSelect
                                      aria-label={`Zone for ${item.name}`}
                                      value={loc.zoneId}
                                      disabled={loadingZones || saving}
                                      placeholder={loadingZones ? 'Loading…' : 'Select zone'}
                                      onChange={next => setLocationDraft(item.id, loc.key, {
                                        zoneId: next,
                                        zoneRowNumber: '',
                                      })}
                                      options={zones.map(zone => ({
                                        value: zone.id,
                                        label: `${zone.id.toUpperCase()}${zone.label ? ` — ${zone.label}` : ''}`,
                                      }))}
                                    />
                                  </label>
                                  <label className="goods-receipt-receive__field">
                                    <span className="goods-receipt-receive__label">Row</span>
                                    <ProductNcSelect
                                      aria-label={`Row for ${item.name}`}
                                      value={loc.zoneRowNumber}
                                      disabled={saving || !loc.zoneId || zoneRows.length === 0}
                                      placeholder={!loc.zoneId ? 'Select zone first' : 'Select row'}
                                      onChange={next => setLocationDraft(item.id, loc.key, {
                                        zoneRowNumber: next,
                                      })}
                                      options={zoneRows.map(row => ({
                                        value: String(row.number),
                                        label: row.label
                                          ? `${row.number} — ${row.label}`
                                          : String(row.number),
                                      }))}
                                    />
                                  </label>
                                </>
                              )}
                              <label className="goods-receipt-receive__field goods-receipt-receive__field--qty">
                                <span className="goods-receipt-receive__label">Qty</span>
                                <input
                                  type="number"
                                  inputMode="numeric"
                                  min={0}
                                  step={1}
                                  className="goods-receipt-receive__input goods-receipt-receive__input--editable"
                                  value={loc.quantity}
                                  placeholder="—"
                                  disabled={saving}
                                  onChange={e => setLocationDraft(item.id, loc.key, {
                                    quantity: e.target.value,
                                  })}
                                  aria-label={`Qty at location for ${item.name}`}
                                />
                              </label>
                              <div className="goods-receipt-receive__row-actions">
                                {draft.locations.length > 1 && (
                                  <button
                                    type="button"
                                    className="goods-receipt-receive__icon-btn goods-receipt-receive__icon-btn--remove"
                                    disabled={saving}
                                    onClick={() => removeLocation(item.id, loc.key)}
                                    aria-label="Remove warehouse location"
                                  >
                                    <X size={16} aria-hidden />
                                  </button>
                                )}
                                {isLast && (
                                  <button
                                    type="button"
                                    className="goods-receipt-receive__icon-btn goods-receipt-receive__icon-btn--add"
                                    disabled={saving}
                                    onClick={() => addLocation(item.id)}
                                    aria-label="Add warehouse location"
                                  >
                                    <Plus size={16} aria-hidden />
                                  </button>
                                )}
                              </div>
                            </div>
                          );
                        })
                      )}
                    </div>
                  </DocumentLineItemSpec>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="invoice-detail-items__empty text-muted text-sm">
            {hiddenLineItems.length > 0
              ? 'All items on this bill are hidden.'
              : 'No line items on this bill.'}
          </p>
        )}

        {canHideItems && !receiveLocked && hiddenLineItems.length > 0 && (
          <ul className="goods-receipt-receive__hidden-list" aria-label="Hidden items">
            {hiddenLineItems.map(item => (
              <li key={item.id} className="goods-receipt-receive__hidden-item">
                <div className="goods-receipt-receive__hidden-meta">
                  <span className="goods-receipt-receive__hidden-badge">Hidden</span>
                  <strong className="goods-receipt-receive__hidden-name">{item.name}</strong>
                  {item.sku ? (
                    <span className="text-muted text-sm">{item.sku}</span>
                  ) : null}
                </div>
                <button
                  type="button"
                  className="goods-receipt-receive__unhide-btn"
                  disabled={saving || hidingLineId === item.id}
                  onClick={() => void handleToggleHidden(item.id, false)}
                >
                  <Eye size={14} aria-hidden />
                  {hidingLineId === item.id ? '…' : 'Unhide'}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {canMarkReceived && receiveLocked && visibleLineItems.some(item => poLineShowsSerialRange(item)) && (
        <div className="goods-receipt-detail__actions">
          {saveError && (
            <div className="products-inline-error panel glass goods-receipt-detail__actions-error" role="alert">
              <AlertCircle size={16} />
              <span>{saveError}</span>
            </div>
          )}
          {saveOk ? (
            <p className="goods-receipt-receive__saved text-sm mb-0 goods-receipt-detail__actions-status" role="status">
              <Check size={14} aria-hidden />
              {saveOk}
            </p>
          ) : null}
          <p className="text-muted text-sm mb-0">
            Bill stays received. Enter the serial range, then save.
          </p>
          <div className="goods-receipt-detail__actions-btns">
            <button
              type="button"
              className="btn btn-secondary"
              disabled={saving}
              onClick={() => void handleSaveSerialRanges()}
            >
              {busy === 'post' ? 'Saving…' : 'Save serial numbers'}
            </button>
          </div>
        </div>
      )}

      {canMarkReceived && needsZohoOpen && (
        <div className="goods-receipt-detail__actions">
          {saveError && (
            <div className="products-inline-error panel glass goods-receipt-detail__actions-error" role="alert">
              <AlertCircle size={16} />
              <span>{saveError}</span>
            </div>
          )}
          {saveOk && (
            <p className="goods-receipt-receive__saved text-sm mb-0 goods-receipt-detail__actions-status" role="status">
              <Check size={14} aria-hidden />
              {saveOk}
            </p>
          )}
          <div className="goods-receipt-detail__actions-btns">
            <button
              type="button"
              className="btn btn-primary"
              disabled={saving}
              onClick={() => void handleRetryZohoOpen()}
            >
              <PackageCheck size={16} aria-hidden />
              {busy === 'post' ? 'Opening in Zoho…' : 'Open bill in Zoho'}
            </button>
          </div>
        </div>
      )}

      {canMarkReceived && !receiveLocked && (
        <div className="goods-receipt-detail__actions">
          {saveError && (
            <div className="products-inline-error panel glass goods-receipt-detail__actions-error" role="alert">
              <AlertCircle size={16} />
              <span>{saveError}</span>
            </div>
          )}
          {saveOk && !dirty && (
            <p className="goods-receipt-receive__saved text-sm mb-0 goods-receipt-detail__actions-status" role="status">
              <Check size={14} aria-hidden />
              {saveOk}
              {goodsReceipt.receiveCheck?.updatedByName
                ? ` · ${goodsReceipt.receiveCheck.updatedByName}`
                : ''}
            </p>
          )}
          <div className="goods-receipt-detail__actions-btns">
            <button
              type="button"
              className="btn btn-secondary"
              disabled={saving || !dirty}
              onClick={() => void handleSaveDraft()}
            >
              {busy === 'draft' ? 'Saving…' : 'Save as draft'}
            </button>
            <span
              className="goods-receipt-detail__actions-primary"
              title={
                !packageDataReady
                  ? `Fill package info (weight + L × B × H) for ${
                      missingPackageLines.length === 1
                        ? missingPackageLines[0].name
                        : `${missingPackageLines.length} products`
                    }`
                    : 'Posts warehouse stock and a product audit, then opens this draft bill in Zoho'
              }
            >
              <button
                type="button"
                className="btn btn-primary"
                disabled={saving || !packageDataReady}
                onClick={openGoodsReceivedDialog}
              >
                <PackageCheck size={16} aria-hidden />
                {busy === 'post' ? 'Updating…' : 'Goods received'}
              </button>
            </span>
          </div>
        </div>
      )}

      <GoodsReceiptReceivedDialog
        open={receiveDialogOpen}
        billNumber={goodsReceipt.billNumber}
        canBackdate={canBackdateReceived}
        saving={busy === 'post'}
        error={receiveDialogOpen ? saveError : ''}
        onClose={() => {
          if (busy === 'post') return;
          setReceiveDialogOpen(false);
        }}
        onConfirm={iso => void handleGoodsReceived(iso)}
      />
    </div>
  );
};
