import { isPwaStandalone } from './invoice-cache';

/** Desktop browsers can embed PDFs in iframes; Android/iOS PWAs cannot reliably use blob: iframes. */
export function prefersNativePdfViewer(): boolean {
  if (typeof window === 'undefined') return true;
  if (isPwaStandalone()) return false;

  const ua = navigator.userAgent;
  if (/Android/i.test(ua)) return false;
  if (/iPhone|iPad|iPod/i.test(ua)) return false;

  return true;
}

export function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}
