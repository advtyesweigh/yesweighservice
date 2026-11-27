import { Capacitor } from '@capacitor/core';
import { TcpPrint } from 'tcp-print';
import {
  DEFAULT_LABEL_GAP_MM,
  DEFAULT_LABEL_HEIGHT_MM,
  DEFAULT_LABEL_WIDTH_MM,
} from '../constants/localPrinterSettings';
import {
  buildGenuineSpareLabelTspl,
  TEST_BIN_LABEL_SAMPLE,
  type BinLabelFields,
} from './localPrinterLabel';
import {
  buildLabelBitmapJob,
  bytesToBase64,
} from './localPrinterLabelBitmap';
import { parseLayoutMedia } from './labelLayouts';
import type { LabelPrinter } from './labelStudio';

/** Encode bytes/text as base64 for the native TCP plugin or the local print bridge. */
export function textToBase64(text: string): string {
  return bytesToBase64(new TextEncoder().encode(text));
}

/** Loopback bridge on a PC that can open TCP to the label printer. */
export const LAN_PRINT_BRIDGE_ORIGIN = 'http://127.0.0.1:47321';

export const PRINT_BRIDGE_START_HINT =
  'Start the print bridge on this PC (npm run print-bridge) on the same network as the label printer. Allow local-network access if the browser asks.';

export function isNativePrintAvailable(): boolean {
  return Capacitor.isNativePlatform();
}

export type PrintTransport = 'android' | 'windows' | 'none';

function bridgeRequest(path: '/health' | '/probe' | '/print', body?: unknown, timeoutMs = 8000): Promise<Response> {
  const init: RequestInit = {
    method: body == null ? 'GET' : 'POST',
    signal: AbortSignal.timeout(timeoutMs),
  };
  if (body != null) {
    init.headers = { 'Content-Type': 'application/json' };
    init.body = JSON.stringify(body);
  }
  return fetch(`${LAN_PRINT_BRIDGE_ORIGIN}${path}`, init);
}

function bridgeUnreachable(err: unknown): boolean {
  if (err instanceof DOMException && (err.name === 'AbortError' || err.name === 'TimeoutError')) {
    return true;
  }
  return err instanceof TypeError;
}

export async function detectPrintTransport(): Promise<PrintTransport> {
  if (isNativePrintAvailable()) return 'android';
  try {
    const res = await bridgeRequest('/health', undefined, 800);
    return res.ok ? 'windows' : 'none';
  } catch {
    return 'none';
  }
}

export async function isLanPrintAvailable(): Promise<boolean> {
  return (await detectPrintTransport()) !== 'none';
}

async function readBridgeError(res: Response): Promise<string> {
  try {
    const data = await res.json() as { error?: string };
    if (data.error?.trim()) return data.error.trim();
  } catch {
    // Response was not JSON.
  }
  return `Print bridge error (${res.status}).`;
}

const LOGISTICS_LAST_HOST_KEY = 'yesweigh.logisticsPrinter.lastHost';

export async function probePrinter(options: {
  host: string;
  port: number;
  timeoutMs?: number;
}): Promise<boolean> {
  const timeoutMs = options.timeoutMs ?? 4000;
  if (isNativePrintAvailable()) {
    try {
      await TcpPrint.probe({
        host: options.host,
        port: options.port,
        timeoutMs,
      });
      return true;
    } catch {
      return false;
    }
  }

  try {
    const res = await bridgeRequest('/probe', {
      host: options.host,
      port: options.port,
      timeoutMs,
    }, timeoutMs + 1500);
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Pick the first reachable host (tries last-good first when provided).
 * Falls back to the first host if probe is unavailable (non-native).
 */
export async function pickReachablePrinter(options: {
  hosts: string[];
  port: number;
  lastHostKey?: string;
  probeTimeoutMs?: number;
}): Promise<{ host: string; port: number }> {
  const hosts = [...new Set(
    options.hosts.map(h => h.trim()).filter(Boolean),
  )];
  if (!hosts.length) {
    throw new Error('No printer IP configured.');
  }

  let ordered = hosts;
  if (options.lastHostKey && typeof localStorage !== 'undefined') {
    try {
      const last = localStorage.getItem(options.lastHostKey)?.trim();
      if (last && hosts.includes(last)) {
        ordered = [last, ...hosts.filter(h => h !== last)];
      }
    } catch {
      // ignore storage errors
    }
  }

  for (const host of ordered) {
    const ok = await probePrinter({
      host,
      port: options.port,
      timeoutMs: options.probeTimeoutMs ?? 4000,
    });
    if (ok) {
      if (options.lastHostKey && typeof localStorage !== 'undefined') {
        try {
          localStorage.setItem(options.lastHostKey, host);
        } catch {
          // ignore
        }
      }
      return { host, port: options.port };
    }
  }

  // Empty TCP probe can fail while a real TSPL job still prints (or Wi‑Fi
  // bind was missing). Attempt the first configured IP instead of aborting.
  return { host: ordered[0]!, port: options.port };
}

export function logisticsLastHostStorageKey(): string {
  return LOGISTICS_LAST_HOST_KEY;
}

export async function sendRawToPrinter(options: {
  host: string;
  port: number;
  payload: string | Uint8Array;
}): Promise<{ bytesSent: number }> {
  const dataBase64 = typeof options.payload === 'string'
    ? textToBase64(options.payload)
    : bytesToBase64(options.payload);
  const timeoutMs = 15000;

  if (isNativePrintAvailable()) {
    const result = await TcpPrint.send({
      host: options.host,
      port: options.port,
      dataBase64,
      timeoutMs,
    });
    return { bytesSent: result.bytesSent };
  }

  let res: Response;
  try {
    res = await bridgeRequest('/print', {
      host: options.host,
      port: options.port,
      dataBase64,
      timeoutMs,
    }, timeoutMs + 3000);
  } catch (err) {
    if (bridgeUnreachable(err)) throw new Error(PRINT_BRIDGE_START_HINT);
    throw err;
  }
  if (!res.ok) throw new Error(await readBridgeError(res));
  const data = await res.json() as { bytesSent?: number };
  return { bytesSent: Number(data.bytesSent) || 0 };
}

/**
 * Print a label using a printer + layout XML (size/gap from XML unless overridden).
 */
export async function sendBinLabel(options: {
  host: string;
  port: number;
  layoutXml: string;
  labelWidthMm?: number;
  labelHeightMm?: number;
  labelGapMm?: number;
  fields: BinLabelFields;
}): Promise<{ bytesSent: number }> {
  const payload = await buildLabelBitmapJob(options.fields, {
    layoutXml: options.layoutXml,
    labelWidthMm: options.labelWidthMm,
    labelHeightMm: options.labelHeightMm,
    labelGapMm: options.labelGapMm,
  });
  return sendRawToPrinter({
    host: options.host,
    port: options.port,
    payload,
  });
}

export async function sendLabelViaPrinter(
  printer: Pick<LabelPrinter, 'host' | 'port'>,
  layoutXml: string,
  fields: BinLabelFields,
): Promise<{ bytesSent: number }> {
  return sendBinLabel({
    host: printer.host.trim(),
    port: printer.port,
    layoutXml,
    fields,
  });
}

/** Test print — same renderer as the on-screen preview. */
export async function sendTestLabel(options: {
  host: string;
  port: number;
  layoutXml: string;
  labelWidthMm?: number;
  labelHeightMm?: number;
  labelGapMm?: number;
  fields?: BinLabelFields;
}): Promise<{ bytesSent: number }> {
  return sendBinLabel({
    ...options,
    fields: options.fields ?? {
      ...TEST_BIN_LABEL_SAMPLE,
      printedOn: new Date(),
    },
  });
}

/** Legacy vector TSPL (not used for WYSIWYG print). */
export function buildTestLabelTspl(options?: {
  labelWidthMm?: number;
  labelHeightMm?: number;
  labelGapMm?: number;
  layoutXml?: string;
}): string {
  const media = options?.layoutXml
    ? parseLayoutMedia(options.layoutXml)
    : {
        labelWidthMm: options?.labelWidthMm ?? DEFAULT_LABEL_WIDTH_MM,
        labelHeightMm: options?.labelHeightMm ?? DEFAULT_LABEL_HEIGHT_MM,
        labelGapMm: options?.labelGapMm ?? DEFAULT_LABEL_GAP_MM,
      };
  return buildGenuineSpareLabelTspl(
    { ...TEST_BIN_LABEL_SAMPLE, printedOn: new Date() },
    media,
  );
}
