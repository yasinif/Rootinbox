/**
 * MediaAttachmentBubble — Rich media message bubble component.
 * Phase 12B §18.1, §18.2, §23.4.
 *
 * Rules:
 * - Sanitized filename rendering (no C0/C1, no bidi overrides, collapsed whitespace, truncated)
 * - Friendly type labels (Image, Video, Audio, PDF Document, File)
 * - PENDING_DECRYPT placeholder path (ADR-P12B-30)
 * - Thumbnail-present vs thumbnail-absent rendering
 * - Telegram-style blurred silhouette before download
 * - Inline video player & audio player upon download
 * - Byte-level upload and download progress rings
 * - Download button affordance & tap to open MediaViewer
 */

import React, { useState, useRef, useMemo } from 'react';
import { sanitizeFileName } from '../../../domain/media/filename';
import { isInlineRenderable, getFriendlyTypeLabel } from '../../../domain/media/mime';
import type { MediaMetadata } from '../../../domain/media/types';
import type { DownloadMediaUseCase } from '../../../usecase/media/DownloadMediaUseCase';
import type { ThumbnailUseCase } from '../../../usecase/media/ThumbnailUseCase';
import { ThumbnailPreview } from './ThumbnailPreview';
import { MediaDownloadButton } from './MediaDownloadButton';
import { MediaViewer } from './MediaViewer';

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

interface MediaAttachmentBubbleProps {
  metadata?: MediaMetadata | null;
  fileName?: string;
  isPendingDecrypt?: boolean;
  downloadUseCase?: DownloadMediaUseCase | null;
  thumbnailUseCase?: ThumbnailUseCase | null;
  mediaKeyId?: string | null;
  status?: 'pending' | 'sent' | 'delivered' | 'seen' | 'failed';
  isUploading?: boolean;
  uploadProgress?: number;
  uploadProgressBytes?: number;
  uploadTotalBytes?: number;
  uploadError?: string;
  onRetryUpload?: () => void;
  onRetryDownload?: () => void;
  onCancelUpload?: () => void;
}

export const MediaAttachmentBubble: React.FC<MediaAttachmentBubbleProps> = ({
  metadata,
  fileName = 'attachment',
  isPendingDecrypt = false,
  downloadUseCase = null,
  thumbnailUseCase = null,
  mediaKeyId = null,
  status,
  isUploading,
  uploadProgress,
  uploadProgressBytes,
  uploadTotalBytes,
  uploadError,
  onRetryUpload,
  onCancelUpload,
}) => {
  const [viewerUrl, setViewerUrl] = useState<string | null>(null);
  const [downloadedBlobUrl, setDownloadedBlobUrl] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState(0);
  const [downloadError, setDownloadError] = useState<string | null>(null);

  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(metadata?.duration || 0);
  const [playbackRate, setPlaybackRate] = useState<1 | 1.5 | 2>(1);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const waveformBars = useMemo(() => {
    if (metadata?.waveform && metadata.waveform.length === 32) {
      return metadata.waveform;
    }
    const bars: number[] = [];
    const seed = metadata?.file_id || 'voice';
    for (let i = 0; i < 32; i++) {
      const charCode = seed.charCodeAt(i % seed.length) || 42;
      const h = 20 + ((charCode * (i + 1) * 17) % 65);
      bars.push(h);
    }
    return bars;
  }, [metadata?.waveform, metadata?.file_id]);

  // 1. PENDING_DECRYPT placeholder rendering
  if (isPendingDecrypt) {
    return (
      <div
        className="media-bubble-pending"
        style={{
          padding: 'var(--space-3)',
          backgroundColor: 'var(--color-bg-secondary)',
          borderRadius: 'var(--radius-sm)',
          fontStyle: 'italic',
          color: 'var(--color-text-secondary)',
          fontSize: 'var(--font-sm)',
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--space-2)',
        }}
      >
        <span>🔒</span>
        <span>Encrypted Attachment (Pending Decryption)</span>
      </div>
    );
  }

  const isPendingUpload = status === 'pending' || Boolean(isUploading) || uploadProgress !== undefined;

  if (!metadata && !isPendingUpload) {
    return (
      <div className="media-bubble-unavailable" style={{ fontSize: 'var(--font-sm)', color: 'var(--color-text-tertiary)' }}>
        <span>Attachment unavailable</span>
      </div>
    );
  }

  const effectiveMetadata: MediaMetadata = metadata || {
    file_id: '',
    media_key: '',
    file_iv_prefix: '',
    media_token: '',
    original_size: uploadTotalBytes || 0,
    total_chunks: 1,
    file_manifest_hash: '',
    mime_type: '',
    inline_thumbnail: null,
  };

  const sanitizedName = sanitizeFileName(fileName || effectiveMetadata.file_name || 'attachment');
  const friendlyLabel = getFriendlyTypeLabel(effectiveMetadata.mime_type);
  const formattedSize = formatBytes(uploadTotalBytes || effectiveMetadata.original_size);
  const isInline = isInlineRenderable(effectiveMetadata.mime_type);
  const progressPct = uploadProgress ?? 0;
  const isVideo = effectiveMetadata.mime_type ? effectiveMetadata.mime_type.toLowerCase().startsWith('video/') : false;
  const isAudio = effectiveMetadata.mime_type ? effectiveMetadata.mime_type.toLowerCase().startsWith('audio/') : false;
  const isImage = effectiveMetadata.mime_type ? effectiveMetadata.mime_type.toLowerCase().startsWith('image/') : false;

  const handleOpenViewer = async () => {
    if (downloadedBlobUrl) {
      setViewerUrl(downloadedBlobUrl);
      return;
    }
    if (!downloadUseCase || !metadata) return;
    try {
      setDownloadError(null);
      const res = await downloadUseCase.execute({ metadata });
      setDownloadedBlobUrl(res.blobUrl);
      setViewerUrl(res.blobUrl);
    } catch (err) {
      console.error('Failed to open viewer:', err);
      setDownloadError(err instanceof Error ? err.message : 'Failed to open media');
    }
  };

  const handleDownload = async () => {
    if (downloading) return;
    if (downloadedBlobUrl) {
      const a = document.createElement('a');
      a.href = downloadedBlobUrl;
      a.download = sanitizedName;
      a.rel = 'noopener noreferrer';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      return;
    }

    if (!downloadUseCase || !metadata) return;
    setDownloading(true);
    setDownloadProgress(0);
    setDownloadError(null);
    try {
      const res = await downloadUseCase.execute({
        metadata,
        observer: {
          onProgress(p) {
            const pct = p.totalBytes > 0 ? Math.round((p.bytesUploaded / p.totalBytes) * 100) : 0;
            setDownloadProgress(pct);
          },
          onComplete() {
            setDownloading(false);
          },
          onError(err) {
            setDownloading(false);
            setDownloadError(typeof err === 'string' ? err : 'Download failed');
          },
        },
      });
      setDownloadedBlobUrl(res.blobUrl);
      if (!isInline) {
        const a = document.createElement('a');
        a.href = res.blobUrl;
        a.download = sanitizedName;
        a.rel = 'noopener noreferrer';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
      }
    } catch (err) {
      console.error('Download failed:', err);
      setDownloadError(err instanceof Error ? err.message : 'Download failed');
    } finally {
      setDownloading(false);
    }
  };
  const togglePlayback = async () => {
    if (!downloadedBlobUrl) {
      await handleDownload();
      return;
    }
    if (!audioRef.current) return;
    if (isPlaying) {
      audioRef.current.pause();
      setIsPlaying(false);
    } else {
      audioRef.current.playbackRate = playbackRate;
      void audioRef.current.play();
      setIsPlaying(true);
    }
  };

  const handleSpeedToggle = () => {
    const nextRate: 1 | 1.5 | 2 = playbackRate === 1 ? 1.5 : playbackRate === 1.5 ? 2 : 1;
    setPlaybackRate(nextRate);
    if (audioRef.current) {
      audioRef.current.playbackRate = nextRate;
    }
  };

  const handleSeek = (index: number) => {
    if (!audioRef.current || !duration) return;
    const seekTime = (index / 32) * duration;
    audioRef.current.currentTime = seekTime;
    setCurrentTime(seekTime);
  };

  const hasPreview = Boolean(effectiveMetadata.preview_data_url || effectiveMetadata.inline_thumbnail);

  return (
    <div
      className="media-attachment-bubble media-bubble"
      style={{
        maxWidth: '320px',
        position: 'relative',
      }}
    >
      {/* 1. If media has been downloaded and is a video: render inline video player */}
      {downloadedBlobUrl && isVideo && (
        <div style={{ marginBottom: '8px', overflow: 'hidden', borderRadius: 'var(--radius-sm, 6px)' }}>
          <video
            src={downloadedBlobUrl}
            controls
            playsInline
            preload="metadata"
            style={{ width: '100%', maxHeight: '280px', display: 'block', backgroundColor: '#000' }}
          />
        </div>
      )}

      {/* 2. Audio / Voice message bubble (Telegram-style 42x42 button, 32-bar waveform, timer/size, speed toggle) */}
      {isAudio && (
        <div
          className="voice-bubble-player"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '10px',
            padding: '10px 12px',
            backgroundColor: 'var(--color-bg-secondary, rgba(255, 255, 255, 0.05))',
            borderRadius: '16px',
            marginBottom: '8px',
          }}
        >
          {downloadedBlobUrl && (
            <audio
              ref={audioRef}
              src={downloadedBlobUrl}
              onTimeUpdate={() => {
                if (audioRef.current) {
                  setCurrentTime(audioRef.current.currentTime);
                  if (audioRef.current.duration && !isNaN(audioRef.current.duration)) {
                    setDuration(audioRef.current.duration);
                  }
                }
              }}
              onLoadedMetadata={() => {
                if (audioRef.current && audioRef.current.duration && !isNaN(audioRef.current.duration)) {
                  setDuration(audioRef.current.duration);
                }
              }}
              onEnded={() => {
                setIsPlaying(false);
                setCurrentTime(0);
              }}
              style={{ display: 'none' }}
            />
          )}

          {/* 42x42 Circular Play/Pause/Download button */}
          <button
            type="button"
            onClick={togglePlayback}
            className="voice-play-btn"
            style={{
              width: '42px',
              height: '42px',
              minWidth: '42px',
              borderRadius: '50%',
              backgroundColor: 'var(--color-primary, #3b82f6)',
              color: '#ffffff',
              border: 'none',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: 'pointer',
              fontSize: '18px',
              boxShadow: '0 2px 6px rgba(0,0,0,0.25)',
            }}
            title={isPlaying ? 'Pause' : 'Play'}
          >
            {downloading ? '⏳' : isPlaying ? '⏸' : '▶'}
          </button>

          {/* 32-bar Waveform and Time/Speed */}
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '4px' }}>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '2px',
                height: '28px',
                cursor: downloadedBlobUrl ? 'pointer' : 'default',
              }}
            >
              {waveformBars.map((heightPct, idx) => {
                const activeProgress = duration > 0 ? currentTime / duration : 0;
                const barProgress = idx / 32;
                const isActive = barProgress <= activeProgress;
                return (
                  <div
                    key={idx}
                    onClick={() => handleSeek(idx)}
                    style={{
                      flex: 1,
                      height: `${Math.max(15, heightPct)}%`,
                      maxHeight: '100%',
                      backgroundColor: isActive ? 'var(--color-primary, #3b82f6)' : 'rgba(255, 255, 255, 0.25)',
                      borderRadius: '1px',
                      transition: 'background-color 0.1s ease',
                    }}
                  />
                );
              })}
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '11px', color: 'var(--color-text-tertiary, #94a3b8)' }}>
              <span>
                {isPlaying || currentTime > 0
                  ? `${Math.floor(currentTime / 60)}:${Math.floor(currentTime % 60).toString().padStart(2, '0')}`
                  : duration > 0
                  ? `${Math.floor(duration / 60)}:${Math.floor(duration % 60).toString().padStart(2, '0')}`
                  : formattedSize}
              </span>
              <button
                type="button"
                onClick={handleSpeedToggle}
                style={{
                  background: 'rgba(255, 255, 255, 0.1)',
                  border: 'none',
                  borderRadius: '10px',
                  color: 'var(--color-text-primary, #f8fafc)',
                  fontSize: '10px',
                  fontWeight: 600,
                  padding: '2px 6px',
                  cursor: 'pointer',
                }}
              >
                {playbackRate}x
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 3. If media has been downloaded and is an image: render crisp unblurred image */}
      {downloadedBlobUrl && isImage && (
        <div
          style={{
            marginBottom: '8px',
            overflow: 'hidden',
            borderRadius: 'var(--radius-sm, 6px)',
            cursor: 'pointer',
          }}
          onClick={handleOpenViewer}
        >
          <img
            src={downloadedBlobUrl}
            alt={sanitizedName}
            style={{ width: '100%', maxHeight: '280px', objectFit: 'cover', display: 'block' }}
          />
        </div>
      )}

      {/* 4. Before download: Blurred silhouette preview if preview_data_url is present */}
      {!downloadedBlobUrl && metadata?.preview_data_url && (
        <div
          className="media-thumb-area"
          style={{
            position: 'relative',
            overflow: 'hidden',
            borderRadius: 'var(--radius-sm, 6px)',
            backgroundColor: 'var(--color-bg-secondary)',
            maxHeight: '220px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: !isPendingUpload ? 'pointer' : 'default',
          }}
          onClick={!isPendingUpload ? handleDownload : undefined}
        >
          <img
            src={metadata?.preview_data_url}
            alt={sanitizedName}
            style={{
              width: '100%',
              height: 'auto',
              maxHeight: '220px',
              objectFit: 'cover',
              filter: isPendingUpload ? 'blur(4px)' : 'blur(14px)',
              transform: isPendingUpload ? 'none' : 'scale(1.06)',
              transition: 'filter 0.3s ease, transform 0.3s ease',
            }}
          />

          {/* Circular progress ring overlay during upload */}
          {isPendingUpload && (
            <div className="media-overlay-layer media-overlay-layer--dark">
              <svg width="44" height="44" viewBox="0 0 44 44">
                <circle cx="22" cy="22" r="18" fill="none" stroke="rgba(255,255,255,0.3)" strokeWidth="3" />
                <circle
                  cx="22"
                  cy="22"
                  r="18"
                  fill="none"
                  stroke="#ffffff"
                  strokeWidth="3"
                  strokeDasharray={2 * Math.PI * 18}
                  strokeDashoffset={2 * Math.PI * 18 * (1 - progressPct / 100)}
                  strokeLinecap="round"
                  transform="rotate(-90 22 22)"
                  style={{ transition: 'stroke-dashoffset 0.2s ease' }}
                />
              </svg>
              <span style={{ color: '#ffffff', fontSize: '11px', fontWeight: 600, marginTop: '4px' }}>
                {progressPct}%
              </span>
              <span style={{ color: 'rgba(255, 255, 255, 0.85)', fontSize: '10px', marginTop: '2px' }}>
                {formatBytes(uploadProgressBytes || 0)} / {formattedSize}
              </span>
            </div>
          )}

          {/* Circular download button overlay before download on recipient side */}
          {!isPendingUpload && (
            <div className="media-overlay-layer media-overlay-layer--dim">
              {downloading ? (
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                  <svg width="44" height="44" viewBox="0 0 44 44">
                    <circle cx="22" cy="22" r="18" fill="none" stroke="rgba(255,255,255,0.3)" strokeWidth="3" />
                    <circle
                      cx="22"
                      cy="22"
                      r="18"
                      fill="none"
                      stroke="#ffffff"
                      strokeWidth="3"
                      strokeDasharray={2 * Math.PI * 18}
                      strokeDashoffset={2 * Math.PI * 18 * (1 - downloadProgress / 100)}
                      strokeLinecap="round"
                      transform="rotate(-90 22 22)"
                    />
                  </svg>
                  <span style={{ color: '#fff', fontSize: '11px', fontWeight: 600, marginTop: '4px' }}>
                    {downloadProgress}%
                  </span>
                </div>
              ) : (
                <div
                  style={{
                    width: '44px',
                    height: '44px',
                    borderRadius: '50%',
                    backgroundColor: 'rgba(0, 0, 0, 0.65)',
                    color: '#ffffff',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: '20px',
                    boxShadow: '0 2px 8px rgba(0,0,0,0.3)',
                  }}
                  title="Click to download"
                >
                  ↓
                </div>
              )}
              <span style={{ color: '#ffffff', fontSize: '11px', fontWeight: 500, textShadow: '0 1px 3px rgba(0,0,0,0.8)' }}>
                {formattedSize}
              </span>
            </div>
          )}
        </div>
      )}

      {/* 5. Thumbnail path if present without preview_data_url and not yet downloaded */}
      {!downloadedBlobUrl && !metadata?.preview_data_url && metadata?.inline_thumbnail && (
        <div className="media-thumb-area" style={{ position: 'relative' }}>
          <ThumbnailPreview
            thumbnailUseCase={thumbnailUseCase}
            mediaKeyId={mediaKeyId}
            fileId={metadata?.file_id || ''}
            inlineThumbnail={metadata?.inline_thumbnail || ''}
            altText={sanitizedName}
            onClick={isInline && !isPendingUpload ? handleOpenViewer : undefined}
          />
          {isPendingUpload && (
            <div className="media-overlay-layer media-overlay-layer--dark">
              <svg width="44" height="44" viewBox="0 0 44 44">
                <circle cx="22" cy="22" r="18" fill="none" stroke="rgba(255,255,255,0.3)" strokeWidth="3" />
                <circle
                  cx="22"
                  cy="22"
                  r="18"
                  fill="none"
                  stroke="#ffffff"
                  strokeWidth="3"
                  strokeDasharray={2 * Math.PI * 18}
                  strokeDashoffset={2 * Math.PI * 18 * (1 - progressPct / 100)}
                  strokeLinecap="round"
                  transform="rotate(-90 22 22)"
                  style={{ transition: 'stroke-dashoffset 0.2s ease' }}
                />
              </svg>
              <span style={{ color: '#ffffff', fontSize: '11px', fontWeight: 600, marginTop: '4px' }}>
                {progressPct}%
              </span>
              <span style={{ color: 'rgba(255, 255, 255, 0.85)', fontSize: '10px', marginTop: '2px' }}>
                {formatBytes(uploadProgressBytes || 0)} / {formattedSize}
              </span>
              {onCancelUpload && (
                <button
                  type="button"
                  data-testid="media-cancel-upload-btn"
                  className="media-cancel-upload-btn"
                  onClick={(e) => {
                    e.stopPropagation();
                    onCancelUpload();
                  }}
                  style={{
                    marginTop: '6px',
                    padding: '3px 8px',
                    fontSize: '11px',
                    color: '#ffffff',
                    backgroundColor: 'rgba(239, 68, 68, 0.85)',
                    border: 'none',
                    borderRadius: '4px',
                    cursor: 'pointer',
                  }}
                  title="Cancel upload"
                >
                  ✕ Cancel
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {/* 6. Progress ring if no thumbnail/preview exists during upload */}
      {!hasPreview && isPendingUpload && (
        <div
          style={{
            padding: '12px',
            display: 'flex',
            alignItems: 'center',
            gap: '12px',
            backgroundColor: 'var(--color-bg-secondary)',
            borderRadius: 'var(--radius-sm)',
            marginBottom: 'var(--space-2)',
          }}
        >
          <svg width="32" height="32" viewBox="0 0 32 32">
            <circle cx="16" cy="16" r="13" fill="none" stroke="var(--color-border)" strokeWidth="3" />
            <circle
              cx="16"
              cy="16"
              r="13"
              fill="none"
              stroke="var(--color-accent)"
              strokeWidth="3"
              strokeDasharray={2 * Math.PI * 13}
              strokeDashoffset={2 * Math.PI * 13 * (1 - progressPct / 100)}
              strokeLinecap="round"
              transform="rotate(-90 16 16)"
              style={{ transition: 'stroke-dashoffset 0.2s ease' }}
            />
          </svg>
          <div style={{ fontSize: 'var(--font-xs)', color: 'var(--color-text-secondary)', flex: 1 }}>
            <div>Uploading... {progressPct}%</div>
            <div style={{ fontSize: '10px', marginTop: '2px' }}>
              {formatBytes(uploadProgressBytes || 0)} / {formattedSize}
            </div>
          </div>
          {onCancelUpload && (
            <button
              type="button"
              data-testid="media-cancel-upload-btn"
              className="media-cancel-upload-btn"
              onClick={(e) => {
                e.stopPropagation();
                onCancelUpload();
              }}
              style={{
                marginLeft: 'auto',
                padding: '4px 8px',
                fontSize: '11px',
                color: '#ef4444',
                backgroundColor: 'rgba(239, 68, 68, 0.1)',
                border: '1px solid rgba(239, 68, 68, 0.3)',
                borderRadius: '4px',
                cursor: 'pointer',
              }}
              title="Cancel upload"
            >
              ✕ Cancel
            </button>
          )}
        </div>
      )}

      <div className="media-info-area">
        <div style={{ marginBottom: 'var(--space-2)' }}>
          <div className="media-file-name">
            {sanitizedName}
          </div>
          <div className="media-file-meta">
            <span>{friendlyLabel}</span> • <span>{formattedSize}</span>
            {status === 'failed' && (
              <span style={{ color: 'var(--color-danger, #ef4444)', marginLeft: '6px' }}>• Failed</span>
            )}
          </div>
        </div>

        {/* Failed Upload Retry Row */}
        {status === 'failed' && (
          <div className="media-error-row" style={{ marginBottom: 'var(--space-2)', display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span style={{ color: 'var(--color-danger, #ef4444)', fontSize: 'var(--font-xs)', fontWeight: 500 }}>
              ⚠️ {uploadError || 'Upload failed'}
            </span>
            {onRetryUpload && (
              <button
                type="button"
                id="retry-upload-btn"
                data-testid="retry-upload-btn"
                className="media-retry-btn"
                onClick={(e) => {
                  e.stopPropagation();
                  onRetryUpload();
                }}
              >
                ↻ Retry
              </button>
            )}
          </div>
        )}

        {/* Failed Download Retry Row */}
        {downloadError && (
          <div className="media-error-row" style={{ marginBottom: 'var(--space-2)', display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span style={{ color: 'var(--color-danger, #ef4444)', fontSize: 'var(--font-xs)', fontWeight: 500 }}>
              ⚠️ {downloadError}
            </span>
            <button
              type="button"
              id="retry-download-btn"
              data-testid="retry-download-btn"
              className="media-retry-btn"
              onClick={(e) => {
                e.stopPropagation();
                void handleDownload();
              }}
            >
              ↻ Retry
            </button>
          </div>
        )}

        {/* Caption */}
        {metadata?.caption && (
          <div
            className="media-caption"
            style={{
              marginBottom: 'var(--space-2)',
              fontSize: 'var(--font-sm)',
              color: 'var(--color-text-primary)',
              wordBreak: 'break-word',
            }}
          >
            {metadata.caption}
          </div>
        )}

        <div className="media-action-row">
          {isInline && !isPendingUpload && (
            <button
              type="button"
              onClick={handleOpenViewer}
              className="btn-view media-view-btn"
            >
              View
            </button>
          )}

          {!isPendingUpload && metadata && (
            <MediaDownloadButton
              metadata={metadata}
              fileName={sanitizedName}
              downloadUseCase={downloadUseCase}
              existingBlobUrl={downloadedBlobUrl}
              onError={(err) => setDownloadError(err.message)}
            />
          )}
        </div>
      </div>

      {viewerUrl && (
        <MediaViewer
          blobUrl={viewerUrl}
          mimeType={effectiveMetadata.mime_type}
          fileName={sanitizedName}
          onClose={() => setViewerUrl(null)}
        />
      )}
    </div>
  );
};
