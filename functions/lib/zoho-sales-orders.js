/**
 * Create Zoho Inventory sales orders and invoices from portal dealer orders.
 */
import { getAccessToken, resolveOrganizationId, authHeaders, ZOHO_API_BASE, hasZohoJsonBody } from './zoho.js';
import {
  recordZohoApiResponse,
  recordZohoApiFailure,
  classifyZohoHttpError,
} from './zoho-api-usage.js';
import { isSacHsn } from './sac-catalog.js';
import { isFreightOrderLine, zohoModeOfTransportFromOrder } from './freight-lines.js';
import { ZOHO_ADDRESS_LINE_MAX, fitZohoAddressLines } from './zoho-contact-fields.js';
import { KNOWN_ZOHO_WAREHOUSE_IDS, loadZohoLocationIdsBySite } from './zoho-locations.js';

function hsnDigits(value) {
  return String(value ?? '').replace(/\D/g, '');
}

const SERVICE_WAREHOUSE_HSN = new Set([
  '998346', // GATC stamping SAC
  '79061190', // GATC fee HSN used in Zoho
  '996812', // freight
]);

function isGatcFeeOrderLine(line) {
  if (SERVICE_WAREHOUSE_HSN.has(hsnDigits(line?.hsn))) return true;
  const sku = String(line?.sku ?? '').trim().toUpperCase();
  if (/^GRV\d/.test(sku)) return true;
  const name = String(line?.name ?? '').trim().toUpperCase();
  return name.includes('GATC FEE') || name.includes('STAMPING FEE');
}

function isZohoNotAuthorized(err) {
  return /not authorized to perform this operation/i.test(String(err?.message ?? ''));
}

/** Goods that Zoho can stock at a warehouse. Freight/SAC/GATC-fee lines must not send warehouse_id. */
export function lineAllowsWarehouse(line) {
  if (isFreightOrderLine(line)) return false;
  if (isGatcFeeOrderLine(line)) return false;
  if (isSacHsn(line.hsn)) return false;
  const sku = String(line?.sku ?? '').trim().toUpperCase();
  const name = String(line?.name ?? '').trim().toUpperCase();
  const warehouses = Array.isArray(line?.warehouses) ? line.warehouses : null;
  if (
    (sku.includes('FREIGHT') || name.includes('FREIGHT'))
    && (!warehouses || warehouses.length === 0)
  ) {
    return false;
  }
  return true;
}

export function warehouseIdForLine(line, fallbackWarehouseId) {
  if (!lineAllowsWarehouse(line)) return null;
  const fallback = fallbackWarehouseId != null && String(fallbackWarehouseId).trim()
    ? String(fallbackWarehouseId).trim()
    : null;
  // Always use the live Cochin / Head Office warehouse. Catalog warehouse ids
  // go stale and Zoho returns "not authorized" for unknown warehouse_id.
  return fallback;
}

function isZohoShippingAddressTooLong(err) {
  return /shipping_address.*less than 100|address.*less than 100 characters/i
    .test(String(err?.message || ''));
}

function inlineShippingAddress(address) {
  if (!address || typeof address !== 'object') return null;
  const fitted = fitZohoAddressLines(address);
  if (!fitted.address && !fitted.city && !fitted.zip) return null;
  return fitted;
}

function addressLineTooLong(address) {
  if (!address || typeof address !== 'object') return false;
  return ['address', 'street', 'street2', 'attention'].some(
    key => String(address[key] || '').trim().length > ZOHO_ADDRESS_LINE_MAX,
  );
}

function stripShippingFromBody(body) {
  const next = cloneSalesOrderBody(body);
  delete next.shipping_address_id;
  delete next.shipping_address;
  return next;
}

function cloneSalesOrderBody(body) {
  return {
    ...body,
    line_items: (body.line_items || []).map(line => ({ ...line })),
  };
}

function withoutSalesperson(body) {
  const next = cloneSalesOrderBody(body);
  delete next.salesperson_id;
  return next;
}

function salesOrderAttemptKey(body) {
  return JSON.stringify({
    salesperson: body.salesperson_id || null,
    shippingId: body.shipping_address_id || null,
    shippingInline: Boolean(body.shipping_address),
    warehouses: (body.line_items || []).map(line => line.warehouse_id || null),
    descriptions: (body.line_items || []).map(line => String(line.description || '')),
    rates: (body.line_items || []).map(line => (
      Object.prototype.hasOwnProperty.call(line, 'rate') ? line.rate : null
    )),
  });
}

function withoutLineDescriptions(body) {
  const next = cloneSalesOrderBody(body);
  next.line_items = next.line_items.map(({ description: _description, ...line }) => line);
  return next;
}

function replaceLineWarehouses(body, warehouseId) {
  const next = cloneSalesOrderBody(body);
  const warehouse = warehouseId != null && String(warehouseId).trim()
    ? String(warehouseId).trim()
    : null;
  if (!warehouse) return next;
  next.line_items = next.line_items.map(line => (
    line.warehouse_id ? { ...line, warehouse_id: warehouse } : line
  ));
  return next;
}

function uniqueSalesOrderCreateAttempts(body, { alternateWarehouseId, alternateWarehouseIds } = {}) {
  const attempts = [];
  const seen = new Set();
  const push = (next) => {
    const key = salesOrderAttemptKey(next);
    if (seen.has(key)) return;
    seen.add(key);
    attempts.push(next);
  };

  const hasSalesperson = Boolean(body.salesperson_id);
  const hasShipping = Boolean(body.shipping_address_id || body.shipping_address);
  const hasDescription = (body.line_items || []).some(line => String(line.description || '').trim());

  // Keep warehouse_id on inventory goods. Multi-warehouse Zoho returns
  // "not authorized" if stocked items are posted without a warehouse — so
  // never strip warehouses on retry (shipping/salesperson are optional).
  const pushFieldVariants = (source) => {
    push(cloneSalesOrderBody(source));
    if (hasShipping) push(stripShippingFromBody(source));
    if (hasSalesperson) {
      push(withoutSalesperson(source));
      if (hasShipping) push(stripShippingFromBody(withoutSalesperson(source)));
    }
    if (hasDescription) {
      const noDesc = withoutLineDescriptions(source);
      push(noDesc);
      if (hasShipping) push(stripShippingFromBody(noDesc));
      if (hasSalesperson) {
        push(withoutSalesperson(noDesc));
        if (hasShipping) push(stripShippingFromBody(withoutSalesperson(noDesc)));
      }
    }
  };

  pushFieldVariants(body);

  const primaryWarehouse = (body.line_items || [])
    .map(line => String(line.warehouse_id || '').trim())
    .find(Boolean) || null;
  const alternates = [
    ...(Array.isArray(alternateWarehouseIds) ? alternateWarehouseIds : []),
    alternateWarehouseId,
  ]
    .map(id => (id != null && String(id).trim() ? String(id).trim() : ''))
    .filter((id, index, all) => id && id !== primaryWarehouse && all.indexOf(id) === index);
  // Item may only be enabled at the other live warehouse (Cochin ↔ Head Office),
  // or the catalog Cochin id may be the older location id vs the current warehouse.
  for (const alternate of alternates) {
    const altFull = replaceLineWarehouses(body, alternate);
    push(altFull);
    let stripped = altFull;
    if (hasShipping) stripped = stripShippingFromBody(stripped);
    if (hasSalesperson) stripped = withoutSalesperson(stripped);
    if (hasDescription) stripped = withoutLineDescriptions(stripped);
    push(stripped);
  }
  return attempts;
}

async function putSalesOrderShippingAddress(accessToken, orgId, salesOrderId, {
  addressId = null,
  address = null,
} = {}) {
  const soId = encodeURIComponent(String(salesOrderId || '').trim());
  if (!soId) return false;
  const fitted = inlineShippingAddress(address);
  const id = String(addressId || '').trim();

  const payloads = [];
  if (fitted) {
    payloads.push({
      ...fitted,
      is_one_off_address: true,
      is_update_customer: false,
    });
  }
  if (id) {
    payloads.push({ address_id: id });
  }
  if (!payloads.length) return false;

  const paths = [
    `/salesorders/${soId}/address/shipping`,
    `/salesorders/${soId}/address`,
  ];
  let lastErr = null;
  for (const path of paths) {
    for (const payload of payloads) {
      try {
        await zohoJson(accessToken, orgId, path, { method: 'PUT', body: payload });
        return true;
      } catch (err) {
        lastErr = err;
      }
    }
  }
  if (fitted) {
    try {
      await zohoJson(accessToken, orgId, `/salesorders/${soId}`, {
        method: 'PUT',
        body: { shipping_address: fitted },
      });
      return true;
    } catch (err) {
      lastErr = err;
    }
  }
  if (lastErr) {
    console.warn('Zoho sales order shipping address apply failed:', lastErr?.message || lastErr);
  }
  return false;
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
    recordZohoApiFailure(err);
    throw err;
  }

  const payload = await res.json().catch(() => ({}));
  recordZohoApiResponse(res.status, path);

  if (!res.ok) {
    const classified = classifyZohoHttpError(res.status, payload);
    const message = payload?.message
      || payload?.code
      || classified?.message
      || `Zoho request failed (${res.status})`;
    const error = new Error(message);
    error.status = res.status;
    error.zohoCode = payload?.code ?? classified?.zohoCode ?? null;
    throw error;
  }
  return payload;
}

function lineItemsFromOrder(order, warehouseId = null) {
  const lines = Array.isArray(order.lines) ? order.lines : [];
  // Multi-warehouse orgs accept warehouse_id; location_id is rejected when Locations is off.
  // SAC/service lines (software keys, GATC, freight) must not send warehouse_id —
  // Zoho returns "You are not authorized to perform this operation".
  // Do not send name/unit/hsn with item_id — Zoho treats that as an item edit
  // (spare freight unit "nos" vs item unit is a common not-authorized).
  return lines.map(line => {
    const warehouse = warehouseIdForLine(line, warehouseId);
    return {
      item_id: String(line.itemId || line.productId),
      rate: Number(line.rate || 0),
      quantity: Number(line.quantity || 0),
      ...(line.description ? { description: String(line.description) } : {}),
      ...(warehouse ? { warehouse_id: warehouse } : {}),
    };
  }).filter(line => line.quantity > 0 && line.item_id);
}

function zohoLineAllowsWarehouse(item) {
  return lineAllowsWarehouse({
    itemId: item?.item_id,
    productId: item?.item_id,
    sku: item?.sku,
    hsn: item?.hsn_or_sac || item?.hsn,
  });
}

function zohoStatusKey(status) {
  return String(status || '').toLowerCase().replace(/\s+/g, '_');
}

function isAlreadyConfirmedMessage(message) {
  return /already|confirmed|status is open|\bis open\b|invoiced/i.test(String(message || ''));
}

function isAlreadyInvoicedQuantityMessage(message) {
  return /no items in this sales order to be invoiced|quantity recorded cannot be more than quantity ordered/i
    .test(String(message || ''));
}

function isInvalidZohoUrlMessage(message) {
  return /invalid url/i.test(String(message || ''));
}

function embeddedInvoiceFromSalesOrder(so) {
  const lists = [so?.invoices, so?.associated_invoices];
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    const hit = list.find(row => row?.invoice_id);
    if (hit) return hit;
  }
  if (so?.invoice_id) {
    return {
      invoice_id: so.invoice_id,
      invoice_number: so.invoice_number || null,
    };
  }
  return null;
}

function linkedInvoiceRecord(row) {
  if (!row?.invoice_id) return null;
  return {
    invoiceId: String(row.invoice_id),
    invoiceNumber: row.invoice_number ? String(row.invoice_number) : null,
  };
}

function salesOrderAlreadyInvoiced(so) {
  const status = zohoStatusKey(so?.status);
  const invoiced = zohoStatusKey(so?.invoiced_status || so?.order_status);
  return status === 'invoiced'
    || status === 'closed'
    || invoiced === 'invoiced'
    || invoiced === 'partially_invoiced'
    || Boolean(embeddedInvoiceFromSalesOrder(so));
}

/**
 * Zoho sometimes omits salesorder.invoices after the invoice was created
 * outside convert. Match only on salesorder_id or the SO number.
 */
async function findInvoiceForSalesOrder(accessToken, orgId, so) {
  const embedded = linkedInvoiceRecord(embeddedInvoiceFromSalesOrder(so));
  if (embedded) return embedded;
  const soId = String(so?.salesorder_id || '').trim();
  const number = String(so?.salesorder_number || '').trim();
  const customerId = String(so?.customer_id || '').trim();
  const queries = [...new Set([
    number,
    String(so?.reference_number || '').trim(),
  ].filter(Boolean))];
  for (const query of queries) {
    const customerQuery = customerId ? `&customer_id=${encodeURIComponent(customerId)}` : '';
    let payload;
    try {
      payload = await zohoJson(
        accessToken,
        orgId,
        `/invoices?search_text=${encodeURIComponent(query)}${customerQuery}&per_page=50`,
      );
    } catch (err) {
      console.warn(
        `Invoice search for SO ${soId || number} (${query}) failed:`,
        err?.message || err,
      );
      continue;
    }
    const rows = Array.isArray(payload?.invoices) ? payload.invoices : [];
    const match = rows.find(inv => soId && String(inv.salesorder_id || '') === soId)
      || rows.find(inv => number && String(inv.reference_number || '') === number)
      || rows.find(inv => number && String(inv.invoice_number || '') === number);
    const linked = linkedInvoiceRecord(match);
    if (linked) return linked;
  }
  return null;
}

function stripSalesOrderItemIds(lines) {
  return (Array.isArray(lines) ? lines : []).map(({ salesorder_item_id: _id, ...line }) => line);
}

async function postZohoIgnore(accessToken, orgId, path, ignorePattern) {
  try {
    await zohoJson(accessToken, orgId, path, { method: 'POST', body: {} });
  } catch (err) {
    const message = String(err?.message || '');
    if (!ignorePattern.test(message) && !isZohoNotAuthorized(err)) throw err;
  }
}

/** Writable line fields only — Zoho GET payloads include read-only keys that break PUT. */
function lineItemsForSalesOrderPut(so, { keepGoodsWarehouse = false } = {}) {
  const items = Array.isArray(so?.line_items) ? so.line_items : [];
  return items.map(item => {
    const line = {
      item_id: item.item_id,
      name: item.name,
      rate: item.rate,
      quantity: item.quantity,
      unit: item.unit || 'pcs',
    };
    if (item.line_item_id) line.line_item_id = item.line_item_id;
    if (item.description) line.description = item.description;
    if (item.hsn_or_sac) line.hsn_or_sac = item.hsn_or_sac;
    if (item.tax_id) line.tax_id = item.tax_id;
    if (
      keepGoodsWarehouse
      && zohoLineAllowsWarehouse(item)
      && item.warehouse_id != null
      && String(item.warehouse_id).trim()
    ) {
      line.warehouse_id = String(item.warehouse_id).trim();
    }
    return line;
  }).filter(line => line.item_id && Number(line.quantity) > 0);
}

function salesOrderHasServiceWarehouse(so) {
  const items = Array.isArray(so?.line_items) ? so.line_items : [];
  return items.some(item =>
    item?.warehouse_id != null
    && String(item.warehouse_id).trim()
    && !zohoLineAllowsWarehouse(item),
  );
}

async function stripServiceWarehousesOnSalesOrder(accessToken, orgId, so) {
  if (!so?.salesorder_id || !salesOrderHasServiceWarehouse(so)) return so;
  const payload = await zohoJson(accessToken, orgId, `/salesorders/${so.salesorder_id}`, {
    method: 'PUT',
    body: {
      customer_id: so.customer_id,
      date: so.date || new Date().toISOString().slice(0, 10),
      line_items: lineItemsForSalesOrderPut(so, { keepGoodsWarehouse: true }),
      ...(so.reference_number ? { reference_number: so.reference_number } : {}),
      ...(so.notes ? { notes: so.notes } : {}),
      ...(so.salesperson_id ? { salesperson_id: so.salesperson_id } : {}),
    },
  });
  return payload?.salesorder || so;
}

async function ensureServiceWarehousesStripped(accessToken, orgId, so) {
  if (!so?.salesorder_id || !salesOrderHasServiceWarehouse(so)) return so;
  const soId = String(so.salesorder_id);

  try {
    const stripped = await stripServiceWarehousesOnSalesOrder(accessToken, orgId, so);
    if (!salesOrderHasServiceWarehouse(stripped)) return stripped;
  } catch (err) {
    console.warn(
      `Could not strip service warehouses on SO ${soId}:`,
      err?.message || err,
    );
  }

  try {
    await zohoJson(accessToken, orgId, `/salesorders/${soId}/status/draft`, {
      method: 'POST',
      body: {},
    });
  } catch (err) {
    const message = String(err?.message || '');
    if (!isZohoNotAuthorized(err) && !/already|draft|cannot|pending/i.test(message)) {
      console.warn(`Could not reopen SO ${soId} as draft:`, message);
    }
  }

  const reloadedPayload = await zohoJson(accessToken, orgId, `/salesorders/${soId}`);
  let current = reloadedPayload?.salesorder || so;
  try {
    current = await stripServiceWarehousesOnSalesOrder(accessToken, orgId, current);
  } catch (err) {
    console.warn(
      `Could not strip service warehouses after draft on SO ${soId}:`,
      err?.message || err,
    );
  }

  const status = zohoStatusKey(current.status);
  if (!['open', 'confirmed', 'invoiced', 'closed'].includes(status)) {
    await confirmSalesOrderRequest(accessToken, orgId, soId);
    const confirmed = await zohoJson(accessToken, orgId, `/salesorders/${soId}`);
    return confirmed?.salesorder || current;
  }
  return current;
}

function goodsWarehouseId(so, item) {
  if (!zohoLineAllowsWarehouse(item)) return null;
  const fromLine = item?.warehouse_id != null ? String(item.warehouse_id).trim() : '';
  if (fromLine) return fromLine;
  const fromSo = so?.warehouse_id != null ? String(so.warehouse_id).trim() : '';
  if (fromSo) return fromSo;
  const items = Array.isArray(so?.line_items) ? so.line_items : [];
  const sibling = items.find(row =>
    zohoLineAllowsWarehouse(row)
    && row?.warehouse_id != null
    && String(row.warehouse_id).trim(),
  );
  return sibling?.warehouse_id != null ? String(sibling.warehouse_id).trim() : null;
}

function invoiceLineItemsFromSalesOrder(so, { linkServiceLines = true } = {}) {
  const items = Array.isArray(so?.line_items) ? so.line_items : [];
  return items.map(item => {
    const line = {
      item_id: item.item_id,
      name: item.name,
      rate: item.rate,
      quantity: item.quantity,
      unit: item.unit || 'pcs',
    };
    if (item.description) line.description = item.description;
    if (item.hsn_or_sac) line.hsn_or_sac = item.hsn_or_sac;
    if (item.tax_id) line.tax_id = item.tax_id;
    if (item.line_item_id && (linkServiceLines || zohoLineAllowsWarehouse(item))) {
      line.salesorder_item_id = item.line_item_id;
    }
    const warehouseId = goodsWarehouseId(so, item);
    if (warehouseId) line.warehouse_id = warehouseId;
    return line;
  }).filter(line => line.item_id && Number(line.quantity) > 0);
}

async function salesOrderReadyToInvoice(accessToken, orgId, soId) {
  try {
    const payload = await zohoJson(accessToken, orgId, `/salesorders/${encodeURIComponent(soId)}`);
    return salesOrderAlreadyInvoiced(payload?.salesorder)
      || ['open', 'confirmed'].includes(zohoStatusKey(payload?.salesorder?.status));
  } catch {
    return false;
  }
}

async function confirmSalesOrderRequest(accessToken, orgId, soId) {
  try {
    await zohoJson(accessToken, orgId, `/salesorders/${soId}/status/confirmed`, {
      method: 'POST',
      body: {},
    });
  } catch (err) {
    if (isAlreadyConfirmedMessage(err?.message)) return;
    if (isInvalidZohoUrlMessage(err?.message)) {
      if (await salesOrderReadyToInvoice(accessToken, orgId, soId)) return;
      try {
        await zohoJson(accessToken, orgId, `/salesorders/${soId}/status/open`, {
          method: 'POST',
          body: {},
        });
        return;
      } catch (openErr) {
        if (isAlreadyConfirmedMessage(openErr?.message)) return;
        if (await salesOrderReadyToInvoice(accessToken, orgId, soId)) return;
        throw openErr;
      }
    }
    if (!isZohoNotAuthorized(err) && !/approv|submit|draft|pending/i.test(String(err?.message || ''))) {
      throw err;
    }
    await postZohoIgnore(
      accessToken,
      orgId,
      `/salesorders/${soId}/submit`,
      /already|submit|approv|cannot submit/i,
    );
    await postZohoIgnore(
      accessToken,
      orgId,
      `/salesorders/${soId}/approve`,
      /already|approv|cannot approve/i,
    );
    try {
      await zohoJson(accessToken, orgId, `/salesorders/${soId}/status/confirmed`, {
        method: 'POST',
        body: {},
      });
    } catch (retryErr) {
      if (isAlreadyConfirmedMessage(retryErr?.message)) return;
      if (
        isInvalidZohoUrlMessage(retryErr?.message)
        && await salesOrderReadyToInvoice(accessToken, orgId, soId)
      ) return;
      throw retryErr;
    }
  }
}

function warehouseRowsFromZohoItem(item) {
  const raw = [
    ...(Array.isArray(item?.warehouses) ? item.warehouses : []),
    ...(Array.isArray(item?.locations) ? item.locations : []),
  ];
  const seen = new Set();
  const rows = [];
  for (const row of raw) {
    const id = String(row?.warehouse_id ?? row?.location_id ?? row?.warehouseId ?? '').trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const stock = Number(
      row?.warehouse_available_for_sale_stock
      ?? row?.warehouse_actual_available_for_sale_stock
      ?? row?.warehouse_available_stock
      ?? row?.warehouse_stock_on_hand
      ?? row?.location_available_stock
      ?? row?.location_stock_on_hand
      ?? 0,
    );
    rows.push({
      id,
      stock: Number.isFinite(stock) ? stock : 0,
    });
  }
  return rows;
}

/** Service / non-inventory Zoho items reject warehouse_id as "not authorized". */
function zohoItemSkipsWarehouse(item) {
  if (!item) return false;
  const productType = String(item.product_type || '').toLowerCase();
  const itemType = String(item.item_type || '').toLowerCase();
  if (productType === 'service') return true;
  if (item.track_inventory === false) return true;
  if (itemType === 'sales' || itemType === 'purchases' || itemType === 'sales_and_purchases') return true;
  if (
    itemType.includes('non-inventory')
    || itemType.includes('non_inventory')
    || itemType.includes('service')
  ) return true;
  if (item.is_combo_product === true && warehouseRowsFromZohoItem(item).length === 0) return true;
  return false;
}

function zohoItemBlockReason(item) {
  if (!item) return null;
  const label = String(item.name || item.sku || item.item_id || 'Item').trim();
  const status = String(item.status || '').trim().toLowerCase();
  if (status && status !== 'active') return `${label} is ${status} in Zoho`;
  if (item.can_be_sold === false) return `${label} is not available for sale in Zoho`;
  return null;
}

function catalogWarehouseIdsByItemId(order) {
  const map = new Map();
  for (const line of Array.isArray(order?.lines) ? order.lines : []) {
    const id = String(line?.itemId || line?.productId || '').trim();
    if (!id) continue;
    const ids = map.get(id) || [];
    for (const row of Array.isArray(line?.warehouses) ? line.warehouses : []) {
      const wid = String(row?.warehouseId ?? row?.warehouse_id ?? '').trim();
      if (wid && !ids.includes(wid)) ids.push(wid);
    }
    if (ids.length) map.set(id, ids);
  }
  return map;
}

function rowsForSalesOrderLine(item, catalogIds) {
  const live = item ? warehouseRowsFromZohoItem(item) : [];
  if (live.length) return live;
  return (catalogIds || []).map(id => ({ id, stock: 0 }));
}

function pickWarehouseId(rows, preferredId) {
  if (!rows.length) return null;
  const preferred = preferredId != null ? String(preferredId).trim() : '';
  if (preferred && rows.some(row => row.id === preferred)) return preferred;
  return (rows.find(row => row.stock > 0) || rows[0]).id;
}

function withoutRates(body) {
  const next = cloneSalesOrderBody(body);
  next.line_items = next.line_items.map(({ rate: _rate, ...line }) => line);
  return next;
}

/**
 * Rebuild a refused sales-order body from the live Zoho item.
 * Inventory lines use that item's warehouse (not a stale Cochin/HO id).
 * Service and non-inventory lines drop warehouse_id.
 */
export function salesOrderBodiesFromZohoItems(sourceBody, itemById, catalogByItem, preferredWarehouseId) {
  const blocked = [];
  for (const item of itemById.values()) {
    const reason = zohoItemBlockReason(item);
    if (reason) blocked.push(reason);
  }
  if (blocked.length) {
    return {
      bodies: [],
      blockedHint: `Zoho Inventory refused this sales order. ${blocked.join('. ')}. `
        + 'Activate the item in Zoho and mark it available for sale, then try again.',
    };
  }

  const mapLines = (body, mode) => {
    const next = cloneSalesOrderBody(body);
    next.line_items = next.line_items.map(line => {
      const copy = { ...line };
      if (!copy.warehouse_id) return copy;
      const itemId = String(copy.item_id || '').trim();
      const item = itemById.get(itemId);
      if (mode === 'omit' || (item && zohoItemSkipsWarehouse(item))) {
        delete copy.warehouse_id;
        return copy;
      }
      const rows = rowsForSalesOrderLine(item, catalogByItem.get(itemId));
      if (!rows.length) return copy;
      if (mode === 'alternate') {
        const current = String(copy.warehouse_id || '').trim();
        const other = rows.find(row => row.id !== current);
        if (other) copy.warehouse_id = other.id;
        return copy;
      }
      const picked = pickWarehouseId(rows, preferredWarehouseId);
      if (picked) copy.warehouse_id = picked;
      return copy;
    });
    return next;
  };

  const preferred = mapLines(sourceBody, 'preferred');
  const stripped = withoutLineDescriptions(
    stripShippingFromBody(withoutSalesperson(preferred)),
  );
  return {
    bodies: [
      preferred,
      stripped,
      mapLines(stripped, 'alternate'),
      mapLines(stripped, 'omit'),
    ],
    blockedHint: null,
  };
}

async function loadSalesOrderZohoItems(accessToken, orgId, itemIds) {
  const byId = new Map();
  await Promise.all(itemIds.map(async (itemId) => {
    try {
      const payload = await zohoJson(accessToken, orgId, `/items/${encodeURIComponent(itemId)}`);
      if (payload?.item) byId.set(itemId, payload.item);
    } catch (err) {
      console.warn('Zoho item lookup during sales order create failed', {
        itemId,
        message: err?.message || err,
      });
    }
  }));
  return byId;
}

async function itemAwareSalesOrderBodies(accessToken, orgId, sourceBody, order, preferredWarehouseId) {
  const itemIds = [...new Set(
    (sourceBody.line_items || [])
      .map(line => String(line.item_id || '').trim())
      .filter(Boolean),
  )];
  const itemById = await loadSalesOrderZohoItems(accessToken, orgId, itemIds);
  console.warn('Zoho sales order item-aware retry', {
    items: itemIds.map(id => {
      const item = itemById.get(id);
      return {
        item_id: id,
        name: item?.name || null,
        item_type: item?.item_type || null,
        product_type: item?.product_type || null,
        status: item?.status || null,
        warehouses: item ? warehouseRowsFromZohoItem(item).map(row => row.id) : null,
      };
    }),
  });
  return salesOrderBodiesFromZohoItems(
    sourceBody,
    itemById,
    catalogWarehouseIdsByItemId(order),
    preferredWarehouseId,
  );
}

const SALES_ORDER_REFUSAL_HINT = 'Zoho Inventory refused this sales order. '
  + 'YesOne loaded each item from Zoho and retried with that item’s own warehouses, '
  + 'without a warehouse on items Zoho does not stock, and without salesperson, shipping address, or a custom rate. '
  + 'Confirm the customer is active, the product is active and available for sale, '
  + 'and the connected Zoho user can create sales orders.';

export async function createSalesOrderFromDealerOrder(secrets, configuredOrgId, order) {
  const accessToken = await getAccessToken(secrets);
  const orgId = await resolveOrganizationId(accessToken, configuredOrgId);
  // order.locationId holds the Zoho warehouse_id for Cochin / Head Office.
  let warehouseId = order.locationId != null && String(order.locationId).trim()
    ? String(order.locationId).trim()
    : (order.warehouseId != null && String(order.warehouseId).trim()
      ? String(order.warehouseId).trim()
      : null);
  let alternateWarehouseIds = [];
  try {
    const bySite = await loadZohoLocationIdsBySite(secrets, configuredOrgId);
    const liveIds = [bySite.cochin, bySite.head_office].filter(Boolean);
    if (warehouseId && liveIds.includes(warehouseId)) {
      alternateWarehouseIds = liveIds.filter(id => id !== warehouseId);
    } else if (liveIds.length) {
      if (warehouseId) {
        // Keep the caller's warehouse (item-enabled Head Office / Cochin).
        // Replacing it with Cochin sends a warehouse the SKU is not enabled at.
        console.warn('Zoho sales order warehouse id is not in the live Cochin/HO pair; trying both', {
          requested: warehouseId,
          cochin: bySite.cochin,
          headOffice: bySite.head_office,
        });
        alternateWarehouseIds = liveIds.filter(id => id !== warehouseId);
      } else {
        warehouseId = bySite.head_office || bySite.cochin || liveIds[0];
        alternateWarehouseIds = liveIds.filter(id => id !== warehouseId);
      }
    }
  } catch (err) {
    console.warn('Could not load live Zoho warehouses for sales order create:', err?.message || err);
  }
  const lineWarehouseIds = [];
  for (const line of Array.isArray(order.lines) ? order.lines : []) {
    for (const row of Array.isArray(line?.warehouses) ? line.warehouses : []) {
      const id = String(row?.warehouseId ?? row?.warehouse_id ?? '').trim();
      if (id) lineWarehouseIds.push(id);
    }
  }
  alternateWarehouseIds = [
    ...alternateWarehouseIds,
    ...lineWarehouseIds,
    ...KNOWN_ZOHO_WAREHOUSE_IDS.cochin,
    ...KNOWN_ZOHO_WAREHOUSE_IDS.head_office,
  ].filter((id, index, all) => id && id !== warehouseId && all.indexOf(id) === index);
  const lineItems = lineItemsFromOrder(order, warehouseId);
  if (!lineItems.length) {
    throw new Error('Order has no valid Zoho line items.');
  }

  const customerId = String(order.zohoCustomerId || '').trim();
  if (!customerId) throw new Error('Dealer is not linked to a Zoho customer.');

  // Zoho Inventory "notes" is the sales-order remarks field (UI: Customer Notes / Remarks).
  const dealerRemarks = String(order.remarks ?? order.notes ?? '').trim();
  const notes = dealerRemarks
    || `YesOne cart ${order.orderNumber || order.id}`;

  // Zoho Inventory creates SOs as Draft by default (Save as Draft).
  // Do not send location_id — multi-warehouse orgs reject it as an invalid element.
  const body = {
    customer_id: customerId,
    reference_number: String(order.orderNumber || order.id || ''),
    date: new Date().toISOString().slice(0, 10),
    line_items: lineItems,
    notes,
  };
  const salespersonId = String(order.salespersonId || '').trim();
  if (salespersonId) {
    body.salesperson_id = salespersonId;
  }
  const shippingId = String(order.shippingAddressId || '').trim();
  const shippingInline = order.shippingAddressInline;
  const shippingIdSafe = Boolean(shippingId) && !addressLineTooLong(shippingInline);
  if (shippingIdSafe) {
    body.shipping_address_id = shippingId;
  }

  const attempts = uniqueSalesOrderCreateAttempts(body, { alternateWarehouseIds });
  const tried = new Set();
  let payload = null;
  let lastErr = null;
  let createdBody = null;
  let itemAwareBodies = [];
  let itemAwareDone = false;

  const postAttempt = async (candidate) => {
    const key = salesOrderAttemptKey(candidate);
    if (tried.has(key)) return 'skip';
    tried.add(key);
    try {
      payload = await zohoJson(accessToken, orgId, '/salesorders', {
        method: 'POST',
        body: candidate,
      });
      createdBody = candidate;
      lastErr = null;
      return 'ok';
    } catch (err) {
      lastErr = err;
      if (isZohoShippingAddressTooLong(err)) {
        console.warn('Zoho shipping address over 100 characters, creating the order without it.');
        return 'next';
      }
      if (!isZohoNotAuthorized(err)) throw err;
      console.warn('Zoho sales order create not authorized', {
        attempt: tried.size,
        status: err?.status || null,
        zohoCode: err?.zohoCode ?? null,
        items: candidate.line_items.map(line => ({
          item_id: line.item_id,
          warehouse_id: line.warehouse_id || null,
          rate: Object.prototype.hasOwnProperty.call(line, 'rate') ? line.rate : null,
        })),
        salesperson: Boolean(candidate.salesperson_id),
        shippingAddressId: Boolean(candidate.shipping_address_id),
      });
      return 'unauthorized';
    }
  };

  for (let i = 0; i < attempts.length; i += 1) {
    const result = await postAttempt(attempts[i]);
    if (result === 'ok') break;
    if (result === 'unauthorized' && !itemAwareDone) {
      itemAwareDone = true;
      const extra = await itemAwareSalesOrderBodies(
        accessToken,
        orgId,
        attempts[i],
        order,
        warehouseId,
      );
      if (extra.blockedHint) {
        const blockedErr = new Error(extra.blockedHint);
        blockedErr.yesOneHint = extra.blockedHint;
        throw blockedErr;
      }
      itemAwareBodies = extra.bodies;
      for (const candidate of extra.bodies) {
        const extraResult = await postAttempt(candidate);
        if (extraResult === 'ok') break;
      }
    }
    if (!lastErr) break;
  }

  if (lastErr && isZohoNotAuthorized(lastErr)) {
    const rateFreeSources = itemAwareBodies.length ? itemAwareBodies : [body];
    for (const candidate of rateFreeSources.map(withoutRates)) {
      const result = await postAttempt(candidate);
      if (result === 'ok') break;
    }
  }

  if (lastErr) {
    if (isZohoNotAuthorized(lastErr)) {
      lastErr.yesOneHint = `${SALES_ORDER_REFUSAL_HINT} Zoho: ${lastErr.message}`;
    }
    throw lastErr;
  }

  const so = payload?.salesorder;
  if (!so?.salesorder_id) {
    throw new Error(payload?.message || 'Zoho did not return a sales order id.');
  }

  const createdWithShipping = Boolean(
    createdBody?.shipping_address_id || createdBody?.shipping_address,
  );
  if (!createdWithShipping || addressLineTooLong(shippingInline)) {
    await putSalesOrderShippingAddress(accessToken, orgId, so.salesorder_id, {
      addressId: shippingId || null,
      address: shippingInline,
    });
  }

  return {
    salesOrderId: String(so.salesorder_id),
    salesOrderNumber: so.salesorder_number ? String(so.salesorder_number) : null,
    status: so.status ? String(so.status) : 'draft',
    locationId: so.location_id != null && String(so.location_id).trim()
      ? String(so.location_id).trim()
      : warehouseId,
    warehouseId: (() => {
      const lineWh = Array.isArray(so.line_items)
        ? so.line_items.find(li => li?.warehouse_id != null && String(li.warehouse_id).trim())
          ?.warehouse_id
        : null;
      return lineWh != null && String(lineWh).trim() ? String(lineWh).trim() : warehouseId;
    })(),
    salespersonId: so.salesperson_id != null && String(so.salesperson_id).trim()
      ? String(so.salesperson_id).trim()
      : (salespersonId || null),
    salespersonName: so.salesperson_name ? String(so.salesperson_name).trim() || null : null,
  };
}

/**
 * Load a Zoho Inventory sales order by id.
 * @param {object} secrets
 * @param {string} configuredOrgId
 * @param {string} salesOrderId
 */
export async function fetchZohoSalesOrder(secrets, configuredOrgId, salesOrderId) {
  const soId = String(salesOrderId || '').trim();
  if (!soId) throw new Error('Sales order id is required.');
  const accessToken = await getAccessToken(secrets);
  const orgId = await resolveOrganizationId(accessToken, configuredOrgId);
  const existing = await zohoJson(accessToken, orgId, `/salesorders/${soId}`);
  return existing?.salesorder || null;
}

/**
 * Replace line items on a Draft Zoho Inventory sales order.
 * @param {object} secrets
 * @param {string} configuredOrgId
 * @param {string} salesOrderId
 * @param {Array<{ itemId: string, name?: string, rate?: number, quantity: number, unit?: string, hsn?: string|null }>} lines
 * @param {{ notes?: string, allowConfirmed?: boolean }} [options]
 */
export async function updateSalesOrderLines(secrets, configuredOrgId, salesOrderId, lines, options = {}) {
  const soId = String(salesOrderId || '').trim();
  if (!soId) throw new Error('Sales order id is required.');
  const lineItems = lineItemsFromOrder({ lines });
  if (!lineItems.length) {
    throw new Error('Sales order must have at least one line item.');
  }

  const accessToken = await getAccessToken(secrets);
  const orgId = await resolveOrganizationId(accessToken, configuredOrgId);
  const existing = await zohoJson(accessToken, orgId, `/salesorders/${soId}`);
  const so = existing?.salesorder;
  if (!so) throw new Error('Sales order not found in Zoho.');

  const status = String(so.status || '').toLowerCase().replace(/\s+/g, '_');
  if (status !== 'draft' && status !== 'pending' && !options.allowConfirmed) {
    throw new Error('Only Draft sales orders can be edited.');
  }

  const body = {
    customer_id: so.customer_id,
    reference_number: so.reference_number || '',
    date: so.date || new Date().toISOString().slice(0, 10),
    line_items: lineItems,
    notes: options.notes !== undefined ? String(options.notes ?? '') : (so.notes || ''),
  };
  if (so.salesperson_id) body.salesperson_id = so.salesperson_id;

  const payload = await zohoJson(accessToken, orgId, `/salesorders/${soId}`, {
    method: 'PUT',
    body,
  });
  const updated = payload?.salesorder;
  return {
    salesOrderId: soId,
    salesOrderNumber: updated?.salesorder_number
      ? String(updated.salesorder_number)
      : (so.salesorder_number ? String(so.salesorder_number) : null),
    status: updated?.status ? String(updated.status) : status,
  };
}

/**
 * Set / replace Zoho salesperson on a sales order (Draft or Confirmed).
 */
export async function setSalesOrderSalesperson(
  secrets,
  configuredOrgId,
  salesOrderId,
  { salespersonId, salespersonName = null } = {},
) {
  const soId = String(salesOrderId || '').trim();
  const spId = String(salespersonId || '').trim();
  if (!soId) throw new Error('Sales order id is required.');
  if (!spId) throw new Error('Salesperson id is required.');

  const accessToken = await getAccessToken(secrets);
  const orgId = await resolveOrganizationId(accessToken, configuredOrgId);
  const existing = await zohoJson(accessToken, orgId, `/salesorders/${soId}`);
  const so = existing?.salesorder;
  if (!so) throw new Error('Sales order not found in Zoho.');

  const body = {
    customer_id: so.customer_id,
    reference_number: so.reference_number || '',
    date: so.date || new Date().toISOString().slice(0, 10),
    line_items: lineItemsForSalesOrderPut(so),
    notes: so.notes || '',
    salesperson_id: spId,
  };
  if (so.shipping_address_id) {
    body.shipping_address_id = so.shipping_address_id;
  }

  const payload = await zohoJson(accessToken, orgId, `/salesorders/${soId}`, {
    method: 'PUT',
    body,
  });
  const updated = payload?.salesorder;
  return {
    salesOrderId: soId,
    salespersonId: updated?.salesperson_id != null && String(updated.salesperson_id).trim()
      ? String(updated.salesperson_id).trim()
      : spId,
    salespersonName: updated?.salesperson_name
      ? String(updated.salesperson_name).trim() || null
      : (salespersonName ? String(salespersonName).trim() || null : null),
  };
}

/**
 * Update shipping address on a Draft/Pending Zoho sales order.
 * Prefer shipping_address_id (contact address); fall back to inline shipping_address.
 */
export async function updateSalesOrderShippingAddress(
  secrets,
  configuredOrgId,
  salesOrderId,
  { shippingAddressId = null, shippingAddressInline = null } = {},
) {
  const soId = String(salesOrderId || '').trim();
  if (!soId) throw new Error('Sales order id is required.');

  const accessToken = await getAccessToken(secrets);
  const orgId = await resolveOrganizationId(accessToken, configuredOrgId);
  const existing = await zohoJson(accessToken, orgId, `/salesorders/${soId}`);
  const so = existing?.salesorder;
  if (!so) throw new Error('Sales order not found in Zoho.');

  const status = String(so.status || '').toLowerCase().replace(/\s+/g, '_');
  if (status !== 'draft' && status !== 'pending') {
    throw new Error('Only Draft sales orders can change shipping address.');
  }

  const body = {
    customer_id: so.customer_id,
    reference_number: so.reference_number || '',
    date: so.date || new Date().toISOString().slice(0, 10),
    line_items: lineItemsForSalesOrderPut(so),
    notes: so.notes || '',
  };
  if (so.salesperson_id) body.salesperson_id = so.salesperson_id;
  const shippingId = String(shippingAddressId || '').trim();
  const applied = await putSalesOrderShippingAddress(accessToken, orgId, soId, {
    addressId: shippingId || null,
    address: shippingAddressInline,
  });
  if (!applied) {
    if (shippingId && !addressLineTooLong(shippingAddressInline)) {
      body.shipping_address_id = shippingId;
    } else if (shippingAddressInline && typeof shippingAddressInline === 'object') {
      body.shipping_address = fitZohoAddressLines(shippingAddressInline);
    } else {
      throw new Error('shippingAddressId or shippingAddressInline is required.');
    }
    await zohoJson(accessToken, orgId, `/salesorders/${soId}`, {
      method: 'PUT',
      body,
    });
  }
  const payload = await zohoJson(accessToken, orgId, `/salesorders/${soId}`);
  const updated = payload?.salesorder;
  return {
    salesOrderId: soId,
    salesOrderNumber: updated?.salesorder_number
      ? String(updated.salesorder_number)
      : (so.salesorder_number ? String(so.salesorder_number) : null),
    status: updated?.status ? String(updated.status) : status,
  };
}

/** Mark a Zoho Inventory sales order as Confirmed. */
export async function confirmSalesOrder(secrets, configuredOrgId, salesOrderId) {
  const soId = String(salesOrderId || '').trim();
  if (!soId) throw new Error('Sales order id is required.');
  const accessToken = await getAccessToken(secrets);
  const orgId = await resolveOrganizationId(accessToken, configuredOrgId);
  const existing = await zohoJson(accessToken, orgId, `/salesorders/${soId}`);
  let so = existing?.salesorder;
  if (!so) throw new Error('Sales order not found in Zoho.');

  const status = zohoStatusKey(so.status);
  if (['open', 'confirmed', 'invoiced', 'closed'].includes(status)) {
    return { salesOrderId: soId, status: status === 'open' ? 'confirmed' : status };
  }

  try {
    so = await stripServiceWarehousesOnSalesOrder(accessToken, orgId, so);
  } catch (err) {
    console.warn(
      `Could not strip service warehouses before confirm for SO ${soId}:`,
      err?.message || err,
    );
  }

  await confirmSalesOrderRequest(accessToken, orgId, soId);
  return { salesOrderId: soId, status: 'confirmed' };
}

/** Mark a Zoho Inventory sales order as Void. */
export async function voidSalesOrder(secrets, configuredOrgId, salesOrderId, reason = '') {
  const soId = String(salesOrderId || '').trim();
  if (!soId) throw new Error('Sales order id is required.');
  const accessToken = await getAccessToken(secrets);
  const orgId = await resolveOrganizationId(accessToken, configuredOrgId);
  const note = String(reason || '').trim().slice(0, 500);
  await zohoJson(accessToken, orgId, `/salesorders/${soId}/status/void`, {
    method: 'POST',
    body: note ? { reason: note } : {},
  });
  return { salesOrderId: soId, status: 'void' };
}

/** Permanently delete a Zoho Inventory sales order (Draft / eligible confirmed only). */
export async function deleteSalesOrder(secrets, configuredOrgId, salesOrderId) {
  const soId = String(salesOrderId || '').trim();
  if (!soId) throw new Error('Sales order id is required.');
  const accessToken = await getAccessToken(secrets);
  const orgId = await resolveOrganizationId(accessToken, configuredOrgId);
  await zohoJson(accessToken, orgId, `/salesorders/${soId}`, {
    method: 'DELETE',
  });
  return { salesOrderId: soId, deleted: true };
}

/** Submit a draft SO for Zoho approval (only when Approvals are enabled in Zoho). */
export async function submitSalesOrderForApproval(secrets, configuredOrgId, salesOrderId) {
  const soId = String(salesOrderId || '').trim();
  if (!soId) throw new Error('Sales order id is required.');
  const accessToken = await getAccessToken(secrets);
  const orgId = await resolveOrganizationId(accessToken, configuredOrgId);
  await zohoJson(accessToken, orgId, `/salesorders/${soId}/submit`, {
    method: 'POST',
    body: {},
  });
  return { salesOrderId: soId };
}

/** Approve a submitted Zoho sales order (Approvals feature). */
export async function approveSalesOrderInZoho(secrets, configuredOrgId, salesOrderId) {
  const soId = String(salesOrderId || '').trim();
  if (!soId) throw new Error('Sales order id is required.');
  const accessToken = await getAccessToken(secrets);
  const orgId = await resolveOrganizationId(accessToken, configuredOrgId);
  await zohoJson(accessToken, orgId, `/salesorders/${soId}/approve`, {
    method: 'POST',
    body: {},
  });
  return { salesOrderId: soId };
}

/** Fetch a sales order PDF from Zoho (no Firestore mirror required). */
export async function downloadSalesOrderPdf(secrets, configuredOrgId, {
  salesOrderId,
  salesOrderNumber,
}) {
  const soId = String(salesOrderId || '').trim();
  if (!soId) throw new Error('Sales order id is required.');

  const accessToken = await getAccessToken(secrets);
  const orgId = await resolveOrganizationId(accessToken, configuredOrgId);
  const url = new URL(`${ZOHO_API_BASE}/salesorders/${soId}`);
  url.searchParams.set('organization_id', orgId);

  let res;
  try {
    res = await fetch(url.toString(), {
      headers: {
        ...authHeaders(accessToken, orgId),
        Accept: 'application/pdf',
      },
    });
  } catch (err) {
    recordZohoApiFailure(err);
    throw err;
  }

  recordZohoApiResponse(res, { operation: `salesorders/${soId}/pdf`, source: 'dealer-orders' });
  if (!res.ok) {
    const classified = classifyZohoHttpError(res.status, {});
    throw new Error(classified?.message || `Could not download sales order PDF (${res.status}).`);
  }

  const buffer = Buffer.from(await res.arrayBuffer());
  if (!buffer.length) throw new Error('PDF file is empty.');

  const number = String(salesOrderNumber || soId).replace(/[^\w.-]+/g, '_');
  return {
    contentBase64: buffer.toString('base64'),
    filename: `${number}.pdf`,
    mimeType: 'application/pdf',
  };
}

/**
 * Read the first invoice already linked to a Zoho sales order (if any).
 */
export async function getSalesOrderLinkedInvoice(secrets, configuredOrgId, salesOrderId) {
  const accessToken = await getAccessToken(secrets);
  const orgId = await resolveOrganizationId(accessToken, configuredOrgId);
  const soId = String(salesOrderId || '').trim();
  if (!soId) throw new Error('Sales order id is required.');

  const soPayload = await zohoJson(accessToken, orgId, `/salesorders/${encodeURIComponent(soId)}`);
  const so = soPayload?.salesorder;
  if (!so) throw new Error('Could not load sales order from Zoho.');

  const status = so.order_status ? String(so.order_status) : (so.status ? String(so.status) : null);
  const linked = await findInvoiceForSalesOrder(accessToken, orgId, so);
  if (!linked) {
    return {
      status,
      invoiceId: null,
      invoiceNumber: null,
    };
  }
  return {
    status,
    invoiceId: linked.invoiceId,
    invoiceNumber: linked.invoiceNumber,
  };
}

/** Zoho invoice/SO shipping payload from a salesorder object. */
function shippingFieldsFromSalesOrder(so) {
  if (!so || typeof so !== 'object') return {};
  const addressId = so.shipping_address_id != null
    ? String(so.shipping_address_id).trim()
    : (so.shipping_address?.address_id != null
      ? String(so.shipping_address.address_id).trim()
      : '');
  if (addressId) return { shipping_address_id: addressId };

  const addr = so.shipping_address;
  if (!addr || typeof addr !== 'object') return {};
  const hasBody = Boolean(
    addr.address || addr.city || addr.state || addr.zip || addr.attention,
  );
  if (!hasBody) return {};
  return {
    shipping_address: fitZohoAddressLines(addr),
  };
}

function invoiceModeOfTransportValue(inv) {
  const fields = Array.isArray(inv?.custom_fields) ? inv.custom_fields : [];
  const hit = fields.find((field) => {
    const api = String(field?.api_name ?? '').trim().toLowerCase();
    const label = String(field?.label ?? '').trim().toLowerCase();
    return api === 'cf_mode_of_transport' || label === 'mode of transport';
  });
  return hit?.value != null ? String(hit.value).trim() : '';
}

function modeOfTransportCustomFields(inv, mode) {
  const value = String(mode ?? '').trim();
  if (!value) return {};
  const existing = Array.isArray(inv?.custom_fields) ? inv.custom_fields : [];
  const rest = existing
    .filter((field) => {
      const api = String(field?.api_name ?? '').trim().toLowerCase();
      const label = String(field?.label ?? '').trim().toLowerCase();
      return api !== 'cf_mode_of_transport' && label !== 'mode of transport';
    })
    .map((field) => {
      const next = {};
      if (field.customfield_id) next.customfield_id = field.customfield_id;
      if (field.api_name) next.api_name = field.api_name;
      if (field.value != null) next.value = field.value;
      return next;
    })
    .filter((field) => field.customfield_id || field.api_name);
  return {
    custom_fields: [
      ...rest,
      { api_name: 'cf_mode_of_transport', value },
    ],
  };
}

/**
 * Create an invoice linked to an existing sales order.
 * Tries convert-from-SO first, then falls back to invoice with salesorder_id.
 * Always copies SO shipping onto the invoice (convert does not reliably inherit it).
 * Sets Zoho `cf_mode_of_transport` from the SO freight line / pickup partner
 * so the tax invoice shows it next to Place of Supply without a manual Zoho edit.
 */
export async function createInvoiceFromSalesOrder(secrets, configuredOrgId, {
  salesOrderId,
  customerId,
  referenceNumber,
  salespersonId = null,
  courierPartner = null,
}) {
  const accessToken = await getAccessToken(secrets);
  const orgId = await resolveOrganizationId(accessToken, configuredOrgId);
  const soId = String(salesOrderId || '').trim();
  if (!soId) throw new Error('Sales order id is required.');
  const spId = String(salespersonId || '').trim();

  const loadSo = async () => {
    const soPayload = await zohoJson(accessToken, orgId, `/salesorders/${soId}`);
    const loaded = soPayload?.salesorder;
    if (!loaded) throw new Error('Could not load sales order from Zoho.');
    return loaded;
  };

  const linkedInvoiceFromSo = (order) => linkedInvoiceRecord(embeddedInvoiceFromSalesOrder(order));

  const resolveExistingInvoice = async (order, { forceSearch = false } = {}) => {
    const embedded = linkedInvoiceFromSo(order);
    if (embedded) return embedded;
    if (!forceSearch && !salesOrderAlreadyInvoiced(order)) return null;
    return findInvoiceForSalesOrder(accessToken, orgId, order);
  };

  const invoiceResult = (inv) => ({
    invoiceId: String(inv.invoice_id),
    invoiceNumber: inv.invoice_number ? String(inv.invoice_number) : null,
  });

  let so = await loadSo();
  const resolveModeOfTransport = () => zohoModeOfTransportFromOrder({
    lineItems: so.line_items,
    courierPartner,
  });

  const patchInvoiceExtras = async (inv) => {
    const invoiceId = String(inv.invoice_id);
    const modeOfTransport = resolveModeOfTransport();
    const needsSalesperson = Boolean(spId && String(inv.salesperson_id || '').trim() !== spId);
    const needsShipping = Object.keys(shippingFieldsFromSalesOrder(so)).length > 0;
    const needsMode = Boolean(
      modeOfTransport && invoiceModeOfTransportValue(inv) !== modeOfTransport,
    );
    if (!needsSalesperson && !needsShipping && !needsMode) {
      return invoiceResult(inv);
    }
    const shippingFields = shippingFieldsFromSalesOrder(so);
    const extrasBody = {
      customer_id: inv.customer_id || so.customer_id,
      date: inv.date || so.date || new Date().toISOString().slice(0, 10),
      line_items: lineItemsForSalesOrderPut(inv, { keepGoodsWarehouse: true }),
      ...(needsSalesperson ? { salesperson_id: spId } : {}),
      ...(needsShipping ? shippingFields : {}),
    };
    const putInvoice = (body) => zohoJson(
      accessToken,
      orgId,
      `/invoices/${encodeURIComponent(invoiceId)}`,
      { method: 'PUT', body },
    );
    try {
      await putInvoice({
        ...extrasBody,
        ...(needsMode ? modeOfTransportCustomFields(inv, modeOfTransport) : {}),
      });
    } catch (err) {
      if (needsMode && (needsSalesperson || needsShipping)) {
        try {
          await putInvoice(extrasBody);
        } catch (retryErr) {
          console.warn(
            'Could not set salesperson/shipping on invoice:',
            retryErr?.message || retryErr,
          );
        }
      } else if (!needsMode) {
        console.warn(
          'Could not set salesperson/shipping on invoice:',
          err?.message || err,
        );
      }
      if (needsMode) {
        try {
          await putInvoice({
            ...extrasBody,
            custom_fields: [{ label: 'Mode of Transport', value: modeOfTransport }],
          });
        } catch (modeErr) {
          console.warn(
            'Could not set mode of transport on invoice:',
            modeErr?.message || modeErr,
          );
        }
      }
    }
    return invoiceResult(inv);
  };

  const patchLinkedInvoice = async (linked) => {
    if (!linked?.invoiceId) return linked;
    try {
      const payload = await zohoJson(
        accessToken,
        orgId,
        `/invoices/${encodeURIComponent(linked.invoiceId)}`,
      );
      const inv = payload?.invoice;
      if (inv?.invoice_id) return patchInvoiceExtras(inv);
    } catch (err) {
      console.warn(
        `Could not load invoice ${linked.invoiceId} to set mode of transport:`,
        err?.message || err,
      );
    }
    return linked;
  };

  const already = await resolveExistingInvoice(so);
  if (already) return patchLinkedInvoice(already);

  try {
    so = await ensureServiceWarehousesStripped(accessToken, orgId, so);
  } catch (err) {
    console.warn(
      `Could not strip service warehouses before invoice for SO ${soId}:`,
      err?.message || err,
    );
  }

  const status = zohoStatusKey(so.status);
  if (!['open', 'confirmed', 'invoiced', 'closed'].includes(status)) {
    await confirmSalesOrderRequest(accessToken, orgId, soId);
    so = await loadSo();
    const afterConfirm = await resolveExistingInvoice(so);
    if (afterConfirm) return patchLinkedInvoice(afterConfirm);
  }

  const shippingFields = shippingFieldsFromSalesOrder(so);

  // Prefer convert endpoint when available. Do not send `{}` — Zoho treats an
  // empty JSON body as unauthorized on some orgs.
  try {
    const converted = await zohoJson(
      accessToken,
      orgId,
      `/invoices/fromsalesorder?salesorder_id=${encodeURIComponent(soId)}`,
      { method: 'POST' },
    );
    const inv = converted?.invoice;
    if (inv?.invoice_id) return patchInvoiceExtras(inv);
  } catch (convertErr) {
    so = await loadSo().catch(() => so);
    const linked = await resolveExistingInvoice(so, {
      forceSearch: isInvalidZohoUrlMessage(convertErr?.message)
        || isAlreadyInvoicedQuantityMessage(convertErr?.message),
    });
    if (linked) return patchLinkedInvoice(linked);
    console.warn(
      `Convert SO ${soId} to invoice failed, trying create:`,
      convertErr?.message || convertErr,
    );
  }

  const linkedLineItems = invoiceLineItemsFromSalesOrder(so, { linkServiceLines: true });
  const goodsLinkedLineItems = invoiceLineItemsFromSalesOrder(so, { linkServiceLines: false });
  if (!linkedLineItems.length) {
    throw new Error('Sales order has no line items to invoice.');
  }

  const baseBody = {
    customer_id: String(customerId || so.customer_id || ''),
    reference_number: String(referenceNumber || so.reference_number || ''),
    date: new Date().toISOString().slice(0, 10),
    salesorder_id: soId,
  };
  const effectiveSp = spId || (so.salesperson_id != null ? String(so.salesperson_id).trim() : '');

  const { salesorder_id: _soLink, ...unlinkedBase } = baseBody;
  const unlinkedLineItems = stripSalesOrderItemIds(linkedLineItems);
  const unlinkedGoodsLineItems = stripSalesOrderItemIds(goodsLinkedLineItems);
  const salespersonFields = effectiveSp ? { salesperson_id: effectiveSp } : {};
  const attempts = [
    { ...baseBody, line_items: linkedLineItems, ...shippingFields, ...salespersonFields },
    { ...baseBody, line_items: linkedLineItems, ...shippingFields },
    { ...baseBody, line_items: linkedLineItems, ...salespersonFields },
    { ...baseBody, line_items: goodsLinkedLineItems, ...shippingFields, ...salespersonFields },
    { ...baseBody, line_items: goodsLinkedLineItems, ...salespersonFields },
    // Convert can report "no items to invoice" while the SO is still open. Creating
    // with salesorder_item_id then fails as "quantity … more than quantity ordered".
    // Retry without the line-item link so Zoho can still invoice the confirmed SO.
    { ...baseBody, line_items: unlinkedLineItems, ...shippingFields, ...salespersonFields },
    { ...baseBody, line_items: unlinkedLineItems, ...salespersonFields },
    { ...baseBody, line_items: unlinkedGoodsLineItems, ...salespersonFields },
    { ...unlinkedBase, line_items: linkedLineItems, ...shippingFields, ...salespersonFields },
    { ...unlinkedBase, line_items: linkedLineItems, ...salespersonFields },
  ];

  let lastErr = null;
  for (const body of attempts) {
    try {
      const payload = await zohoJson(accessToken, orgId, '/invoices', {
        method: 'POST',
        body,
      });
      const inv = payload?.invoice;
      if (inv?.invoice_id) return patchInvoiceExtras(inv);
      lastErr = new Error(payload?.message || 'Zoho did not return an invoice id.');
    } catch (err) {
      lastErr = err;
      so = await loadSo().catch(() => so);
      const message = String(err?.message || '');
      const linked = await resolveExistingInvoice(so, {
        forceSearch: isInvalidZohoUrlMessage(message) || isAlreadyInvoicedQuantityMessage(message),
      });
      if (linked) return patchLinkedInvoice(linked);
      if (salesOrderAlreadyInvoiced(so)) {
        throw new Error(
          'This sales order is already invoiced in Zoho, but YesOne could not read the invoice id. Use Mark as invoiced, or refresh and retry.',
        );
      }
      if (isAlreadyInvoicedQuantityMessage(message) || isZohoNotAuthorized(err)) continue;
      break;
    }
  }

  throw lastErr || new Error('Zoho did not return an invoice id.');
}

function invoiceAlreadySentMessage(message) {
  return /already (been )?sent|not (in )?draft|status is sent|has been sent/i.test(String(message ?? ''));
}

/**
 * Move a Zoho invoice out of Draft (portal payment confirmed).
 * No-ops if it is already sent. Approves first when Zoho requires it.
 */
export async function markInvoiceAsSent(secrets, configuredOrgId, invoiceId) {
  const id = String(invoiceId || '').trim();
  if (!id) throw new Error('Invoice id is required.');
  const accessToken = await getAccessToken(secrets);
  const orgId = await resolveOrganizationId(accessToken, configuredOrgId);

  const postSent = () => zohoJson(
    accessToken,
    orgId,
    `/invoices/${encodeURIComponent(id)}/status/sent`,
    { method: 'POST', body: {} },
  );

  try {
    await postSent();
    return { invoiceId: id, status: 'sent' };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (invoiceAlreadySentMessage(message)) {
      return { invoiceId: id, status: 'sent' };
    }
    if (!/approv/i.test(message) && !isZohoNotAuthorized(err)) throw err;
    try {
      await zohoJson(
        accessToken,
        orgId,
        `/invoices/${encodeURIComponent(id)}/approve`,
        { method: 'POST' },
      );
    } catch (approveErr) {
      const approveMessage = approveErr instanceof Error ? approveErr.message : String(approveErr);
      if (
        !/already|approv/i.test(approveMessage)
        && !isZohoNotAuthorized(approveErr)
      ) throw approveErr;
    }
    try {
      await postSent();
      return { invoiceId: id, status: 'sent' };
    } catch (sentErr) {
      const sentMessage = sentErr instanceof Error ? sentErr.message : String(sentErr);
      if (invoiceAlreadySentMessage(sentMessage)) {
        return { invoiceId: id, status: 'sent' };
      }
      throw sentErr;
    }
  }
}

function einvoicePushLooksLikeInvalidBody(err) {
  return /json|invalid|unknown|parameter|unrecognized|not (a )?valid|unexpected/i.test(
    String(err?.message ?? ''),
  );
}

/**
 * Push an invoice's e-invoice to the IRP (Zoho "Push to IRP").
 * Invoice / IRN only — never generate or push e-way bill details.
 * Logistics generates the e-way bill later via Generate e-way bill.
 * Only succeeds for GST-registered B2B customers.
 */
export async function pushInvoiceEinvoiceToIrp(secrets, configuredOrgId, invoiceId) {
  const accessToken = await getAccessToken(secrets);
  const orgId = await resolveOrganizationId(accessToken, configuredOrgId);
  const id = String(invoiceId || '').trim();
  if (!id) throw new Error('Invoice id is required.');

  const path = `/invoices/${encodeURIComponent(id)}/einvoice/push`;
  const skipEway = { generate_ewaybill: false, push_ewaybill: false };
  let payload;
  try {
    payload = await zohoJson(accessToken, orgId, path, {
      method: 'POST',
      body: skipEway,
    });
  } catch (err) {
    if (!einvoicePushLooksLikeInvalidBody(err)) throw err;
    payload = await zohoJson(
      accessToken,
      orgId,
      `${path}?generate_ewaybill=false`,
      { method: 'POST' },
    );
  }

  return {
    invoiceId: id,
    message: payload?.message ? String(payload.message) : 'success',
    code: payload?.code ?? 0,
  };
}

