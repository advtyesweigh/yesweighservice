import {
  recordZohoApiResponse,
  recordZohoApiFailure,
  classifyZohoHttpError,
} from './zoho-api-usage.js';
import { isSacHsn } from './sac-catalog.js';

const ZOHO_ACCOUNTS_URL = 'https://accounts.zoho.in';
export const ZOHO_API_BASE = 'https://www.zohoapis.in/inventory/v1';
const ROOT_CATEGORY_ID = '-1';
const MRP_MULTIPLIER = Number(process.env.ZOHO_MRP_MULTIPLIER ?? '2.5');

/**
 * Zoho Inventory treats an empty JSON body (`{}`) as unauthorized on some orgs
 * (confirm / approve / mark-sent / convert). Omit the body instead.
 */
export function hasZohoJsonBody(body) {
  if (body == null) return false;
  if (typeof body === 'object' && !Array.isArray(body) && Object.keys(body).length === 0) {
    return false;
  }
  return true;
}

export function normaliseCategoryId(id) {
  const s = String(id ?? '').trim();
  return s === '' || s === ROOT_CATEGORY_ID ? '' : s;
}

function validPositiveRate(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function resolveLabelRate(item) {
  const existingMrp = validPositiveRate(item.label_rate);
  if (existingMrp != null) return existingMrp;

  const saleRate =
    validPositiveRate(item.sales_rate)
    ?? validPositiveRate(item.rate)
    ?? validPositiveRate(item.pricebook_rate);

  if (saleRate != null) {
    return Math.round(saleRate * MRP_MULTIPLIER * 100) / 100;
  }

  return 1;
}

/** @type {{ token: string; expiresAt: number } | null} */
let tokenCache = null;

export function getStockStatus(stock, reorderLevel, hsn = null) {
  if (isSacHsn(hsn)) return 'in_stock';
  if (stock <= 0) return 'out_of_stock';
  if (reorderLevel > 0 && stock <= reorderLevel) return 'low_stock';
  return 'in_stock';
}

export function normaliseWarehouses(raw) {
  const list = Array.isArray(raw?.warehouses) ? raw.warehouses : [];
  return list
    .filter(w => w?.warehouse_name || w?.name)
    .map(w => ({
      warehouseId: String(w.warehouse_id ?? ''),
      warehouseName: String(w.warehouse_name ?? w.name ?? ''),
      stock: Number(
        w.warehouse_accounting_stock_on_hand
        ?? w.warehouse_accounting_available_for_sale_stock
        ?? w.warehouse_stock_accounting
        ?? w.warehouse_stock_on_hand
        ?? w.stock
        ?? 0,
      ),
    }));
}

export function normaliseItem(raw) {
  let stockRaw = 0;
  if (raw.account_stock_on_hand != null) stockRaw = raw.account_stock_on_hand;
  else if (raw.accounting_stock != null) stockRaw = raw.accounting_stock;
  else if (raw.stock_on_hand != null) stockRaw = raw.stock_on_hand;
  else if (raw.available_stock != null) stockRaw = raw.available_stock;
  else if (raw.actual_available_stock != null) stockRaw = raw.actual_available_stock;

  const stock = Number.parseFloat(String(stockRaw)) || 0;
  const reorderLevel = Number.parseFloat(String(raw.reorder_level || 0)) || 0;
  const hsn = String(raw.hsn_or_sac ?? '');

  return {
    id: String(raw.item_id ?? ''),
    name: String(raw.name ?? raw.item_name ?? 'Unnamed product'),
    sku: String(raw.sku ?? ''),
    description: String(raw.description ?? ''),
    unit: String(raw.unit ?? 'pcs'),
    rate: Number.parseFloat(String(raw.rate ?? 0)) || 0,
    stock,
    stockStatus: getStockStatus(stock, reorderLevel, hsn),
    hasImage: Boolean(raw.image_url || raw.image_document_id),
    categoryId: normaliseCategoryId(raw.category_id),
    categoryName: String(raw.category_name ?? '').trim(),
    status: String(raw.status ?? 'active'),
    hsn,
    taxName: String(raw.tax_name ?? ''),
    taxPercentage: Number(raw.tax_percentage ?? 0),
    reorderLevel,
    warehouses: normaliseWarehouses(raw),
  };
}

function zohoTokenErrorIsRetryable(err) {
  const msg = String(err?.message ?? err ?? '');
  return /access denied|not authorized|unauthorized|invalid oauth|econnreset|timed out|socket|fetch failed/i.test(msg);
}

async function requestZohoAccessToken(secrets) {
  const body = new URLSearchParams({
    refresh_token: secrets.refreshToken,
    client_id: secrets.clientId,
    client_secret: secrets.clientSecret,
    grant_type: 'refresh_token',
  });

  const response = await fetch(`${ZOHO_ACCOUNTS_URL}/oauth/v2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.error) {
    throw new Error(payload.error || payload.message || 'Failed to refresh Zoho access token.');
  }

  const expiresIn = Number(payload.expires_in_sec || payload.expires_in || 3600);
  tokenCache = {
    token: payload.access_token,
    expiresAt: Date.now() + expiresIn * 1000,
  };
  return tokenCache.token;
}

export async function getAccessToken(secrets) {
  const { assertZohoInventoryAllowed } = await import('./zoho-api-usage.js');
  await assertZohoInventoryAllowed();

  if (tokenCache && tokenCache.expiresAt > Date.now() + 60_000) {
    return tokenCache.token;
  }

  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await requestZohoAccessToken(secrets);
    } catch (err) {
      lastError = err;
      if (!zohoTokenErrorIsRetryable(err) || attempt >= 3) break;
      await new Promise(resolve => setTimeout(resolve, 400 * attempt));
    }
  }
  throw lastError;
}

export function authHeaders(accessToken, orgId) {
  return {
    Authorization: `Zoho-oauthtoken ${accessToken}`,
    'X-com-zoho-inventory-organizationid': orgId,
  };
}

export async function fetchOrganizations(accessToken) {
  const response = await fetch(`${ZOHO_API_BASE}/organizations`, {
    headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
  });
  const payload = await response.json();
  if (!response.ok || (payload.code !== undefined && payload.code !== 0)) {
    throw new Error(payload.message || 'Failed to load Zoho organizations.');
  }
  return payload.organizations ?? [];
}

export async function resolveOrganizationId(accessToken, configuredOrgId) {
  const configured = String(configuredOrgId ?? '').trim();
  if (configured) return configured;

  const orgs = await fetchOrganizations(accessToken);
  if (!orgs.length) {
    throw new Error('No Zoho Inventory organization found. Set ZOHO_ORGANIZATION_ID.');
  }
  return String(orgs[0].organization_id);
}

/** @deprecated Item groups removed from Zoho — use category_id on items. Kept for diagnostics only. */
export async function fetchAllItemGroups(accessToken, orgId, page = 1, perPage = 200) {
  const url = new URL(`${ZOHO_API_BASE}/itemgroups`);
  url.searchParams.set('organization_id', orgId);
  url.searchParams.set('page', String(page));
  url.searchParams.set('per_page', String(perPage));

  const response = await fetch(url, { headers: authHeaders(accessToken, orgId) });
  const payload = await response.json();
  if (payload.code !== 0) {
    throw new Error(payload.message || 'Zoho item groups API error');
  }

  const groups = (payload.itemgroups ?? []).map(raw => ({
    id: String(raw.group_id ?? raw.itemgroup_id ?? ''),
    name: String(raw.group_name ?? raw.name ?? 'Category'),
    productCount: Number(raw.product_count ?? raw.item_count ?? 0),
  })).filter(g => g.id);

  const hasMore = Boolean(payload.page_context?.has_more_page);
  if (hasMore) {
    const next = await fetchAllItemGroups(accessToken, orgId, page + 1, perPage);
    return [...groups, ...next];
  }

  return groups;
}

/** @deprecated Item groups removed from Zoho — use category_id on items. Kept for diagnostics only. */
export async function fetchItemsByGroup(accessToken, orgId, groupId, page = 1, perPage = 200) {
  const url = new URL(`${ZOHO_API_BASE}/items`);
  url.searchParams.set('organization_id', orgId);
  url.searchParams.set('group_id', groupId);
  url.searchParams.set('page', String(page));
  url.searchParams.set('per_page', String(perPage));
  url.searchParams.set('sort_column', 'item_name');
  url.searchParams.set('sort_order', 'A');

  const response = await fetch(url, { headers: authHeaders(accessToken, orgId) });
  const payload = await response.json();
  if (payload.code !== 0) {
    throw new Error(payload.message || `Zoho items API error for group ${groupId}`);
  }

  const items = (payload.items ?? []).map(raw => ({
    id: String(raw.item_id ?? ''),
    status: String(raw.status ?? 'active'),
  })).filter(item => item.id);

  const hasMore = Boolean(payload.page_context?.has_more_page);
  if (hasMore) {
    const next = await fetchItemsByGroup(accessToken, orgId, groupId, page + 1, perPage);
    return [...items, ...next];
  }

  return items;
}

/** Bulk item details — fills in category_id when the list endpoint omits it. */
export async function fetchBulkItemDetails(accessToken, orgId, itemIds) {
  if (!itemIds.length) return [];

  const url = new URL(`${ZOHO_API_BASE}/itemdetails`);
  url.searchParams.set('organization_id', orgId);
  url.searchParams.set('item_ids', itemIds.join(','));

  const response = await fetch(url, { headers: authHeaders(accessToken, orgId) });
  const payload = await response.json();
  if (payload.code !== 0) {
    throw new Error(payload.message || 'Zoho bulk item details error');
  }

  return (payload.items ?? []).map(raw => {
    const categoryId = normaliseCategoryId(raw.category_id);
    return {
      id: String(raw.item_id ?? ''),
      categoryId: categoryId || null,
      categoryName: categoryId ? String(raw.category_name ?? '').trim() || null : null,
      status: String(raw.status ?? 'active'),
      warehouses: normaliseWarehouses(raw),
    };
  }).filter(item => item.id);
}

export async function fetchAllProducts(accessToken, orgId, page = 1, perPage = 200) {
  const url = new URL(`${ZOHO_API_BASE}/items`);
  url.searchParams.set('organization_id', orgId);
  url.searchParams.set('page', String(page));
  url.searchParams.set('per_page', String(perPage));
  url.searchParams.set('sort_column', 'item_name');
  url.searchParams.set('sort_order', 'A');

  const response = await fetch(url, { headers: authHeaders(accessToken, orgId) });
  const payload = await response.json();
  if (payload.code !== 0) {
    throw new Error(payload.message || 'Zoho items API error');
  }

  const items = (payload.items ?? []).map(normaliseItem);
  const hasMore = Boolean(payload.page_context?.has_more_page);
  if (hasMore) {
    const next = await fetchAllProducts(accessToken, orgId, page + 1, perPage);
    return [...items, ...next];
  }
  return items;
}

export async function fetchProductDetail(accessToken, orgId, itemId) {
  const url = `${ZOHO_API_BASE}/items/${itemId}?organization_id=${orgId}`;
  const response = await fetch(url, { headers: authHeaders(accessToken, orgId) });
  await recordZohoApiResponse(response, { operation: `items/${itemId}`, source: 'catalog' });
  const payload = await response.json();
  if (payload.code !== 0) {
    const err = classifyZohoHttpError(
      String(payload.message ?? '').toLowerCase().includes('rate') ? 429 : 400,
      payload,
    );
    await recordZohoApiFailure(err, { operation: `items/${itemId}`, source: 'catalog' });
    throw new Error(payload.message || 'Zoho product detail error');
  }

  const item = payload.item;
  if (!item) throw new Error('Product not found in Zoho response');

  const stock = Number(
    item.account_stock_on_hand
    ?? item.accounting_stock
    ?? item.stock_on_hand
    ?? item.available_stock
    ?? 0,
  );
  const reorderLevel = Number(item.reorder_level ?? 0);
  const hsn = item.hsn_or_sac || null;

  const warehouses = normaliseWarehouses(item);

  return {
    id: String(item.item_id ?? itemId),
    name: String(item.name ?? ''),
    sku: item.sku || null,
    description: item.description || null,
    unit: String(item.unit ?? 'pcs'),
    rate: Number(item.rate ?? 0),
    stock,
    stockStatus: getStockStatus(stock, reorderLevel, hsn),
    categoryId: normaliseCategoryId(item.category_id) || null,
    categoryName: normaliseCategoryId(item.category_id)
      ? String(item.category_name ?? '').trim() || null
      : null,
    status: String(item.status ?? 'active'),
    hsn,
    taxName: item.tax_name || null,
    taxPercentage: item.tax_percentage != null ? Number(item.tax_percentage) : null,
    reorderLevel,
    preferredVendor: item.preferred_vendor?.vendor_name || null,
    warehouses,
  };
}

export async function downloadProductImage(accessToken, orgId, itemId, retryCount = 0) {
  const url = `${ZOHO_API_BASE}/items/${itemId}/image?organization_id=${orgId}`;
  const response = await fetch(url, {
    headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
  });

  if (response.status === 404) return null;

  if (response.status === 429) {
    if (retryCount < 2) {
      const delay = 2 ** (retryCount + 1) * 1000 + Math.random() * 1000;
      await new Promise(resolve => setTimeout(resolve, delay));
      return downloadProductImage(accessToken, orgId, itemId, retryCount + 1);
    }
    return 'RATE_LIMITED';
  }

  if (!response.ok) return null;

  const arrayBuf = await response.arrayBuffer();
  const contentType = response.headers.get('content-type') || 'image/jpeg';
  const ext = contentType.split('/')[1]?.split(';')[0]?.trim() || 'jpg';

  return {
    buffer: Buffer.from(arrayBuf),
    contentType,
    ext,
  };
}

/** Download a specific Zoho gallery/document image for an item. */
export async function downloadProductDocumentImage(
  accessToken,
  orgId,
  itemId,
  documentId,
  retryCount = 0,
) {
  const id = String(documentId ?? '').trim();
  const productId = String(itemId ?? '').trim();
  if (!id || !productId) return null;

  const candidates = [
    `${ZOHO_API_BASE}/items/${productId}/documents/${id}?organization_id=${orgId}`,
    `${ZOHO_API_BASE}/items/documents/${id}?organization_id=${orgId}`,
    `${ZOHO_API_BASE}/documents/${id}?organization_id=${orgId}`,
    `${ZOHO_API_BASE}/documents/${id}?organization_id=${orgId}&inline=true`,
    `${ZOHO_API_BASE}/items/${productId}/image?organization_id=${orgId}&document_id=${id}`,
  ];

  for (const url of candidates) {
    const response = await fetch(url, {
      headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
    });

    if (response.status === 404) continue;

    if (response.status === 429) {
      if (retryCount < 2) {
        const delay = 2 ** (retryCount + 1) * 1000 + Math.random() * 1000;
        await new Promise(resolve => setTimeout(resolve, delay));
        return downloadProductDocumentImage(accessToken, orgId, productId, id, retryCount + 1);
      }
      return 'RATE_LIMITED';
    }

    if (!response.ok) continue;

    const contentType = response.headers.get('content-type') || '';
    // Skip JSON error payloads disguised as 200.
    if (contentType.includes('application/json')) continue;

    const arrayBuf = await response.arrayBuffer();
    if (!arrayBuf.byteLength) continue;

    const type = contentType.split(';')[0].trim() || 'image/jpeg';
    const ext = type.split('/')[1]?.trim() || 'jpg';
    return {
      buffer: Buffer.from(arrayBuf),
      contentType: type,
      ext: ext.replace('jpeg', 'jpg'),
    };
  }

  return null;
}

/** Download the Zoho "rear / back" image when present. */
export async function downloadProductBackImage(accessToken, orgId, itemId, retryCount = 0) {
  const url = `${ZOHO_API_BASE}/items/${itemId}/backimage?organization_id=${orgId}`;
  const response = await fetch(url, {
    headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
  });

  if (response.status === 404) return null;

  if (response.status === 429) {
    if (retryCount < 2) {
      const delay = 2 ** (retryCount + 1) * 1000 + Math.random() * 1000;
      await new Promise(resolve => setTimeout(resolve, delay));
      return downloadProductBackImage(accessToken, orgId, itemId, retryCount + 1);
    }
    return 'RATE_LIMITED';
  }

  if (!response.ok) return null;

  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/json')) return null;

  const arrayBuf = await response.arrayBuffer();
  if (!arrayBuf.byteLength) return null;

  const type = contentType.split(';')[0].trim() || 'image/jpeg';
  const ext = type.split('/')[1]?.trim() || 'jpg';
  return {
    buffer: Buffer.from(arrayBuf),
    contentType: type,
    ext: ext.replace('jpeg', 'jpg'),
  };
}

/** Upload or replace the primary item image in Zoho Inventory. */
export async function uploadProductImageToZoho(accessToken, orgId, itemId, buffer, contentType) {
  const url = `${ZOHO_API_BASE}/items/${itemId}/image?organization_id=${orgId}`;
  const ext = contentType.includes('png')
    ? 'png'
    : contentType.includes('webp')
      ? 'webp'
      : 'jpg';
  const filename = `product-${itemId}.${ext}`;

  const form = new FormData();
  form.append('image', new Blob([buffer], { type: contentType }), filename);

  const response = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
    body: form,
  });

  const text = await response.text();
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }

  if (payload?.code !== undefined && payload.code !== 0) {
    throw new Error(payload.message || 'Zoho image upload failed.');
  }
  if (!response.ok) {
    throw new Error(payload?.message || `Zoho image upload failed (${response.status}).`);
  }

  return payload ?? { ok: true };
}

/** Append gallery images (does not replace primary unless updatePrimary is true). */
export async function uploadProductGalleryImagesToZoho(
  accessToken,
  orgId,
  itemId,
  images,
  options = {},
) {
  if (!images?.length) return { ok: true };

  const url = new URL(`${ZOHO_API_BASE}/items/${itemId}/images`);
  url.searchParams.set('organization_id', orgId);
  if (options.updatePrimary === true) {
    url.searchParams.set('update_primary_image', 'true');
  }
  if (options.removeAll === true) {
    url.searchParams.set('remove_all', 'true');
  }

  const form = new FormData();
  images.forEach((img, index) => {
    const type = String(img.contentType ?? 'image/jpeg');
    const ext = type.includes('png') ? 'png' : type.includes('webp') ? 'webp' : 'jpg';
    form.append(
      'image',
      new Blob([img.buffer], { type }),
      `gallery-${itemId}-${index + 1}.${ext}`,
    );
  });

  const response = await fetch(url.toString(), {
    method: 'POST',
    headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
    body: form,
  });

  const text = await response.text();
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }

  if (payload?.code !== undefined && payload.code !== 0) {
    throw new Error(payload.message || 'Zoho gallery image upload failed.');
  }
  if (!response.ok) {
    throw new Error(payload?.message || `Zoho gallery image upload failed (${response.status}).`);
  }

  return payload ?? { ok: true };
}

const LOCAL_ONLY_IMAGE_DOCUMENT_IDS = new Set(['zoho_back']);

/** Firestore-only gallery ids — never send to Zoho delete APIs. */
export function isLocalOnlyImageDocumentId(documentId) {
  const id = String(documentId ?? '').trim();
  return !id || id.startsWith('local_') || LOCAL_ONLY_IMAGE_DOCUMENT_IDS.has(id);
}

/** Zoho delete failures that still allow removing the app/Storage copy. */
export function isRecoverableZohoImageDeleteError(message) {
  const msg = String(message ?? '').toLowerCase();
  return (
    msg.includes('does not exist')
    || msg.includes('invalid value passed for document_ids')
    || msg.includes('not authorized to perform this operation')
    || msg.includes('image not found')
    || msg.includes('no image')
    // Rate limit / daily quota — clear Firebase now; Zoho cleanup can retry later.
    || msg.includes('rate limit')
    || msg.includes('rate-limit')
    || msg.includes('too many requests')
    || msg.includes('blocked for some time')
    || msg.includes('exceeded the maximum number of requests')
    || msg.includes('maximum call rate limit')
    || /\b429\b/.test(msg)
  );
}

/** Delete specific gallery images by Zoho document_id. */
export async function deleteProductGalleryImagesFromZoho(accessToken, orgId, itemId, documentIds) {
  const ids = [...new Set((documentIds ?? []).map(id => String(id).trim()).filter(Boolean))];
  if (!ids.length) return { ok: true };

  const url = new URL(`${ZOHO_API_BASE}/items/${itemId}/images`);
  url.searchParams.set('organization_id', orgId);
  url.searchParams.set('document_ids', ids.join(','));

  const response = await fetch(url.toString(), {
    method: 'DELETE',
    headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
  });
  await recordZohoApiResponse(response, { operation: 'deleteProductGalleryImages', source: 'catalog' });

  const text = await response.text();
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }

  const zohoFailed = (payload?.code !== undefined && payload.code !== 0) || !response.ok;
  if (zohoFailed) {
    const err = classifyZohoHttpError(
      response.status,
      payload ?? { message: `Zoho gallery image delete failed (${response.status}).` },
    );
    await recordZohoApiFailure(err, { operation: 'deleteProductGalleryImages', source: 'catalog' });
    // Prefer Zoho body message so recoverable-matchers (rate limit, not found, …) still work.
    throw new Error(payload?.message || err.message || 'Zoho gallery image delete failed.');
  }

  return payload ?? { ok: true };
}

/** Raw Zoho item payload (includes documents for gallery metadata). */
export async function fetchZohoItemRaw(accessToken, orgId, itemId) {
  return fetchZohoItemForUpdate(accessToken, orgId, itemId);
}

/** Remove the primary item image from Zoho Inventory. */
export async function deleteProductImageFromZoho(accessToken, orgId, itemId) {
  const url = `${ZOHO_API_BASE}/items/${itemId}/image?organization_id=${orgId}`;
  const response = await fetch(url, {
    method: 'DELETE',
    headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
  });
  await recordZohoApiResponse(response, { operation: 'deleteProductImage', source: 'catalog' });

  if (response.status === 404) {
    return { ok: true };
  }

  const text = await response.text();
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }

  const zohoFailed = (payload?.code !== undefined && payload.code !== 0) || !response.ok;
  if (zohoFailed) {
    const err = classifyZohoHttpError(
      response.status,
      payload ?? { message: `Zoho image delete failed (${response.status}).` },
    );
    await recordZohoApiFailure(err, { operation: 'deleteProductImage', source: 'catalog' });
    throw new Error(payload?.message || err.message || 'Zoho image delete failed.');
  }

  return payload ?? { ok: true };
}

async function fetchZohoItemForUpdate(accessToken, orgId, itemId) {
  const detailUrl = `${ZOHO_API_BASE}/items/${itemId}?organization_id=${orgId}`;
  const detailRes = await fetch(detailUrl, { headers: authHeaders(accessToken, orgId) });
  const detailData = await detailRes.json();
  if (detailData.code !== 0 || !detailData.item) {
    throw new Error(`Zoho item fetch failed: ${detailData.message ?? 'unknown error'}`);
  }
  return detailData.item;
}

async function putZohoItemUpdate(accessToken, orgId, itemId, updateBody) {
  const putUrl = `${ZOHO_API_BASE}/items/${itemId}`;
  const params = new URLSearchParams();
  params.set('organization_id', orgId);
  params.set('JSONString', JSON.stringify(updateBody));

  const response = await fetch(putUrl, {
    method: 'PUT',
    headers: {
      Authorization: `Zoho-oauthtoken ${accessToken}`,
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
    },
    body: params.toString(),
  });

  const payload = await response.json();
  if (payload.code !== 0) {
    throw new Error(payload.message || 'Zoho item update failed');
  }
}

/** Assign Zoho item category — India org requires label_rate (MRP) on PUT. */
export async function moveProductToCategory(accessToken, orgId, itemId, categoryId) {
  const item = await fetchZohoItemForUpdate(accessToken, orgId, itemId);
  await putZohoItemUpdate(accessToken, orgId, itemId, {
    category_id: categoryId,
    label_rate: resolveLabelRate(item),
  });
}

/** Mark a Zoho inventory item active or inactive — India org requires label_rate on PUT. */
export async function setProductStatus(accessToken, orgId, itemId, status) {
  const normalized = String(status ?? '').trim().toLowerCase();
  if (normalized !== 'active' && normalized !== 'inactive') {
    throw new Error('status must be active or inactive');
  }

  const item = await fetchZohoItemForUpdate(accessToken, orgId, itemId);
  const body = {
    status: normalized,
    label_rate: resolveLabelRate(item),
  };
  const categoryId = normaliseCategoryId(item.category_id);
  if (categoryId) body.category_id = categoryId;

  await putZohoItemUpdate(accessToken, orgId, itemId, body);
}

/** Update item name, SKU, and optional rate on Zoho — India org requires label_rate on PUT. */
export async function updateProductDetails(accessToken, orgId, itemId, input) {
  const name = String(input?.name ?? '').trim();
  const sku = String(input?.sku ?? '').trim();
  if (!name) throw new Error('Item name is required.');
  if (!sku) throw new Error('Item SKU is required.');

  const item = await fetchZohoItemForUpdate(accessToken, orgId, itemId);
  const body = {
    name,
    sku,
  };

  let nextRate = null;
  if (input?.rate != null && input.rate !== '') {
    nextRate = Number(input.rate);
    if (!Number.isFinite(nextRate) || nextRate < 0) {
      throw new Error('Rate must be a valid number.');
    }
    nextRate = Math.round(nextRate * 100) / 100;
    body.rate = nextRate;
  }

  const overrideMrp = validPositiveRate(input?.labelRate ?? input?.mrpOverride);
  if (overrideMrp != null) {
    body.label_rate = overrideMrp;
  } else {
    body.label_rate = resolveLabelRate({
      ...item,
      ...(nextRate != null ? { rate: nextRate, sales_rate: nextRate } : {}),
    });
  }

  const categoryId = normaliseCategoryId(item.category_id);
  if (categoryId) body.category_id = categoryId;
  if (item.status) body.status = item.status;

  await putZohoItemUpdate(accessToken, orgId, itemId, body);
}
