import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Camera, Loader2, Minus, Plus, Replace, Trash2, X } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { useConfirm } from '../../context/ConfirmContext';
import {
  BIN_NUMBERS,
  ROW_NUMBERS,
  VALID_RACK_LETTERS,
  readItemQuantity,
  type BinNumber,
  type RowNumber,
  type YesStorePhoto,
  type YesStoreItemDoc,
} from '../../types/yes-store';
import { deleteItem, updateItemDetails } from '../../lib/yesStore/data';
import {
  recordCatalogProductAuditForYesStoreItem,
  refreshHeadOfficeAuditSnapshot,
} from '../../lib/catalogProductAudit/data';
import {
  deleteYesStorePhotos,
  uploadYesStorePhoto,
  validateYesStoreImage,
} from '../../lib/yesStore/photos';
import { YesStorePhotoImg } from './YesStorePhotoImg';
import { pendingFromFile, type PhotoSlot } from './ItemPhotoQtyForm';
import { WarehouseWizardShell, WizardNextButton } from './WarehouseWizardShell';

type SlotTuple = [PhotoSlot | null, PhotoSlot | null];

type WarehouseItemEditorProps = {
  item: YesStoreItemDoc;
  onBack: () => void;
  onHome: () => void;
  onSaved?: () => void;
  /** After replace deletes this item, open the bin editor at the same location. */
  onReplacedInBin?: (location: {
    rackId: string;
    rowNumber: RowNumber;
    binNumber: BinNumber;
  }) => void;
};

function parseQuantity(value: string): number | null {
  if (value.trim() === '') return null;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function revokePending(slot: PhotoSlot | null) {
  if (slot?.kind === 'pending') URL.revokeObjectURL(slot.pending.previewUrl);
}

function savedPhotos(slots: SlotTuple): YesStorePhoto[] {
  return slots
    .filter((s): s is Extract<PhotoSlot, { kind: 'saved' }> => s?.kind === 'saved')
    .map(s => s.photo);
}

function slotsUploading(slots: SlotTuple): boolean {
  return slots.some(s => s?.kind === 'pending' && s.uploading);
}

function slotUploading(slot: PhotoSlot | null): boolean {
  return slot?.kind === 'pending' && Boolean(slot.uploading);
}

function initialSlots(item: YesStoreItemDoc): SlotTuple {
  const photos = item.photos ?? [];
  return [
    photos[0] ? { kind: 'saved', photo: photos[0] } : null,
    photos[1] ? { kind: 'saved', photo: photos[1] } : null,
  ];
}

export const WarehouseItemEditor: React.FC<WarehouseItemEditorProps> = ({
  item,
  onBack,
  onHome,
  onSaved,
  onReplacedInBin,
}) => {
  const { user } = useAuth();
  const confirm = useConfirm();
  const [rackId, setRackId] = useState<string>(item.rackId.toLowerCase());
  const [rowNumber, setRowNumber] = useState<RowNumber>(item.rowNumber);
  const [binNumber, setBinNumber] = useState<BinNumber>(item.binNumber);
  const [quantity, setQuantity] = useState<string>(String(readItemQuantity(item)));
  const [slots, setSlots] = useState<SlotTuple>(() => initialSlots(item));
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [replacing, setReplacing] = useState(false);
  const [error, setError] = useState('');

  const fileRef = useRef<HTMLInputElement>(null);
  const targetSlotRef = useRef<0 | 1 | null>(null);
  const slotsRef = useRef(slots);
  const uploadGenRef = useRef<Map<number, number>>(new Map());
  slotsRef.current = slots;

  useEffect(() => {
    return () => {
      slotsRef.current.forEach(revokePending);
    };
  }, []);

  const originalPhotos = item.photos ?? [];
  const originalQty = readItemQuantity(item);
  const parsedQty = parseQuantity(quantity);
  const currentSaved = savedPhotos(slots);
  const uploading = slotsUploading(slots);

  const photosChanged =
    currentSaved.length !== originalPhotos.length ||
    currentSaved.some((p, i) => p.id !== originalPhotos[i]?.id);
  const changed =
    rackId !== item.rackId.toLowerCase() ||
    rowNumber !== item.rowNumber ||
    binNumber !== item.binNumber ||
    parsedQty !== originalQty ||
    photosChanged;

  const busy = saving || deleting || replacing;

  const uploadSlotPhoto = useCallback(async (slotIndex: 0 | 1, file: File) => {
    const generation = (uploadGenRef.current.get(slotIndex) ?? 0) + 1;
    uploadGenRef.current.set(slotIndex, generation);

    const pending = pendingFromFile(file);
    setSlots(prev => {
      const next = [...prev] as SlotTuple;
      revokePending(next[slotIndex]);
      next[slotIndex] = { kind: 'pending', pending, uploading: true };
      return next;
    });
    setError('');

    const parentId = item.id;
    try {
      const photo = await uploadYesStorePhoto('item', parentId, file);
      if (uploadGenRef.current.get(slotIndex) !== generation) {
        await deleteYesStorePhotos([photo]).catch(() => undefined);
        return;
      }
      URL.revokeObjectURL(pending.previewUrl);
      setSlots(prev => {
        const next = [...prev] as SlotTuple;
        next[slotIndex] = { kind: 'saved', photo };
        return next;
      });
    } catch (err: unknown) {
      if (uploadGenRef.current.get(slotIndex) !== generation) return;
      setSlots(prev => {
        const next = [...prev] as SlotTuple;
        const slot = next[slotIndex];
        if (slot?.kind === 'pending') next[slotIndex] = { ...slot, uploading: false };
        return next;
      });
      setError(err instanceof Error ? err.message : 'Could not upload photo.');
    }
  }, [item.id]);

  const openPhotoPicker = (slotIndex: 0 | 1) => {
    const slot = slotsRef.current[slotIndex];
    if (slotUploading(slot)) return;
    targetSlotRef.current = slotIndex;
    fileRef.current?.click();
  };

  const handleFile = (fileList: FileList | null) => {
    const slotIndex = targetSlotRef.current;
    targetSlotRef.current = null;
    if (slotIndex == null || !fileList?.length) return;
    const file = fileList[0];
    const err = validateYesStoreImage(file);
    if (err) {
      setError(err);
      return;
    }
    void uploadSlotPhoto(slotIndex, file);
  };

  const removeSlot = (slotIndex: 0 | 1) => {
    uploadGenRef.current.set(slotIndex, (uploadGenRef.current.get(slotIndex) ?? 0) + 1);
    setSlots(prev => {
      const next = [...prev] as SlotTuple;
      revokePending(next[slotIndex]);
      next[slotIndex] = null;
      return next;
    });
  };

  const handleSave = async () => {
    setError('');
    if (uploading) {
      setError('Wait for photo uploads to finish.');
      return;
    }
    if (parsedQty == null) {
      setError('Enter a valid quantity.');
      return;
    }
    const photos = savedPhotos(slotsRef.current);
    if (!photos.length) {
      setError('Add at least one photo.');
      return;
    }
    setSaving(true);
    try {
      const counter = user
        ? { uid: user.uid, displayName: user.displayName }
        : undefined;
      const removed = originalPhotos.filter(prev => !photos.some(next => next.id === prev.id));
      await updateItemDetails(
        item.id,
        { rackId, rowNumber, binNumber, quantity: parsedQty, photos },
        counter,
      );
      if (removed.length) await deleteYesStorePhotos(removed).catch(() => undefined);
      void recordCatalogProductAuditForYesStoreItem(item.id).catch(() => undefined);
      onSaved?.();
      onHome();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not save changes.');
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    setError('');
    setDeleting(true);
    try {
      const catalogProductId = item.catalogProductId?.trim() || '';
      await deleteItem(item.id);
      if (originalPhotos.length) await deleteYesStorePhotos(originalPhotos).catch(() => undefined);
      if (catalogProductId) {
        void refreshHeadOfficeAuditSnapshot(catalogProductId).catch(() => undefined);
      }
      onSaved?.();
      onHome();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not delete item.');
      setDeleting(false);
    }
  };

  const handleReplace = async () => {
    setError('');
    const ok = await confirm({
      title: 'Replace this item?',
      message:
        'This deletes the current stock record, then opens the bin so you can count the new item at the same location. It will not leave a duplicate.',
      confirmLabel: 'Replace',
      cancelLabel: 'Cancel',
      destructive: true,
    });
    if (!ok) return;

    setReplacing(true);
    try {
      const catalogProductId = item.catalogProductId?.trim() || '';
      await deleteItem(item.id);
      if (originalPhotos.length) await deleteYesStorePhotos(originalPhotos).catch(() => undefined);
      if (catalogProductId) {
        void refreshHeadOfficeAuditSnapshot(catalogProductId).catch(() => undefined);
      }
      onSaved?.();
      if (onReplacedInBin) {
        onReplacedInBin({
          rackId: item.rackId.toLowerCase(),
          rowNumber: item.rowNumber,
          binNumber: item.binNumber,
        });
      } else {
        onHome();
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not replace item.');
      setReplacing(false);
    }
  };

  return (
    <WarehouseWizardShell
      title="Edit Item"
      onBack={onBack}
      onHome={onHome}
      footer={
        <>
          {error && <p className="wh-error wh-error--footer">{error}</p>}
          <WizardNextButton
            label={saving ? 'Saving…' : 'Save changes'}
            variant="success"
            disabled={busy || uploading || !changed || parsedQty == null}
            onClick={() => void handleSave()}
          />
        </>
      }
    >
      <div className="wh-edit">
        <section className="wh-edit-card">
          <div className="wh-edit-card__head">
            <h2 className="wh-edit-card__title">Photos</h2>
            <span className="wh-edit-card__hint">{currentSaved.length}/2</span>
          </div>
          <div className="wh-item-edit__photos">
            {([0, 1] as const).map(slotIndex => {
              const slot = slots[slotIndex];
              const pendingPreview = slot?.kind === 'pending' ? slot.pending.previewUrl : null;
              const isUploading = slotUploading(slot);
              const hasImage = slot?.kind === 'saved' || Boolean(pendingPreview);
              return (
                <div className="wh-item-edit__photo-wrap" key={slotIndex}>
                  <button
                    type="button"
                    className={`wh-photo-slot ${hasImage ? 'has-image' : ''} ${isUploading ? 'is-uploading' : ''}`}
                    onClick={() => openPhotoPicker(slotIndex)}
                    disabled={isUploading || busy}
                    aria-label={`Photo ${slotIndex + 1}`}
                  >
                    {slot?.kind === 'saved' ? (
                      <YesStorePhotoImg photo={slot.photo} emptyClassName="wh-photo-slot__empty" />
                    ) : pendingPreview ? (
                      <img src={pendingPreview} alt="" />
                    ) : (
                      <Camera size={18} aria-hidden />
                    )}
                    {isUploading && (
                      <span className="wh-photo-slot__overlay" aria-hidden>
                        <Loader2 size={20} className="spin-icon" />
                      </span>
                    )}
                  </button>
                  {hasImage && !isUploading && (
                    <button
                      type="button"
                      className="wh-item-edit__photo-remove"
                      onClick={() => removeSlot(slotIndex)}
                      disabled={busy}
                      aria-label={`Remove photo ${slotIndex + 1}`}
                    >
                      <X size={13} aria-hidden />
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </section>

        <section className="wh-edit-card">
          <div className="wh-edit-card__head">
            <h2 className="wh-edit-card__title">Location</h2>
            <span className="wh-edit-card__hint">
              {rackId.toUpperCase()} · {rowNumber} · {binNumber}
            </span>
          </div>

          <div className="wh-edit-field">
            <span className="wh-edit-field__label">Rack</span>
            <div className="wh-chips">
              {VALID_RACK_LETTERS.map(letter => (
                <button
                  key={letter}
                  type="button"
                  className={`wh-chip${rackId === letter ? ' is-selected' : ''}`}
                  onClick={() => setRackId(letter)}
                  disabled={busy}
                >
                  {letter.toUpperCase()}
                </button>
              ))}
            </div>
          </div>

          <div className="wh-edit-field">
            <span className="wh-edit-field__label">Row</span>
            <div className="wh-chips">
              {ROW_NUMBERS.map(n => (
                <button
                  key={n}
                  type="button"
                  className={`wh-chip${rowNumber === n ? ' is-selected' : ''}`}
                  onClick={() => setRowNumber(n)}
                  disabled={busy}
                >
                  {n}
                </button>
              ))}
            </div>
          </div>

          <div className="wh-edit-field">
            <span className="wh-edit-field__label">Bin</span>
            <div className="wh-chips">
              {BIN_NUMBERS.map(n => (
                <button
                  key={n}
                  type="button"
                  className={`wh-chip${binNumber === n ? ' is-selected' : ''}`}
                  onClick={() => setBinNumber(n)}
                  disabled={busy}
                >
                  {n}
                </button>
              ))}
            </div>
          </div>
        </section>

        <section className="wh-edit-card wh-edit-card--row">
          <h2 className="wh-edit-card__title">Quantity</h2>
          <div className="wh-qty-stepper">
            <button
              type="button"
              className="wh-qty-stepper__btn"
              onClick={() => setQuantity(String(Math.max(0, (parsedQty ?? 0) - 1)))}
              disabled={busy || (parsedQty ?? 0) <= 0}
              aria-label="Decrease quantity"
            >
              <Minus size={18} aria-hidden />
            </button>
            <input
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              enterKeyHint="done"
              autoComplete="off"
              className="wh-qty-stepper__input"
              placeholder="Qty"
              value={quantity}
              disabled={busy}
              aria-label="Quantity"
              onChange={e => {
                const v = e.target.value;
                if (v === '' || /^\d+$/.test(v)) setQuantity(v);
              }}
              onFocus={e => e.target.select()}
            />
            <button
              type="button"
              className="wh-qty-stepper__btn"
              onClick={() => setQuantity(String((parsedQty ?? 0) + 1))}
              disabled={busy}
              aria-label="Increase quantity"
            >
              <Plus size={18} aria-hidden />
            </button>
          </div>
        </section>

        <div className="wh-item-edit__actions">
          <button
            type="button"
            className="wh-item-edit__replace"
            onClick={() => void handleReplace()}
            disabled={busy}
          >
            {replacing ? (
              <Loader2 size={18} className="spin-icon" aria-hidden />
            ) : (
              <Replace size={18} aria-hidden />
            )}
            Replace item
          </button>
          <button
            type="button"
            className="wh-item-edit__delete"
            onClick={() => void handleDelete()}
            disabled={busy}
          >
            {deleting ? <Loader2 size={18} className="spin-icon" aria-hidden /> : <Trash2 size={18} aria-hidden />}
            Delete item
          </button>
        </div>
      </div>

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
