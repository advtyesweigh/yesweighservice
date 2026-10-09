import { doc, getDoc, serverTimestamp, setDoc } from 'firebase/firestore';
import { getFunctions, httpsCallable } from 'firebase/functions';
import { PUBLIC_APP_ORIGIN } from '../constants/brand';
import { app, db } from '../firebase';
import type { DealerAddress } from './dealerAddress';
import type { GstinLookupDetails } from './dealers';

const SHARE_COLLECTION = 'dealerCreateShares';
const functions = getFunctions(app, 'asia-south1');

export type DealerCreateShareRecord = {
  token: string;
  waId: string;
  phone: string;
  status: 'open' | 'completed';
  companyName: string;
  dealerId: string;
};

export function createDealerShareToken(): string {
  const bytes = new Uint8Array(18);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

export function dealerCreateSharePublicPath(token: string): string {
  return `/s/dealer/${token}`;
}

export function dealerCreateSharePublicUrl(token: string): string {
  return `${PUBLIC_APP_ORIGIN.replace(/\/$/, '')}${dealerCreateSharePublicPath(token)}`;
}

export async function createDealerCreateShare(input: {
  waId: string;
  phone: string;
  createdByUid: string;
  createdByName?: string;
}): Promise<string> {
  try {
    const fn = httpsCallable<
      { waId: string; phone: string },
      { token?: string }
    >(functions, 'createDealerCreateShareFn', { timeout: 30_000 });
    const result = await fn({
      waId: String(input.waId || '').trim(),
      phone: String(input.phone || '').replace(/\D/g, '').slice(-10),
    });
    const token = String(result.data?.token || '').trim();
    if (token) return token;
  } catch (err) {
    const code = err && typeof err === 'object' && 'code' in err
      ? String((err as { code?: string }).code || '')
      : '';
    if (code && !/not-found|unimplemented/i.test(code)) {
      throw err;
    }
  }
  const token = createDealerShareToken();
  await setDoc(doc(db, SHARE_COLLECTION, token), {
    waId: String(input.waId || '').trim(),
    phone: String(input.phone || '').replace(/\D/g, '').slice(-10),
    createdByUid: String(input.createdByUid || '').trim(),
    createdByName: String(input.createdByName || '').trim(),
    status: 'open',
    createdAt: serverTimestamp(),
  });
  return token;
}

function mapShare(token: string, data: Record<string, unknown>): DealerCreateShareRecord {
  return {
    token,
    waId: String(data.waId ?? ''),
    phone: String(data.phone ?? ''),
    status: String(data.status ?? 'open') === 'completed' ? 'completed' : 'open',
    companyName: String(data.companyName ?? ''),
    dealerId: String(data.dealerId ?? ''),
  };
}

export async function fetchDealerCreateShare(token: string): Promise<DealerCreateShareRecord | null> {
  const cleaned = token.trim();
  if (!cleaned) return null;
  try {
    const fn = httpsCallable<{ token: string }, DealerCreateShareRecord>(
      functions,
      'getDealerCreateShareFn',
      { timeout: 15_000 },
    );
    const result = await fn({ token: cleaned });
    if (result.data?.token) return mapShare(result.data.token, result.data as unknown as Record<string, unknown>);
  } catch (err) {
    const code = err && typeof err === 'object' && 'code' in err
      ? String((err as { code?: string }).code || '')
      : '';
    if (code && /not-found/i.test(code) && !/functions\/not-found/i.test(code)) {
      return null;
    }
  }
  const snap = await getDoc(doc(db, SHARE_COLLECTION, cleaned));
  if (!snap.exists()) return null;
  return mapShare(snap.id, snap.data() as Record<string, unknown>);
}

export async function publicFetchGstinDetails(token: string, gstin: string): Promise<GstinLookupDetails> {
  const fn = httpsCallable<{ token: string; gstin: string }, { details: GstinLookupDetails }>(
    functions,
    'publicFetchGstinDetails',
    { timeout: 45_000 },
  );
  const result = await fn({ token, gstin });
  return result.data.details;
}

export async function publicCreateDealerFromShare(input: {
  token: string;
  companyName: string;
  contactName?: string;
  phone?: string;
  email?: string;
  gstin?: string;
  gstTreatment?: string;
  legalName?: string;
  taxpayerType?: string;
  constitutionOfBusiness?: string;
  pan?: string;
  billing?: DealerAddress;
}): Promise<{ dealerId: string; companyName: string }> {
  const fn = httpsCallable<typeof input, { dealerId: string; companyName: string }>(
    functions,
    'publicCreateDealerFromShare',
    { timeout: 120_000 },
  );
  const result = await fn(input);
  return {
    dealerId: String(result.data.dealerId ?? ''),
    companyName: String(result.data.companyName ?? input.companyName),
  };
}
