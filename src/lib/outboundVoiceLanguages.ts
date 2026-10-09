/**
 * Outbound WhatsApp voice language choices for the Cloud inbox header.
 * Indian codes must match Sarvam bulbul:v3. Arabic / Chinese use Google Cloud TTS.
 */

export type OutboundVoiceLanguageOption = {
  /** '' / 'auto' = detect from chat. Otherwise BCP-47 / Sarvam code. */
  value: string;
  label: string;
  engine: 'auto' | 'sarvam' | 'google';
};

/** Official bulbul:v3 language_code set (10 Indian + English India). */
export const SARVAM_BULBUL_TTS_LANGUAGES: ReadonlyArray<OutboundVoiceLanguageOption> = [
  { value: 'hi-IN', label: 'Hindi', engine: 'sarvam' },
  { value: 'bn-IN', label: 'Bengali', engine: 'sarvam' },
  { value: 'ta-IN', label: 'Tamil', engine: 'sarvam' },
  { value: 'te-IN', label: 'Telugu', engine: 'sarvam' },
  { value: 'kn-IN', label: 'Kannada', engine: 'sarvam' },
  { value: 'ml-IN', label: 'Malayalam', engine: 'sarvam' },
  { value: 'mr-IN', label: 'Marathi', engine: 'sarvam' },
  { value: 'gu-IN', label: 'Gujarati', engine: 'sarvam' },
  { value: 'pa-IN', label: 'Punjabi', engine: 'sarvam' },
  { value: 'od-IN', label: 'Odia', engine: 'sarvam' },
  { value: 'en-IN', label: 'English (India)', engine: 'sarvam' },
];

export const GOOGLE_OUTBOUND_TTS_LANGUAGES: ReadonlyArray<OutboundVoiceLanguageOption> = [
  { value: 'ar', label: 'Arabic', engine: 'google' },
  { value: 'zh-CN', label: 'Chinese', engine: 'google' },
];

export const OUTBOUND_VOICE_LANGUAGE_OPTIONS: ReadonlyArray<OutboundVoiceLanguageOption> = [
  { value: 'auto', label: 'Auto', engine: 'auto' },
  ...SARVAM_BULBUL_TTS_LANGUAGES,
  ...GOOGLE_OUTBOUND_TTS_LANGUAGES,
];

export const OUTBOUND_VOICE_LANGUAGE_AUTO = 'auto';

export function normalizeOutboundVoiceLanguageValue(raw: string | undefined | null): string {
  const value = String(raw ?? '').trim();
  if (!value || /^(auto|unknown)$/i.test(value)) return OUTBOUND_VOICE_LANGUAGE_AUTO;
  const match = OUTBOUND_VOICE_LANGUAGE_OPTIONS.find((opt) => {
    if (opt.value === OUTBOUND_VOICE_LANGUAGE_AUTO) return false;
    if (opt.value.toLowerCase() === value.toLowerCase()) return true;
    const left = (opt.value.split(/[-_]/)[0] || '').toLowerCase();
    const right = (value.split(/[-_]/)[0] || '').toLowerCase();
    if (left === 'zh' || left === 'cmn') return right === 'zh' || right === 'cmn';
    if (left === 'od' || left === 'or') return right === 'od' || right === 'or';
    return left === right && Boolean(left);
  });
  return match?.value || OUTBOUND_VOICE_LANGUAGE_AUTO;
}

export function outboundVoiceLanguageLabel(code: string | undefined | null): string {
  const value = normalizeOutboundVoiceLanguageValue(code);
  if (value === OUTBOUND_VOICE_LANGUAGE_AUTO) return 'Auto detect';
  return OUTBOUND_VOICE_LANGUAGE_OPTIONS.find((opt) => opt.value === value)?.label || 'Auto detect';
}
