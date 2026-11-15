/**
 * Merge ELMASS SYSTEMS & SERVICES → ELMASS' Weighing & Automation Pvt. Ltd
 *
 * Prefers firebase-admin (ADC / service account). Falls back to client Auth +
 * setDealerSetting callable (server folds invoiceDealerStats when functions
 * include the dealer_sales_merges side-effect).
 *
 *   node scripts/merge-elmass-dealers.mjs
 *   node scripts/merge-elmass-dealers.mjs YesWeigh@2026
 */

import { createRequire } from 'node:module';
import { initializeApp as initClient } from 'firebase/app';
import { getAuth, signInWithEmailAndPassword, signOut } from 'firebase/auth';
import { getFunctions, httpsCallable } from 'firebase/functions';
import {
  getFirestore as getClientFirestore,
  collection,
  getDocs,
  doc,
  getDoc,
} from 'firebase/firestore';

const require = createRequire(new URL('../functions/package.json', import.meta.url));

const PROJECT = 'yesweigh-service';
const KEEP_ID = '99381000005074017';
const OLD_ID = '99381000000084733';
const KEEP_NAME = "ELMASS' Weighing & Automation Pvt. Ltd";
const OLD_NAME = 'ELMASS SYSTEMS & SERVICES';
const PASSWORD = process.argv[2] ?? 'YesWeigh@2026';

const firebaseConfig = {
  apiKey: 'AIzaSyBiLI--JR640YlXb2uiuBrLJ83XtFMPncE',
  authDomain: 'yesweigh-service.firebaseapp.com',
  projectId: PROJECT,
  storageBucket: 'yesweigh-service.firebasestorage.app',
  messagingSenderId: '108990753929',
  appId: '1:108990753929:web:564393f84ecd0347c3aa58',
};

function sumCategoryMap(a = {}, b = {}) {
  const next = { ...a };
  for (const [key, raw] of Object.entries(b || {})) {
    const amount = Number(raw ?? 0);
    if (!Number.isFinite(amount) || amount === 0) continue;
    next[key] = Number(next[key] ?? 0) + amount;
  }
  return next;
}

async function mergeViaAdmin() {
  const { initializeApp, applicationDefault, getApps } = require('firebase-admin/app');
  const { getFirestore, FieldValue } = require('firebase-admin/firestore');
  if (!getApps().length) {
    initializeApp({ credential: applicationDefault(), projectId: PROJECT });
  }
  const db = getFirestore();
  const results = [];
  for (const collectionId of ['invoiceDealerStats', 'salesOrderDealerStats']) {
    const fromRef = db.collection(collectionId).doc(OLD_ID);
    const toRef = db.collection(collectionId).doc(KEEP_ID);
    const [fromSnap, toSnap] = await Promise.all([fromRef.get(), toRef.get()]);
    if (!fromSnap.exists) {
      results.push({ collectionId, action: 'skip_missing_from' });
      continue;
    }
    const from = fromSnap.data() || {};
    const to = toSnap.exists ? (toSnap.data() || {}) : {};
    const fromDate = String(from.latestDate ?? '');
    const toDate = String(to.latestDate ?? '');
    const latestDate = !toDate
      ? (from.latestDate ?? null)
      : !fromDate
        ? (to.latestDate ?? null)
        : fromDate > toDate
          ? from.latestDate
          : to.latestDate;
    await toRef.set({
      customerId: KEEP_ID,
      customerName: KEEP_NAME,
      count: Number(to.count ?? 0) + Number(from.count ?? 0),
      amount: Number(to.amount ?? 0) + Number(from.amount ?? 0),
      total: Number(to.total ?? 0) + Number(from.total ?? 0),
      balance: Number(to.balance ?? 0) + Number(from.balance ?? 0),
      itemQuantity: (to.itemQuantity != null || from.itemQuantity != null)
        ? Number(to.itemQuantity ?? 0) + Number(from.itemQuantity ?? 0)
        : null,
      byCategory: sumCategoryMap(to.byCategory, from.byCategory),
      amountByCategory: sumCategoryMap(to.amountByCategory, from.amountByCategory),
      documentAmountByCategory: sumCategoryMap(
        to.documentAmountByCategory,
        from.documentAmountByCategory,
      ),
      latestDate,
      updatedAt: FieldValue.serverTimestamp(),
      mergedFromCustomerIds: FieldValue.arrayUnion(OLD_ID),
      mergedAt: new Date().toISOString(),
    }, { merge: true });
    await fromRef.delete();
    results.push({
      collectionId,
      action: 'merged',
      keepTotal: Number(to.total ?? 0) + Number(from.total ?? 0),
      keepAmount: Number(to.amount ?? 0) + Number(from.amount ?? 0),
    });
  }
  await db.collection('zohoCustomers').doc(OLD_ID).set({
    isFiltered: true,
    filterReason: 'Manual',
    dealerStage: 'Non Active',
    mergedIntoCustomerId: KEEP_ID,
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });
  await db.collection('dealerSettings').doc('dealer_sales_merges').set({
    value: {
      merges: [{
        fromCustomerId: OLD_ID,
        toCustomerId: KEEP_ID,
        fromName: OLD_NAME,
        toName: KEEP_NAME,
        reason: 'Same entity (phone 9846036922, Ernakulam/Kerala).',
        mergedAt: new Date().toISOString(),
      }],
    },
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });
  return { mode: 'admin', results };
}

async function mergeViaCallable() {
  const app = initClient(firebaseConfig);
  const auth = getAuth(app);
  await signInWithEmailAndPassword(auth, 'admin@yesweigh.in', PASSWORD);
  const functions = getFunctions(app, 'asia-south1');
  const setDealerSetting = httpsCallable(functions, 'setDealerSetting');
  const patchDealer = httpsCallable(functions, 'patchDealer');

  await patchDealer({
    id: OLD_ID,
    patch: {
      isFiltered: true,
      filterReason: 'Manual',
      dealerStage: 'Non Active',
    },
  });

  const saved = await setDealerSetting({
    key: 'dealer_sales_merges',
    value: {
      merges: [{
        fromCustomerId: OLD_ID,
        toCustomerId: KEEP_ID,
        fromName: OLD_NAME,
        toName: KEEP_NAME,
        reason: 'Same entity (phone 9846036922, Ernakulam/Kerala).',
        mergedAt: new Date().toISOString(),
      }],
    },
  });

  const db = getClientFirestore(app);
  const keep = (await getDoc(doc(db, 'invoiceDealerStats', KEEP_ID))).data();
  const old = (await getDoc(doc(db, 'invoiceDealerStats', OLD_ID))).data();
  const dealer = (await getDoc(doc(db, 'zohoCustomers', OLD_ID))).data();
  await signOut(auth);
  return {
    mode: 'callable',
    saved: saved.data,
    keepStats: keep ? { amount: keep.amount, total: keep.total, count: keep.count } : null,
    oldStats: old ? { amount: old.amount, total: old.total, count: old.count } : null,
    oldDealer: dealer ? {
      isFiltered: dealer.isFiltered,
      filterReason: dealer.filterReason,
    } : null,
  };
}

try {
  const adminResult = await mergeViaAdmin();
  console.log(JSON.stringify(adminResult, null, 2));
} catch (adminErr) {
  console.warn('Admin merge unavailable:', adminErr?.message || adminErr);
  const callableResult = await mergeViaCallable();
  console.log(JSON.stringify(callableResult, null, 2));
}
