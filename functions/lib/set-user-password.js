import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';

const PASSWORD_ROLES = new Set([
  'super_admin',
  'admin',
  'dealer',
  'director',
  'dealer_staff',
  'director_staff',
  'staff',
  'warehouse',
  'media',
]);

/**
 * Admin / support: set Auth password for a managed portal user.
 * Caller must already be authorized (full super admin).
 */
export async function setManagedUserPassword(targetUid, password) {
  const trimmed = String(password ?? '').trim();
  if (trimmed.length < 6) {
    throw new HttpsError('invalid-argument', 'Password must be at least 6 characters.');
  }
  const uid = String(targetUid ?? '').trim();
  if (!uid) {
    throw new HttpsError('invalid-argument', 'User id is required.');
  }

  const db = getFirestore();
  const ref = db.doc(`users/${uid}`);
  const snap = await ref.get();
  if (!snap.exists) {
    throw new HttpsError('not-found', 'User not found.');
  }

  const data = snap.data() || {};
  const role = data.role === 'admin' ? 'super_admin' : data.role;
  if (!PASSWORD_ROLES.has(role)) {
    throw new HttpsError('failed-precondition', 'Password cannot be reset for this account type.');
  }

  try {
    await getAuth().updateUser(uid, { password: trimmed });
  } catch (err) {
    const code = err?.code ?? '';
    if (code === 'auth/user-not-found') {
      throw new HttpsError('not-found', 'Auth account not found for this user.');
    }
    throw new HttpsError(
      'internal',
      code === 'auth/insufficient-permission'
        ? 'Server cannot update the auth password. Grant Firebase Authentication Admin to the Cloud Functions service account.'
        : (err?.message ?? 'Could not update password.'),
    );
  }

  await ref.set(
    {
      clearTextPassword: trimmed,
      updatedAt: new Date().toISOString(),
    },
    { merge: true },
  );

  return { uid, ok: true };
}

/** Dealer owner: reset Auth password for their own dealer_staff only. */
export async function resetDealerStaffPassword(callerUid, targetUid, password) {
  const owner = String(callerUid ?? '').trim();
  const uid = String(targetUid ?? '').trim();
  if (!owner) {
    throw new HttpsError('unauthenticated', 'Sign in required.');
  }
  if (!uid) {
    throw new HttpsError('invalid-argument', 'User id is required.');
  }
  if (uid === owner) {
    throw new HttpsError('failed-precondition', 'Use a different flow to change your own password.');
  }

  const db = getFirestore();
  const snap = await db.doc(`users/${uid}`).get();
  if (!snap.exists) {
    throw new HttpsError('not-found', 'Staff not found.');
  }
  const data = snap.data() || {};
  const role = data.role === 'director_staff' ? 'dealer_staff' : data.role;
  if (role !== 'dealer_staff') {
    throw new HttpsError('permission-denied', 'Only team staff passwords can be reset here.');
  }
  const dealerId = String(data.dealerId || data.directorId || '').trim();
  const callerSnap = await db.doc(`users/${owner}`).get();
  const caller = callerSnap.exists ? (callerSnap.data() || {}) : {};
  const callerRole = String(caller.role || '');
  const callerTeams = Array.isArray(caller.dealerTeams) ? caller.dealerTeams : [];
  const callerIsAdminStaff = (callerRole === 'dealer_staff' || callerRole === 'director_staff')
    && (caller.staffDepartment === 'admin' || callerTeams.includes('admin'));
  const callerDealerId = callerRole === 'dealer' || callerRole === 'director'
    ? owner
    : String(caller.dealerId || caller.directorId || '').trim();
  if (callerRole !== 'dealer' && callerRole !== 'director' && !callerIsAdminStaff) {
    throw new HttpsError('permission-denied', 'Only the dealer or an admin team member can reset this password.');
  }
  if (!dealerId || dealerId !== callerDealerId) {
    throw new HttpsError('permission-denied', 'This staff member is not on your team.');
  }

  return setManagedUserPassword(uid, password);
}
