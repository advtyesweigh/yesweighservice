import { useEffect, useRef, useState } from 'react';
import {
  Circle,
  FlipHorizontal2,
  Images,
  X,
} from 'lucide-react';
import {
  capturePhotoFromVideo,
  createVideoFileFromBlob,
  createVideoMediaRecorder,
  finalizeMediaRecorder,
  prepareVideoFileForUpload,
  recommendedRecorderTimeslice,
  stopMediaStream,
} from '../../lib/captureMedia';
import { getRecentMedia, pushRecentMedia, subscribeRecentMedia } from '../../lib/recentMediaCache';
import { cameraPermissionErrorMessage, getEvidenceCameraStream } from '../../lib/mediaPermissions';
import { validateSupportFile } from '../../lib/supportAttachments';

interface SupportChatCameraProps {
  onClose: () => void;
  onSendFiles: (files: File[]) => void | Promise<void>;
  onPickGallery: () => void;
}

const MAX_RECORD_SECONDS = 120;
const LONG_PRESS_MS = 380;

function formatRecordTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function useRecentMedia() {
  const [, setTick] = useState(0);
  useEffect(() => subscribeRecentMedia(() => setTick(t => t + 1)), []);
  return getRecentMedia();
}

export function SupportChatCamera({ onClose, onSendFiles, onPickGallery }: SupportChatCameraProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const tickRef = useRef<number | null>(null);
  const timeoutRef = useRef<number | null>(null);
  const holdTimerRef = useRef<number | null>(null);
  const pointerDownAtRef = useRef(0);
  const longPressStartedRef = useRef(false);
  const stopOnUpRef = useRef(false);
  const recordingRef = useRef(false);

  const [facingMode, setFacingMode] = useState<'environment' | 'user'>('environment');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [recording, setRecording] = useState(false);
  const [recordSeconds, setRecordSeconds] = useState(0);
  const recentMedia = useRecentMedia();

  recordingRef.current = recording;

  const clearTimers = () => {
    if (tickRef.current != null) window.clearInterval(tickRef.current);
    if (timeoutRef.current != null) window.clearTimeout(timeoutRef.current);
    if (holdTimerRef.current != null) window.clearTimeout(holdTimerRef.current);
    tickRef.current = null;
    timeoutRef.current = null;
    holdTimerRef.current = null;
  };

  const stopStream = () => {
    stopMediaStream(streamRef.current);
    streamRef.current = null;
  };

  const cleanup = () => {
    clearTimers();
    recorderRef.current = null;
    chunksRef.current = [];
    longPressStartedRef.current = false;
    stopOnUpRef.current = false;
    stopStream();
    setRecording(false);
    setRecordSeconds(0);
  };

  useEffect(() => () => cleanup(), []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    stopStream();

    void getEvidenceCameraStream(facingMode, true)
      .then(stream => {
        if (cancelled) {
          stopMediaStream(stream);
          return;
        }
        streamRef.current = stream;
        const video = videoRef.current;
        if (video) {
          video.srcObject = stream;
          video.muted = true;
          void video.play().catch(() => undefined);
        }
        setLoading(false);
      })
      .catch(err => {
        if (!cancelled) {
          setError(cameraPermissionErrorMessage(err, 'Could not open camera. Check permissions and try again.'));
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
      stopStream();
    };
  }, [facingMode]);

  const handleClose = () => {
    cleanup();
    onClose();
  };

  const capturePhoto = async () => {
    const video = videoRef.current;
    if (!video || loading || error || recordingRef.current) return;
    setLoading(true);
    try {
      const file = await capturePhotoFromVideo(video);
      await pushRecentMedia(file);
      cleanup();
      onClose();
      await onSendFiles([file]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not capture photo.');
      setLoading(false);
    }
  };

  const stopRecording = async (send: boolean) => {
    const recorder = recorderRef.current;
    if (!recorder || recorder.state === 'inactive') return;

    try {
      const durationMs = Math.max(recordSeconds, 1) * 1000;
      const blob = await finalizeMediaRecorder(recorder, chunksRef.current);
      clearTimers();
      chunksRef.current = [];
      recorderRef.current = null;
      longPressStartedRef.current = false;
      setRecording(false);
      setRecordSeconds(0);

      if (send) {
        const mimeType = blob.type || recorder.mimeType || 'video/webm';
        const rawFile = createVideoFileFromBlob(blob, mimeType);
        const file = await prepareVideoFileForUpload(rawFile, durationMs);
        await pushRecentMedia(file);
        cleanup();
        onClose();
        await onSendFiles([file]);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save video.');
      cleanup();
    }
  };

  const startRecording = () => {
    const stream = streamRef.current;
    if (!stream || recordingRef.current) return;

    let recorder: MediaRecorder;
    try {
      recorder = createVideoMediaRecorder(stream);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Video recording is not supported.');
      return;
    }

    chunksRef.current = [];
    recorder.ondataavailable = event => {
      if (event.data.size > 0) chunksRef.current.push(event.data);
    };
    recorderRef.current = recorder;
    const timeslice = recommendedRecorderTimeslice(recorder.mimeType);
    if (timeslice) recorder.start(timeslice);
    else recorder.start();
    setRecording(true);
    setRecordSeconds(0);

    tickRef.current = window.setInterval(() => {
      setRecordSeconds(prev => prev + 1);
    }, 1000);

    timeoutRef.current = window.setTimeout(() => {
      void stopRecording(true);
    }, MAX_RECORD_SECONDS * 1000);
  };

  const onShutterPointerDown = () => {
    if (loading || error) return;
    pointerDownAtRef.current = Date.now();
    longPressStartedRef.current = false;
    stopOnUpRef.current = false;

    if (recordingRef.current) {
      stopOnUpRef.current = true;
      return;
    }

    holdTimerRef.current = window.setTimeout(() => {
      if (recordingRef.current) return;
      longPressStartedRef.current = true;
      startRecording();
    }, LONG_PRESS_MS);
  };

  const onShutterPointerUp = () => {
    if (holdTimerRef.current != null) {
      window.clearTimeout(holdTimerRef.current);
      holdTimerRef.current = null;
    }

    if (recordingRef.current) {
      if (stopOnUpRef.current) {
        void stopRecording(true);
      }
      stopOnUpRef.current = false;
      return;
    }

    if (longPressStartedRef.current) {
      longPressStartedRef.current = false;
      return;
    }

    if (Date.now() - pointerDownAtRef.current < LONG_PRESS_MS) {
      void capturePhoto();
    }
  };

  const sendRecent = async (file: File) => {
    const err = validateSupportFile(file);
    if (err) {
      window.alert(err);
      return;
    }
    cleanup();
    onClose();
    await onSendFiles([file]);
  };

  return (
    <div className="support-chat__camera" role="dialog" aria-label="Camera">
      <div className="support-chat__camera-top">
        <button type="button" className="support-chat__camera-top-btn" onClick={handleClose} aria-label="Close">
          <X size={22} />
        </button>
      </div>

      <div className="support-chat__camera-body">
        {error ? (
          <p className="support-chat__camera-error">{error}</p>
        ) : (
          <>
            <video
              ref={videoRef}
              className="support-chat__camera-preview"
              muted
              playsInline
              autoPlay
            />
            {recording && (
              <span className="support-chat__camera-rec-badge">
                <Circle size={10} fill="currentColor" />
                {formatRecordTime(recordSeconds)}
              </span>
            )}
          </>
        )}
      </div>

      <div className="support-chat__camera-bottom">
        {recentMedia.length > 0 && (
          <div className="support-chat__camera-recent">
            <div className="support-chat__camera-recent-scroll">
              {recentMedia.map(item => (
                <button
                  key={item.id}
                  type="button"
                  className="support-chat__camera-recent-thumb"
                  onClick={() => void sendRecent(item.file)}
                >
                  {item.kind === 'video' ? (
                    <video src={item.previewUrl} muted playsInline preload="metadata" />
                  ) : (
                    <img src={item.previewUrl} alt="" />
                  )}
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="support-chat__camera-controls">
          <button
            type="button"
            className="support-chat__camera-flip support-evidence-camera__gallery-btn"
            aria-label="Choose photo or video from gallery"
            disabled={recording}
            onClick={() => {
              cleanup();
              onClose();
              onPickGallery();
            }}
          >
            <Images size={22} />
          </button>

          <button
            type="button"
            className={`support-chat__camera-shutter${recording ? ' support-chat__camera-shutter--recording support-chat__camera-shutter--stop' : ''}`}
            disabled={loading || Boolean(error)}
            aria-label={recording ? 'Stop recording' : 'Take photo or hold to record video'}
            onPointerDown={onShutterPointerDown}
            onPointerUp={onShutterPointerUp}
            onPointerCancel={onShutterPointerUp}
          />

          <button
            type="button"
            className="support-chat__camera-flip"
            aria-label="Switch camera"
            disabled={loading || recording}
            onClick={() => setFacingMode(f => (f === 'environment' ? 'user' : 'environment'))}
          >
            <FlipHorizontal2 size={22} />
          </button>
        </div>
      </div>
    </div>
  );
}
