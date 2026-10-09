/**
 * Sarvam AI key lives only on the server.
 * Prefer Cloud Functions env; Firestore aiAgent is a fallback. Never send to the browser.
 */
import { getFirestore } from 'firebase-admin/firestore';

export function sarvamApiKey() {
  return String(process.env.SARVAM_API_KEY || '').trim();
}

export function sarvamConfigured() {
  return Boolean(sarvamApiKey());
}

export async function loadSarvamApiKey() {
  const fromEnv = sarvamApiKey();
  if (fromEnv) return fromEnv;
  const snap = await getFirestore().doc('whatsappSettings/aiAgent').get();
  return String(snap.data()?.sarvamApiKey || '').trim();
}
