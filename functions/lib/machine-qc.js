/**
 * QC marks a machine for dealer back-bill / customer-invoice PDF.
 * It does not change the product unit rate.
 */

const MACHINE_QC_CATEGORIES = new Set([
  'WEIGHING SCALE IMPORT',
  'BILL PRINTING SCALES',
  'BILL PRINTING SCALE',
]);

export const MACHINE_QC_BACK_BILL_NOTE = '(back bill it)';

const LEGACY_QC_FEE_NOTE_RE = /\n?QC:\s*₹[\d,.]+\s*per machine/gi;
const BACK_BILL_NOTE_RE = /\n?\(back bill it\)/gi;

export function normalizeCategoryName(categoryName) {
  return String(categoryName ?? '').trim().replace(/\s+/g, ' ').toUpperCase();
}

export function machineQcFeeForCategory() {
  return 0;
}

export function productHasMachineQc(product) {
  return MACHINE_QC_CATEGORIES.has(normalizeCategoryName(product?.categoryName));
}

export function parseQcEnabled(value) {
  return value === true || value === 'true' || value === 1 || value === '1';
}

/**
 * @returns {{ qcEnabled: boolean, qcFeePerUnit: number }}
 */
export function resolveMachineQc(product, qcEnabled) {
  if (!parseQcEnabled(qcEnabled) || !productHasMachineQc(product)) {
    return { qcEnabled: false, qcFeePerUnit: 0 };
  }
  return { qcEnabled: true, qcFeePerUnit: 0 };
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
} = {}) {
  const base = stripMachineQcDescription(description);
  if (!qcEnabled) return base || null;
  if (base.includes(MACHINE_QC_BACK_BILL_NOTE)) return base;
  return base ? `${base}\n${MACHINE_QC_BACK_BILL_NOTE}` : MACHINE_QC_BACK_BILL_NOTE;
}
