import React, { useEffect, useMemo, useState } from 'react';
import { CircleOff, Pencil, Plus, Printer, Save, Trash2, X } from 'lucide-react';
import { DecimalTextInput } from '../DecimalAmountInput';
import { useConfirm } from '../../context/ConfirmContext';
import {
  formatStockQuantity,
  catalogProductWarehouseStock,
} from '../../lib/catalog';
import type { CatalogInventorySiteConfig } from '../../lib/catalogInventorySites';
import {
  calculateGroupTotals,
  type InventoryAuditGroupTotals,
} from '../../lib/yesStore/inventoryAudit';
import { formatAuditDateTime } from '../../lib/yesStore/format';
import {
  createLinkedStoreItem,
  deleteItem,
  listItemsByCatalogProduct,
  unlinkYesStoreItemFromCatalog,
  updateStoreItemLocationAndQty,
} from '../../lib/yesStore/data';
import { deleteYesStorePhotos } from '../../lib/yesStore/photos';
import {
  listWarehouseZoneRows,
  listWarehouseZones,
} from '../../lib/warehouseLocations/data';
import {
  deleteCatalogSiteInventory,
  markCatalogSiteNoStock,
  saveCatalogSiteInventory,
} from '../../lib/catalogSiteInventory/data';
import { getOpenAuditCycle } from '../../lib/auditCycles/data';
import { recordCatalogProductAuditAfterCount } from '../../lib/catalogProductAudit/data';
import type { AuditCycleDoc } from '../../types/audit-cycle';
import type { CatalogProduct, CatalogProductDetail } from '../../types/catalog';
import {
  getCatalogSiteInventoryLocations,
  isNoStockSiteInventoryAudit,
  type CatalogSiteInventoryDoc,
} from '../../types/catalog-site-inventory';
import type { WarehouseZoneDoc, WarehouseZoneRowDoc } from '../../types/warehouse-locations';
import {
  BIN_NUMBERS,
  ROW_NUMBERS,
  VALID_RACK_LETTERS,
  formatItemLocationShort,
  readItemQuantity,
  type BinNumber,
  type RowNumber,
  type YesStoreItemDoc,
} from '../../types/yes-store';
import {
  BinLabelPrintDialog,
  binLabelFieldsFromStoreItem,
} from './BinLabelPrintDialog';
import type { BinLabelFields } from '../../lib/localPrinterLabel';

function QtyWithAuditStamp({
  qtyLabel,
  auditedAt,
}: {
  qtyLabel: string;
  auditedAt?: string | null;
}) {
  const stamp = auditedAt ? formatAuditDateTime(auditedAt) : '';
  const hasStamp = Boolean(auditedAt && stamp && stamp !== '—');

  return (
    <td className="product-site-stock__qty-cell">
      <span className="product-site-stock__qty-main">{qtyLabel}</span>
      {hasStamp && (
        <span className="product-site-stock__qty-meta">{stamp}</span>
      )}
    </td>
  );
}

function SiteTypeBadge({ site }: { site: CatalogInventorySiteConfig['site'] }) {
  return (
    <span
      className={[
        'product-site-stock__badge',
        site === 'head_office' ? 'product-site-stock__badge--store' : 'product-site-stock__badge--warehouse',
      ].join(' ')}
    >
      {site === 'head_office' ? 'Store room' : 'Warehouse'}
    </span>
  );
}

function HeadOfficeLocationTable({
  product,
  auditItems,
  auditTotals,
}: {
  product: CatalogProduct;
  auditItems: YesStoreItemDoc[];
  auditTotals: InventoryAuditGroupTotals;
}) {
  const isBundle = auditTotals.mode === 'bundle';
  const [printFields, setPrintFields] = useState<BinLabelFields | null>(null);

  return (
    <div className="product-site-stock__table-wrap product-site-stock__table-wrap--store">
      <table className="product-site-stock__table product-site-stock__table--hero-values">
        <thead>
          <tr>
            <th>Rack</th>
            <th>Row</th>
            <th>Bin</th>
            {isBundle && <th>Part</th>}
            <th>Qty</th>
            <th className="product-site-stock__actions-col" aria-label="Actions" />
          </tr>
        </thead>
        <tbody>
          {auditTotals.parts.map(part => {
            const binItem = auditItems.find(item => item.id === part.itemId);
            if (!binItem) return null;

            const locationShort = formatItemLocationShort(
              binItem.rackId,
              binItem.rowNumber,
              binItem.binNumber,
            );
            const showPartLabel =
              isBundle && part.partLabel.trim() !== locationShort;
            const auditedAt =
              binItem.lastAuditedAt ?? binItem.countedAt ?? binItem.updatedAt;

            return (
              <tr key={part.itemId}>
                <td>{binItem.rackId.toUpperCase()}</td>
                <td>{binItem.rowNumber}</td>
                <td>{binItem.binNumber}</td>
                {isBundle && (
                  <td>{showPartLabel ? part.partLabel : '—'}</td>
                )}
                <QtyWithAuditStamp
                  qtyLabel={formatStockQuantity(readItemQuantity(binItem), product.unit)}
                  auditedAt={auditedAt}
                />
                <td className="product-site-stock__actions-cell">
                  <button
                    type="button"
                    className="product-site-stock__print-btn"
                    onClick={() => setPrintFields(binLabelFieldsFromStoreItem(product, binItem))}
                    aria-label="Print label"
                    title="Print label"
                  >
                    <Printer size={16} aria-hidden />
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {printFields && (
        <BinLabelPrintDialog
          fields={printFields}
          layoutId="genuine-spare"
          productId={product.id}
          onClose={() => setPrintFields(null)}
        />
      )}
    </div>
  );
}

type EditableHeadOfficeRow = {
  key: string;
  itemId?: string;
  rackId: string;
  rowNumber: string;
  binNumber: string;
  quantity: string;
};

function createHeadOfficeEditableRow(defaults?: Partial<EditableHeadOfficeRow>): EditableHeadOfficeRow {
  return {
    key: crypto.randomUUID(),
    rackId: defaults?.rackId ?? '',
    rowNumber: defaults?.rowNumber ?? '',
    binNumber: defaults?.binNumber ?? '',
    quantity: defaults?.quantity ?? '1',
    itemId: defaults?.itemId,
  };
}

function headOfficeRowsFromItems(items: YesStoreItemDoc[]): EditableHeadOfficeRow[] {
  if (items.length === 0) return [createHeadOfficeEditableRow()];
  return items.map(item =>
    createHeadOfficeEditableRow({
      itemId: item.id,
      rackId: item.rackId.toLowerCase(),
      rowNumber: String(item.rowNumber),
      binNumber: String(item.binNumber),
      quantity: String(readItemQuantity(item)),
    }),
  );
}

function HeadOfficeEditRow({
  row,
  saving,
  canRemove,
  onUpdate,
  onRemove,
}: {
  row: EditableHeadOfficeRow;
  saving: boolean;
  canRemove: boolean;
  onUpdate: (patch: Partial<EditableHeadOfficeRow>) => void;
  onRemove: () => void;
}) {
  return (
    <div className="product-site-stock__edit-row product-site-stock__edit-row--store">
      <LocationDropdownField
        label="Rack"
        value={row.rackId}
        disabled={saving}
        onChange={rackId => onUpdate({ rackId })}
        options={VALID_RACK_LETTERS.map(letter => ({
          value: letter,
          label: letter.toUpperCase(),
        }))}
      />
      <LocationDropdownField
        label="Row"
        value={row.rowNumber}
        disabled={saving}
        onChange={rowNumber => onUpdate({ rowNumber })}
        options={ROW_NUMBERS.map(n => ({ value: String(n), label: String(n) }))}
      />
      <LocationDropdownField
        label="Bin"
        value={row.binNumber}
        disabled={saving}
        onChange={binNumber => onUpdate({ binNumber })}
        options={BIN_NUMBERS.map(n => ({ value: String(n), label: String(n) }))}
      />
      <label className="product-site-stock__dropdown-field">
        <span className="product-site-stock__dropdown-label">Qty</span>
        <DecimalTextInput
          className="product-site-stock__dropdown product-site-stock__dropdown--qty"
          value={row.quantity}
          decimals={0}
          onChange={quantity => onUpdate({ quantity })}
          disabled={saving}
          aria-label="Counted qty"
        />
      </label>
      <button
        type="button"
        className="product-site-stock__row-remove product-site-stock__row-remove--inline"
        onClick={onRemove}
        disabled={saving || !canRemove}
        aria-label="Remove row"
      >
        <Trash2 size={14} aria-hidden />
      </button>
    </div>
  );
}

function MarkNoStockButton({
  disabled,
  onClick,
}: {
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="btn btn-secondary btn-sm product-site-stock__no-stock-btn"
      disabled={disabled}
      onClick={onClick}
    >
      <CircleOff size={14} aria-hidden />
      Mark as no stock
    </button>
  );
}

function HeadOfficeLocationSection({
  product,
  siteConfig,
  auditItems,
  zeroStockRecord,
  canEdit,
  editorUid,
  editorName,
  onSaved,
  onZeroStockSaved,
}: {
  product: CatalogProduct;
  siteConfig: CatalogInventorySiteConfig;
  auditItems: YesStoreItemDoc[];
  zeroStockRecord: CatalogSiteInventoryDoc | null;
  canEdit: boolean;
  editorUid: string;
  editorName?: string | null;
  onSaved: (items: YesStoreItemDoc[]) => void;
  onZeroStockSaved: (record: CatalogSiteInventoryDoc | null) => void;
}) {
  const confirm = useConfirm();
  const [rows, setRows] = useState<EditableHeadOfficeRow[]>(() => headOfficeRowsFromItems(auditItems));
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [openCycle, setOpenCycle] = useState<AuditCycleDoc | null | undefined>(undefined);

  const countingLocked = openCycle == null;
  const canCount = canEdit && Boolean(openCycle);

  const auditTotals = useMemo(() => {
    if (auditItems.length === 0) return null;
    const zohoQty = catalogProductWarehouseStock(product, siteConfig.warehouseName);
    return calculateGroupTotals(auditItems, {
      ...product,
      stock: zohoQty,
    });
  }, [auditItems, product, siteConfig.warehouseName]);

  const isNoStockAudit = isNoStockSiteInventoryAudit(zeroStockRecord)
    && auditItems.length === 0;

  useEffect(() => {
    let active = true;
    void getOpenAuditCycle('head_office')
      .then(cycle => {
        if (active) setOpenCycle(cycle);
      })
      .catch(() => {
        if (active) setOpenCycle(null);
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!editing) {
      setRows(headOfficeRowsFromItems(auditItems));
    }
  }, [auditItems, editing]);

  const startEditing = () => {
    if (countingLocked) {
      setError('No open audit cycle — counting locked for Head Office.');
      return;
    }
    setRows(headOfficeRowsFromItems(auditItems));
    setError('');
    setEditing(true);
  };

  const cancelEditing = () => {
    setRows(headOfficeRowsFromItems(auditItems));
    setError('');
    setEditing(false);
  };

  const updateRow = (key: string, patch: Partial<EditableHeadOfficeRow>) => {
    setRows(prev => prev.map(row => (row.key === key ? { ...row, ...patch } : row)));
  };

  const addRow = () => {
    setRows(prev => [...prev, createHeadOfficeEditableRow()]);
  };

  const removeRow = (key: string) => {
    setRows(prev => {
      const next = prev.filter(row => row.key !== key);
      return next.length ? next : [createHeadOfficeEditableRow({ quantity: '' })];
    });
  };

  const handleSave = async () => {
    if (!editorUid) {
      setError('Sign in required to save.');
      return;
    }
    if (!openCycle?.id) {
      setError('No open audit cycle — counting locked for Head Office.');
      return;
    }

    const incomplete = rows.filter(row => {
      const filledCount = [row.rackId, row.rowNumber, row.binNumber, row.quantity.trim()].filter(
        Boolean,
      ).length;
      return filledCount > 0 && filledCount < 4;
    });
    if (incomplete.length) {
      setError('Finish rack, row, bin, and quantity for every location, or clear the row.');
      return;
    }

    const prepared = rows
      .filter(row => row.rackId && row.rowNumber && row.binNumber)
      .map(row => {
        const qty = Number.parseInt(row.quantity, 10);
        const rowNumber = Number.parseInt(row.rowNumber, 10);
        const binNumber = Number.parseInt(row.binNumber, 10);
        return { row, qty, rowNumber, binNumber };
      });

    for (const entry of prepared) {
      if (!Number.isFinite(entry.qty) || entry.qty < 0) {
        setError('Quantity must be 0 or greater for every location.');
        return;
      }
    }

    const keptIds = new Set(
      prepared.map(entry => entry.row.itemId).filter((id): id is string => Boolean(id)),
    );
    const removedItems = auditItems.filter(item => !keptIds.has(item.id));
    if (prepared.length === 0 && removedItems.length === 0) {
      setError('Add a location, enter 0 for an emptied bin, or mark as no stock.');
      return;
    }
    if (removedItems.length > 0) {
      const ok = await confirm({
        title: removedItems.length === 1 ? 'Delete this bin item?' : `Delete ${removedItems.length} bin items?`,
        message: 'Removed locations are deleted from the store room bin, including their photos. A quantity of 0 keeps the bin and records it as empty.',
        confirmLabel: 'Delete from bin',
        destructive: true,
      });
      if (!ok) return;
    }

    setSaving(true);
    setError('');
    const counter = { uid: editorUid, displayName: editorName };
    const template = auditItems[0];
    const linkMode = template?.catalogLinkMode === 'part' ? 'part' : 'unit';

    try {
      for (const removed of removedItems) {
        await deleteItem(removed.id);
        if (removed.photos?.length) {
          await deleteYesStorePhotos(removed.photos).catch(() => undefined);
        }
      }

      for (const entry of prepared) {
        const location = {
          rackId: entry.row.rackId,
          rowNumber: entry.rowNumber as RowNumber,
          binNumber: entry.binNumber as BinNumber,
          quantity: entry.qty,
        };
        if (entry.row.itemId) {
          await updateStoreItemLocationAndQty(entry.row.itemId, location, counter);
        } else {
          await createLinkedStoreItem({
            ...location,
            product: {
              id: product.id,
              name: product.name,
              sku: product.sku,
            },
            countedBy: counter,
            linkedByUid: editorUid,
            linkedByName: editorName,
            mode: linkMode,
            partLabel:
              linkMode === 'part'
                ? formatItemLocationShort(location.rackId, location.rowNumber, location.binNumber)
                : null,
            unitsPerProduct: template?.unitsPerProduct ?? 1,
          });
        }
      }

      if (prepared.length === 0) {
        const saved = await markCatalogSiteNoStock({
          catalogProductId: product.id,
          site: 'head_office',
          updatedByUid: editorUid,
          updatedByName: editorName,
        });
        onZeroStockSaved(saved);
      } else if (zeroStockRecord) {
        await deleteCatalogSiteInventory(product.id, 'head_office');
        onZeroStockSaved(null);
      }

      const nextItems = await listItemsByCatalogProduct(product.id);
      const { warning } = await recordCatalogProductAuditAfterCount(
        product.id,
        'warehouse_count',
        openCycle.id,
      );
      onSaved(nextItems);
      setEditing(false);
      if (warning) setError(warning);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save store room stock.');
    } finally {
      setSaving(false);
    }
  };

  const handleMarkNoStock = async () => {
    if (!editorUid) {
      setError('Sign in required to save.');
      return;
    }
    if (!openCycle?.id) {
      setError('No open audit cycle — counting locked for Head Office.');
      return;
    }
    const ok = await confirm({
      title: 'Mark as no stock?',
      message: auditItems.length > 0
        ? 'This will unlink all store room bins, set counted quantity to 0, and record no location.'
        : 'This marks the spare as audited with quantity 0 and no rack/row/bin location.',
      confirmLabel: 'Mark as no stock',
      destructive: auditItems.length > 0,
    });
    if (!ok) return;

    setSaving(true);
    setError('');
    try {
      for (const item of auditItems) {
        await unlinkYesStoreItemFromCatalog(item.id);
      }
      const saved = await markCatalogSiteNoStock({
        catalogProductId: product.id,
        site: 'head_office',
        updatedByUid: editorUid,
        updatedByName: editorName,
      });
      const { warning } = await recordCatalogProductAuditAfterCount(
        product.id,
        'warehouse_count',
        openCycle.id,
      );
      onSaved([]);
      onZeroStockSaved(saved);
      setEditing(false);
      if (warning) setError(warning);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not mark as no stock.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <section
      className={[
        'product-site-stock',
        editing ? 'product-site-stock--editing' : '',
        isNoStockAudit ? 'product-site-stock--no-stock' : '',
      ].filter(Boolean).join(' ')}
    >
      <header className="product-site-stock__header">
        <h3 className="product-site-stock__title">{siteConfig.warehouseName}</h3>
        <div className="product-site-stock__header-actions">
          <SiteTypeBadge site={siteConfig.site} />
          {canCount && (
            <button
              type="button"
              className={[
                'product-site-stock__edit-btn',
                editing ? 'product-site-stock__edit-btn--active' : '',
              ].filter(Boolean).join(' ')}
              title={editing ? 'Cancel editing' : 'Edit store room locations'}
              aria-label={editing ? 'Cancel editing' : 'Edit store room locations'}
              aria-pressed={editing}
              onClick={() => (editing ? cancelEditing() : startEditing())}
            >
              {editing ? <X size={15} aria-hidden /> : <Pencil size={15} aria-hidden />}
            </button>
          )}
        </div>
      </header>

      {canEdit && openCycle === null && (
        <p className="product-site-stock__cycle-lock text-muted text-sm">
          No open audit cycle — counting locked.
        </p>
      )}

      {editing && canCount ? (
        <div className="product-site-stock__editor-modern">
          {rows.map(row => (
            <HeadOfficeEditRow
              key={row.key}
              row={row}
              saving={saving}
              canRemove={rows.length > 1 || Boolean(row.itemId)}
              onUpdate={patch => updateRow(row.key, patch)}
              onRemove={() => removeRow(row.key)}
            />
          ))}

          <button
            type="button"
            className="product-site-stock__add-row-btn"
            disabled={saving}
            onClick={addRow}
          >
            <Plus size={14} aria-hidden />
            Add location
          </button>

          {error && <p className="product-site-stock__error text-sm">{error}</p>}

          <div className="product-site-stock__editor-toolbar product-site-stock__editor-toolbar--modern">
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              disabled={saving}
              onClick={cancelEditing}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-primary btn-sm product-site-stock__save-btn"
              disabled={saving}
              onClick={() => void handleSave()}
            >
              <Save size={14} aria-hidden />
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      ) : auditTotals && auditTotals.parts.length > 0 ? (
        <HeadOfficeLocationTable
          product={product}
          auditItems={auditItems}
          auditTotals={auditTotals}
        />
      ) : isNoStockAudit ? (
        <p className="product-site-stock__empty text-muted text-sm">
          Audited as no stock. No rack, row, or bin recorded.
        </p>
      ) : (
        <div className="product-site-stock__empty-block">
          <p className="product-site-stock__empty text-muted text-sm">
            {canCount
              ? 'No store room bins linked yet. Use the pen to add rack/row/bin locations.'
              : openCycle === null
                ? 'No store room bins linked yet. Open an audit cycle to count.'
                : 'No store room bins linked to this item yet.'}
          </p>
          {canCount && (
            <MarkNoStockButton disabled={saving} onClick={() => void handleMarkNoStock()} />
          )}
        </div>
      )}

      {canCount && !editing && auditTotals && auditTotals.parts.length > 0 && (
        <div className="product-site-stock__no-stock-actions">
          <MarkNoStockButton disabled={saving} onClick={() => void handleMarkNoStock()} />
        </div>
      )}
      {error && !editing && <p className="product-site-stock__error text-sm">{error}</p>}
    </section>
  );
}

type EditableCochinRow = {
  id: string;
  zoneId: string;
  zoneRowNumber: string;
  quantity: string;
};

function createEditableRow(defaultZoneId = ''): EditableCochinRow {
  return {
    id: crypto.randomUUID(),
    zoneId: defaultZoneId,
    zoneRowNumber: '',
    quantity: '0',
  };
}

function rowsFromRecord(
  record: CatalogSiteInventoryDoc | null,
  defaultZoneId: string,
): EditableCochinRow[] {
  const locations = getCatalogSiteInventoryLocations(record);
  if (locations.length === 0) return [createEditableRow(defaultZoneId)];
  return locations.map(loc => ({
    id: crypto.randomUUID(),
    zoneId: loc.zoneId,
    zoneRowNumber: String(loc.zoneRowNumber),
    quantity: String(loc.quantity),
  }));
}

function LocationDropdownField({
  label,
  value,
  onChange,
  disabled,
  placeholder = 'Select',
  options,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  placeholder?: string;
  options: Array<{ value: string; label: string }>;
}) {
  return (
    <label className="product-site-stock__dropdown-field">
      <span className="product-site-stock__dropdown-label">{label}</span>
      <select
        className="product-site-stock__dropdown"
        value={value}
        onChange={e => onChange(e.target.value)}
        disabled={disabled}
        aria-label={label}
      >
        <option value="">{placeholder}</option>
        {options.map(option => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function CochinEditRow({
  row,
  zones,
  zoneRows,
  saving,
  canRemove,
  onUpdate,
  onRemove,
}: {
  row: EditableCochinRow;
  zones: WarehouseZoneDoc[];
  zoneRows: WarehouseZoneRowDoc[];
  saving: boolean;
  canRemove: boolean;
  onUpdate: (patch: Partial<EditableCochinRow>) => void;
  onRemove: () => void;
}) {
  return (
    <div className="product-site-stock__edit-row">
      <LocationDropdownField
        label="Zone"
        value={row.zoneId}
        disabled={saving || zones.length === 0}
        onChange={zoneId => onUpdate({ zoneId, zoneRowNumber: '' })}
        options={zones.map(zone => ({
          value: zone.id,
          label: `${zone.id.toUpperCase()}${zone.label ? ` — ${zone.label}` : ''}`,
        }))}
      />
      <LocationDropdownField
        label="Row"
        value={row.zoneRowNumber}
        disabled={saving || !row.zoneId || zoneRows.length === 0}
        onChange={zoneRowNumber => onUpdate({ zoneRowNumber })}
        options={zoneRows.map(zoneRow => ({
          value: String(zoneRow.number),
          label: String(zoneRow.number),
        }))}
      />
      <label className="product-site-stock__dropdown-field">
        <span className="product-site-stock__dropdown-label">Qty</span>
        <DecimalTextInput
          className="product-site-stock__dropdown product-site-stock__dropdown--qty"
          value={row.quantity}
          decimals={0}
          onChange={quantity => onUpdate({ quantity })}
          disabled={saving}
          aria-label="Counted qty"
        />
      </label>
      <button
        type="button"
        className="product-site-stock__row-remove product-site-stock__row-remove--inline"
        onClick={onRemove}
        disabled={saving || !canRemove}
        aria-label="Remove row"
      >
        <Trash2 size={14} aria-hidden />
      </button>
    </div>
  );
}

function CochinLocationSection({
  product,
  siteConfig,
  record,
  canEdit,
  editorUid,
  editorName,
  onSaved,
}: {
  product: CatalogProduct;
  siteConfig: CatalogInventorySiteConfig;
  record: CatalogSiteInventoryDoc | null;
  canEdit: boolean;
  editorUid: string;
  editorName?: string | null;
  onSaved: (record: CatalogSiteInventoryDoc) => void;
}) {
  const confirm = useConfirm();
  const [zones, setZones] = useState<WarehouseZoneDoc[]>([]);
  const [rowsByZone, setRowsByZone] = useState<Record<string, WarehouseZoneRowDoc[]>>({});
  const [rows, setRows] = useState<EditableCochinRow[]>(() => [createEditableRow()]);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [openCycle, setOpenCycle] = useState<AuditCycleDoc | null | undefined>(undefined);

  const countingLocked = openCycle == null;
  const canCount = canEdit && Boolean(openCycle);

  useEffect(() => {
    let active = true;
    void listWarehouseZones().then(async nextZones => {
      if (!active) return;
      const rowEntries = await Promise.all(
        nextZones.map(async zone => [zone.id, await listWarehouseZoneRows(zone.id)] as const),
      );
      if (!active) return;
      setZones(nextZones);
      setRowsByZone(Object.fromEntries(rowEntries));
    }).catch(() => {
      if (active) setZones([]);
    });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    let active = true;
    void getOpenAuditCycle('cochin')
      .then(cycle => {
        if (active) setOpenCycle(cycle);
      })
      .catch(() => {
        if (active) setOpenCycle(null);
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!editing) {
      setRows(rowsFromRecord(record, zones[0]?.id ?? ''));
    }
  }, [record, zones, editing]);

  const readOnlyLocations = useMemo(
    () => getCatalogSiteInventoryLocations(record),
    [record],
  );
  const isNoStockAudit = isNoStockSiteInventoryAudit(record);

  const startEditing = () => {
    if (countingLocked) {
      setError('No open audit cycle — counting locked for Cochin.');
      return;
    }
    setRows(rowsFromRecord(record, zones[0]?.id ?? ''));
    setError('');
    setEditing(true);
  };

  const cancelEditing = () => {
    setRows(rowsFromRecord(record, zones[0]?.id ?? ''));
    setError('');
    setEditing(false);
  };

  const updateRow = (id: string, patch: Partial<EditableCochinRow>) => {
    setRows(prev => prev.map(row => (row.id === id ? { ...row, ...patch } : row)));
  };

  const addRow = () => {
    setRows(prev => [...prev, createEditableRow(zones[0]?.id ?? '')]);
  };

  const removeRow = (id: string) => {
    setRows(prev => prev.filter(row => row.id !== id));
  };

  const handleSave = async () => {
    if (!openCycle?.id) {
      setError('No open audit cycle — counting locked for Cochin.');
      return;
    }
    const locations = rows
      .filter(row => row.zoneId && row.zoneRowNumber)
      .map(row => ({
        zoneId: row.zoneId,
        zoneRowNumber: Number(row.zoneRowNumber),
        quantity: Number(row.quantity),
      }));
    for (const location of locations) {
      if (!Number.isFinite(location.quantity) || location.quantity < 0) {
        setError('Quantity must be 0 or greater for every location.');
        return;
      }
    }
    if (locations.length === 0 && readOnlyLocations.length > 0) {
      const ok = await confirm({
        title: 'Delete warehouse locations?',
        message: 'This removes every zone and row for this product and records counted quantity as 0. Enter 0 on a row to keep the location and mark it empty.',
        confirmLabel: 'Delete locations',
        destructive: true,
      });
      if (!ok) return;
    }
    setSaving(true);
    setError('');
    try {
      const saved = await saveCatalogSiteInventory({
        catalogProductId: product.id,
        site: 'cochin',
        locations,
        updatedByUid: editorUid,
        updatedByName: editorName,
      });
      const { warning } = await recordCatalogProductAuditAfterCount(
        product.id,
        'cochin_inventory',
        openCycle.id,
      );
      onSaved(saved);
      setEditing(false);
      if (warning) setError(warning);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save Cochin stock.');
    } finally {
      setSaving(false);
    }
  };

  const handleMarkNoStock = async () => {
    if (!editorUid) {
      setError('Sign in required to save.');
      return;
    }
    if (!openCycle?.id) {
      setError('No open audit cycle — counting locked for Cochin.');
      return;
    }
    const ok = await confirm({
      title: 'Mark as no stock?',
      message: readOnlyLocations.length > 0
        ? 'This clears all warehouse locations and sets counted quantity to 0.'
        : 'This marks the product as audited with quantity 0 and no zone/row location.',
      confirmLabel: 'Mark as no stock',
      destructive: readOnlyLocations.length > 0,
    });
    if (!ok) return;

    setSaving(true);
    setError('');
    try {
      const saved = await markCatalogSiteNoStock({
        catalogProductId: product.id,
        site: 'cochin',
        updatedByUid: editorUid,
        updatedByName: editorName,
      });
      const { warning } = await recordCatalogProductAuditAfterCount(
        product.id,
        'cochin_inventory',
        openCycle.id,
      );
      onSaved(saved);
      setEditing(false);
      if (warning) setError(warning);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not mark as no stock.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <section
      className={[
        'product-site-stock',
        editing ? 'product-site-stock--editing' : '',
        isNoStockAudit ? 'product-site-stock--no-stock' : '',
      ].filter(Boolean).join(' ')}
    >
      <header className="product-site-stock__header">
        <h3 className="product-site-stock__title">{siteConfig.warehouseName}</h3>
        <div className="product-site-stock__header-actions">
          <SiteTypeBadge site={siteConfig.site} />
          {canCount && (
            <button
              type="button"
              className={[
                'product-site-stock__edit-btn',
                editing ? 'product-site-stock__edit-btn--active' : '',
              ].filter(Boolean).join(' ')}
              title={editing ? 'Cancel editing' : 'Edit warehouse locations'}
              aria-label={editing ? 'Cancel editing' : 'Edit warehouse locations'}
              aria-pressed={editing}
              onClick={() => (editing ? cancelEditing() : startEditing())}
            >
              {editing ? <X size={15} aria-hidden /> : <Pencil size={15} aria-hidden />}
            </button>
          )}
        </div>
      </header>

      {canEdit && openCycle === null && (
        <p className="product-site-stock__cycle-lock text-muted text-sm">
          No open audit cycle — counting locked.
        </p>
      )}

      {editing && canCount ? (
        <div className="product-site-stock__editor-modern">
          {rows.map(row => (
            <CochinEditRow
              key={row.id}
              row={row}
              zones={zones}
              zoneRows={row.zoneId ? (rowsByZone[row.zoneId] ?? []) : []}
              saving={saving}
              canRemove
              onUpdate={patch => updateRow(row.id, patch)}
              onRemove={() => removeRow(row.id)}
            />
          ))}

          <button
            type="button"
            className="product-site-stock__add-row-btn"
            disabled={saving}
            onClick={addRow}
          >
            <Plus size={14} aria-hidden />
            Add row
          </button>

          {zones.length === 0 && (
            <p className="product-site-stock__hint text-muted text-sm">
              Add warehouse zones in Settings → Warehouse first.
            </p>
          )}
          {error && <p className="product-site-stock__error text-sm">{error}</p>}

          <div className="product-site-stock__editor-toolbar product-site-stock__editor-toolbar--modern">
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              disabled={saving}
              onClick={cancelEditing}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-primary btn-sm product-site-stock__save-btn"
              disabled={saving}
              onClick={() => void handleSave()}
            >
              <Save size={14} aria-hidden />
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      ) : readOnlyLocations.length > 0 ? (
        <div className="product-site-stock__table-wrap product-site-stock__table-wrap--warehouse">
          <table className="product-site-stock__table product-site-stock__table--hero-values">
            <thead>
              <tr>
                <th>Zone</th>
                <th>Row</th>
                <th>Qty</th>
              </tr>
            </thead>
            <tbody>
              {readOnlyLocations.map((location, index) => (
                <tr key={`${location.zoneId}-${location.zoneRowNumber}-${index}`}>
                  <td>{location.zoneId.toUpperCase()}</td>
                  <td>{location.zoneRowNumber}</td>
                  <QtyWithAuditStamp
                    qtyLabel={formatStockQuantity(location.quantity, product.unit)}
                    auditedAt={record?.updatedAt}
                  />
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : isNoStockAudit ? (
        <p className="product-site-stock__empty text-muted text-sm">
          Audited as no stock. No zone or row recorded.
        </p>
      ) : (
        <div className="product-site-stock__empty-block">
          <p className="product-site-stock__empty text-muted text-sm">
            {canCount
              ? 'No warehouse count recorded yet. Use the pen to add zone/row locations.'
              : openCycle === null
                ? 'No warehouse count recorded yet. Open an audit cycle to count.'
                : 'No warehouse count recorded yet.'}
          </p>
          {canCount && (
            <MarkNoStockButton disabled={saving} onClick={() => void handleMarkNoStock()} />
          )}
        </div>
      )}

      {canCount && !editing && readOnlyLocations.length > 0 && (
        <div className="product-site-stock__no-stock-actions">
          <MarkNoStockButton disabled={saving} onClick={() => void handleMarkNoStock()} />
        </div>
      )}
      {error && !editing && <p className="product-site-stock__error text-sm">{error}</p>}
    </section>
  );
}

export const ProductSiteStockLocations: React.FC<{
  product: CatalogProductDetail;
  siteConfig: CatalogInventorySiteConfig;
  auditItems: YesStoreItemDoc[];
  cochinRecord: CatalogSiteInventoryDoc | null;
  headOfficeRecord?: CatalogSiteInventoryDoc | null;
  canEditCochin: boolean;
  canEditHeadOffice?: boolean;
  editorUid: string;
  editorName?: string | null;
  onCochinSaved: (record: CatalogSiteInventoryDoc) => void;
  onHeadOfficeSaved?: (items: YesStoreItemDoc[]) => void;
  onHeadOfficeZeroStockSaved?: (record: CatalogSiteInventoryDoc | null) => void;
}> = ({
  product,
  siteConfig,
  auditItems,
  cochinRecord,
  headOfficeRecord = null,
  canEditCochin,
  canEditHeadOffice = false,
  editorUid,
  editorName,
  onCochinSaved,
  onHeadOfficeSaved,
  onHeadOfficeZeroStockSaved,
}) => {
  if (siteConfig.site === 'cochin') {
    return (
      <CochinLocationSection
        product={product}
        siteConfig={siteConfig}
        record={cochinRecord}
        canEdit={canEditCochin}
        editorUid={editorUid}
        editorName={editorName}
        onSaved={onCochinSaved}
      />
    );
  }

  return (
    <HeadOfficeLocationSection
      product={product}
      siteConfig={siteConfig}
      auditItems={auditItems}
      zeroStockRecord={headOfficeRecord}
      canEdit={canEditHeadOffice}
      editorUid={editorUid}
      editorName={editorName}
      onSaved={items => onHeadOfficeSaved?.(items)}
      onZeroStockSaved={record => onHeadOfficeZeroStockSaved?.(record)}
    />
  );
};
