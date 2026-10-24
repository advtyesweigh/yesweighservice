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
const MACHINE_QC_NOTE_RE = /QC:\s*₹\s*([\d,]+(?:\.\d+)?)\s*per machine/i;
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

/** Fee written by appendMachineQcDescription. This is the QC tick Zoho can store. */
export function parseMachineQcNote(description) {
  const match = String(description ?? '').match(MACHINE_QC_NOTE_RE);
  if (!match) return null;
  const fee = Number(String(match[1]).replace(/,/g, ''));
  if (!Number.isFinite(fee) || fee <= 0) return null;
  return { qcEnabled: true, qcFeePerUnit: Math.round(fee * 100) / 100 };
}

/**
 * Explicit tick/fee wins. Otherwise the `QC: ₹… per machine` note is the tick
 * that survived a Zoho round-trip (Zoho has no QC field).
 */
export function machineQcFieldsFromLine(line) {
  const noted = parseMachineQcNote(line?.description);
  const feeFlag = Number(line?.qcFeePerUnit);
  const flagged = line?.qcEnabled === true || (Number.isFinite(feeFlag) && feeFlag > 0);
  if (flagged) {
    const fee = feeFlag > 0 ? feeFlag : (noted?.qcFeePerUnit ?? 0);
    if (!(fee > 0)) return { qcEnabled: false, qcFeePerUnit: 0 };
    return { qcEnabled: true, qcFeePerUnit: Math.round(fee * 100) / 100 };
  }
  return noted ?? { qcEnabled: false, qcFeePerUnit: 0 };
}

export function lineWithMachineQcFields(line) {
  const qc = machineQcFieldsFromLine(line);
  if (!qc.qcEnabled) return line;
  return {
    ...line,
    qcEnabled: true,
    qcFeePerUnit: qc.qcFeePerUnit,
    description: appendMachineQcDescription(line?.description, qc),
  };
}

export function appendMachineQcDescription(description, {
  qcEnabled = false,
  qcFeePerUnit = 0,
} = {}) {
  const noted = parseMachineQcNote(description);
  const base = stripMachineQcDescription(description);
  if (!qcEnabled) return base || null;
  const explicit = Number(qcFeePerUnit);
  const fee = explicit > 0 ? explicit : (noted?.qcFeePerUnit ?? 0);
  if (!(fee > 0)) return base || null;
  const amount = fee.toLocaleString('en-IN', { maximumFractionDigits: 2 });
  const note = `QC: ₹${amount} per machine`;
  if (/\bQC:\s*₹/i.test(base)) return base || null;
  return base ? `${base}\n${note}` : note;
}

/**
 * Keep a prior tick when Zoho echoes the line without the QC sentence.
 * A different description is left alone so an intentional edit can clear QC.
 */
export function preserveMachineQcLines(incoming, previous) {
  const lines = Array.isArray(incoming) ? incoming : [];
  const prevLines = Array.isArray(previous) ? previous : [];
  if (!prevLines.length) return lines;
  const used = new Set();
  return lines.map(line => {
    if (machineQcFieldsFromLine(line).qcEnabled) return lineWithMachineQcFields(line);
    const itemId = String(line?.itemId || '');
    if (!itemId) return line;
    const idx = prevLines.findIndex((prev, i) => {
      if (used.has(i)) return false;
      if (String(prev?.itemId || '') !== itemId) return false;
      return machineQcFieldsFromLine(prev).qcEnabled;
    });
    if (idx < 0) return line;
    const prev = prevLines[idx];
    const incomingDesc = String(line?.description || '').trim();
    const prevBase = stripMachineQcDescription(prev?.description);
    const sameBody = !incomingDesc || incomingDesc === prevBase;
    if (!sameBody) return line;
    used.add(idx);
    const qc = machineQcFieldsFromLine(prev);
    return {
      ...line,
      qcEnabled: true,
      qcFeePerUnit: qc.qcFeePerUnit,
      description: appendMachineQcDescription(incomingDesc || prev.description, qc),
    };
  });
}

/**
 * Authoritative ticks from the lines we just created or edited.
 * A source line with QC off clears a stale note on that item.
 */
export function applySourceMachineQc(lines, sourceLines) {
  const mirrored = Array.isArray(lines) ? lines : [];
  const sources = Array.isArray(sourceLines) ? sourceLines : [];
  if (!sources.length) return mirrored.map(lineWithMachineQcFields);
  const used = new Set();
  return mirrored.map(line => {
    const itemId = String(line?.itemId || '');
    const idx = sources.findIndex((src, i) => {
      if (used.has(i)) return false;
      const srcId = String(src?.itemId || src?.productId || '');
      return Boolean(itemId) && srcId === itemId;
    });
    if (idx < 0) return lineWithMachineQcFields(line);
    used.add(idx);
    const src = sources[idx];
    const qc = machineQcFieldsFromLine(src);
    if (!qc.qcEnabled) {
      return {
        ...line,
        qcEnabled: false,
        qcFeePerUnit: 0,
        description: stripMachineQcDescription(line?.description) || null,
      };
    }
    return {
      ...line,
      qcEnabled: true,
      qcFeePerUnit: qc.qcFeePerUnit,
      description: appendMachineQcDescription(line?.description || src.description, qc),
    };
  });
}
