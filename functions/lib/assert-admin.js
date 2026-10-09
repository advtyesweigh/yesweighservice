import { getFirestore } from 'firebase-admin/firestore';

export async function assertSignedInUser(uid) {
  if (!uid) {
    const err = new Error('Sign in required.');
    err.code = 'unauthenticated';
    throw err;
  }
  const snap = await getFirestore().doc(`users/${uid}`).get();
  const data = snap.data() ?? {};
  if (!snap.exists || data.active === false) {
    const err = new Error('Active account required.');
    err.code = 'permission-denied';
    throw err;
  }
  return {
    uid,
    role: String(data.role ?? ''),
    displayName: String(data.displayName ?? data.name ?? '').trim() || null,
    name: String(data.name ?? data.displayName ?? '').trim() || null,
    email: String(data.email ?? '').trim() || null,
  };
}

export async function assertSalesOrAdmin(uid) {
  const user = await assertSignedInUser(uid);
  if (user.role !== 'super_admin') {
    const err = new Error('Admin access required.');
    err.code = 'permission-denied';
    throw err;
  }
  return user;
}
