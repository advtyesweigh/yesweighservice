import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Camera, Loader2, Plus, Replace, Trash2 } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { useConfirm } from '../../context/ConfirmContext';
import {
  readItemQuantity,
  type BinNumber,
  type RowNumber,
  type YesStoreItemDoc,
  type YesStorePhoto,
} from '../../types/yes-store';
import {
  createItem,
  deleteItem,
  listItemsInBin,
  updateItem,
} from '../../lib/yesStore/data';
import {
  recordCatalogProductAuditForYesStoreItem,
  refreshHeadOfficeAuditSnapshot,
} from '../../lib/catalogProductAudit/data';
import { deleteYesStorePhotos, uploadYesStorePhoto, validateYesStoreImage } from '../../lib/yesStore/photos';
import { YesStorePhotoImg } from './YesStorePhotoImg';
import { pendingFromFile, type PhotoSlot } from './ItemPhotoQtyForm';
import { WarehouseWizardShell, WizardNextButton } from './WarehouseWizardShell';

type ItemRowState = {
  key: string;
  itemId?: string;
  catalogProductId?: string | null;
  slots: [PhotoSlot | null, PhotoSlot | null];
  quantity: string;
  saving: boolean;
  error: string;
  dirty: boolean;
};

type WarehouseBinEditorProps = {
  rackId: string;
  rowNumber: RowNumber;
  binNumber: BinNumber;
  onBack: () => void;
  onHome: () => void;
  onSaved?: () => void;
  /** After a replace from item edit, ensure an empty draft row is ready. */
  ensureDraftRow?: boolean;
};

function parseQuantity(value: string): number | null {
  if (value.trim() === '') return null;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function rowHasContent(row: ItemRowState): boolean {
  return savedPhotos(row.slots).length > 0 || row.quantity.trim() !== '';
}

function newRowKey(): string {
  return `row_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function emptyRow(): ItemRowState {
  return {
    key: newRowKey(),
    slots: [null, null],
    quantity: '',
    saving: false,
    error: '',
    dirty: false,
  };
}

function itemToRow(item: YesStoreItemDoc): ItemRowState {
  const photos = item.photos ?? [];
  return {
    key: item.id,
    itemId: item.id,
    catalogProductId: item.catalogProductId ?? null,
    slots: [
      photos[0] ? { kind: 'saved', photo: photos[0] } : null,
      photos[1] ? { kind: 'saved', photo: photos[1] } : null,
    ],
    quantity: String(readItemQuantity(item)),
    saving: false,
    error: '',
    dirty: false,
  };
}

function revokePending(slot: PhotoSlot | null) {
  if (slot?.kind === 'pending') URL.revokeObjectURL(slot.pending.previewUrl);
}

function savedPhotos(slots: [PhotoSlot | null, PhotoSlot | null]): YesStorePhoto[] {
  return slots
    .filter((s): s is Extract<PhotoSlot, { kind: 'saved' }> => s?.kind === 'saved')
    .map(s => s.photo);
}

function slotsUploading(slots: [PhotoSlot | null, PhotoSlot | null]): boolean {
  return slots.some(s => s?.kind === 'pending' && s.uploading);
}

function slotUploading(slot: PhotoSlot | null): boolean {
  return slot?.kind === 'pending' && Boolean(slot.uploading);
}

export const WarehouseBinEditor: React.FC<WarehouseBinEditorProps> = ({
  rackId,
  rowNumber,
  binNumber,
  onBack,
  onHome,
  onSaved,
  ensureDraftRow = false,
}) => {
  const { user } = useAuth();
  const confirm = useConfirm();
  const [rows, setRows] = useState<ItemRowState[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const targetRef = useRef<{ rowKey: string; slotIndex: 0 | 1 } | null>(null);
  const rowsRef = useRef(rows);
  const uploadGenRef = useRef<Map<string, number>>(new Map());
  rowsRef.current = rows;

  const loadBin = useCallback(async () => {
    setLoading(true);
    setLoadError('');
    try {
      const items = await listItemsInBin(rackId, rowNumber, binNumber);
      if (items.length) {
        const mapped = items.map(itemToRow);
        setRows(ensureDraftRow ? [...mapped, emptyRow()] : mapped);
      } else {
        setRows([emptyRow()]);
      }
    } catch (err: unknown) {
      setLoadError(err instanceof Error ? err.message : 'Could not load bin items');
      setRows([emptyRow()]);
    } finally {
      setLoading(false);
    }
  }, [rackId, rowNumber, binNumber, ensureDraftRow]);

  useEffect(() => {
    void loadBin();
    return () => {
      rowsRef.current.forEach(row => row.slots.forEach(revokePending));
    };
  }, [loadBin]);

  const updateRow = (rowKey: string, patch: Partial<ItemRowState>) => {
    setRows(prev => prev.map(row => (row.key === rowKey ? { ...row, ...patch, dirty: true } : row)));
  };

  const persistRow = useCallback(async (rowKey: string): Promise<boolean> => {
    const row = rowsRef.current.find(r => r.key === rowKey);
    if (!row || row.saving || slotsUploading(row.slots)) return false;

    const photos = savedPhotos(row.slots);
    if (!photos.length) return true;

    const quantity = parseQuantity(row.quantity);
    if (quantity == null) return false;

    setRows(prev =>
      prev.map(r => (r.key === rowKey ? { ...r, saving: true, error: '' } : r)),
    );

    try {
      const counter = user
        ? { uid: user.uid, displayName: user.displayName }
        : undefined;
      if (row.itemId) {
        const prevItem = rowsRef.current.find(r => r.key === rowKey);
        const prevSaved = prevItem ? savedPhotos(prevItem.slots) : [];
        const removed = prevSaved.filter(prev => !photos.some(next => next.id === prev.id));
        await updateItem(row.itemId, { quantity, photos }, counter);
        if (removed.length) await deleteYesStorePhotos(removed);
      } else {
        const created = await createItem({
          rackId,
          rowNumber,
          binNumber,
          quantity,
          photos,
          countedBy: counter,
        });
        row.slots.forEach(revokePending);
        setRows(prev =>
          prev.map(r => (r.key === rowKey ? itemToRow(created) : r)),
        );
        onSaved?.();
        void recordCatalogProductAuditForYesStoreItem(created.id).catch(() => undefined);
        return true;
      }

      row.slots.forEach(revokePending);
      const savedItemId = row.itemId;
      setRows(prev =>
        prev.map(r =>
          r.key === rowKey
            ? {
                ...r,
                itemId: row.itemId,
                slots: [
                  photos[0] ? { kind: 'saved' as const, photo: photos[0] } : null,
                  photos[1] ? { kind: 'saved' as const, photo: photos[1] } : null,
                ],
                quantity: String(quantity),
                saving: false,
                error: '',
                dirty: false,
              }
            : r,
        ),
      );
      onSaved?.();
      if (savedItemId) {
        void recordCatalogProductAuditForYesStoreItem(savedItemId).catch(() => undefined);
      }
      return true;
    } catch (err: unknown) {
      setRows(prev =>
        prev.map(r =>
          r.key === rowKey
            ? {
                ...r,
                saving: false,
                error: err instanceof Error ? err.message : 'Could not save item',
              }
            : r,
        ),
      );
      throw err;
    }
  }, [rackId, rowNumber, binNumber, onSaved, user]);

  const uploadSlotPhoto = useCallback(async (
    rowKey: string,
    slotIndex: 0 | 1,
    file: File,
  ) => {
    const slotKey = `${rowKey}-${slotIndex}`;
    const generation = (uploadGenRef.current.get(slotKey) ?? 0) + 1;
    uploadGenRef.current.set(slotKey, generation);

    const pending = pendingFromFile(file);
    setRows(prev =>
      prev.map(row => {
        if (row.key !== rowKey) return row;
        revokePending(row.slots[slotIndex]);
        const next = [...row.slots] as [PhotoSlot | null, PhotoSlot | null];
        next[slotIndex] = { kind: 'pending', pending, uploading: true };
        return { ...row, slots: next, error: '', dirty: true };
      }),
    );

    const row = rowsRef.current.find(r => r.key === rowKey);
    if (!row) return;

    const parentId = row.itemId ?? `new_${rackId}_${rowNumber}_${binNumber}_${rowKey}`;

    try {
      const photo = await uploadYesStorePhoto('item', parentId, file);
      if (uploadGenRef.current.get(slotKey) !== generation) {
        await deleteYesStorePhotos([photo]).catch(() => undefined);
        return;
      }

      URL.revokeObjectURL(pending.previewUrl);
      setRows(prev =>
        prev.map(r => {
          if (r.key !== rowKey) return r;
          const next = [...r.slots] as [PhotoSlot | null, PhotoSlot | null];
          next[slotIndex] = { kind: 'saved', photo };
          return { ...r, slots: next, error: '', dirty: true };
        }),
      );
    } catch (err: unknown) {
      if (uploadGenRef.current.get(slotKey) !== generation) return;
      const message = err instanceof Error ? err.message : 'Could not upload photo';
      setRows(prev =>
        prev.map(r => {
          if (r.key !== rowKey) return r;
          const next = [...r.slots] as [PhotoSlot | null, PhotoSlot | null];
          const slot = next[slotIndex];
          if (slot?.kind === 'pending') {
            next[slotIndex] = { ...slot, uploading: false };
          }
          return { ...r, slots: next, error: message };
        }),
      );
    }
  }, [rackId, rowNumber, binNumber]);

  const handleSubmit = async () => {
    setSubmitError('');
    const currentRows = rowsRef.current;

    if (currentRows.some(r => slotsUploading(r.slots))) {
      setSubmitError('Wait for photo uploads to finish.');
      return;
    }

    for (let i = 0; i < currentRows.length; i += 1) {
      const row = currentRows[i];
      const photos = savedPhotos(row.slots);
      if (!photos.length) continue;
      if (parseQuantity(row.quantity) == null) {
        setSubmitError(`Enter quantity for item ${i + 1}.`);
        return;
      }
    }

    setSubmitting(true);
    try {
      for (const row of currentRows) {
        if (!rowHasContent(row)) continue;
        const photos = savedPhotos(row.slots);
        if (!photos.length) continue;
        await persistRow(row.key);
      }
      onHome();
    } catch (err: unknown) {
      setSubmitError(err instanceof Error ? err.message : 'Could not save items');
    } finally {
      setSubmitting(false);
    }
  };

  const openPhotoPicker = (rowKey: string, slotIndex: 0 | 1) => {
    const row = rowsRef.current.find(r => r.key === rowKey);
    const slot = row?.slots[slotIndex];
    if (slot?.kind === 'pending' && slot.uploading) return;
    targetRef.current = { rowKey, slotIndex };
    fileRef.current?.click();
  };

  const handleFile = (fileList: FileList | null) => {
    const target = targetRef.current;
    if (!target || !fileList?.length) return;
    const file = fileList[0];
    const err = validateYesStoreImage(file);
    if (err) {
      updateRow(target.rowKey, { error: err });
      targetRef.current = null;
      return;
    }
    void uploadSlotPhoto(target.rowKey, target.slotIndex, file);
    targetRef.current = null;
  };

  const handleDelete = async (rowKey: string) => {
    const row = rowsRef.current.find(r => r.key === rowKey);
    if (!row) return;
    if (slotsUploading(row.slots)) return;

    if (row.itemId) {
      setRows(prev => prev.map(r => (r.key === rowKey ? { ...r, saving: true, error: '' } : r)));
      try {
        const catalogProductId = row.catalogProductId?.trim() || '';
        await deleteItem(row.itemId);
        const photos = savedPhotos(row.slots);
        if (photos.length) await deleteYesStorePhotos(photos);
        if (catalogProductId) {
          void refreshHeadOfficeAuditSnapshot(catalogProductId).catch(() => undefined);
        }
        onSaved?.();
      } catch (err: unknown) {
        setRows(prev =>
          prev.map(r =>
            r.key === rowKey
              ? {
                  ...r,
                  saving: false,
                  error: err instanceof Error ? err.message : 'Could not delete item',
                }
              : r,
          ),
        );
        return;
      }
    }

    row.slots.forEach((slot, index) => {
      uploadGenRef.current.set(`${rowKey}-${index}`, (uploadGenRef.current.get(`${rowKey}-${index}`) ?? 0) + 1);
      revokePending(slot);
    });
    setRows(prev => {
      const next = prev.filter(r => r.key !== rowKey);
      return next.length ? next : [emptyRow()];
    });
  };

  const handleReplace = async (rowKey: string) => {
    const row = rowsRef.current.find(r => r.key === rowKey);
    if (!row?.itemId || slotsUploading(row.slots) || row.saving) return;

    const ok = await confirm({
      title: 'Replace this item?',
      message:
        'The current photos and quantity will be deleted. You can then add new photos and quantity in this slot. This does not create a duplicate location.',
      confirmLabel: 'Replace',
      cancelLabel: 'Cancel',
      destructive: true,
    });
    if (!ok) return;

    setRows(prev => prev.map(r => (r.key === rowKey ? { ...r, saving: true, error: '' } : r)));
    try {
      const catalogProductId = row.catalogProductId?.trim() || '';
      await deleteItem(row.itemId);
      const photos = savedPhotos(row.slots);
      if (photos.length) await deleteYesStorePhotos(photos).catch(() => undefined);
      if (catalogProductId) {
        void refreshHeadOfficeAuditSnapshot(catalogProductId).catch(() => undefined);
      }
      onSaved?.();
    } catch (err: unknown) {
      setRows(prev =>
        prev.map(r =>
          r.key === rowKey
            ? {
                ...r,
                saving: false,
                error: err instanceof Error ? err.message : 'Could not replace item',
              }
            : r,
        ),
      );
      return;
    }

    row.slots.forEach((slot, index) => {
      uploadGenRef.current.set(`${rowKey}-${index}`, (uploadGenRef.current.get(`${rowKey}-${index}`) ?? 0) + 1);
      revokePending(slot);
    });
    const next = emptyRow();
    setRows(prev => prev.map(r => (r.key === rowKey ? next : r)));
  };

  const handleAddRow = async () => {
    const existing = rowsRef.current.filter(r => r.itemId || rowHasContent(r));
    if (existing.length > 0) {
      const ok = await confirm({
        title: 'Add another item?',
        message:
          'This bin already has stock. Adding creates another location record — it does not replace the existing one. To replace, tap Replace on that item.',
        confirmLabel: 'Add another',
        cancelLabel: 'Cancel',
      });
      if (!ok) return;
    }
    setRows(prev => [...prev, emptyRow()]);
  };

  return (
    <WarehouseWizardShell
      title="Bin Items"
      onBack={onBack}
      onHome={onHome}
      footer={
        <>
          {submitError && <p className="wh-error wh-error--footer">{submitError}</p>}
          <WizardNextButton
            label="Submit"
            variant="success"
            disabled={submitting || rows.some(r => slotsUploading(r.slots))}
            onClick={() => void handleSubmit()}
          />
        </>
      }
    >
      <div className="wh-bin-location">
        <span>Rack: <strong>{rackId.toUpperCase()}</strong></span>
        <span className="wh-bin-location__sep">/</span>
        <span>Row: <strong>{rowNumber}</strong></span>
        <span className="wh-bin-location__sep">/</span>
        <span>Bin: <strong>{binNumber}</strong></span>
      </div>

      {loadError && <p className="wh-error">{loadError}</p>}

      {loading ? (
        <div className="wh-bin-loading">
          <div className="loader-ring" />
        </div>
      ) : (
        <>
          <div className="wh-item-rows">
            {rows.map((row, index) => {
              const uploading = slotsUploading(row.slots);
              return (
                <article className="wh-item-row" key={row.key}>
                  <header className="wh-item-row__head">
                    <span className="wh-item-row__label">Item {index + 1}</span>
                    <div className="wh-item-row__head-actions">
                      {uploading && <span className="wh-item-row__status">Uploading…</span>}
                      {!uploading && row.saving && <span className="wh-item-row__status">Saving…</span>}
                      {row.itemId && !uploading && !row.saving && (
                        <button
                          type="button"
                          className="wh-item-row__replace"
                          onClick={() => void handleReplace(row.key)}
                          aria-label={`Replace item ${index + 1}`}
                        >
                          <Replace size={14} aria-hidden />
                          Replace
                        </button>
                      )}
                    </div>
                  </header>

                  <div className="wh-item-row__body">
                    <div className="wh-item-row__photos">
                      {([0, 1] as const).map(slotIndex => {
                        const slot = row.slots[slotIndex];
                        const pendingPreview =
                          slot?.kind === 'pending' ? slot.pending.previewUrl : null;
                        const isUploading = slotUploading(slot);
                        const hasImage = slot?.kind === 'saved' || Boolean(pendingPreview);
                        return (
                          <button
                            key={slotIndex}
                            type="button"
                            className={`wh-photo-slot ${hasImage ? 'has-image' : ''} ${isUploading ? 'is-uploading' : ''}`}
                            onClick={() => openPhotoPicker(row.key, slotIndex)}
                            disabled={isUploading}
                            aria-label={`Item ${index + 1} photo ${slotIndex + 1}`}
                          >
                            {slot?.kind === 'saved' ? (
                              <YesStorePhotoImg photo={slot.photo} emptyClassName="wh-photo-slot__empty" />
                            ) : pendingPreview ? (
                              <img src={pendingPreview} alt="" />
                            ) : (
                              <Camera size={20} aria-hidden />
                            )}
                            {isUploading && (
                              <span className="wh-photo-slot__overlay" aria-hidden>
                                <Loader2 size={22} className="spin-icon" />
                              </span>
                            )}
                          </button>
                        );
                      })}
                    </div>

                    <label className="wh-item-row__qty-wrap">
                      <span className="sr-only">Quantity for item {index + 1}</span>
                      <input
                        type="text"
                        inputMode="numeric"
                        pattern="[0-9]*"
                        className="wh-item-row__qty"
                        placeholder="Qty"
                        value={row.quantity}
                        onFocus={e => e.target.select()}
                        onChange={e => {
                          const v = e.target.value;
                          if (v === '' || /^\d+$/.test(v)) {
                            updateRow(row.key, { quantity: v });
                          }
                        }}
                      />
                    </label>

                    <button
                      type="button"
                      className="wh-item-row__delete"
                      onClick={() => void handleDelete(row.key)}
                      disabled={row.saving || uploading}
                      aria-label={`Delete item ${index + 1}`}
                    >
                      <Trash2 size={18} />
                    </button>
                  </div>

                  {row.error && <p className="wh-item-row__error">{row.error}</p>}
                </article>
              );
            })}
          </div>

          <button type="button" className="wh-add-row" onClick={() => void handleAddRow()}>
            <Plus size={18} aria-hidden />
            Add item
          </button>
        </>
      )}

      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="sr-only"
        onChange={e => {
          handleFile(e.target.files);
          e.target.value = '';
        }}
      />
    </WarehouseWizardShell>
  );
};
