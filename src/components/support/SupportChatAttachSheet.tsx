import { useEffect, useRef, useState } from 'react';
import { FileText, Image as ImageIcon, Images, X } from 'lucide-react';
import { getRecentMedia, subscribeRecentMedia } from '../../lib/recentMediaCache';
import { retainFileCopy, validateSupportFile } from '../../lib/supportAttachments';

const DOCUMENT_ACCEPT = [
  '.pdf',
  '.doc',
  '.docx',
  '.xls',
  '.xlsx',
  '.ppt',
  '.pptx',
  '.txt',
  '.csv',
  '.zip',
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'text/plain',
  'text/csv',
  'application/zip',
].join(',');

interface SupportChatAttachSheetProps {
  open: boolean;
  onClose: () => void;
  onSendFiles: (files: File[]) => void | Promise<void>;
  onPickGallery: () => void;
}

function useRecentMedia() {
  const [, setTick] = useState(0);
  useEffect(() => subscribeRecentMedia(() => setTick(t => t + 1)), []);
  return getRecentMedia();
}

export function SupportChatAttachSheet({
  open,
  onClose,
  onSendFiles,
  onPickGallery,
}: SupportChatAttachSheetProps) {
  const documentRef = useRef<HTMLInputElement>(null);
  const recentMedia = useRecentMedia();

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  const sendRecent = async (file: File) => {
    const err = validateSupportFile(file);
    if (err) {
      window.alert(err);
      return;
    }
    onClose();
    await onSendFiles([file]);
  };

  return (
    <div className="support-chat__attach-sheet-root" role="presentation">
      <button
        type="button"
        className="support-chat__attach-sheet-backdrop"
        aria-label="Close attachments"
        onClick={onClose}
      />

      <div className="support-chat__attach-sheet" role="dialog" aria-label="Attach">
        <div className="support-chat__attach-sheet-handle" aria-hidden />

        <div className="support-chat__attach-grid">
          <button
            type="button"
            className="support-chat__attach-item"
            onClick={() => documentRef.current?.click()}
          >
            <span className="support-chat__attach-icon support-chat__attach-icon--document">
              <FileText size={24} strokeWidth={1.75} />
            </span>
            <span className="support-chat__attach-label">Document</span>
          </button>
          <button
            type="button"
            className="support-chat__attach-item"
            onClick={() => {
              onClose();
              onPickGallery();
            }}
          >
            <span className="support-chat__attach-icon support-chat__attach-icon--gallery">
              <Images size={24} strokeWidth={1.75} />
            </span>
            <span className="support-chat__attach-label">Gallery</span>
          </button>
        </div>

        <div className="support-chat__attach-recent">
          <div className="support-chat__attach-recent-scroll">
            <button
              type="button"
              className="support-chat__attach-recent-thumb support-chat__attach-recent-thumb--gallery"
              aria-label="Choose photo or video from gallery"
              onClick={() => {
                onClose();
                onPickGallery();
              }}
            >
              <ImageIcon size={22} />
            </button>
            {recentMedia.map(item => (
              <button
                key={item.id}
                type="button"
                className="support-chat__attach-recent-thumb"
                onClick={() => void sendRecent(item.file)}
              >
                {item.kind === 'video' ? (
                  <video src={item.previewUrl} muted playsInline preload="metadata" />
                ) : (
                  <img src={item.previewUrl} alt="" />
                )}
                {item.kind === 'video' && (
                  <span className="support-chat__attach-recent-video-badge" aria-hidden>
                    <span />
                  </span>
                )}
              </button>
            ))}
          </div>
        </div>

        <button
          type="button"
          className="support-chat__attach-sheet-close"
          aria-label="Close"
          onClick={onClose}
        >
          <X size={22} />
        </button>
      </div>

      <input
        ref={documentRef}
        type="file"
        accept={DOCUMENT_ACCEPT}
        hidden
        onChange={e => {
          void (async () => {
            const file = e.target.files?.[0];
            if (!file) return;
            try {
              const retained = await retainFileCopy(file);
              if (documentRef.current) documentRef.current.value = '';
              const err = validateSupportFile(retained);
              if (err) {
                window.alert(err);
                return;
              }
              onClose();
              await onSendFiles([retained]);
            } catch (err) {
              if (documentRef.current) documentRef.current.value = '';
              window.alert(err instanceof Error ? err.message : 'Could not read document.');
            }
          })();
        }}
      />
    </div>
  );
}
