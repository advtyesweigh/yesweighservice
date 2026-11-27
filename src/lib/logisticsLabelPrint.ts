import {
  LOGISTICS_LABEL_GAP_MM,
  LOGISTICS_LABEL_HEIGHT_MM,
  LOGISTICS_LABEL_WIDTH_MM,
} from '../constants/localPrinterSettings';
import { LABEL_DPI, mmToDots } from './labelLayouts/units';
import {
  buildCanvasTsplBitmapJob,
} from './localPrinterLabelBitmap';
import {
  isLanPrintAvailable,
  logisticsLastHostStorageKey,
  pickReachablePrinter,
  sendRawToPrinter,
} from './localPrinterPrint';
import {
  getLabelMediaForUsage,
  getLogisticsLabelPrinter,
  loadLabelStudioDoc,
  printerHostCandidates,
} from './labelStudio';
import type { ShippingLabelViewModel } from './shippingLabel';
import { buildShippingLabelBitmapJob } from './shippingLabelBitmap';
import { SHIPPING_LABEL_HEADER_STYLES } from './shippingLabelHeader';

function escapeTspl(value: string): string {
  return value.replace(/"/g, "'").replace(/\r?\n/g, ' ').trim();
}

function wrapLines(value: string, maxLen: number, maxLines: number): string[] {
  const words = value.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (next.length <= maxLen) {
      current = next;
      continue;
    }
    if (current) lines.push(current);
    current = word.slice(0, maxLen);
    if (lines.length >= maxLines) break;
  }
  if (current && lines.length < maxLines) lines.push(current);
  while (lines.length < 1) lines.push('—');
  return lines.slice(0, maxLines);
}

/** Build TSPL for one 100×150 mm shipping label. */
export function buildShippingLabelTspl(
  label: ShippingLabelViewModel,
  media = getLabelMediaForUsage('logistics_shipping'),
): string {
  const width = media.labelWidthMm || LOGISTICS_LABEL_WIDTH_MM;
  const height = media.labelHeightMm || LOGISTICS_LABEL_HEIGHT_MM;
  const gap = media.labelGapMm || LOGISTICS_LABEL_GAP_MM;
  const fromLines = wrapLines(`${label.fromName} ${label.fromAddress}`, 28, 4);
  const toLines = wrapLines(`${label.toName} ${label.toAddress}`, 28, 4);
  const boxLabel = label.shipmentMode === 'envelope'
    ? '1/1'
    : `${label.boxIndex}/${label.boxTotal}`;
  const boxCount = label.shipmentMode === 'envelope' ? 'ENV' : String(label.numberOfBoxes);

  const lines = [
    `SIZE ${width} mm,${height} mm`,
    `GAP ${gap} mm,0`,
    'DIRECTION 1',
    'REFERENCE 0,0',
    'CLS',
    'TEXT 40,40,"3",0,1,1,"YESWEIGH"',
    'TEXT 320,48,"2",0,1,1,"GENUINE SPARE PART"',
    'BAR 40,90,720,3',
    'TEXT 40,110,"1",0,1,1,"FROM (SHIPPER)"',
    'TEXT 400,110,"1",0,1,1,"TO (CONSIGNEE)"',
    ...fromLines.map((line, i) => `TEXT 40,${140 + i * 28},"2",0,1,1,"${escapeTspl(line)}"`),
    ...toLines.map((line, i) => `TEXT 400,${140 + i * 28},"2",0,1,1,"${escapeTspl(line)}"`),
    'BAR 40,270,720,2',
    `TEXT 40,290,"1",0,1,1,"NUMBER OF BOXES"`,
    `TEXT 40,320,"3",0,1,1,"${escapeTspl(boxCount)}"`,
    `TEXT 400,290,"1",0,1,1,"BOX NUMBER"`,
    `TEXT 400,320,"3",0,1,1,"${escapeTspl(boxLabel)}"`,
    'BAR 40,370,720,2',
    'TEXT 40,390,"1",0,1,1,"GROSS WEIGHT"',
    `TEXT 40,420,"3",0,1,1,"${label.grossWeightKg.toFixed(2)} kg"`,
    'TEXT 400,390,"1",0,1,1,"CHARGEABLE WEIGHT"',
    `TEXT 400,420,"3",0,1,1,"${label.chargeableWeightKg.toFixed(2)} kg"`,
    'BAR 40,470,720,2',
    `TEXT 40,500,"2",0,1,1,"${escapeTspl(label.partnerLabel)}"`,
    `BARCODE 360,490,"128",80,1,0,2,4,"${escapeTspl(label.consignmentNo)}"`,
    `TEXT 360,590,"2",0,1,1,"${escapeTspl(label.consignmentNo)}"`,
    'BAR 40,640,720,3',
    'TEXT 40,660,"1",0,1,1,"DESTINATION CITY"',
    `TEXT 40,690,"3",0,1,1,"${escapeTspl(label.destinationCity)}"`,
    'TEXT 400,660,"1",0,1,1,"BOOKING BRANCH"',
    `TEXT 400,690,"2",0,1,1,"${escapeTspl(label.bookingBranch)}"`,
    'TEXT 400,740,"1",0,1,1,"BOOKING DATE"',
    `TEXT 400,770,"2",0,1,1,"${escapeTspl(label.bookingDate)}"`,
    'TEXT 400,810,"1",0,1,1,"BOOKING DATE"',
    `TEXT 400,840,"2",0,1,1,"${escapeTspl(label.bookingTime)}"`,
    'TEXT 400,880,"1",0,1,1,"BOOKED BY"',
    `TEXT 400,910,"2",0,1,1,"YESWEIGH"`,
    'PRINT 1,1',
  ];
  return `${lines.join('\r\n')}\r\n`;
}

export function buildCourierLabelTspl(input: {
  partnerLabel: string;
  consignmentNo: string;
  deliverToName: string;
  deliverToAddress: string;
  serviceType: string;
  branch: string;
  pieces: string;
  weightKg: number;
  media?: ReturnType<typeof getLabelMediaForUsage>;
}): string {
  const media = input.media ?? getLabelMediaForUsage('logistics_courier');
  const width = media.labelWidthMm || LOGISTICS_LABEL_WIDTH_MM;
  const height = media.labelHeightMm || LOGISTICS_LABEL_HEIGHT_MM;
  const gap = media.labelGapMm || LOGISTICS_LABEL_GAP_MM;
  const toLines = wrapLines(`${input.deliverToName} ${input.deliverToAddress}`, 42, 5);

  const lines = [
    `SIZE ${width} mm,${height} mm`,
    `GAP ${gap} mm,0`,
    'DIRECTION 1',
    'REFERENCE 0,0',
    'CLS',
    `TEXT 40,40,"3",0,1,1,"${escapeTspl(input.partnerLabel)}"`,
    'TEXT 40,90,"2",0,1,1,"COURIER LABEL"',
    'BAR 40,130,720,3',
    `BARCODE 80,160,"128",120,1,0,3,6,"${escapeTspl(input.consignmentNo)}"`,
    `TEXT 80,310,"3",0,1,1,"${escapeTspl(input.consignmentNo)}"`,
    'BAR 40,360,720,2',
    'TEXT 40,390,"1",0,1,1,"DELIVER TO"',
    ...toLines.map((line, i) => `TEXT 40,${420 + i * 32},"2",0,1,1,"${escapeTspl(line)}"`),
    'BAR 40,600,720,2',
    'TEXT 40,630,"1",0,1,1,"SERVICE"',
    `TEXT 40,660,"2",0,1,1,"${escapeTspl(input.serviceType || '—')}"`,
    'TEXT 400,630,"1",0,1,1,"BRANCH"',
    `TEXT 400,660,"2",0,1,1,"${escapeTspl(input.branch || '—')}"`,
    'TEXT 40,720,"1",0,1,1,"PIECES"',
    `TEXT 40,750,"3",0,1,1,"${escapeTspl(input.pieces)}"`,
    'TEXT 400,720,"1",0,1,1,"WEIGHT"',
    `TEXT 400,750,"3",0,1,1,"${input.weightKg.toFixed(2)} kg"`,
    'PRINT 1,1',
  ];
  return `${lines.join('\r\n')}\r\n`;
}

export async function resolveLogisticsPrinterOrThrow(): Promise<{ host: string; port: number }> {
  const studio = await loadLabelStudioDoc();
  const printer = getLogisticsLabelPrinter(studio);
  const hosts = printerHostCandidates(printer);
  if (!hosts.length) {
    throw new Error(
      'Set at least one logistics label printer IP in Admin → Settings → Label printing.',
    );
  }
  return pickReachablePrinter({
    hosts,
    port: printer.port,
    lastHostKey: logisticsLastHostStorageKey(),
  });
}

/** Thermal print when the APK or the local print bridge can reach a printer. */
export async function tryPrintShippingLabelsThermal(
  labels: ShippingLabelViewModel[],
): Promise<{ usedThermal: boolean; bytesSent: number }> {
  if (!labels.length || !(await isLanPrintAvailable())) {
    return { usedThermal: false, bytesSent: 0 };
  }
  const printer = await resolveLogisticsPrinterOrThrow();
  let bytesSent = 0;
  for (const label of labels) {
    const payload = await buildShippingLabelBitmapJob(label);
    const result = await sendRawToPrinter({ ...printer, payload });
    bytesSent += result.bytesSent;
  }
  return { usedThermal: true, bytesSent };
}

export async function tryPrintCourierLabelThermal(input: {
  partnerLabel: string;
  consignmentNo: string;
  deliverToName: string;
  deliverToAddress: string;
  serviceType: string;
  branch: string;
  pieces: string;
  weightKg: number;
}): Promise<{ usedThermal: boolean; bytesSent: number }> {
  if (!(await isLanPrintAvailable())) {
    return { usedThermal: false, bytesSent: 0 };
  }
  const printer = await resolveLogisticsPrinterOrThrow();
  const payload = buildCourierLabelTspl(input);
  const result = await sendRawToPrinter({ ...printer, payload });
  return { usedThermal: true, bytesSent: result.bytesSent };
}

/** Shared sheet CSS for browser print + standalone shipping-label HTML. */
export const SHIPPING_LABEL_SHEET_STYLES = `
  .sheet {
    width: ${LOGISTICS_LABEL_WIDTH_MM}mm;
    height: ${LOGISTICS_LABEL_HEIGHT_MM}mm;
    margin: 0;
    border: none;
    padding: 2.5mm;
    overflow: hidden;
    page-break-after: always;
    break-after: page;
    display: flex;
    flex-direction: column;
    gap: 0;
    box-sizing: border-box;
    color: #111;
    background: #fff;
    font-family: Arial, Helvetica, sans-serif;
  }
  .sheet:last-child { page-break-after: auto; break-after: auto; }
  .sheet__frame {
    flex: 1 1 auto;
    min-height: 0;
    border: 2.5px solid #111;
    border-radius: 3.2mm;
    padding: 2.4mm 2.4mm 2.2mm;
    background: #fff;
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  ${SHIPPING_LABEL_HEADER_STYLES}
  .sheet__header { border-bottom: none; margin: 0; padding-bottom: 0; }
  .sheet__label {
    display: block;
    color: #111;
    background: none;
    font-size: 9px;
    font-weight: 900;
    letter-spacing: 0.03em;
    text-transform: uppercase;
    line-height: 1.15;
    margin-bottom: 0;
  }
  .sheet__glyph { width: 12px; height: 12px; flex-shrink: 0; }
  .sheet__metric-head .sheet__glyph { width: 11px; height: 11px; }
  .sheet__panel {
    border: 1.4px solid #111;
    border-radius: 2.2mm;
    overflow: hidden;
    margin-top: 1.2mm;
  }
  .sheet__parties {
    display: grid;
    grid-template-columns: 1fr 1fr;
    border-top: 1.5px solid #111;
    border-bottom: none;
    margin: 1.2mm 0 0;
    min-height: 36mm;
    overflow: hidden;
    flex: 1 1 auto;
  }
  .sheet__party {
    padding: 7px 8px;
    min-width: 0;
    overflow: hidden;
    display: flex;
    flex-direction: column;
  }
  .sheet__party .sheet__label { margin-bottom: 5px; font-size: 10px; }
  .sheet__party + .sheet__party { border-left: 1.5px solid #111; }
  .sheet__party-name {
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 3;
    overflow: hidden;
    font-family: Arial, Helvetica, sans-serif;
    font-size: 13px;
    font-weight: 700;
    line-height: 1.2;
    margin-bottom: 5px;
  }
  .sheet__party-address {
    margin: 0;
    font-family: Arial, Helvetica, sans-serif;
    font-size: 11px;
    font-weight: 700;
    line-height: 1.3;
    white-space: pre-line;
    flex: 1 1 auto;
    min-height: 0;
    overflow: hidden;
  }
  .sheet__party-phone {
    display: block;
    margin-top: 5px;
    font-family: Arial, Helvetica, sans-serif;
    font-size: 12px;
    font-weight: 700;
    line-height: 1.2;
  }
  .sheet__metrics {
    display: flex;
    flex-direction: column;
    margin: 0;
    min-height: 96px;
    flex: 0 0 auto;
  }
  .sheet__metrics-row {
    display: grid;
    flex: 1 1 0;
    min-height: 0;
  }
  .sheet__metrics-row--3 { grid-template-columns: repeat(3, 1fr); }
  .sheet__metrics-row--4 { grid-template-columns: repeat(4, 1fr); }
  .sheet__metrics-row + .sheet__metrics-row { border-top: 1px solid #111; }
  .sheet__metric {
    padding: 5px 4px;
    border-right: 1px solid #111;
    min-width: 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
    overflow: hidden;
  }
  .sheet__metric:last-child { border-right: none; }
  .sheet__metric-head { display: flex; align-items: center; gap: 2px; min-width: 0; }
  .sheet__metric-title {
    font-size: 7.5px;
    font-weight: 900;
    text-transform: uppercase;
    line-height: 1.1;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    min-width: 0;
  }
  .sheet__metric-value {
    font-size: 11px;
    font-weight: 900;
    line-height: 1.15;
    word-break: break-word;
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    overflow: hidden;
  }
  .sheet__courier {
    display: grid;
    grid-template-columns: 0.85fr 1.25fr;
    margin: 0;
    min-height: 80px;
    flex: 1 1 auto;
  }
  .sheet__courier-side {
    padding: 6px;
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  .sheet__courier-side--logo { padding: 2px; }
  .sheet__courier-side + .sheet__courier-side { border-left: 1.4px solid #111; }
  .sheet__courier-side--track { align-items: center; text-align: center; }
  .sheet__carrier-logo {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 0;
    width: 100%;
    height: 100%;
  }
  .sheet__courier-side--logo .sheet__carrier-logo img {
    width: 100%;
    height: 100%;
    max-width: none;
    max-height: none;
    object-fit: cover;
    display: block;
  }
  .sheet__carrier-name {
    font-size: 11px;
    font-weight: 900;
    text-align: center;
    text-transform: uppercase;
  }
  .sheet__awb {
    display: block;
    font-family: Arial, Helvetica, sans-serif;
    font-size: 12px;
    font-weight: 700;
    letter-spacing: 0.02em;
    margin: 3px 0 0;
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .sheet__barcode {
    display: flex;
    justify-content: center;
    align-items: stretch;
    gap: 0;
    height: 40px;
    width: 100%;
    margin-top: 4px;
    padding: 0 8px;
    box-sizing: border-box;
    flex: 1 1 auto;
    min-height: 36px;
  }
  .sheet__barcode i {
    display: block;
    min-width: 0;
    height: 100%;
  }
  .sheet__info {
    display: grid;
    grid-template-columns: 1fr 1fr;
    margin: 0;
    margin-top: auto;
    min-height: 44px;
  }
  .sheet__info-cell {
    padding: 8px;
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 0;
    border-right: 1.4px solid #111;
  }
  .sheet__info-cell:nth-child(2n) { border-right: none; }
  .sheet__info-head { display: flex; align-items: center; gap: 4px; }
  .sheet__info-cell strong {
    font-size: 14px;
    font-weight: 900;
    line-height: 1.15;
    word-break: break-word;
  }
`;

/** Browser print fallback — clones rendered 100×150 mm sheets into a print window. */
export const SHIPPING_LABEL_BROWSER_PRINT_STYLES = `
  @page { margin: 0; size: ${LOGISTICS_LABEL_WIDTH_MM}mm ${LOGISTICS_LABEL_HEIGHT_MM}mm; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body { font-family: Arial, Helvetica, sans-serif; color: #111; background: #fff; }
  ${SHIPPING_LABEL_SHEET_STYLES}
`;

export function printShippingLabelElements(
  elements: Array<HTMLElement | null>,
  title = 'Shipping label',
): void {
  const sheets = elements.filter((el): el is HTMLElement => Boolean(el));
  if (!sheets.length || typeof window === 'undefined') return;
  const win = window.open('', '_blank', 'noopener,noreferrer,width=420,height=640');
  if (!win) {
    throw new Error('Pop-up blocked. Allow pop-ups to print the shipping label.');
  }
  win.document.open();
  win.document.write(
    `<!DOCTYPE html><html><head><title>${title}</title>`
    + `<style>${SHIPPING_LABEL_BROWSER_PRINT_STYLES}</style></head>`
    + `<body>${sheets.map(el => el.outerHTML).join('')}</body></html>`,
  );
  win.document.close();
  win.focus();
  win.onload = () => {
    win.print();
  };
  window.setTimeout(() => {
    try { win.print(); } catch { /* ignore */ }
  }, 250);
}

/** Browser print fallback using the same 203 DPI canvases as thermal / on-screen preview.
 *  Each canvas becomes one physical page at 100×150 mm (one label per box). */
export function printShippingLabelCanvases(
  canvases: Array<HTMLCanvasElement | null>,
  title = 'Shipping label',
): void {
  const ready = canvases.filter(
    (canvas): canvas is HTMLCanvasElement => Boolean(canvas && canvas.width > 0 && canvas.height > 0),
  );
  if (!ready.length || typeof window === 'undefined') {
    throw new Error('Label preview is still rendering. Wait a moment and try again.');
  }
  const win = window.open('', '_blank', 'noopener,noreferrer,width=420,height=640');
  if (!win) {
    throw new Error('Pop-up blocked. Allow pop-ups to print the shipping label.');
  }
  const w = LOGISTICS_LABEL_WIDTH_MM;
  const h = LOGISTICS_LABEL_HEIGHT_MM;
  const styles = `
    @page { margin: 0; size: ${w}mm ${h}mm; }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    html, body { margin: 0; padding: 0; background: #fff; }
    .label-page {
      width: ${w}mm;
      height: ${h}mm;
      overflow: hidden;
      page-break-after: always;
      break-after: page;
      page-break-inside: avoid;
      break-inside: avoid;
    }
    .label-page:last-child {
      page-break-after: auto;
      break-after: auto;
    }
    .label-page img {
      display: block;
      width: ${w}mm;
      height: ${h}mm;
      max-width: none;
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    }
  `;
  const body = ready
    .map((canvas, index) => (
      `<div class="label-page">`
      + `<img src="${canvas.toDataURL('image/png')}" `
      + `width="${canvas.width}" height="${canvas.height}" `
      + `alt="Shipping label ${index + 1} of ${ready.length}" />`
      + `</div>`
    ))
    .join('');
  win.document.open();
  win.document.write(
    `<!DOCTYPE html><html><head><title>${title}</title><style>${styles}</style></head>`
    + `<body>${body}</body></html>`,
  );
  win.document.close();
  win.focus();

  let printed = false;
  const triggerPrint = () => {
    if (printed) return;
    printed = true;
    try { win.print(); } catch { /* ignore */ }
  };

  const imgs = Array.from(win.document.images);
  if (!imgs.length) {
    window.setTimeout(triggerPrint, 250);
    return;
  }
  let pending = imgs.length;
  const onReady = () => {
    pending -= 1;
    if (pending <= 0) triggerPrint();
  };
  for (const img of imgs) {
    if (img.complete) onReady();
    else {
      img.addEventListener('load', onReady, { once: true });
      img.addEventListener('error', onReady, { once: true });
    }
  }
  // Safety net if load events never fire
  window.setTimeout(triggerPrint, 1500);
}

function loadLabelImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Could not load shipping label image.'));
    img.src = src;
  });
}

/**
 * Fit a Delhivery (or other) label image into our 100×150 mm @ 203 DPI canvas
 * so preview matches the logistics thermal printer stock.
 * Equal side insets keep the artwork centered on the die-cut.
 */
export async function renderImageToLogisticsLabelCanvas(
  src: string,
): Promise<HTMLCanvasElement> {
  const width = mmToDots(LOGISTICS_LABEL_WIDTH_MM, LABEL_DPI);
  const height = mmToDots(LOGISTICS_LABEL_HEIGHT_MM, LABEL_DPI);
  /** Quiet margin so thermal print is not hard against the left edge. */
  const padX = mmToDots(4, LABEL_DPI);
  const padY = mmToDots(3, LABEL_DPI);
  const img = await loadLabelImage(src);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not prepare label canvas.');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  const availW = Math.max(1, width - padX * 2);
  const availH = Math.max(1, height - padY * 2);
  const scale = Math.min(availW / img.naturalWidth, availH / img.naturalHeight);
  const drawW = Math.round(img.naturalWidth * scale);
  const drawH = Math.round(img.naturalHeight * scale);
  const x = padX + Math.round((availW - drawW) / 2);
  const y = padY + Math.round((availH - drawH) / 2);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, x, y, drawW, drawH);
  return canvas;
}

/** Thermal print for pre-rendered label images (e.g. official Delhivery labels). */
export async function tryPrintLabelImagesThermal(
  imageUrls: string[],
): Promise<{ usedThermal: boolean; bytesSent: number }> {
  if (!imageUrls.length || !(await isLanPrintAvailable())) {
    return { usedThermal: false, bytesSent: 0 };
  }
  const printer = await resolveLogisticsPrinterOrThrow();
  const media = getLabelMediaForUsage('logistics_shipping');
  let bytesSent = 0;
  for (const url of imageUrls) {
    const canvas = await renderImageToLogisticsLabelCanvas(url);
    const payload = buildCanvasTsplBitmapJob(canvas, {
      labelWidthMm: media.labelWidthMm || LOGISTICS_LABEL_WIDTH_MM,
      labelHeightMm: media.labelHeightMm || LOGISTICS_LABEL_HEIGHT_MM,
      labelGapMm: media.labelGapMm || LOGISTICS_LABEL_GAP_MM,
    });
    const result = await sendRawToPrinter({ ...printer, payload });
    bytesSent += result.bytesSent;
  }
  return { usedThermal: true, bytesSent };
}

/** Open the system print dialog for a PDF (A4 / office printer). */
export function printPdfBytes(bytes: Uint8Array, title = 'Document'): void {
  if (typeof window === 'undefined') {
    throw new Error('Print is only available in the browser.');
  }
  if (!bytes.length) throw new Error('Nothing to print.');
  const blob = new Blob([Uint8Array.from(bytes)], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);
  const iframe = document.createElement('iframe');
  iframe.title = title;
  iframe.setAttribute('aria-hidden', 'true');
  iframe.style.position = 'fixed';
  iframe.style.right = '0';
  iframe.style.bottom = '0';
  iframe.style.width = '0';
  iframe.style.height = '0';
  iframe.style.border = '0';
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    iframe.remove();
    URL.revokeObjectURL(url);
  };
  iframe.onload = () => {
    const win = iframe.contentWindow;
    if (!win) {
      cleanup();
      throw new Error('Could not open print preview.');
    }
    win.focus();
    win.print();
    window.setTimeout(cleanup, 60_000);
  };
  document.body.appendChild(iframe);
  iframe.src = url;
  window.setTimeout(() => {
    try {
      iframe.contentWindow?.print();
    } catch {
      /* PDF iframe onload is unreliable in some browsers */
    }
  }, 600);
}

/** Browser print fallback: each image → one 100×150 mm page. */
export async function printShippingLabelImages(
  imageUrls: string[],
  title = 'Shipping label',
): Promise<void> {
  if (!imageUrls.length) throw new Error('No shipping labels to print.');
  const canvases = await Promise.all(
    imageUrls.map(url => renderImageToLogisticsLabelCanvas(url)),
  );
  printShippingLabelCanvases(canvases, title);
}
