/**
 * Kotak uncategorised bank feeds from Zoho Books/Inventory banking.
 * Stored at kotakBankFeeds/{transactionId}.
 */
import { getFirestore } from 'firebase-admin/firestore';
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

const ZOHO_BOOKS_API_BASE = 'https://www.zohoapis.in/books/v3';
const COLLECTION = 'kotakBankFeeds';
const META_DOC = 'kotakBankFeedMeta/latest';

function isKotakName(...parts) {
  return parts.some(part => /kotak/i.test(String(part ?? '')));
}

async function zohoBankJson(accessToken, orgId, path, {
  method = 'GET',
  body,
  query = {},
  apiBase,
  jsonString = false,
} = {}) {
  const url = new URL(`${apiBase}${path}`);
  if (!url.searchParams.has('organization_id')) {
    url.searchParams.set('organization_id', orgId);
  }
  for (const [key, value] of Object.entries(query)) {
    if (value != null && String(value).trim() !== '') {
      url.searchParams.set(key, String(value));
    }
  }

  const sendBody = hasZohoJsonBody(body);
  const init = {
    method,
    headers: {
      ...authHeaders(accessToken, orgId),
      'X-com-zoho-books-organizationid': orgId,
    },
  };
  if (sendBody && jsonString) {
    init.headers['Content-Type'] = 'application/x-www-form-urlencoded';
    init.body = new URLSearchParams({ JSONString: JSON.stringify(body) }).toString();
  } else if (sendBody) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }

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
    const message = String(payload?.message ?? classified?.message ?? `Zoho banking request failed (${res.status}).`);
    const err = new Error(message);
    err.status = res.status;
    throw err;
  }
  if (payload?.code !== undefined && payload.code !== 0) {
    throw new Error(String(payload.message || 'Zoho banking API error.'));
  }
  return payload;
}

async function zohoBankJsonWithFallback(accessToken, orgId, path, options = {}) {
  try {
    return await zohoBankJson(accessToken, orgId, path, {
      ...options,
      apiBase: ZOHO_BOOKS_API_BASE,
    });
  } catch (err) {
    const status = Number(err?.status) || 0;
    const msg = String(err?.message || '');
    if (status !== 404 && !/invalid url|unknown url|not found/i.test(msg)) {
      throw err;
    }
    return zohoBankJson(accessToken, orgId, path, {
      ...options,
      apiBase: ZOHO_API_BASE,
    });
  }
}

function valueHasClock(value) {
  const text = String(value || '').trim();
  if (!text) return false;
  return /T\d{2}:\d{2}/.test(text)
    || /^\d{1,2}:\d{2}/.test(text)
    || /\s\d{1,2}:\d{2}/.test(text);
}

function pickPostedTime(raw, keyHint = '') {
  if (raw == null) return null;
  if (typeof raw !== 'object') {
    if (/last_modified|created_time|updated_time/i.test(keyHint)) return null;
    return valueHasClock(raw) ? String(raw).trim() : null;
  }
  if (Array.isArray(raw)) {
    for (const item of raw) {
      const found = pickPostedTime(item);
      if (found) return found;
    }
    return null;
  }
  const preferred = [
    raw.time,
    raw.transaction_time,
    raw.entry_time,
    raw.posted_time,
    raw.value_time,
    raw.txn_time,
    raw.date,
  ];
  for (const candidate of preferred) {
    if (valueHasClock(candidate)) return String(candidate).trim();
  }
  for (const [key, value] of Object.entries(raw)) {
    if (/last_modified|created_time|updated_time/i.test(key)) continue;
    const found = pickPostedTime(value, key);
    if (found) return found;
  }
  return null;
}

function mapFeed(raw, account) {
  const transactionId = String(raw?.transaction_id ?? raw?.imported_transaction_id ?? '').trim();
  const amount = Number(raw?.amount ?? 0);
  const debitOrCredit = String(raw?.debit_or_credit ?? '').trim().toLowerCase() || null;
  return {
    transactionId,
    date: raw?.date ? String(raw.date) : null,
    postedTime: pickPostedTime(raw),
    amount: Number.isFinite(amount) ? amount : 0,
    debitOrCredit,
    transactionType: raw?.transaction_type != null
      ? String(raw.transaction_type).trim().toLowerCase()
      : null,
    payee: raw?.payee != null ? String(raw.payee) : null,
    description: raw?.description != null ? String(raw.description) : null,
    referenceNumber: raw?.reference_number != null ? String(raw.reference_number) : null,
    status: String(raw?.status ?? 'uncategorized'),
    accountId: String(raw?.account_id ?? account?.accountId ?? ''),
    accountName: String(raw?.account_name ?? account?.accountName ?? ''),
    bankName: String(account?.bankName ?? ''),
    importedTransactionId: raw?.imported_transaction_id != null
      ? String(raw.imported_transaction_id)
      : null,
  };
}

function zohoRecordId(value) {
  if (value == null) return '';
  return String(value).trim();
}

function isKotakCurrentAccount(row) {
  const name = String(row?.account_name ?? '');
  const number = String(row?.account_number ?? '');
  const partner = String(row?.partner_bank_source ?? '');
  if (partner === 'kotak_bank') return true;
  if (/kotak current/i.test(name)) return true;
  return /3712$/.test(number.replace(/\s/g, '')) && isKotakName(row?.bank_name, name);
}

async function listKotakAccounts(accessToken, orgId) {
  const payload = await zohoBankJsonWithFallback(accessToken, orgId, '/bankaccounts', {
    query: { filter_by: 'Status.Active' },
  });
  const rows = Array.isArray(payload.bankaccounts) ? payload.bankaccounts : [];
  const mapped = rows
    .filter(row => isKotakCurrentAccount(row) || isKotakName(row.bank_name, row.account_name, row.account_code, row.partner_bank_source))
    .map(row => ({
      accountId: zohoRecordId(row.account_id),
      accountName: String(row.account_name ?? ''),
      bankName: String(row.bank_name ?? 'Kotak'),
      accountNumber: String(row.account_number ?? ''),
      partnerBankSource: String(row.partner_bank_source ?? ''),
      lastRefreshDate: row.feeds_last_refresh_date != null ? String(row.feeds_last_refresh_date) : null,
      uncategorizedCount: Number(row.uncategorized_transactions ?? 0),
    }))
    .filter(row => row.accountId);

  const current = mapped.filter(row =>
    row.partnerBankSource === 'kotak_bank'
    || /kotak current/i.test(row.accountName)
    || /3712$/.test(row.accountNumber.replace(/\s/g, '')),
  );
  return current.length ? current : mapped;
}

async function refreshAccountFeeds(accessToken, orgId, account) {
  const accountId = zohoRecordId(account.accountId);
  const encoded = encodeURIComponent(accountId);
  const errors = [];

  try {
    const payload = await zohoBankJsonWithFallback(accessToken, orgId, `/bankaccounts/${encoded}`, {
      method: 'PUT',
      jsonString: true,
      body: {
        account_name: account.accountName || 'Kotak Current Account',
        refresh_feeds: true,
      },
    });
    return {
      ok: true,
      path: `/bankaccounts/${accountId}`,
      message: String(payload?.message || 'Refresh Feeds started for Kotak Current Account.'),
    };
  } catch (err) {
    errors.push(`PUT account: ${err?.message || err}`);
  }

  try {
    await zohoBankJsonWithFallback(accessToken, orgId, `/bankaccounts/${encoded}/balance`, {
      query: { refresh: 'true' },
    });
    await zohoBankJsonWithFallback(accessToken, orgId, `/bankaccounts/${encoded}/transactions`, {
      query: { per_page: 1 },
    });
    return {
      ok: true,
      path: `/bankaccounts/${accountId}/balance`,
      message: 'Asked Zoho Books to pull the latest Kotak Current Account balance and transactions.',
    };
  } catch (err) {
    errors.push(`balance/transactions: ${err?.message || err}`);
  }

  const message = errors.join(' | ') || 'Zoho Refresh Feeds failed.';
  console.warn(`Zoho Refresh Feeds failed for account ${accountId}: ${message}`);
  return { ok: false, path: null, message };
}

/**
 * Same as Zoho Books Banking → gear → Refresh Feeds for Kotak accounts.
 * Asks Zoho to pull new transactions from the bank. Does not wait for the feed.
 */
export async function refreshKotakBankFeedsInZoho(secrets, orgId) {
  if (!secrets) {
    throw new Error('Zoho credentials are not configured.');
  }
  const accessToken = await getAccessToken(secrets);
  const organizationId = await resolveOrganizationId(accessToken, orgId);
  const accounts = await listKotakAccounts(accessToken, organizationId);
  if (accounts.length === 0) {
    throw new Error('No Kotak bank account found in Zoho Banking.');
  }

  const results = [];
  for (const account of accounts) {
    const refreshed = await refreshAccountFeeds(accessToken, organizationId, account);
    results.push({
      accountId: account.accountId,
      accountName: account.accountName,
      ...refreshed,
    });
  }

  const okRows = results.filter(row => row.ok);
  if (okRows.length === 0) {
    throw new Error(results[0]?.message || 'Zoho could not refresh Kotak bank feeds.');
  }

  const names = okRows.map(row => row.accountName).filter(Boolean);
  const latest = await listKotakAccounts(accessToken, organizationId).catch(() => accounts);
  const uncategorizedCount = latest.reduce((sum, row) => sum + (Number(row.uncategorizedCount) || 0), 0);
  return {
    refreshed: true,
    accountNames: names,
    uncategorizedCount,
    lastRefreshDate: latest[0]?.lastRefreshDate ?? accounts[0]?.lastRefreshDate ?? null,
    lastZohoFeedRefresh: results,
    message: `Refresh Feeds started for ${names.join(', ') || 'Kotak Current Account'}. Zoho is pulling new transactions from the bank.`,
  };
}

/** Uncategorised transaction count for Kotak Current Account from Zoho Books. */
export async function getKotakBankFeedSummary(secrets, orgId) {
  if (!secrets) {
    throw new Error('Zoho credentials are not configured.');
  }
  const accessToken = await getAccessToken(secrets);
  const organizationId = await resolveOrganizationId(accessToken, orgId);
  const accounts = await listKotakAccounts(accessToken, organizationId);
  if (accounts.length === 0) {
    throw new Error('No Kotak bank account found in Zoho Banking.');
  }
  const uncategorizedCount = accounts.reduce((sum, row) => sum + (Number(row.uncategorizedCount) || 0), 0);
  return {
    uncategorizedCount,
    accountNames: accounts.map(row => row.accountName).filter(Boolean),
    lastRefreshDate: accounts[0]?.lastRefreshDate ?? null,
  };
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function listUncategorizedForAccount(accessToken, orgId, account) {
  const feeds = [];
  let page = 1;
  let hasMore = true;
  while (hasMore && page <= 20) {
    const payload = await zohoBankJsonWithFallback(accessToken, orgId, '/banktransactions', {
      query: {
        account_id: account.accountId,
        filter_by: 'Status.Uncategorized',
        per_page: 200,
        page,
        sort_column: 'date',
      },
    });
    const rows = Array.isArray(payload.banktransactions) ? payload.banktransactions : [];
    for (const row of rows) {
      const mapped = mapFeed(row, account);
      if (mapped.transactionId) feeds.push(mapped);
    }
    const ctx = payload.page_context || {};
    hasMore = Boolean(ctx.has_more_page);
    page += 1;
  }
  return feeds;
}

async function persistFeeds(feeds, source, extras = {}) {
  const db = getFirestore();
  const col = db.collection(COLLECTION);
  const existing = await col.get();
  const keep = new Set(feeds.map(feed => feed.transactionId));
  const fetchedAt = new Date().toISOString();

  const writes = [];
  for (const feed of feeds) {
    writes.push({
      ref: col.doc(feed.transactionId),
      data: {
        ...feed,
        fetchedAt,
        source,
      },
    });
  }
  const deletes = existing.docs.filter(doc => !keep.has(doc.id));

  const commitChunk = async (ops) => {
    const batch = db.batch();
    for (const op of ops) {
      if (op.delete) batch.delete(op.ref);
      else batch.set(op.ref, op.data, { merge: true });
    }
    await batch.commit();
  };

  const chunkSize = 400;
  for (let i = 0; i < writes.length; i += chunkSize) {
    await commitChunk(writes.slice(i, i + chunkSize).map(row => ({ ref: row.ref, data: row.data })));
  }
  for (let i = 0; i < deletes.length; i += chunkSize) {
    await commitChunk(deletes.slice(i, i + chunkSize).map(doc => ({ ref: doc.ref, delete: true })));
  }

  await db.doc(META_DOC).set({
    lastSyncedAt: fetchedAt,
    source,
    count: feeds.length,
    accountNames: [...new Set(feeds.map(feed => feed.accountName).filter(Boolean))],
    ...(extras && typeof extras === 'object' ? extras : {}),
  }, { merge: true });

  return { fetchedAt, count: feeds.length };
}

/**
 * Pull Kotak uncategorised bank feeds from Zoho and store them in Firestore.
 * @returns {{ feeds: object[], fetchedAt: string, count: number, accountNames: string[] }}
 */
export async function syncKotakUncategorizedFeeds(secrets, orgId, { source = 'manual', skipRefresh = false } = {}) {
  if (!secrets) {
    throw new Error('Zoho credentials are not configured.');
  }
  const accessToken = await getAccessToken(secrets);
  const organizationId = await resolveOrganizationId(accessToken, orgId);
  const accounts = await listKotakAccounts(accessToken, organizationId);
  if (accounts.length === 0) {
    throw new Error('No Kotak bank account found in Zoho Banking.');
  }

  const refreshResults = [];
  if (!skipRefresh) {
    for (const account of accounts) {
      const refreshed = await refreshAccountFeeds(accessToken, organizationId, account);
      refreshResults.push({
        accountId: account.accountId,
        accountName: account.accountName,
        ...refreshed,
      });
    }
    if (refreshResults.some(row => row.ok)) {
      // Zoho pulls from the bank asynchronously after Refresh Feeds.
      await sleep(5000);
    }
  }

  const feeds = [];
  for (const account of accounts) {
    const rows = await listUncategorizedForAccount(accessToken, organizationId, account);
    feeds.push(...rows);
  }

  const unique = [];
  const seen = new Set();
  for (const feed of feeds) {
    if (seen.has(feed.transactionId)) continue;
    seen.add(feed.transactionId);
    unique.push(feed);
  }
  unique.sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));

  const persisted = await persistFeeds(unique, source, skipRefresh ? {} : {
    lastZohoFeedRefreshAt: new Date().toISOString(),
    lastZohoFeedRefresh: refreshResults,
  });
  const withReservations = await overlayFeedReservations(unique);
  return {
    feeds: withReservations,
    fetchedAt: persisted.fetchedAt,
    count: withReservations.length,
    accountNames: accounts.map(account => account.accountName),
  };
}

export async function overlayFeedReservations(feeds) {
  const rows = Array.isArray(feeds) ? feeds : [];
  if (!rows.length) return rows;
  const snaps = await getFirestore().collection(COLLECTION).get();
  const reservedSo = new Map();
  const reservedPo = new Map();
  for (const doc of snaps.docs) {
    const data = doc.data() || {};
    const soId = String(data.reservedForSalesOrderId || '').trim();
    const poId = String(data.reservedForPurchaseOrderId || '').trim();
    if (soId) reservedSo.set(doc.id, soId);
    if (poId) reservedPo.set(doc.id, poId);
  }
  return rows.map(feed => ({
    ...feed,
    reservedForSalesOrderId: reservedSo.get(feed.transactionId) || null,
    reservedForPurchaseOrderId: reservedPo.get(feed.transactionId) || null,
  }));
}

function isBankCategorizeUrlError(err) {
  const msg = String(err?.message || '');
  const status = Number(err?.status) || 0;
  return status === 404
    || /invalid url|unknown url|not found|already categorized|already been categorized|not an uncategorized/i.test(msg);
}

function paymentAlreadyRecordedMessage(message) {
  return /already (been )?(recorded|applied|paid|exists)|duplicate|reference number.*(exist|used)/i.test(
    String(message || ''),
  );
}

function categorizeCustomerPaymentPaths(id, accountId) {
  const encoded = encodeURIComponent(id);
  const paths = [
    `/banktransactions/uncategorized/${encoded}/categorize/customerpayments`,
    `/banktransactions/uncategorizeds/${encoded}/categorize/customerpayments`,
    `/banktransactions/${encoded}/categorize/customerpayments`,
  ];
  const account = String(accountId || '').trim();
  if (account) {
    paths.push(
      `/bankaccounts/${encodeURIComponent(account)}/uncategorized/${encoded}/categorize/customerpayments`,
    );
  }
  return paths;
}

/** Kotak partner-bank lines sometimes reject raw JSON and the flat uncategorized URL. */
async function postBankWrite(accessToken, orgId, path, body) {
  const attempts = [
    { apiBase: ZOHO_BOOKS_API_BASE, jsonString: false },
    { apiBase: ZOHO_BOOKS_API_BASE, jsonString: true },
    { apiBase: ZOHO_API_BASE, jsonString: false },
  ];
  let lastErr = null;
  for (const attempt of attempts) {
    try {
      return await zohoBankJson(accessToken, orgId, path, {
        method: 'POST',
        body,
        apiBase: attempt.apiBase,
        jsonString: attempt.jsonString,
      });
    } catch (err) {
      lastErr = err;
      if (!isBankCategorizeUrlError(err)) throw err;
    }
  }
  throw lastErr || new Error('Zoho banking request failed.');
}

async function loadInvoiceForBankPayment(accessToken, orgId, invoiceId) {
  const path = `/invoices/${encodeURIComponent(invoiceId)}`;
  for (const apiBase of [ZOHO_BOOKS_API_BASE, ZOHO_API_BASE]) {
    try {
      const payload = await zohoBankJson(accessToken, orgId, path, { apiBase });
      if (payload?.invoice) return payload.invoice;
    } catch (err) {
      if (!isBankCategorizeUrlError(err) && apiBase === ZOHO_API_BASE) return null;
    }
  }
  return null;
}

function paymentAlreadyOnInvoice(invoice, reference) {
  if (!invoice || typeof invoice !== 'object') return null;
  const status = String(invoice.status || '').toLowerCase().replace(/\s+/g, '_');
  const balance = Number(invoice.balance);
  const total = Number(invoice.total);
  const ref = String(reference || '').trim().toLowerCase();
  const payments = Array.isArray(invoice.payments) ? invoice.payments : [];
  const matched = ref
    ? payments.find(row => String(row?.reference_number || '').trim().toLowerCase() === ref)
    : null;
  if (matched) {
    const paid = Number(matched.amount ?? matched.amount_applied);
    if (Number.isFinite(paid) && paid > 0) return paid;
    if (Number.isFinite(total) && total > 0) return total;
  }
  const settled = status === 'paid'
    || (Number.isFinite(balance) && balance <= 0.01 && Number.isFinite(total) && total > 0);
  if (settled) return Number.isFinite(total) && total > 0 ? total : null;
  return null;
}

function paymentModeFromFeed(feed) {
  const text = `${feed?.payee || ''} ${feed?.description || ''} ${feed?.referenceNumber || ''}`.toLowerCase();
  if (/\bupi\b/.test(text)) return 'UPI';
  if (/\bneft\b/.test(text)) return 'NEFT';
  if (/\brtgs\b/.test(text)) return 'RTGS';
  if (/\bimps\b/.test(text)) return 'IMPS';
  return 'Bank Transfer';
}

function feedDateYmd(feed) {
  const raw = String(feed?.date || '').trim();
  const match = raw.match(/^(\d{4}-\d{2}-\d{2})/);
  if (match) return match[1];
  const parsed = new Date(raw);
  if (!Number.isNaN(parsed.getTime())) return parsed.toISOString().slice(0, 10);
  return new Date().toISOString().slice(0, 10);
}

/**
 * Categorize a reserved Kotak pay-in as a customer payment on the Zoho invoice
 * so the invoice is marked paid.
 */
export async function applyReservedKotakFeedToInvoice(secrets, orgId, {
  feed,
  customerId,
  invoiceId,
  invoiceTotal,
}) {
  const transactionId = String(feed?.transactionId || '').trim();
  const accountId = String(feed?.accountId || '').trim();
  const contactId = String(customerId || '').trim();
  const invId = String(invoiceId || '').trim();
  if (!transactionId || !accountId || !contactId || !invId) {
    throw new Error('Bank pay-in, customer, and invoice are required to mark the invoice paid.');
  }

  const amount = Number(feed?.amount);
  const total = Number(invoiceTotal);
  const payable = Number.isFinite(total) && total > 0 ? total : amount;
  const applied = Math.min(
    Number.isFinite(amount) && amount > 0 ? amount : payable,
    payable,
  );
  if (!(applied > 0)) {
    throw new Error('Bank pay-in amount is missing.');
  }

  const body = {
    customer_id: contactId,
    account_id: accountId,
    amount: Number.isFinite(amount) && amount > 0 ? amount : applied,
    date: feedDateYmd(feed),
    payment_mode: paymentModeFromFeed(feed),
    reference_number: String(feed?.referenceNumber || transactionId).slice(0, 50),
    description: String(feed?.description || feed?.payee || 'Kotak pay-in').slice(0, 250),
    invoices: [
      {
        invoice_id: invId,
        amount_applied: applied,
      },
    ],
  };

  const accessToken = await getAccessToken(secrets);
  const organizationId = await resolveOrganizationId(accessToken, orgId);
  const ids = [...new Set([
    transactionId,
    String(feed?.importedTransactionId || '').trim(),
  ].filter(Boolean))];
  const paths = ids.flatMap(id => categorizeCustomerPaymentPaths(id, accountId));

  const postCategorize = async (path, payload) => {
    await postBankWrite(accessToken, organizationId, path, payload);
    return { amountApplied: applied, transactionId };
  };

  let lastErr = null;
  for (const path of paths) {
    try {
      return await postCategorize(path, body);
    } catch (err) {
      lastErr = err;
      const msg = String(err?.message || '');
      if (/payment_mode|payment mode/i.test(msg)) {
        try {
          const withoutMode = { ...body };
          delete withoutMode.payment_mode;
          return await postCategorize(path, withoutMode);
        } catch (retryErr) {
          lastErr = retryErr;
        }
      }
    }
  }

  // Already an SO + invoice in Zoho: the uncategorized categorize URL often
  // returns "Invalid URL Passed" because the Kotak line was already matched,
  // or because this partner-bank id is not on that route. Use the invoice.
  if (!isBankCategorizeUrlError(lastErr)) {
    throw new Error(String(lastErr?.message || 'Could not associate the Kotak pay-in with this invoice in Zoho.'));
  }

  const reference = body.reference_number;
  let invoice = await loadInvoiceForBankPayment(accessToken, organizationId, invId);
  const alreadyPaid = paymentAlreadyOnInvoice(invoice, reference);
  if (alreadyPaid != null) {
    return { amountApplied: alreadyPaid || applied, transactionId, alreadySettled: true };
  }

  const balance = Number(invoice?.balance);
  const amountApplied = Number.isFinite(balance) && balance > 0
    ? Math.min(applied, balance)
    : applied;
  const paymentAmount = Number.isFinite(amount) && amount > 0 ? amount : amountApplied;
  const paymentBodies = [
    {
      ...body,
      amount: paymentAmount,
      invoices: [{ invoice_id: invId, amount_applied: amountApplied }],
    },
    {
      ...body,
      amount: amountApplied,
      invoices: [{ invoice_id: invId, amount_applied: amountApplied }],
    },
  ];
  let paymentErr = lastErr;
  for (const paymentBody of paymentBodies) {
    try {
      await postBankWrite(accessToken, organizationId, '/customerpayments', paymentBody);
      return { amountApplied, transactionId };
    } catch (err) {
      paymentErr = err;
      if (/payment_mode|payment mode/i.test(String(err?.message || ''))) {
        try {
          const withoutMode = { ...paymentBody };
          delete withoutMode.payment_mode;
          await postBankWrite(accessToken, organizationId, '/customerpayments', withoutMode);
          return { amountApplied, transactionId };
        } catch (retryErr) {
          paymentErr = retryErr;
        }
      }
      const msg = String(paymentErr?.message || '');
      const tryingExcess = Number(paymentBody.amount) > amountApplied + 0.009;
      if (tryingExcess && /amount|balance|excess|applied/i.test(msg)) continue;
      if (!isBankCategorizeUrlError(paymentErr) && !paymentAlreadyRecordedMessage(msg)) break;
    }
  }

  invoice = await loadInvoiceForBankPayment(accessToken, organizationId, invId);
  const settledAfter = paymentAlreadyOnInvoice(invoice, reference);
  if (settledAfter != null || paymentAlreadyRecordedMessage(paymentErr?.message)) {
    return {
      amountApplied: settledAfter || amountApplied,
      transactionId,
      alreadySettled: true,
    };
  }

  throw new Error(String(
    paymentErr?.message
    || lastErr?.message
    || 'Could not associate the Kotak pay-in with this invoice in Zoho.',
  ));
}

function money2(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100) / 100;
}

function vendorPaymentIdFromPayload(payload) {
  const raw = payload?.vendorpayment
    || payload?.vendorpayments
    || payload?.payment
    || payload?.banktransaction
    || payload?.banktransactions;
  const row = Array.isArray(raw) ? raw[0] : raw;
  if (!row || typeof row !== 'object') return null;
  const id = String(row.payment_id || row.vendorpayment_id || row.transaction_id || '').trim();
  return id || null;
}

function describeVendorAdvance(purchaseOrderNumber, amountUsd, rate) {
  const po = String(purchaseOrderNumber || '').trim();
  const usd = money2(amountUsd);
  const fx = money2(rate);
  return [
    po ? `Vendor advance ${po}` : 'Vendor advance',
    usd > 0 ? `$${usd.toFixed(2)}` : null,
    fx > 0 ? `@ ₹${fx.toFixed(2)}` : null,
  ].filter(Boolean).join(' · ').slice(0, 250);
}

/**
 * Categorize a reserved Kotak payout as a Zoho vendor advance.
 * USD amount + FX rate are stored on the payment; leftover INR is bank charges.
 */
export async function applyReservedKotakFeedAsVendorAdvance(secrets, orgId, {
  feed,
  vendorId,
  amountUsd,
  usdToInrRate,
  purchaseOrderNumber,
}) {
  const transactionId = String(feed?.transactionId || '').trim();
  const accountId = String(feed?.accountId || '').trim();
  const contactId = String(vendorId || '').trim();
  if (!transactionId || !accountId || !contactId) {
    throw new Error('Bank payout, Kotak account, and vendor are required to mark this paid in Zoho.');
  }

  const amountInr = money2(feed?.amount);
  const usd = money2(amountUsd);
  const rate = Math.round(Number(usdToInrRate) * 10000) / 10000;
  if (!(usd > 0)) throw new Error('Enter a USD amount.');
  if (!(rate > 0)) throw new Error('Exchange rate is missing.');
  if (!(amountInr > 0)) throw new Error('Bank payout amount is missing.');

  const expectedInr = money2(usd * rate);
  const bankCharges = money2(Math.max(0, amountInr - expectedInr));

  const base = {
    vendor_id: contactId,
    date: feedDateYmd(feed),
    payment_mode: paymentModeFromFeed(feed),
    reference_number: String(feed?.referenceNumber || transactionId).slice(0, 50),
    description: describeVendorAdvance(purchaseOrderNumber, usd, rate),
    paid_through_account_id: accountId,
    account_id: accountId,
  };

  const bodies = [
    {
      ...base,
      amount: usd,
      exchange_rate: rate,
      bank_charges: bankCharges,
      bills: [],
    },
    {
      ...base,
      amount: usd,
      exchange_rate: rate,
      bank_charges: bankCharges,
    },
    {
      ...base,
      amount: amountInr,
      exchange_rate: rate,
      bank_charges: bankCharges,
      bills: [],
    },
    {
      ...base,
      amount: amountInr,
      bills: [],
    },
  ];

  const accessToken = await getAccessToken(secrets);
  const organizationId = await resolveOrganizationId(accessToken, orgId);
  const ids = [...new Set([
    transactionId,
    String(feed?.importedTransactionId || '').trim(),
  ].filter(Boolean))];
  const paths = ids.flatMap(id => ([
    `/banktransactions/uncategorized/${encodeURIComponent(id)}/categorize/vendorpayments`,
    `/banktransactions/uncategorizeds/${encodeURIComponent(id)}/categorize/vendorpayments`,
  ]));

  let lastErr = null;
  for (const path of paths) {
    for (const body of bodies) {
      const attempts = [body];
      if (body.payment_mode) {
        const withoutMode = { ...body };
        delete withoutMode.payment_mode;
        attempts.push(withoutMode);
      }
      for (const attempt of attempts) {
        try {
          const payload = await zohoBankJsonWithFallback(accessToken, organizationId, path, {
            method: 'POST',
            body: attempt,
          });
          return {
            amountUsd: usd,
            usdToInrRate: rate,
            amountInr,
            bankCharges,
            transactionId,
            zohoVendorPaymentId: vendorPaymentIdFromPayload(payload),
          };
        } catch (err) {
          lastErr = err;
        }
      }
    }
  }
  throw new Error(String(lastErr?.message || 'Could not mark this Kotak payout as a vendor advance in Zoho.'));
}
