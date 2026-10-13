/**
 * Call-log speech-to-text. Downloads the recording the play button already uses
 * and runs Sarvam Saaras in Malayalam. Stereo recordings are split by channel.
 * Mixed recordings use the batch API with diarization so two voices become
 * separate turns. A finished speaker result is not sent to Sarvam again.
 * Never logs the API key or the recording URL.
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';
import ffmpegPath from 'ffmpeg-static';
import { loadSarvamApiKey } from './sarvam.js';
import { extFromMime } from './whatsapp-transcribe.js';
import {
  malayalamLineForTranscript,
  sarvamSpeechToText,
  sarvamSpeechToTextSegments,
} from './whatsapp-voice-translate.js';

const EVENTS = 'phoneEvents';
const MAX_BYTES = 32 * 1024 * 1024;
const MAX_SECONDS = 20 * 60;
/** Match the callable timeout so a second tap does not start a parallel job. */
const PROCESSING_WINDOW_MS = 10 * 60 * 1000;
const SARVAM_JOB_URL = 'https://api.sarvam.ai/speech-to-text/job/v1';
const DIARIZE_POLL_MS = 3000;
const DIARIZE_DEADLINE_MS = 8 * 60 * 1000;
/** Saaras BCP-47 code. Phone calls and the teal transcript button always request this. */
const PHONE_STT_LANGUAGE = 'ml-IN';

/**
 * Voxbay stereo WAVs follow the usual PBX split: left is the customer,
 * right is the agent. Mono files do not use this map.
 */
const STEREO_ROLES = Object.freeze(['customer', 'agent']);

function trim(value) {
  return String(value ?? '').trim();
}

function fail(message, code = 'failed-precondition') {
  const err = new Error(message);
  err.code = code;
  return err;
}

function safeMessage(err) {
  const raw = trim(err?.message) || 'Could not transcribe this recording.';
  if (
    /api[_-]?key|subscription-key|sarvam\.ai|https?:\/\//i.test(raw)
    || /^(internal|unavailable|unknown|not-found)$/i.test(raw)
  ) {
    return 'Could not transcribe this recording.';
  }
  return raw.slice(0, 240);
}

function contentTypeFor(header, url) {
  const raw = trim(header).split(';')[0].toLowerCase();
  if (raw.startsWith('audio/')) return raw;
  const filePath = String(url || '').split('?')[0].toLowerCase();
  if (filePath.endsWith('.mp3')) return 'audio/mpeg';
  if (filePath.endsWith('.wav')) return 'audio/wav';
  if (filePath.endsWith('.ogg') || filePath.endsWith('.opus')) return 'audio/ogg';
  if (filePath.endsWith('.m4a') || filePath.endsWith('.mp4') || filePath.endsWith('.aac')) return 'audio/mp4';
  if (filePath.endsWith('.webm')) return 'audio/webm';
  return 'audio/mpeg';
}

function speakerOf(row) {
  const value = trim(row?.speaker || row?.role).toLowerCase();
  if (value === 'agent' || value === 'customer') return value;
  return '';
}

export function normalizeTranscriptTurns(value) {
  if (!Array.isArray(value)) return [];
  const turns = [];
  for (const row of value) {
    const speaker = speakerOf(row);
    const text = trim(row?.malayalamText) || trim(row?.text);
    if (!speaker || !text) continue;
    turns.push({ speaker, text });
  }
  return turns;
}

function bothSpeakers(turns) {
  const roles = new Set((turns || []).map(turn => turn.speaker));
  return roles.has('agent') && roles.has('customer');
}

function speakersReady(row) {
  const turns = normalizeTranscriptTurns(row?.transcriptTurns);
  if (bothSpeakers(turns)) return true;
  if (row?.transcriptSingleSpeaker === true && (trim(row?.transcript) || trim(row?.malayalamText))) {
    return true;
  }
  return false;
}

export function channelCountFromProbe(stderr) {
  const line = String(stderr || '').split('\n').find(row => /Audio:/i.test(row)) || '';
  if (/\bstereo\b/i.test(line)) return 2;
  if (/\bmono\b/i.test(line)) return 1;
  const match = line.match(/\b(\d+)\s+channels?\b/i);
  return match ? Number(match[1]) : 0;
}

export function stereoLayoutFromPcm(pcm) {
  if (!pcm || pcm.length < 16) return 'mono';
  const frames = Math.floor(pcm.length / 4);
  if (frames < 8) return 'mono';
  const step = Math.max(1, Math.floor(frames / 8000));
  let sumL = 0;
  let sumR = 0;
  let dot = 0;
  let count = 0;
  for (let i = 0; i < frames; i += step) {
    const left = pcm.readInt16LE(i * 4);
    const right = pcm.readInt16LE(i * 4 + 2);
    sumL += left * left;
    sumR += right * right;
    dot += left * right;
    count += 1;
  }
  if (!count) return 'mono';
  const rmsL = Math.sqrt(sumL / count);
  const rmsR = Math.sqrt(sumR / count);
  const peak = Math.max(rmsL, rmsR);
  if (peak < 40) return 'silent';
  if (rmsL < peak * 0.12) return 'right-only';
  if (rmsR < peak * 0.12) return 'left-only';
  const denom = Math.sqrt(sumL * sumR) || 1;
  if (dot / denom > 0.92) return 'duplicate';
  return 'split';
}

export function mergeTimedTurns(groups) {
  const items = [];
  for (const group of groups || []) {
    const speaker = speakerOf(group);
    if (!speaker) continue;
    for (const segment of group.segments || []) {
      const text = trim(segment?.text);
      if (!text) continue;
      const start = Number(segment?.start);
      items.push({ speaker, text, start: Number.isFinite(start) ? start : 0 });
    }
  }
  items.sort((a, b) => a.start - b.start || (a.speaker === 'customer' ? -1 : 1));
  const turns = [];
  for (const item of items) {
    const last = turns[turns.length - 1];
    if (last && last.speaker === item.speaker) {
      last.text = `${last.text} ${item.text}`.replace(/\s+/g, ' ').trim();
    } else {
      turns.push({ speaker: item.speaker, text: item.text });
    }
  }
  return turns;
}

/** Map Sarvam diarized entries onto agent and customer. One speaker stays unsplit. */
export function turnsFromDiarizedEntries(entries, direction) {
  const cleaned = [];
  const list = Array.isArray(entries) ? entries : [];
  for (const entry of list) {
    const text = trim(entry?.transcript || entry?.text);
    if (!text) continue;
    const speakerId = trim(entry?.speaker_id ?? entry?.speakerId) || '0';
    const start = Number(entry?.start_time_seconds ?? entry?.start);
    cleaned.push({
      speakerId,
      text,
      start: Number.isFinite(start) ? start : 0,
    });
  }
  cleaned.sort((a, b) => a.start - b.start || a.speakerId.localeCompare(b.speakerId));
  const firstStart = new Map();
  for (const entry of cleaned) {
    if (!firstStart.has(entry.speakerId)) firstStart.set(entry.speakerId, entry.start);
  }
  const speakers = [...firstStart.entries()].sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]));
  if (speakers.length < 2) return { singleSpeaker: true, turns: [] };
  const outbound = trim(direction).toLowerCase() === 'outbound';
  const firstRole = outbound ? 'customer' : 'agent';
  const secondRole = firstRole === 'agent' ? 'customer' : 'agent';
  const roles = new Map([[speakers[0][0], firstRole]]);
  for (let i = 1; i < speakers.length; i += 1) roles.set(speakers[i][0], secondRole);
  const turns = [];
  for (const entry of cleaned) {
    const speaker = roles.get(entry.speakerId) || secondRole;
    const last = turns[turns.length - 1];
    if (last && last.speaker === speaker && last.speakerId === entry.speakerId) {
      last.text = `${last.text} ${entry.text}`.replace(/\s+/g, ' ').trim();
    } else {
      turns.push({ speaker, speakerId: entry.speakerId, text: entry.text });
    }
  }
  const visible = turns.map(({ speaker, text }) => ({ speaker, text }));
  if (!bothSpeakers(visible)) return { singleSpeaker: true, turns: [] };
  return { singleSpeaker: false, turns: visible };
}

async function downloadRecording(url) {
  let res;
  try {
    res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(90_000) });
  } catch (err) {
    console.warn('phone recording download failed', err?.name || 'error');
    throw fail('Could not download this recording.', 'unavailable');
  }
  if (!res.ok) throw fail('Could not download this recording.', 'unavailable');
  const advertised = Number(res.headers.get('content-length') || 0);
  if (Number.isFinite(advertised) && advertised > MAX_BYTES) {
    throw fail('Recording is too large to transcribe.', 'failed-precondition');
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  if (!buffer.length) throw fail('Recording is empty.', 'failed-precondition');
  if (buffer.length > MAX_BYTES) {
    throw fail('Recording is too large to transcribe.', 'failed-precondition');
  }
  return {
    buffer,
    contentType: contentTypeFor(res.headers.get('content-type'), url),
  };
}

function startedMs(value) {
  if (value && typeof value.toMillis === 'function') return value.toMillis();
  return 0;
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    if (!ffmpegPath) {
      reject(fail('Could not transcribe this recording.', 'failed-precondition'));
      return;
    }
    const child = spawn(ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
      if (stderr.length > 4000) stderr = stderr.slice(-4000);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(stderr);
      else reject(new Error(stderr.trim() || `ffmpeg exited with code ${code}`));
    });
  });
}

async function withTempInput(buffer, contentType, fn) {
  const id = randomUUID();
  const inPath = path.join(tmpdir(), `phone-audio-${id}.${extFromMime(contentType)}`);
  await fs.writeFile(inPath, buffer);
  try {
    return await fn(inPath);
  } finally {
    await fs.unlink(inPath).catch(() => {});
  }
}

async function probeChannelCount(buffer, contentType) {
  if (!ffmpegPath || !buffer?.length) return 0;
  return withTempInput(buffer, contentType, async (inPath) => {
    const stderr = await new Promise((resolve) => {
      const child = spawn(ffmpegPath, ['-hide_banner', '-i', inPath], {
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      let errText = '';
      child.stderr.on('data', (chunk) => {
        errText += String(chunk);
        if (errText.length > 8000) errText = errText.slice(-8000);
      });
      child.on('error', () => resolve(''));
      child.on('close', () => resolve(errText));
    });
    return channelCountFromProbe(stderr);
  });
}

async function readStereoPcm(buffer, contentType) {
  return withTempInput(buffer, contentType, async (inPath) => {
    const outPath = path.join(tmpdir(), `phone-pcm-${randomUUID()}.pcm`);
    try {
      await runFfmpeg([
        '-hide_banner', '-loglevel', 'error', '-y',
        '-i', inPath,
        '-vn',
        '-filter_complex', 'pan=stereo|c0=c0|c1=c1',
        '-ar', '8000',
        '-f', 's16le',
        '-acodec', 'pcm_s16le',
        outPath,
      ]);
      return await fs.readFile(outPath);
    } finally {
      await fs.unlink(outPath).catch(() => {});
    }
  });
}

async function extractChannelWav(buffer, contentType, channelIndex) {
  return withTempInput(buffer, contentType, async (inPath) => {
    const outPath = path.join(tmpdir(), `phone-ch-${randomUUID()}.wav`);
    const pan = channelIndex === 0 ? 'pan=mono|c0=c0' : 'pan=mono|c0=c1';
    try {
      await runFfmpeg([
        '-hide_banner', '-loglevel', 'error', '-y',
        '-i', inPath,
        '-vn',
        '-af', pan,
        '-ac', '1',
        '-ar', '16000',
        '-f', 'wav',
        outPath,
      ]);
      const wav = await fs.readFile(outPath);
      if (!wav?.length) throw fail('Could not transcribe this recording.', 'failed-precondition');
      return wav;
    } finally {
      await fs.unlink(outPath).catch(() => {});
    }
  });
}

function joinText(parts) {
  return parts.map(part => trim(part)).filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
}

async function malayalamCopy(text, languageCode) {
  const spoken = trim(text);
  if (!spoken) return '';
  const line = await malayalamLineForTranscript(spoken, languageCode || PHONE_STT_LANGUAGE);
  return trim(line) || spoken;
}

async function decorateTurns(turns, languageCode) {
  const decorated = [];
  for (const turn of turns) {
    const text = await malayalamCopy(turn.text, languageCode);
    if (!text) continue;
    decorated.push({ speaker: turn.speaker, text });
  }
  return decorated;
}

async function resultFromTurns(turns, languageCode, speakerSource) {
  const ready = turns.filter(turn => trim(turn.text));
  if (!bothSpeakers(ready)) {
    const transcript = await malayalamCopy(joinText(ready.map(turn => turn.text)), languageCode);
    return {
      transcript,
      malayalamText: transcript,
      languageCode: trim(languageCode) || PHONE_STT_LANGUAGE,
      turns: [],
      singleSpeaker: true,
      speakerSource,
    };
  }
  const decorated = await decorateTurns(ready, languageCode);
  if (!bothSpeakers(decorated)) {
    const transcript = joinText(decorated.map(turn => turn.text));
    return {
      transcript,
      malayalamText: transcript,
      languageCode: trim(languageCode) || PHONE_STT_LANGUAGE,
      turns: [],
      singleSpeaker: true,
      speakerSource,
    };
  }
  const malayalamText = joinText(decorated.map(turn => turn.text));
  return {
    transcript: malayalamText,
    malayalamText,
    languageCode: trim(languageCode) || PHONE_STT_LANGUAGE,
    turns: decorated,
    singleSpeaker: false,
    speakerSource,
  };
}

async function sarvamJobJson(url, apiKey, body) {
  const res = await fetch(url, {
    method: body ? 'POST' : 'GET',
    headers: {
      'api-subscription-key': apiKey,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.warn('sarvam speech job failed', res.status);
    throw fail('Could not transcribe this recording.', 'failed-precondition');
  }
  return json;
}

function signedFileUrl(entry) {
  if (typeof entry === 'string') return trim(entry);
  return trim(entry?.file_url);
}

function diarizedEntries(result) {
  const block = result?.diarized_transcript;
  if (Array.isArray(block)) return block;
  if (Array.isArray(block?.entries)) return block.entries;
  return [];
}

async function diarizeRecording(buffer, contentType, apiKey, direction) {
  const ext = extFromMime(contentType) || 'wav';
  const filename = `recording.${ext}`;
  const created = await sarvamJobJson(SARVAM_JOB_URL, apiKey, {
    job_parameters: {
      model: 'saaras:v3',
      mode: 'transcribe',
      language_code: PHONE_STT_LANGUAGE,
      with_diarization: true,
      num_speakers: 2,
    },
  });
  const jobId = trim(created?.job_id);
  if (!jobId) throw fail('Could not transcribe this recording.', 'failed-precondition');

  const uploads = await sarvamJobJson(`${SARVAM_JOB_URL}/upload-files`, apiKey, {
    job_id: jobId,
    files: [filename],
  });
  const uploadUrl = signedFileUrl(uploads?.upload_urls?.[filename]);
  if (!uploadUrl) throw fail('Could not transcribe this recording.', 'failed-precondition');
  const container = trim(uploads?.storage_container_type);
  const rawType = trim(contentType).split(';')[0];
  const putHeaders = {
    'Content-Type': rawType.startsWith('audio/') || rawType.startsWith('video/') ? rawType : 'audio/wav',
  };
  if (container === 'Azure' || container === 'Azure_V1' || !container) {
    putHeaders['x-ms-blob-type'] = 'BlockBlob';
  }
  const put = await fetch(uploadUrl, { method: 'PUT', headers: putHeaders, body: buffer });
  if (!put.ok) {
    console.warn('sarvam speech upload failed', put.status);
    throw fail('Could not transcribe this recording.', 'failed-precondition');
  }

  await sarvamJobJson(`${SARVAM_JOB_URL}/${encodeURIComponent(jobId)}/start`, apiKey, {});

  const deadline = Date.now() + DIARIZE_DEADLINE_MS;
  let status = null;
  while (Date.now() < deadline) {
    status = await sarvamJobJson(`${SARVAM_JOB_URL}/${encodeURIComponent(jobId)}/status`, apiKey);
    const state = trim(status?.job_state);
    if (state === 'Completed' || state === 'PartiallyCompleted') break;
    if (state === 'Failed') throw fail('Could not transcribe this recording.', 'failed-precondition');
    await new Promise(resolve => setTimeout(resolve, DIARIZE_POLL_MS));
  }
  if (!status || (trim(status.job_state) !== 'Completed' && trim(status.job_state) !== 'PartiallyCompleted')) {
    throw fail('Could not transcribe this recording.', 'failed-precondition');
  }

  const files = [];
  for (const detail of status.job_details || []) {
    if (detail?.state && detail.state !== 'Success') continue;
    for (const output of detail.outputs || []) {
      const name = trim(output?.file_name);
      if (name) files.push(name);
    }
  }
  if (!files.length) files.push('0.json');
  const downloads = await sarvamJobJson(`${SARVAM_JOB_URL}/download-files`, apiKey, {
    job_id: jobId,
    files,
  });
  const resultName = files.find(name => signedFileUrl(downloads?.download_urls?.[name])) || files[0];
  const resultUrl = signedFileUrl(downloads?.download_urls?.[resultName]);
  if (!resultUrl) throw fail('Could not transcribe this recording.', 'failed-precondition');
  const resultRes = await fetch(resultUrl);
  if (!resultRes.ok) throw fail('Could not transcribe this recording.', 'failed-precondition');
  const result = await resultRes.json().catch(() => ({}));
  const spoken = turnsFromDiarizedEntries(diarizedEntries(result), direction);
  const languageCode = trim(result?.language_code) || PHONE_STT_LANGUAGE;
  if (!spoken.singleSpeaker) return resultFromTurns(spoken.turns, languageCode, 'diarization');
  const transcript = trim(result?.transcript);
  if (!transcript) throw fail('No speech detected in this recording.', 'failed-precondition');
  const malayalamText = await malayalamCopy(transcript, languageCode);
  return {
    transcript: malayalamText,
    malayalamText,
    languageCode,
    turns: [],
    singleSpeaker: true,
    speakerSource: 'diarization',
  };
}

async function transcribeChannel(buffer, contentType, channelIndex, apiKey) {
  try {
    const wav = await extractChannelWav(buffer, contentType, channelIndex);
    return await sarvamSpeechToTextSegments(wav, 'audio/wav', apiKey, {
      languageCode: PHONE_STT_LANGUAGE,
    });
  } catch (err) {
    console.warn('phone channel transcription failed', channelIndex, err?.message || err);
    return { transcript: '', languageCode: '', segments: [] };
  }
}

async function transcribeSplitChannels(buffer, contentType, apiKey) {
  const channels = await Promise.all([0, 1].map(index => transcribeChannel(buffer, contentType, index, apiKey)));
  const groups = channels.map((spoken, index) => ({
    speaker: STEREO_ROLES[index],
    segments: spoken.segments?.length
      ? spoken.segments
      : (trim(spoken.transcript) ? [{ text: spoken.transcript, start: index }] : []),
  }));
  const languageCode = trim(channels.find(spoken => spoken.languageCode)?.languageCode) || PHONE_STT_LANGUAGE;
  const turns = mergeTimedTurns(groups);
  if (!turns.length) throw fail('No speech detected in this recording.', 'failed-precondition');
  return resultFromTurns(turns, languageCode, 'channels');
}

async function transcribeAsMalayalam(buffer, contentType, apiKey) {
  const spoken = await sarvamSpeechToText(buffer, contentType, apiKey, {
    languageCode: PHONE_STT_LANGUAGE,
  });
  const transcript = await malayalamCopy(spoken.transcript, spoken.languageCode || PHONE_STT_LANGUAGE);
  if (!transcript) throw fail('No speech detected in this recording.', 'failed-precondition');
  return {
    transcript,
    malayalamText: transcript,
    languageCode: PHONE_STT_LANGUAGE,
    turns: [],
    singleSpeaker: true,
    speakerSource: '',
  };
}

async function transcribeCallSpeakers(buffer, contentType, direction, apiKey) {
  const channels = await probeChannelCount(buffer, contentType);
  if (channels < 2) return diarizeRecording(buffer, contentType, apiKey, direction);
  let layout = 'split';
  try {
    const pcm = await readStereoPcm(buffer, contentType);
    layout = stereoLayoutFromPcm(pcm);
  } catch (err) {
    console.warn('phone channel layout failed', err?.message || err);
    layout = 'split';
  }
  if (layout === 'silent') throw fail('No speech detected in this recording.', 'failed-precondition');
  if (layout === 'split') {
    try {
      return await transcribeSplitChannels(buffer, contentType, apiKey);
    } catch (err) {
      console.warn('phone channel split failed', err?.message || err);
      return diarizeRecording(buffer, contentType, apiKey, direction);
    }
  }
  if (layout === 'left-only' || layout === 'right-only') {
    const wav = await extractChannelWav(buffer, contentType, layout === 'left-only' ? 0 : 1);
    return diarizeRecording(wav, 'audio/wav', apiKey, direction);
  }
  return diarizeRecording(buffer, contentType, apiKey, direction);
}

function savedPayload(row, skipped) {
  const turns = normalizeTranscriptTurns(row.transcriptTurns);
  const dialogue = bothSpeakers(turns);
  const malayalamText = trim(row.malayalamText) || trim(row.transcript);
  return {
    ok: true,
    status: 'completed',
    skipped,
    transcript: malayalamText,
    languageCode: trim(row.transcriptLanguage) || PHONE_STT_LANGUAGE,
    malayalamText,
    turns: dialogue ? turns : [],
    singleSpeaker: !dialogue,
  };
}

async function persistSpokenTranscript(ref, spoken) {
  await ref.set({
    transcript: spoken.transcript,
    malayalamText: spoken.malayalamText || spoken.transcript,
    transcriptLanguage: spoken.languageCode || PHONE_STT_LANGUAGE,
    transcriptTurns: spoken.turns,
    transcriptSingleSpeaker: spoken.singleSpeaker === true,
    transcriptSpeakerSource: spoken.speakerSource || '',
    transcriptionStatus: 'completed',
    transcriptionError: '',
    transcriptionUpdatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });
}

/**
 * Transcribe one phoneEvents recording in Malayalam.
 * A saved two-speaker transcript, or a saved single-speaker result, is returned
 * without another Sarvam request. A flat transcript with no speaker result is run again.
 */
export async function transcribePhoneCall(data) {
  const eventId = trim(data?.eventId).replace(/[/\s]/g, '');
  if (!eventId) throw fail('Call is required.', 'invalid-argument');

  const ref = getFirestore().collection(EVENTS).doc(eventId);
  const claim = await getFirestore().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw fail('Could not find that call.', 'not-found');
    const row = snap.data() || {};
    if (speakersReady(row)) return { kind: 'saved', row };
    const status = trim(row.transcriptionStatus).toLowerCase();
    const started = startedMs(row.transcriptionStartedAt);
    if (status === 'processing' && started && Date.now() - started < PROCESSING_WINDOW_MS) {
      return { kind: 'processing' };
    }
    const recordingUrl = trim(row.recordingUrl);
    if (!/^https?:\/\//i.test(recordingUrl)) {
      throw fail('This call has no recording to transcribe.', 'failed-precondition');
    }
    const duration = Number(row.durationSeconds);
    if (Number.isFinite(duration) && duration > MAX_SECONDS) {
      throw fail('This recording is too long to transcribe.', 'failed-precondition');
    }
    tx.set(ref, {
      transcriptionStatus: 'processing',
      transcriptionError: '',
      transcriptionStartedAt: FieldValue.serverTimestamp(),
      transcriptionUpdatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    return { kind: 'run', recordingUrl, direction: trim(row.direction) };
  });

  if (claim.kind === 'saved') return savedPayload(claim.row, true);
  if (claim.kind === 'processing') {
    return {
      ok: true,
      status: 'processing',
      skipped: true,
      transcript: '',
      languageCode: '',
      malayalamText: '',
      turns: [],
      singleSpeaker: false,
    };
  }

  try {
    const apiKey = await loadSarvamApiKey();
    if (!apiKey) throw fail('Transcription is not configured.', 'failed-precondition');
    const { buffer, contentType } = await downloadRecording(claim.recordingUrl);
    let spoken;
    try {
      spoken = await transcribeCallSpeakers(buffer, contentType, claim.direction, apiKey);
    } catch (err) {
      console.warn('phone speaker transcription failed', err?.message || err);
      spoken = await transcribeAsMalayalam(buffer, contentType, apiKey);
    }
    if (!trim(spoken.transcript) && !spoken.turns?.length) {
      throw fail('No speech detected in this recording.', 'failed-precondition');
    }
    await persistSpokenTranscript(ref, spoken);
    return {
      ok: true,
      status: 'completed',
      skipped: false,
      transcript: spoken.transcript,
      languageCode: spoken.languageCode || PHONE_STT_LANGUAGE,
      malayalamText: spoken.malayalamText || spoken.transcript,
      turns: spoken.singleSpeaker ? [] : spoken.turns,
      singleSpeaker: spoken.singleSpeaker === true,
    };
  } catch (err) {
    const message = safeMessage(err);
    await ref.set({
      transcriptionStatus: 'failed',
      transcriptionError: message,
      transcriptionUpdatedAt: FieldValue.serverTimestamp(),
    }, { merge: true }).catch(() => {});
    if (err?.code) {
      err.message = message;
      throw err;
    }
    throw fail(message, 'unavailable');
  }
}
