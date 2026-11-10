import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react';
import {
  Camera,
  Film,
  Image as ImageIcon,
  Mic,
  Paperclip,
  Pause,
  Send,
  Smile,
  Trash2,
  X,
} from 'lucide-react';
import {
  pickAudioMimeType,
  stopMediaStream,
} from '../../lib/captureMedia';
import { pushRecentMedia } from '../../lib/recentMediaCache';
import {
  MAX_SUPPORT_ATTACHMENTS,
  createPendingSupportFile,
  retainFileCopy,
  validateSupportFile,
  type PendingSupportFile,
} from '../../lib/supportAttachments';
import { SupportChatAttachSheet } from './SupportChatAttachSheet';
import { SupportChatCamera } from './SupportChatCamera';

export interface SupportChatComposerHandle {
  focusInput: () => void;
}

interface SupportChatComposerProps {
  text: string;
  onTextChange: (text: string) => void;
  pendingFiles: PendingSupportFile[];
  onPendingFilesChange: (files: PendingSupportFile[]) => void;
  onSend: () => void;
  onSendFiles: (files: File[]) => void;
  placeholder: string;
}

const MAX_VOICE_SECONDS = 120;
const MIN_VOICE_MS = 400;
const VOICE_WAVEFORM_BARS = 28;

function resizeComposer(el: HTMLTextAreaElement | null) {
  if (!el) return;
  el.style.height = 'auto';
  el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
}

function formatRecordTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export const SupportChatComposer = forwardRef<SupportChatComposerHandle, SupportChatComposerProps>(
  function SupportChatComposer(
    {
      text,
      onTextChange,
      pendingFiles,
      onPendingFilesChange,
      onSend,
      onSendFiles,
      placeholder,
    },
    ref,
  ) {
    const inputRef = useRef<HTMLTextAreaElement>(null);
    const galleryRef = useRef<HTMLInputElement>(null);
    const mediaStreamRef = useRef<MediaStream | null>(null);
    const mediaRecorderRef = useRef<MediaRecorder | null>(null);
    const voiceChunksRef = useRef<Blob[]>([]);
    const voiceStartedAtRef = useRef(0);
    const voicePausedMsRef = useRef(0);
    const voicePauseStartedRef = useRef(0);
    const voicePausedRef = useRef(false);
    const voiceTickRef = useRef<number | null>(null);
    const voiceTimeoutRef = useRef<number | null>(null);
    const voiceAudioContextRef = useRef<AudioContext | null>(null);
    const voiceAnalyserRef = useRef<AnalyserNode | null>(null);
    const voiceWaveformFrameRef = useRef<number | null>(null);
    const voiceWaveformDataRef = useRef<Uint8Array | null>(null);

    const [attachSheetOpen, setAttachSheetOpen] = useState(false);
    const [cameraOpen, setCameraOpen] = useState(false);
    const [recordingVoice, setRecordingVoice] = useState(false);
    const [voicePaused, setVoicePaused] = useState(false);
    const [voiceSeconds, setVoiceSeconds] = useState(0);
    const [voiceWaveform, setVoiceWaveform] = useState<number[]>(
      () => Array.from({ length: VOICE_WAVEFORM_BARS }, () => 0.12),
    );

    const canSend = Boolean(text.trim() || pendingFiles.length > 0);
    const busy = cameraOpen || recordingVoice;

    useImperativeHandle(ref, () => ({
      focusInput: () => inputRef.current?.focus(),
    }));

    const sendFilesWithRecent = async (files: File[]) => {
      await Promise.all(files.map(file => pushRecentMedia(file)));
      await onSendFiles(files);
    };

    const clearVoiceTimers = () => {
      if (voiceTickRef.current != null) window.clearInterval(voiceTickRef.current);
      if (voiceTimeoutRef.current != null) window.clearTimeout(voiceTimeoutRef.current);
      voiceTickRef.current = null;
      voiceTimeoutRef.current = null;
    };

    const voiceElapsedMs = () => {
      const pausedNow = voicePausedRef.current && voicePauseStartedRef.current
        ? Date.now() - voicePauseStartedRef.current
        : 0;
      return Date.now() - voiceStartedAtRef.current - voicePausedMsRef.current - pausedNow;
    };

    const syncVoiceSeconds = () => {
      setVoiceSeconds(Math.max(0, Math.floor(voiceElapsedMs() / 1000)));
    };

    const pauseVoiceWaveformAnimation = () => {
      if (voiceWaveformFrameRef.current != null) {
        window.cancelAnimationFrame(voiceWaveformFrameRef.current);
        voiceWaveformFrameRef.current = null;
      }
    };

    const runVoiceWaveformAnimation = () => {
      pauseVoiceWaveformAnimation();
      const tick = () => {
        const node = voiceAnalyserRef.current;
        const buffer = voiceWaveformDataRef.current;
        if (!node || !buffer) return;

        node.getByteFrequencyData(buffer as Uint8Array<ArrayBuffer>);
        const step = Math.max(1, Math.floor(buffer.length / VOICE_WAVEFORM_BARS));
        const bars = Array.from({ length: VOICE_WAVEFORM_BARS }, (_, index) => {
          const start = index * step;
          let sum = 0;
          for (let i = start; i < start + step && i < buffer.length; i += 1) {
            sum += buffer[i];
          }
          const avg = sum / step;
          return Math.max(0.12, Math.min(1, avg / 180));
        });
        setVoiceWaveform(bars);
        voiceWaveformFrameRef.current = window.requestAnimationFrame(tick);
      };
      voiceWaveformFrameRef.current = window.requestAnimationFrame(tick);
    };

    const stopVoiceWaveform = () => {
      pauseVoiceWaveformAnimation();
      voiceAnalyserRef.current = null;
      voiceWaveformDataRef.current = null;
      if (voiceAudioContextRef.current) {
        void voiceAudioContextRef.current.close().catch(() => undefined);
        voiceAudioContextRef.current = null;
      }
      setVoiceWaveform(Array.from({ length: VOICE_WAVEFORM_BARS }, () => 0.12));
    };

    const startVoiceWaveform = (stream: MediaStream) => {
      stopVoiceWaveform();
      try {
        const audioContext = new AudioContext();
        const source = audioContext.createMediaStreamSource(stream);
        const analyser = audioContext.createAnalyser();
        analyser.fftSize = 128;
        analyser.smoothingTimeConstant = 0.72;
        source.connect(analyser);
        voiceAudioContextRef.current = audioContext;
        voiceAnalyserRef.current = analyser;
        voiceWaveformDataRef.current = new Uint8Array(analyser.frequencyBinCount);
        runVoiceWaveformAnimation();
      } catch {
        // Waveform is optional — recording still works without it.
      }
    };

    useEffect(() => () => {
      clearVoiceTimers();
      stopVoiceWaveform();
      stopMediaStream(mediaStreamRef.current);
    }, []);

    const addPickedFiles = async (picked: FileList | null) => {
      if (!picked?.length) return;
      const next = [...pendingFiles];
      for (const file of Array.from(picked)) {
        if (next.length >= MAX_SUPPORT_ATTACHMENTS) break;
        try {
          const retained = await retainFileCopy(file);
          const err = validateSupportFile(retained);
          if (err) {
            window.alert(err);
            continue;
          }
          await pushRecentMedia(retained);
          next.push(createPendingSupportFile(retained));
        } catch (err) {
          window.alert(err instanceof Error ? err.message : `Could not read ${file.name}.`);
        }
      }
      onPendingFilesChange(next);
    };

    const removePendingFile = (id: string) => {
      const target = pendingFiles.find(f => f.id === id);
      if (target?.previewUrl) URL.revokeObjectURL(target.previewUrl);
      onPendingFilesChange(pendingFiles.filter(f => f.id !== id));
    };

    const startVoiceRecording = async () => {
      if (busy || canSend || recordingVoice) return;

      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        mediaStreamRef.current = stream;
        startVoiceWaveform(stream);

        const mimeType = pickAudioMimeType();
        const recorder = mimeType
          ? new MediaRecorder(stream, { mimeType })
          : new MediaRecorder(stream);

        voiceChunksRef.current = [];
        recorder.ondataavailable = event => {
          if (event.data.size > 0) voiceChunksRef.current.push(event.data);
        };

        mediaRecorderRef.current = recorder;
        recorder.start();
        voiceStartedAtRef.current = Date.now();
        voicePausedMsRef.current = 0;
        voicePauseStartedRef.current = 0;
        setRecordingVoice(true);
        voicePausedRef.current = false;
        setVoicePaused(false);
        setVoiceSeconds(0);

        voiceTickRef.current = window.setInterval(syncVoiceSeconds, 250);

        voiceTimeoutRef.current = window.setTimeout(() => {
          void finishVoiceRecording(false);
        }, MAX_VOICE_SECONDS * 1000);
      } catch {
        setRecordingVoice(false);
        setVoicePaused(false);
        stopVoiceWaveform();
        stopMediaStream(mediaStreamRef.current);
        mediaStreamRef.current = null;
      }
    };

    const toggleVoicePause = () => {
      const recorder = mediaRecorderRef.current;
      if (!recorder || !recordingVoice) return;

      if (recorder.state === 'recording') {
        recorder.pause();
        clearVoiceTimers();
        voicePauseStartedRef.current = Date.now();
        voicePausedRef.current = true;
        setVoicePaused(true);
        pauseVoiceWaveformAnimation();
        return;
      }

      if (recorder.state === 'paused') {
        voicePausedMsRef.current += Date.now() - voicePauseStartedRef.current;
        voicePauseStartedRef.current = 0;
        recorder.resume();
        voicePausedRef.current = false;
        setVoicePaused(false);
        voiceTickRef.current = window.setInterval(syncVoiceSeconds, 250);
        voiceTimeoutRef.current = window.setTimeout(() => {
          void finishVoiceRecording(false);
        }, Math.max(0, MAX_VOICE_SECONDS * 1000 - voiceElapsedMs()));
        runVoiceWaveformAnimation();
      }
    };

    const finishVoiceRecording = async (cancelled: boolean) => {
      const recorder = mediaRecorderRef.current;
      clearVoiceTimers();
      stopVoiceWaveform();

      if (!recorder || recorder.state === 'inactive') {
        setRecordingVoice(false);
        setVoicePaused(false);
        setVoiceSeconds(0);
        stopMediaStream(mediaStreamRef.current);
        mediaStreamRef.current = null;
        return;
      }

      const duration = voiceElapsedMs();

      recorder.onstop = async () => {
        const blob = new Blob(voiceChunksRef.current, { type: recorder.mimeType || 'audio/webm' });
        voiceChunksRef.current = [];
        mediaRecorderRef.current = null;
        stopMediaStream(mediaStreamRef.current);
        mediaStreamRef.current = null;
        setRecordingVoice(false);
        voicePausedRef.current = false;
        setVoicePaused(false);
        setVoiceSeconds(0);
        voicePausedMsRef.current = 0;
        voicePauseStartedRef.current = 0;

        if (!cancelled && duration >= MIN_VOICE_MS && blob.size > 0) {
          const ext = blob.type.includes('ogg') ? 'ogg' : 'webm';
          const file = new File([blob], `voice-${Date.now()}.${ext}`, {
            type: blob.type || 'audio/webm',
            lastModified: Date.now(),
          });
          await sendFilesWithRecent([file]);
        }
      };

      if (recorder.state === 'paused') {
        recorder.resume();
      }
      recorder.stop();
    };

    return (
      <>
        <form
          className="support-chat__composer"
          onSubmit={e => {
            e.preventDefault();
            if (canSend) onSend();
          }}
        >
          {pendingFiles.length > 0 && (
            <ul className="support-attachment-picker__previews support-attachment-picker__previews--compact">
              {pendingFiles.map(item => (
                <li key={item.id} className="support-attachment-picker__preview">
                  {item.kind === 'video' ? (
                    <video src={item.previewUrl} className="support-attachment-picker__media" muted />
                  ) : item.kind === 'audio' ? (
                    <span className="support-attachment-picker__audio-thumb" aria-hidden>
                      <Mic size={18} />
                    </span>
                  ) : item.kind === 'document' ? (
                    <span className="support-attachment-picker__audio-thumb" aria-hidden>
                      <Paperclip size={18} />
                    </span>
                  ) : (
                    <img src={item.previewUrl} alt="" className="support-attachment-picker__media" />
                  )}
                  <span className="support-attachment-picker__badge" aria-hidden>
                    {item.kind === 'video' ? <Film size={12} /> : item.kind === 'audio' ? <Mic size={12} /> : item.kind === 'document' ? <Paperclip size={12} /> : <ImageIcon size={12} />}
                  </span>
                  <button
                    type="button"
                    className="support-attachment-picker__remove"
                    aria-label={`Remove ${item.file.name}`}
                    onClick={() => removePendingFile(item.id)}
                  >
                    <X size={14} />
                  </button>
                </li>
              ))}
            </ul>
          )}

          {recordingVoice ? (
            <div className="support-chat__voice-panel" role="group" aria-label="Voice recording">
              <button
                type="button"
                className="support-chat__voice-btn support-chat__voice-btn--delete"
                aria-label="Delete recording"
                onClick={() => void finishVoiceRecording(true)}
              >
                <Trash2 size={22} />
              </button>

              <div className="support-chat__voice-track">
                <span className="support-chat__voice-time">{formatRecordTime(voiceSeconds)}</span>
                <div className="support-chat__voice-waveform" aria-hidden>
                  {voiceWaveform.map((level, index) => (
                    <span
                      key={index}
                      className="support-chat__voice-waveform-bar"
                      style={{ transform: `scaleY(${level})` }}
                    />
                  ))}
                </div>
              </div>

              <button
                type="button"
                className="support-chat__voice-btn support-chat__voice-btn--pause"
                aria-label={voicePaused ? 'Resume recording' : 'Pause recording'}
                onClick={toggleVoicePause}
              >
                {voicePaused ? <Mic size={22} /> : <Pause size={22} fill="currentColor" />}
              </button>

              <button
                type="button"
                className="support-chat__action support-chat__action--send support-chat__voice-send"
                aria-label="Send voice note"
                onClick={() => void finishVoiceRecording(false)}
              >
                <Send size={18} />
              </button>
            </div>
          ) : (
            <div className="support-chat__composer-bar">
              <button
                type="button"
                className="support-chat__emoji-btn"
                aria-label="Emoji"
                disabled={busy}
                onClick={() => inputRef.current?.focus()}
              >
                <Smile size={22} />
              </button>

              <div className="support-chat__pill">
                <textarea
                  ref={inputRef}
                  className="support-chat__input"
                  rows={1}
                  placeholder={placeholder}
                  value={text}
                  onChange={e => {
                    onTextChange(e.target.value);
                    resizeComposer(e.currentTarget);
                  }}
                  disabled={busy}
                  aria-label="Message"
                />

                <div className="support-chat__pill-actions">
                  <button
                    type="button"
                    className="support-chat__pill-btn"
                    aria-label="Attach"
                    aria-expanded={attachSheetOpen}
                    disabled={busy}
                    onClick={() => setAttachSheetOpen(true)}
                  >
                    <Paperclip size={20} />
                  </button>
                  <button
                    type="button"
                    className="support-chat__pill-btn"
                    aria-label="Camera"
                    disabled={busy}
                    onClick={() => setCameraOpen(true)}
                  >
                    <Camera size={20} />
                  </button>
                </div>
              </div>

              {canSend ? (
                <button
                  type="submit"
                  className="support-chat__action support-chat__action--send"
                  disabled={busy}
                  aria-label="Send message"
                >
                  <Send size={18} />
                </button>
              ) : (
                <button
                  type="button"
                  className="support-chat__action support-chat__action--mic"
                  disabled={busy}
                  aria-label="Record voice note"
                  onClick={() => void startVoiceRecording()}
                >
                  <Mic size={20} />
                </button>
              )}
            </div>
          )}
        </form>

        <input
          ref={galleryRef}
          type="file"
          accept="image/*,image/jpeg,image/png,image/webp,image/heic,image/heif,.jpg,.jpeg,.png,.webp,.heic,.heif,video/*,video/mp4,video/quicktime,video/webm,.mp4,.mov,.webm,.m4v"
          multiple
          hidden
          onChange={e => {
            void (async () => {
              await addPickedFiles(e.target.files);
              if (galleryRef.current) galleryRef.current.value = '';
            })();
          }}
        />

        <SupportChatAttachSheet
          open={attachSheetOpen}
          onClose={() => setAttachSheetOpen(false)}
          onSendFiles={sendFilesWithRecent}
          onPickGallery={() => galleryRef.current?.click()}
        />

        {cameraOpen && (
          <SupportChatCamera
            onClose={() => setCameraOpen(false)}
            onSendFiles={sendFilesWithRecent}
            onPickGallery={() => galleryRef.current?.click()}
          />
        )}
      </>
    );
  },
);
