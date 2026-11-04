/**
 * ECS Lite Create Shop → Zoho Books sales invoice + WhatsApp session PDF.
 * Customer and item ids are fixed (Retail Cloud service / ECS Lite Key).
 */

import { FieldValue, getFirestore } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import {
  getAccessToken,
  resolveOrganizationId,
  authHeaders,
  ZOHO_API_BASE,
  hasZohoJsonBody,
} from './zoho.js';
import {
  recordZohoApiResponse,
  recordZohoApiFailure,
  classifyZohoHttpError,
} from './zoho-api-usage.js';
import { sendWhatsAppCloudFile } from './whatsapp-cloud.js';

/** Same collection as ecs-dealer-portal (keep local to avoid a circular import). */
const ECS_LITE_PENDING_SHOPS_COLLECTION = 'ecsLitePendingShops';

/** Zoho Books contact: Retail Cloud service (always — never the shop WhatsApp contact). */
export const ECS_LITE_ZOHO_CUSTOMER_ID = '99381000019875126';
/** Zoho Books item: ECS Lite Key (SKU LITE). */
export const ECS_LITE_ZOHO_ITEM_ID = '99381000035110388';
/** Selling price excl. GST (item default); Zoho applies GST18 / IGST18 from the item. */
export const ECS_LITE_ZOHO_RATE = 1900;

function asString(value) {
  if (value == null) return '';
  return String(value).trim();
}

function phoneDigits(value) {
  return asString(value).replace(/\D/g, '');
}

/** Match whatsapp-cloud normalizeWaId (10-digit India → 91…). */
function toWaId(value) {
  let digits = phoneDigits(value);
  if (digits.length === 10) digits = `91${digits}`;
  if (digits.length === 11 && digits.startsWith('0')) digits = `91${digits.slice(1)}`;
  return digits;
}

async function zohoJson(accessToken, orgId, path, { method = 'GET', body } = {}) {
  const url = new URL(`${ZOHO_API_BASE}${path}`);
  if (!url.searchParams.has('organization_id')) {
    url.searchParams.set('organization_id', orgId);
  }

  const sendBody = hasZohoJsonBody(body);
  const init = {
    method,
    headers: {
      ...authHeaders(accessToken, orgId),
      ...(sendBody ? { 'Content-Type': 'application/json' } : {}),
    },
  };
  if (sendBody) init.body = JSON.stringify(body);

  let res;
  try {
    res = await fetch(url, init);
  } catch (err) {
    await recordZohoApiFailure(err, { operation: path, source: 'ecs-lite-invoice' });
    throw err;
  }

  const payload = await res.json().catch(() => ({}));
  await recordZohoApiResponse(res, { operation: path, source: 'ecs-lite-invoice' });

  if (!res.ok || (payload.code !== undefined && payload.code !== 0)) {
    const classified = classifyZohoHttpError(res.status, payload);
    if (classified?.code === 'RATE_LIMITED') {
      await recordZohoApiFailure(classified, { operation: path, source: 'ecs-lite-invoice' });
      throw classified;
    }
    const message = payload?.message
      || classified?.message
      || `Zoho request failed (${res.status})`;
    const error = new Error(message);
    error.status = res.status;
    error.zohoCode = payload?.code ?? null;
    throw error;
  }
  return payload;
}

/**
 * Build line description from Create Shop form fields.
 * Prefer full license key when available; otherwise masked inventory preview.
 */
export function buildEcsLiteInvoiceDescription(fields = {}) {
  const keyNumber = asString(fields.licenseKey)
    || asString(fields.keyNumber)
    || asString(fields.keyPreview)
    || asString(fields.keyId)
    || '—';
  const shopName = asString(fields.shopName) || '—';
  const username = asString(fields.username) || '—';
  const phone = phoneDigits(fields.phone) || asString(fields.phone) || '—';
  const mac = asString(fields.mac) || '—';
  return [
    `Key number: ${keyNumber}`,
    `Shop name: ${shopName}`,
    `Username: ${username}`,
    `Phone: ${phone}`,
    `MAC ID: ${mac}`,
  ].join('\n');
}

async function fetchItemTaxId(accessToken, orgId, itemId) {
  try {
    const payload = await zohoJson(accessToken, orgId, `/items/${encodeURIComponent(itemId)}`);
    const taxId = asString(payload?.item?.tax_id);
    return taxId || null;
  } catch (err) {
    console.warn('ECS Lite Zoho item tax lookup failed:', err?.message || err);
    return null;
  }
}

/**
 * Create a Zoho sales invoice for one ECS Lite Key.
 * Always invoices Retail Cloud service — never creates/looks up a shop customer.
 */
export async function createEcsLiteSalesInvoice(secrets, configuredOrgId, fields = {}) {
  const accessToken = await getAccessToken(secrets);
  const orgId = await resolveOrganizationId(accessToken, configuredOrgId);
  const description = buildEcsLiteInvoiceDescription(fields);
  const taxId = await fetchItemTaxId(accessToken, orgId, ECS_LITE_ZOHO_ITEM_ID);

  const line = {
    item_id: ECS_LITE_ZOHO_ITEM_ID,
    rate: ECS_LITE_ZOHO_RATE,
    quantity: 1,
    description,
  };
  if (taxId) line.tax_id = taxId;

  const body = {
    customer_id: ECS_LITE_ZOHO_CUSTOMER_ID,
    date: new Date().toISOString().slice(0, 10),
    reference_number: asString(fields.approvalId || fields.keyId).slice(0, 50) || undefined,
    line_items: [line],
  };

  const payload = await zohoJson(accessToken, orgId, '/invoices', {
    method: 'POST',
    body,
  });
  const inv = payload?.invoice;
  const invoiceId = asString(inv?.invoice_id);
  if (!invoiceId) {
    throw new Error(payload?.message || 'Zoho did not return an invoice id.');
  }

  return {
    invoiceId,
    invoiceNumber: asString(inv?.invoice_number) || null,
    total: inv?.total != null ? Number(inv.total) : null,
    accessToken,
    orgId,
  };
}

export async function downloadEcsLiteInvoicePdf(accessToken, orgId, invoiceId) {
  const id = asString(invoiceId);
  if (!id) throw new Error('Invoice id is required.');
  const url = new URL(`${ZOHO_API_BASE}/invoices/${encodeURIComponent(id)}`);
  url.searchParams.set('organization_id', orgId);
  url.searchParams.set('accept', 'pdf');
  url.searchParams.set('t', String(Date.now()));

  const res = await fetch(url.toString(), {
    headers: {
      ...authHeaders(accessToken, orgId),
      Accept: 'application/pdf',
    },
  });
  await recordZohoApiResponse(res, {
    operation: `invoices/${id}/pdf`,
    source: 'ecs-lite-invoice',
  });

  if (!res.ok) {
    if (res.status === 429) {
      const err = new Error('Zoho rate limit exceeded.');
      err.code = 'RATE_LIMITED';
      await recordZohoApiFailure(err, {
        operation: `invoices/${id}/pdf`,
        source: 'ecs-lite-invoice',
      });
      throw err;
    }
    const text = await res.text();
    let message = `Could not download invoice PDF (${res.status}).`;
    try {
      const payload = JSON.parse(text);
      if (payload?.message) message = payload.message;
    } catch {
      // ignore
    }
    throw new Error(message);
  }

  const buffer = Buffer.from(await res.arrayBuffer());
  if (!buffer.length) throw new Error('Invoice PDF file is empty.');
  return buffer;
}

function whatsappErrorMessage(err) {
  if (err instanceof HttpsError) return err.message;
  return asString(err?.message) || 'WhatsApp send failed.';
}

function isWhatsAppSessionClosed(message) {
  return /24 hours|re-engagement|131047|session/i.test(String(message || ''));
}

/**
 * Session (Cloud API document) send — same path as staff file send in an open chat.
 * Never uses WhatsApp message templates.
 */
export async function sendEcsLiteInvoicePdfWhatsApp({
  phone,
  pdfBuffer,
  invoiceNumber,
  actor = {},
}) {
  const waId = toWaId(phone);
  if (waId.length < 10 || waId.length > 15) {
    const err = new Error('Phone must be digits only — country code + number (8 to 15 digits).');
    err.code = 'invalid-phone';
    throw err;
  }

  const safeNumber = asString(invoiceNumber).replace(/[^\w.-]+/g, '_') || 'invoice';
  const fileName = `ECS-Lite-${safeNumber}.pdf`;
  const caption = invoiceNumber
    ? `ECS Lite invoice ${invoiceNumber}`
    : 'ECS Lite invoice';

  try {
    const sent = await sendWhatsAppCloudFile({
      waId,
      fileBase64: pdfBuffer.toString('base64'),
      mimeType: 'application/pdf',
      fileName,
      caption,
    }, actor);
    return {
      ok: true,
      waId,
      whatsappMessageId: sent?.id || null,
    };
  } catch (err) {
    const message = whatsappErrorMessage(err);
    const closed = isWhatsAppSessionClosed(message);
    const out = new Error(
      closed
        ? `WhatsApp session is closed (24h window). Invoice PDF was not sent: ${message}`
        : message,
    );
    out.code = closed ? 'whatsapp-session-closed' : 'whatsapp-send-failed';
    out.cause = err;
    throw out;
  }
}

/**
 * After ECS pending create succeeds: create Zoho invoice, persist ids, send PDF via session WA.
 * Zoho invoice is kept even when WhatsApp fails.
 */
export async function afterEcsLitePendingShopInvoice(secrets, configuredOrgId, {
  docId,
  fields,
  actor = {},
} = {}) {
  const result = {
    zohoInvoiceId: null,
    zohoInvoiceNumber: null,
    zohoInvoiceError: null,
    whatsappSent: false,
    whatsappError: null,
    whatsappMessageId: null,
  };

  let invoice;
  try {
    invoice = await createEcsLiteSalesInvoice(secrets, configuredOrgId, fields);
    result.zohoInvoiceId = invoice.invoiceId;
    result.zohoInvoiceNumber = invoice.invoiceNumber;
  } catch (err) {
    result.zohoInvoiceError = asString(err?.message) || 'Zoho invoice create failed.';
    console.warn('ECS Lite Zoho invoice create failed:', result.zohoInvoiceError);
    if (docId) {
      await getFirestore().collection(ECS_LITE_PENDING_SHOPS_COLLECTION).doc(docId).set({
        zohoInvoiceError: result.zohoInvoiceError,
        zohoInvoiceAttemptedAt: FieldValue.serverTimestamp(),
      }, { merge: true }).catch(() => {});
    }
    return result;
  }

  if (docId) {
    await getFirestore().collection(ECS_LITE_PENDING_SHOPS_COLLECTION).doc(docId).set({
      zohoInvoiceId: result.zohoInvoiceId,
      zohoInvoiceNumber: result.zohoInvoiceNumber,
      zohoInvoiceError: null,
      zohoInvoiceCreatedAt: FieldValue.serverTimestamp(),
    }, { merge: true }).catch((persistErr) => {
      console.warn(
        'ecsLitePendingShops Zoho invoice id persist failed:',
        persistErr?.message ?? persistErr,
      );
    });
  }

  const phone = toWaId(fields?.phone);
  if (phone.length < 10 || phone.length > 15) {
    result.whatsappError = 'Phone is invalid; invoice PDF was not sent on WhatsApp.';
  } else {
    try {
      const pdfBuffer = await downloadEcsLiteInvoicePdf(
        invoice.accessToken,
        invoice.orgId,
        invoice.invoiceId,
      );
      const sent = await sendEcsLiteInvoicePdfWhatsApp({
        phone,
        pdfBuffer,
        invoiceNumber: invoice.invoiceNumber,
        actor,
      });
      result.whatsappSent = true;
      result.whatsappMessageId = sent.whatsappMessageId;
    } catch (err) {
      result.whatsappError = whatsappErrorMessage(err);
      console.warn('ECS Lite invoice WhatsApp PDF send failed:', result.whatsappError);
    }
  }

  if (docId) {
    await getFirestore().collection(ECS_LITE_PENDING_SHOPS_COLLECTION).doc(docId).set({
      zohoInvoiceWhatsAppSent: result.whatsappSent,
      zohoInvoiceWhatsAppError: result.whatsappError || null,
      zohoInvoiceWhatsAppMessageId: result.whatsappMessageId || null,
      zohoInvoiceWhatsAppAt: FieldValue.serverTimestamp(),
    }, { merge: true }).catch(() => {});
  }

  return result;
}
