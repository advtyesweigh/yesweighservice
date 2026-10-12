/**
 * Extra QC fee per machine for dealer/staff sales-order lines.
 * Fee is rolled into the product unit rate (no separate Zoho line).
 */

const MACHINE_QC_FEES = {
  'WEIGHING SCALE IMPORT': 50,
  'BILL PRINTING SCALES': 150,
  'BILL PRINTING SCALE': 150,
};

export const MACHINE_QC_BACK_BILL_NOTE = '(back bill it)';

const LEGACY_QC_FEE_NOTE_RE = /\n?QC:\s*₹[\d,.]+\s*per machine/gi;
const BACK_BILL_NOTE_RE = /\n?\(back bill it\)/gi;

export function normalizeCategoryName(categoryName) {
  return String(categoryName ?? '').trim().replace(/\s+/g, ' ').toUpperCase();
}

export function machineQcFeeForCategory(categoryName) {
  const fee = MACHINE_QC_FEES[normalizeCategoryName(categoryName)];
  return Number.isFinite(fee) && fee > 0 ? fee : 0;
}

export function productHasMachineQc(product) {
  return machineQcFeeForCategory(product?.categoryName) > 0;
}

export function parseQcEnabled(value) {
  return value === true || value === 'true' || value === 1 || value === '1';
}

/**
 * @returns {{ qcEnabled: boolean, qcFeePerUnit: number }}
 */
export function resolveMachineQc(product, qcEnabled) {
  const fee = machineQcFeeForCategory(product?.categoryName);
  if (!parseQcEnabled(qcEnabled) || fee <= 0) {
    return { qcEnabled: false, qcFeePerUnit: 0 };
  }
  return { qcEnabled: true, qcFeePerUnit: fee };
}

export function stripBackBillNote(description) {
  const next = String(description ?? '')
    .replace(BACK_BILL_NOTE_RE, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return next || null;
}

export function stripMachineQcDescription(description) {
  return String(description ?? '')
    .replace(LEGACY_QC_FEE_NOTE_RE, '')
    .replace(BACK_BILL_NOTE_RE, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function appendMachineQcDescription(description, {
  qcEnabled = false,
  qcFeePerUnit = 0,
} = {}) {
  const base = stripMachineQcDescription(description);
  if (!qcEnabled) return base || null;
  const fee = Number(qcFeePerUnit) || 0;
  if (fee <= 0) return base || null;
  const amount = fee.toLocaleString('en-IN', { maximumFractionDigits: 2 });
  const note = `QC: ₹${amount} per machine`;
  if (base.includes(note) || /\bQC:/i.test(base)) return base || null;
  return base ? `${base}\n${note}` : note;
}
