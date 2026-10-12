import React, { useEffect, useMemo, useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import { BadgeCheck, Ban, CheckCircle2, Hash, PackagePlus, Send, Unlink, X } from 'lucide-react';
import { DocumentKamStrip } from '../../components/admin/DocumentKamStrip';
import { DocumentPartyBlock } from '../../components/admin/DocumentPartyBlock';
import { appendPhoneToAddressLine } from '../../lib/logisticsDealers';
import { InvoiceDocumentBody } from '../../components/invoices/InvoiceDocumentBody';
import { InvoiceLocalFreightEditor } from '../../components/invoices/InvoiceLocalFreightEditor';
import { GatcSerialPickerDialog } from '../../components/invoices/GatcSerialPickerDialog';
import { RelatedSupportRequests } from '../../components/support/RelatedSupportRequests';
import { useConfirm } from '../../context/ConfirmContext';
import { logisticsPartnerLabel } from '../../constants/logisticsPartners';
import { useAuth } from '../../context/AuthContext';
import { isFreightInvoiceLineItem, serialNumbersFromLineItem } from '../../lib/invoices';
import {
  allotNonGatcSerialsToInvoice,
  isNonGatcSerialEligibleLine,
  isVoidOrCancelledInvoiceStatus,
  nonGatcSerialShortage,
  pushRcInvoiceToYesGatc,
  unlinkNonGatcSerialsFromInvoice,
} from '../../lib/nonGatcSerialAllot';
import {
  allotGatcStampedSerialsToInvoice,
  gatcStampedSerialShortage,
  invoiceLineStampingCapacityKg,
  isGatcStampedSerialEligibleLine,
  unlinkGatcStampedSerialsFromInvoice,
} from '../../lib/gatcStampedSerialAllot';
import {
  findYesGatcRcForDealer,
  type YesGatcDealerRcLink,
} from '../../lib/yesgatcRecords';
import {
  effectiveInvoiceFreightSku,
  overlayLocalFreightOnLineItems,
  type LocalFreightSelectSku,
} from '../../lib/invoiceLocalFreight';
import {
  invoiceIsDeliveredForSerials,
  invoiceNeedsMandatorySerials,
} from '../../lib/invoiceSerialGate';
import {
  appendMachineQcDescription,
  documentLooksLikeMachineQc,
  lineLooksLikeMachineQc,
  stripBackBillNote,
} from '../../lib/machineQc';
import { INVOICE_QC_REQUIRED } from '../../lib/invoiceMachineQc';
import { canVoidAdminInvoice, isInternalOpsUser } from '../../lib/staffAccess';
import { voidAdminInvoice } from '../../lib/voidAdminInvoice';
import type { AdminInvoiceDetailOutletContext } from './adminInvoiceDetailContext';

export const AdminInvoiceDocumentPage: React.FC = () => {
  const { user } = useAuth();
  const confirm = useConfirm();
  const {
    invoice,
    customerId,
    invoiceId,
    showManualLogistics,
    manualLogisticsPartnerId,
    manualLogisticsPartnerFromFreight,
    onOpenManualLogistics,
    showMarkDelivered,
    onOpenMarkDelivered,
    existingBooking,
    kamCardOpen,
    qcPhotoCount = 0,
    needsMandatoryQc = false,
    canEditLocalFreight = false,
    localFreightBusy = false,
    localFreightError = '',
    onChangeLocalFreight,
    reloadInvoice,
  } = useOutletContext<AdminInvoiceDetailOutletContext>();

  const isOps = isInternalOpsUser(user);
  const showKamCard = Boolean(invoice) && (!isOps || Boolean(kamCardOpen));
  const [freightOpen, setFreightOpen] = useState(true);
  const [allotBusy, setAllotBusy] = useState(false);
  const [allotError, setAllotError] = useState('');
  const [allotNotice, setAllotNotice] = useState('');
  const [rcLink, setRcLink] = useState<YesGatcDealerRcLink | null>(null);
  const [gatcPicker, setGatcPicker] = useState<{
    lineId: string;
    need: number;
    title: string;
    capacityKg: number | null;
    mode: 'gatc' | 'nongatc';
    productId?: string | null;
    sku?: string | null;
    productName?: string | null;
  } | null>(null);
  const [gatcPickerError, setGatcPickerError] = useState('');
  const [voidBusy, setVoidBusy] = useState(false);

  useEffect(() => {
    if (!kamCardOpen) return;
    window.requestAnimationFrame(() => {
      document.getElementById('invoice-detail-kam')?.scrollIntoView({
        behavior: 'smooth',
        block: 'nearest',
      });
    });
  }, [kamCardOpen]);

  useEffect(() => {
    if (!customerId) {
      setRcLink(null);
      return;
    }
    let cancelled = false;
    void findYesGatcRcForDealer(customerId)
      .then(link => {
        if (!cancelled) setRcLink(link);
      })
      .catch(() => {
        if (!cancelled) setRcLink(null);
      });
    return () => {
      cancelled = true;
    };
  }, [customerId]);

  const displayInvoice = useMemo(() => {
    if (!invoice) return null;
    const qcOrder = documentLooksLikeMachineQc(invoice);
    return {
      ...invoice,
      lineItems: overlayLocalFreightOnLineItems(invoice).map(item => {
        if (isFreightInvoiceLineItem(item)) return item;
        const description = (qcOrder || lineLooksLikeMachineQc(item))
          ? appendMachineQcDescription(item.description, {
            qcEnabled: item.qcEnabled === true || lineLooksLikeMachineQc(item),
            qcFeePerUnit: item.qcFeePerUnit ?? 0,
          })
          : stripBackBillNote(item.description);
        return description === item.description ? item : { ...item, description };
      }),
    };
  }, [invoice]);

  if (!displayInvoice || !invoice) return null;

  const trackingLabel = existingBooking?.consignmentNo?.trim()
    || existingBooking?.trackingNo?.trim()
    || '';
  const selectedFreightSku = (effectiveInvoiceFreightSku(invoice) || null) as LocalFreightSelectSku | null;
  const freightItem = displayInvoice.lineItems.find(item => isFreightInvoiceLineItem(item));
  const selectedLineItemId = canEditLocalFreight && freightOpen
    ? (freightItem?.id ?? null)
    : null;

  const invoiceVoid = isVoidOrCancelledInvoiceStatus(invoice.status);
  const invoiceDelivered = invoiceIsDeliveredForSerials(invoice);
  const canAllotSerials = Boolean(
    user
    && !invoiceVoid
    && (
      isOps
      || (user.role === 'warehouse' && !invoiceDelivered)
    ),
  );
  const needsSerialAllot = invoiceNeedsMandatorySerials(displayInvoice.lineItems);
  const hasAllottedSerials = displayInvoice.lineItems.some(
    line => isNonGatcSerialEligibleLine(line) && serialNumbersFromLineItem(line).length > 0,
  );
  const yesgatcPushed = Boolean(invoice.yesgatcRcPushedAt);
  const canPushYesGatc = Boolean(canAllotSerials && rcLink && hasAllottedSerials);

  const actorName = user?.displayName?.trim() || user?.email?.trim() || 'YESWEIGH';
  const showVoidInvoice = Boolean(user && canVoidAdminInvoice(user) && !invoiceVoid);

  const zohoNotice = (result: { zohoPushed?: boolean; zohoError?: string }) => {
    if (result.zohoPushed) return ' Zoho invoice updated.';
    if (result.zohoError) return ` Zoho update failed: ${result.zohoError}`;
    return '';
  };

  const yesgatcNotice = (result: {
    yesgatcPushed?: boolean;
    yesgatcSkipped?: string | null;
    yesgatcError?: string | null;
  }) => {
    if (result.yesgatcPushed) return ' Pushed to YesGATC.';
    if (result.yesgatcSkipped === 'not_rc') return '';
    if (result.yesgatcSkipped === 'no_webhook') {
      return ' YesGATC pending — paste the YesGATC URL in Serial numbers.';
    }
    if (result.yesgatcError) return ` YesGATC: ${result.yesgatcError}`;
    return '';
  };

  const openNonGatcPicker = (
    lineId: string,
    need: number,
    title: string,
    productId?: string | null,
    sku?: string | null,
  ) => {
    if (!canAllotSerials || allotBusy || need <= 0) return;
    setGatcPickerError('');
    setGatcPicker({ lineId, need, title, capacityKg: null, mode: 'nongatc', productId, sku });
  };

  const handleUnlinkSerials = async (lineId?: string, serial?: string) => {
    if (!canAllotSerials || allotBusy) return;
    const one = Boolean(serial);
    const ok = await confirm({
      title: one ? 'Unlink this serial number' : 'Unlink serial numbers',
      message: one
        ? `Return ${serial} to the pool and remove it from the Zoho invoice? Other serials on this line stay.`
        : lineId
          ? 'Return every serial on this line to the pool and remove them from the Zoho invoice?'
          : 'Return all allotted serial numbers to the pool and remove them from the Zoho invoice?',
      confirmLabel: 'Unlink',
      destructive: true,
    });
    if (!ok) return;
    setAllotBusy(true);
    setAllotError('');
    setAllotNotice('');
    try {
      const result = await unlinkNonGatcSerialsFromInvoice({
        customerId,
        invoiceId,
        actorName,
        lineId,
        ...(one ? { serials: [serial as string] } : {}),
      });
      await reloadInvoice?.();
      if (result.released > 0) {
        setAllotNotice(
          `Unlinked ${result.released.toLocaleString('en-IN')} serial${result.released === 1 ? '' : 's'}.${zohoNotice(result)}${yesgatcNotice(result)}`,
        );
      } else {
        setAllotNotice('No serial numbers to unlink.');
      }
    } catch (err) {
      setAllotError(err instanceof Error ? err.message : 'Could not unlink serial numbers.');
    } finally {
      setAllotBusy(false);
    }
  };

  const openGatcPicker = (
    lineId: string,
    need: number,
    title: string,
    capacityKg: number | null,
    productId?: string | null,
    sku?: string | null,
  ) => {
    if (!canAllotSerials || allotBusy || need <= 0) return;
    setGatcPickerError('');
    setGatcPicker({
      lineId,
      need,
      title,
      capacityKg,
      mode: 'gatc',
      productId,
      sku,
      productName: title,
    });
  };

  const handleSavePickerSerials = async (ids: string[]) => {
    if (!gatcPicker || !canAllotSerials || allotBusy) return;
    setAllotBusy(true);
    setGatcPickerError('');
    setAllotError('');
    setAllotNotice('');
    try {
      if (gatcPicker.mode === 'nongatc') {
        const result = await allotNonGatcSerialsToInvoice({
          customerId,
          invoiceId,
          lineId: gatcPicker.lineId,
          serials: ids,
          actorName,
        });
        await reloadInvoice?.();
        setGatcPicker(null);
        setAllotNotice(
          `Linked ${result.allotted.toLocaleString('en-IN')} serial${result.allotted === 1 ? '' : 's'}.${zohoNotice(result)}${yesgatcNotice(result)}`,
        );
        return;
      }
      const result = await allotGatcStampedSerialsToInvoice({
        customerId,
        invoiceId,
        lineId: gatcPicker.lineId,
        certificateIds: ids,
        actorName,
      });
      await reloadInvoice?.();
      setGatcPicker(null);
      setAllotNotice(
        `Linked ${result.allotted.toLocaleString('en-IN')} GATC serial${result.allotted === 1 ? '' : 's'}.${zohoNotice(result)}${yesgatcNotice(result)}`,
      );
    } catch (err) {
      setGatcPickerError(
        err instanceof Error
          ? err.message
          : gatcPicker.mode === 'nongatc'
            ? 'Could not save serial numbers.'
            : 'Could not save GATC serial numbers.',
      );
    } finally {
      setAllotBusy(false);
    }
  };

  const handleUnlinkGatcSerials = async (lineId?: string, serial?: string) => {
    if (!canAllotSerials || allotBusy) return;
    const one = Boolean(serial);
    const ok = await confirm({
      title: one ? 'Unlink this GATC serial' : 'Unlink GATC serial numbers',
      message: one
        ? `Remove ${serial} from this invoice and unlink its certificate? Other serials on this line stay.`
        : lineId
          ? 'Remove every GATC serial on this line, unlink the certificates, and update Zoho?'
          : 'Remove all GATC serials from this invoice, unlink the certificates, and update Zoho?',
      confirmLabel: 'Unlink',
      destructive: true,
    });
    if (!ok) return;
    setAllotBusy(true);
    setAllotError('');
    setAllotNotice('');
    try {
      const result = await unlinkGatcStampedSerialsFromInvoice({
        customerId,
        invoiceId,
        actorName,
        lineId,
        ...(one ? { serials: [serial as string] } : {}),
      });
      await reloadInvoice?.();
      if (result.released > 0) {
        setAllotNotice(
          `Unlinked ${result.released.toLocaleString('en-IN')} GATC serial${result.released === 1 ? '' : 's'}.${zohoNotice(result)}${yesgatcNotice(result)}`,
        );
      } else {
        setAllotNotice('No GATC serial numbers to unlink.');
      }
    } catch (err) {
      setAllotError(err instanceof Error ? err.message : 'Could not unlink GATC serial numbers.');
    } finally {
      setAllotBusy(false);
    }
  };

  const handleVoidInvoice = async () => {
    if (!showVoidInvoice || voidBusy || allotBusy) return;
    const ok = await confirm({
      title: 'Void invoice',
      message: `Void ${invoice.invoiceNumber || 'this invoice'} in Zoho? Serial numbers will return to the pool and GATC certificates will be unlinked from this invoice.`,
      confirmLabel: 'Void invoice',
      destructive: true,
    });
    if (!ok) return;
    setVoidBusy(true);
    setAllotError('');
    setAllotNotice('');
    try {
      const result = await voidAdminInvoice({ customerId, invoiceId });
      await reloadInvoice?.();
      const released = Number(result.released) || 0;
      setAllotNotice(
        released > 0
          ? `Invoice voided in Zoho. Released ${released.toLocaleString('en-IN')} serial${released === 1 ? '' : 's'} and unlinked GATC certificates.`
          : 'Invoice voided in Zoho.',
      );
    } catch (err) {
      setAllotError(err instanceof Error ? err.message : 'Could not void this invoice.');
    } finally {
      setVoidBusy(false);
    }
  };

  const handlePushYesGatc = async () => {
    if (!canPushYesGatc || allotBusy) return;
    setAllotBusy(true);
    setAllotError('');
    setAllotNotice('');
    try {
      const result = await pushRcInvoiceToYesGatc({
        customerId,
        invoiceId,
        actorName,
        force: true,
      });
      await reloadInvoice?.();
      if (result.pushed) {
        setAllotNotice(
          `Pushed to YesGATC${result.rc?.rcName ? ` · ${result.rc.rcName}` : ''}${result.qty != null ? ` · qty ${result.qty}` : ''}.`,
        );
      } else if (result.skipped === 'not_rc') {
        setAllotError('This dealer is not linked as an RC.');
      } else if (result.skipped === 'no_serials') {
        setAllotError('Allot serial numbers before pushing to YesGATC.');
      } else if (result.skipped === 'no_webhook') {
        setAllotError('Paste the YesGATC webhook URL in Serial numbers first.');
      } else if (result.skipped === 'already_pushed') {
        setAllotNotice('Already pushed to YesGATC.');
      } else {
        setAllotError(result.error || 'Could not push this invoice to YesGATC.');
      }
    } catch (err) {
      setAllotError(err instanceof Error ? err.message : 'Could not push this invoice to YesGATC.');
    } finally {
      setAllotBusy(false);
    }
  };

  return (
    <>
      <DocumentPartyBlock
        className="mb-4"
        customerName={invoice.customerName}
        address={
          invoice.shippingAddress
            ? appendPhoneToAddressLine(invoice.shippingAddress, invoice.shippingPhone)
            : invoice.shippingAddress
        }
        telHref={invoice.customerTelHref}
        whatsappHref={invoice.customerWhatsappHref}
        emptyAddressLabel="No address on file"
      />

      {showKamCard ? (
        <div id="invoice-detail-kam">
          <DocumentKamStrip
            className="mb-4"
            salespersonId={invoice.salespersonId}
            salespersonName={invoice.salespersonName}
          />
        </div>
      ) : null}
      <RelatedSupportRequests
        dealerId={customerId}
        invoiceId={invoiceId}
        invoiceNumber={invoice.invoiceNumber}
      />
      {needsMandatoryQc ? (
        <p className="invoice-qc-mandatory-banner" role="status">
          Extra packing required — upload {INVOICE_QC_REQUIRED} QC photos before dispatch.
          {qcPhotoCount > 0 ? ` ${qcPhotoCount}/{INVOICE_QC_REQUIRED} uploaded.` : ''}
        </p>
      ) : null}
      <InvoiceDocumentBody
        invoice={displayInvoice}
        itemClassName="admin-invoice-detail-item"
        totalsAfterItems
        selectFreightOnly={canEditLocalFreight}
        selectedLineItemId={selectedLineItemId}
        onSelectLineItem={canEditLocalFreight ? (item) => {
          if (!isFreightInvoiceLineItem(item)) return;
          setFreightOpen(open => !open);
        } : undefined}
        renderExpanded={canEditLocalFreight && onChangeLocalFreight
          ? (item) => (
            isFreightInvoiceLineItem(item) ? (
              <InvoiceLocalFreightEditor
                invoice={invoice}
                selectedSku={selectedFreightSku}
                busy={localFreightBusy}
                error={localFreightError}
                onSelect={onChangeLocalFreight}
              />
            ) : null
          )
          : undefined}
        itemMeta={item => {
          const nonGatc = isNonGatcSerialEligibleLine(item);
          const gatcStamped = isGatcStampedSerialEligibleLine(item);
          const qcRequested = !isFreightInvoiceLineItem(item) && (
            Boolean(invoice.qcRequested)
            || documentLooksLikeMachineQc(invoice)
            || lineLooksLikeMachineQc(item)
          );
          if (!nonGatc && !gatcStamped && !qcRequested) return null;
          const serials = serialNumbersFromLineItem(item);
          const short = nonGatc ? nonGatcSerialShortage(item) : gatcStampedSerialShortage(item);
          const serialBlock = (nonGatc || gatcStamped) ? (
            <div className="invoice-nongatc-serials">
              {serials.length ? (
                <div className="invoice-nongatc-serials__list">
                  <span>Serial Numbers</span>
                  <div className="invoice-nongatc-serials__chips">
                    {serials.map(serial => (
                      <span key={serial} className="invoice-nongatc-serials__chip">
                        {serial}
                        {canAllotSerials ? (
                          <button
                            type="button"
                            className="invoice-nongatc-serials__chip-x"
                            disabled={allotBusy}
                            aria-label={`Unlink ${serial}`}
                            onClick={e => {
                              e.stopPropagation();
                              void (gatcStamped
                                ? handleUnlinkGatcSerials(item.id, serial)
                                : handleUnlinkSerials(item.id, serial));
                            }}
                          >
                            <X size={12} aria-hidden />
                          </button>
                        ) : null}
                      </span>
                    ))}
                  </div>
                </div>
              ) : (
                <p className="invoice-nongatc-serials__empty">No serial numbers</p>
              )}
              {canAllotSerials && nonGatc && short > 0 ? (
                <button
                  type="button"
                  className="btn btn-secondary btn-sm invoice-nongatc-serials__btn"
                  disabled={allotBusy}
                  onClick={e => {
                    e.stopPropagation();
                    openNonGatcPicker(item.id, short, item.name, item.itemId, item.sku);
                  }}
                >
                  <Hash size={14} aria-hidden />
                  {allotBusy ? 'Opening…' : `Add serial number (${short})`}
                </button>
              ) : null}
              {canAllotSerials && gatcStamped && short > 0 ? (
                <button
                  type="button"
                  className="btn btn-sm invoice-nongatc-serials__btn invoice-nongatc-serials__btn--gatc"
                  disabled={allotBusy}
                  onClick={e => {
                    e.stopPropagation();
                    openGatcPicker(
                      item.id,
                      short,
                      item.name,
                      invoiceLineStampingCapacityKg(item),
                      item.itemId,
                      item.sku,
                    );
                  }}
                >
                  <BadgeCheck size={14} aria-hidden />
                  {allotBusy ? 'Opening…' : `Add GATC serial number (${short})`}
                </button>
              ) : null}
              {canAllotSerials && serials.length ? (
                <button
                  type="button"
                  className="btn btn-secondary btn-sm invoice-nongatc-serials__btn"
                  disabled={allotBusy}
                  onClick={e => {
                    e.stopPropagation();
                    void (gatcStamped ? handleUnlinkGatcSerials(item.id) : handleUnlinkSerials(item.id));
                  }}
                >
                  <Unlink size={14} aria-hidden />
                  {allotBusy ? 'Unlinking…' : gatcStamped ? 'Unlink all GATC serials' : 'Unlink all serials'}
                </button>
              ) : null}
              {canPushYesGatc && yesgatcPushed ? (
                <p className="invoice-nongatc-serials__yesgatc">Pushed to YesGATC</p>
              ) : null}
              {canPushYesGatc && !yesgatcPushed ? (
                <button
                  type="button"
                  className="btn btn-secondary btn-sm invoice-nongatc-serials__btn"
                  disabled={allotBusy}
                  onClick={e => {
                    e.stopPropagation();
                    void handlePushYesGatc();
                  }}
                >
                  <Send size={14} aria-hidden />
                  {allotBusy ? 'Pushing…' : 'Push to YesGATC'}
                </button>
              ) : null}
            </div>
          ) : null;
          return (
            <div className="invoice-detail-item__meta-stack">
              {qcRequested ? (
                <p className="invoice-detail-item__qc-requested">QC requested</p>
              ) : null}
              {serialBlock}
            </div>
          );
        }}
        afterItems={
          <>
            {canPushYesGatc && !needsSerialAllot ? (
              <div className="invoice-nongatc-serials invoice-nongatc-serials--bar panel glass">
                {yesgatcPushed ? (
                  <p className="invoice-nongatc-serials__yesgatc">
                    Pushed to YesGATC
                    {invoice.yesgatcRcName ? ` · ${invoice.yesgatcRcName}` : rcLink ? ` · ${rcLink.rcName}` : ''}
                    {invoice.yesgatcRcCode ? ` · ${invoice.yesgatcRcCode}` : ''}
                  </p>
                ) : (
                  <button
                    type="button"
                    className="btn btn-primary invoice-nongatc-serials__btn"
                    disabled={allotBusy}
                    onClick={() => void handlePushYesGatc()}
                  >
                    <Send size={16} aria-hidden />
                    {allotBusy ? 'Pushing…' : 'Push to YesGATC'}
                  </button>
                )}
                {invoice.yesgatcRcPushError && !yesgatcPushed ? (
                  <p className="invoice-nongatc-serials__error">{invoice.yesgatcRcPushError}</p>
                ) : null}
                {allotError ? <p className="invoice-nongatc-serials__error">{allotError}</p> : null}
                {allotNotice ? <p className="invoice-nongatc-serials__ok">{allotNotice}</p> : null}
              </div>
            ) : null}
            {canAllotSerials && needsSerialAllot ? (
              <div className="invoice-nongatc-serials invoice-nongatc-serials--bar panel glass">
                <p className="invoice-nongatc-serials__empty">
                  Add serial numbers on weighing-scale lines before booking courier or marking delivered.
                </p>
                <button
                  type="button"
                  className="btn btn-primary invoice-nongatc-serials__btn"
                  disabled={allotBusy}
                  onClick={() => {
                    const gatcLine = displayInvoice.lineItems.find(
                      item => gatcStampedSerialShortage(item) > 0,
                    );
                    if (gatcLine) {
                      openGatcPicker(
                        gatcLine.id,
                        gatcStampedSerialShortage(gatcLine),
                        gatcLine.name,
                        invoiceLineStampingCapacityKg(gatcLine),
                        gatcLine.itemId,
                        gatcLine.sku,
                      );
                      return;
                    }
                    const line = displayInvoice.lineItems.find(
                      item => nonGatcSerialShortage(item) > 0,
                    );
                    if (line) openNonGatcPicker(line.id, nonGatcSerialShortage(line), line.name, line.itemId, line.sku);
                  }}
                >
                  <Hash size={16} aria-hidden />
                  {allotBusy ? 'Opening…' : 'Add serial numbers'}
                </button>
                {allotError ? <p className="invoice-nongatc-serials__error">{allotError}</p> : null}
                {allotNotice ? <p className="invoice-nongatc-serials__ok">{allotNotice}</p> : null}
              </div>
            ) : allotError || allotNotice ? (
              <div className="invoice-nongatc-serials invoice-nongatc-serials--bar panel glass">
                {allotError ? <p className="invoice-nongatc-serials__error">{allotError}</p> : null}
                {allotNotice ? <p className="invoice-nongatc-serials__ok">{allotNotice}</p> : null}
              </div>
            ) : null}
          {showManualLogistics || showMarkDelivered || showVoidInvoice || (existingBooking && trackingLabel) ? (
            <div className="invoice-manual-logistics panel glass">
              <div className="invoice-manual-logistics__actions">
                {showManualLogistics ? (
                  <button
                    type="button"
                    className="btn btn-secondary invoice-manual-logistics__btn"
                    onClick={onOpenManualLogistics}
                    title="Enter tracking number and box count only — no courier API booking"
                  >
                    <PackagePlus size={18} aria-hidden />
                    Manual Logistics
                  </button>
                ) : null}
                {showMarkDelivered ? (
                  <button
                    type="button"
                    className="btn btn-primary invoice-manual-logistics__btn"
                    onClick={onOpenMarkDelivered}
                    title="Mark delivered without a logistics booking"
                  >
                    <CheckCircle2 size={18} aria-hidden />
                    Mark as delivered
                  </button>
                ) : null}
                {showVoidInvoice ? (
                  <button
                    type="button"
                    className="btn invoice-manual-logistics__btn invoice-void-invoice-btn"
                    disabled={voidBusy || allotBusy}
                    onClick={() => void handleVoidInvoice()}
                    title="Void this invoice in Zoho, release serials, and unlink GATC certificates"
                  >
                    <Ban size={18} aria-hidden />
                    {voidBusy ? 'Voiding…' : 'Void Invoice'}
                  </button>
                ) : null}
              </div>
              {existingBooking && trackingLabel && !showManualLogistics && !showMarkDelivered ? (
                <p className="text-sm invoice-manual-logistics__saved">
                  Logistics:
                  {' '}
                  <strong>{trackingLabel}</strong>
                  {existingBooking.numberOfBoxes
                    ? ` · ${existingBooking.numberOfBoxes} box${existingBooking.numberOfBoxes === 1 ? '' : 'es'}`
                    : ''}
                </p>
              ) : null}
              {showManualLogistics ? (
                <p className="text-muted text-sm invoice-manual-logistics__hint">
                  {manualLogisticsPartnerFromFreight
                    ? (
                      <>
                        Record an existing
                        {' '}
                        {logisticsPartnerLabel(manualLogisticsPartnerId)}
                        {' '}
                        tracking number and box count — no booking automation.
                      </>
                    )
                    : (
                      <>
                        No freight line on this invoice — choose the delivery partner,
                        then enter tracking number and box count.
                      </>
                    )}
                </p>
              ) : showMarkDelivered ? (
                <p className="text-muted text-sm invoice-manual-logistics__hint">
                  Mark this invoice delivered even if no AWB or logistics booking exists.
                </p>
              ) : showVoidInvoice ? (
                <p className="text-muted text-sm invoice-manual-logistics__hint">
                  Void this invoice in Zoho. Serial numbers return to the pool and GATC
                  certificates are unlinked.
                </p>
              ) : null}
            </div>
          ) : null}
          </>
        }
      />
      {gatcPicker ? (
        <GatcSerialPickerDialog
          title={gatcPicker.title}
          need={gatcPicker.need}
          capacityKg={gatcPicker.capacityKg}
          mode={gatcPicker.mode}
          productId={gatcPicker.productId}
          sku={gatcPicker.sku}
          productName={gatcPicker.productName || gatcPicker.title}
          invoiceId={invoiceId}
          invoiceNumber={invoice.invoiceNumber}
          saving={allotBusy}
          error={gatcPickerError}
          onClose={() => {
            if (!allotBusy) {
              setGatcPicker(null);
              setGatcPickerError('');
            }
          }}
          onSave={ids => void handleSavePickerSerials(ids)}
        />
      ) : null}
    </>
  );
};
