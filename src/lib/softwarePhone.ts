function callerDigits(value: string): string {
  return String(value || '').replace(/\D/g, '');
}

function callerE164Digits(value: string): string {
  const digits = callerDigits(value);
  if (!digits) return '';
  if (digits.length === 10) return `91${digits}`;
  if (digits.length === 11 && digits.startsWith('0')) return `91${digits.slice(1)}`;
  if (digits.length === 12 && digits.startsWith('91')) return digits;
  return digits;
}

export function callerTelHref(value: string): string {
  const e164 = callerE164Digits(value);
  return e164 ? `tel:+${e164}` : '';
}

export function callerWhatsAppHref(value: string, text = ''): string {
  const e164 = callerE164Digits(value);
  if (!e164) return '';
  const message = String(text ?? '').replace(/\r\n/g, '\n').trim();
  if (!message) return `https://wa.me/${e164}`;
  return `https://wa.me/${e164}?text=${encodeURIComponent(message)}`;
}

export function isLikelyWhatsAppNumber(value: string): boolean {
  const e164 = callerE164Digits(value);
  const national = e164.startsWith('91') && e164.length >= 12 ? e164.slice(-10) : e164.slice(-10);
  return national.length === 10 && /^[6-9]/.test(national);
}
