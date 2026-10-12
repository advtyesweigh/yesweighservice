/** QC marks a machine for dealer back-bill / customer-invoice PDF. It does not change the unit rate. */

const MACHINE_QC_CATEGORIES = new Set([
  'WEIGHING SCALE IMPORT',
  'BILL PRINTING SCALES',
  'BILL PRINTING SCALE',
]);

export const MACHINE_QC_BACK_BILL_NOTE = '(back bill it)';

const LEGACY_QC_FEE_NOTE_RE = /\n?QC:\s*₹[\d,.]+\s*per machine/gi;
const BACK_BILL_NOTE_RE = /\n?\(back bill it\)/gi;

export function normalizeCategoryName(categoryName: string | null | undefined): string {
  return String(categoryName ?? '').trim().replace(/\s+/g, ' ').toUpperCase();
}

export function machineQcFeeForCategory(_categoryName?: string | null): number {
  return 0;
}

export function productHasMachineQc(
  product: { categoryName?: string | null } | null | undefined,
): boolean {
  return MACHINE_QC_CATEGORIES.has(normalizeCategoryName(product?.categoryName));
}

export function lineSupportsDealerInvoicePdf(
  line: { qcEnabled?: boolean | null; categoryName?: string | null } | null | undefined,
  catalog?: { categoryName?: string | null } | null,
): boolean {
  if (line?.qcEnabled === true) return true;
  return productHasMachineQc(line) || productHasMachineQc(catalog);
}

export function resolveMachineQc(
  categoryName: string | null | undefined,
  qcEnabled: boolean | null | undefined,
): { qcEnabled: boolean; qcFeePerUnit: number } {
  if (!qcEnabled || !productHasMachineQc({ categoryName })) {
    return { qcEnabled: false, qcFeePerUnit: 0 };
  }
  return { qcEnabled: true, qcFeePerUnit: 0 };
}

export function stripMachineQcDescription(description: string | null | undefined): string {
  return String(description ?? '')
    .replace(LEGACY_QC_FEE_NOTE_RE, '')
    .replace(BACK_BILL_NOTE_RE, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function appendMachineQcDescription(
  description: string | null | undefined,
  input: { qcEnabled?: boolean | null; qcFeePerUnit?: number | null } = {},
): string | null {
  const base = stripMachineQcDescription(description);
  if (!input.qcEnabled) return base || null;
  if (base.includes(MACHINE_QC_BACK_BILL_NOTE)) return base;
  return base ? `${base}\n${MACHINE_QC_BACK_BILL_NOTE}` : MACHINE_QC_BACK_BILL_NOTE;
}

/** True when any order/cart line has QC ticked (unlocks dealer customer-invoice PDF). */
export function linesHaveMachineQc(
  lines: Array<{ qcEnabled?: boolean | null; qcFeePerUnit?: number | null } | null | undefined> | null | undefined,
): boolean {
  return (lines ?? []).some(
    line => line?.qcEnabled === true || Number(line?.qcFeePerUnit) > 0,
  );
}
