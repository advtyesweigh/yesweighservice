/** Extra QC fee per machine, rolled into the product unit rate. */

const MACHINE_QC_FEES: Record<string, number> = {
  'WEIGHING SCALE IMPORT': 50,
  'BILL PRINTING SCALES': 150,
  'BILL PRINTING SCALE': 150,
};

export const MACHINE_QC_BACK_BILL_NOTE = '(back bill it)';

const LEGACY_QC_FEE_NOTE_RE = /\n?QC:\s*₹[\d,.]+\s*per machine/gi;
const BACK_BILL_NOTE_RE = /\n?\(back bill it\)/gi;

export function normalizeCategoryName(categoryName: string | null | undefined): string {
  return String(categoryName ?? '').trim().replace(/\s+/g, ' ').toUpperCase();
}

export function machineQcFeeForCategory(categoryName?: string | null): number {
  const fee = MACHINE_QC_FEES[normalizeCategoryName(categoryName)];
  return Number.isFinite(fee) && fee > 0 ? fee : 0;
}

export function productHasMachineQc(
  product: { categoryName?: string | null } | null | undefined,
): boolean {
  return machineQcFeeForCategory(product?.categoryName) > 0;
}

export function resolveMachineQc(
  categoryName: string | null | undefined,
  qcEnabled: boolean | null | undefined,
): { qcEnabled: boolean; qcFeePerUnit: number } {
  const fee = machineQcFeeForCategory(categoryName);
  if (!qcEnabled || fee <= 0) {
    return { qcEnabled: false, qcFeePerUnit: 0 };
  }
  return { qcEnabled: true, qcFeePerUnit: fee };
}

export function stripBackBillNote(description: string | null | undefined): string | null {
  const next = String(description ?? '')
    .replace(BACK_BILL_NOTE_RE, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return next || null;
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
  const fee = Number(input.qcFeePerUnit) || 0;
  if (fee <= 0) return base || null;
  const amount = fee.toLocaleString('en-IN', { maximumFractionDigits: 2 });
  const note = `QC: ₹${amount} per machine`;
  if (base.includes(note) || /\bQC:/i.test(base)) return base || null;
  return base ? `${base}\n${note}` : note;
}

/** True when any order/cart line has QC ticked (unlocks dealer customer-invoice PDF). */
export function linesHaveMachineQc(
  lines: Array<{ qcEnabled?: boolean | null; qcFeePerUnit?: number | null } | null | undefined> | null | undefined,
): boolean {
  return (lines ?? []).some(
    line => line?.qcEnabled === true || Number(line?.qcFeePerUnit) > 0,
  );
}

export function lineLooksLikeMachineQc(
  line?: {
    qcEnabled?: boolean | null;
    qcFeePerUnit?: number | null;
    description?: string | null;
    categoryName?: string | null;
  } | null,
): boolean {
  if (!line) return false;
  return line.qcEnabled === true || Number(line.qcFeePerUnit) > 0;
}

/** Dealer invoice PDF and the "QC requested" label apply only after QC is ticked. */
export function lineSupportsDealerInvoicePdf(
  line: {
    qcEnabled?: boolean | null;
    qcFeePerUnit?: number | null;
    description?: string | null;
  } | null | undefined,
): boolean {
  return lineLooksLikeMachineQc(line);
}

/** QC photos and the QC label follow an explicit tick or fee on a line. */
export function documentLooksLikeMachineQc(input?: {
  qcRequested?: boolean | null;
  dealerCustomerInvoice?: { url?: string | null; storagePath?: string | null } | null;
  lineItems?: Array<{
    qcEnabled?: boolean | null;
    qcFeePerUnit?: number | null;
    description?: string | null;
  } | null | undefined> | null;
} | null): boolean {
  if (!input) return false;
  return (input.lineItems ?? []).some(lineLooksLikeMachineQc);
}
