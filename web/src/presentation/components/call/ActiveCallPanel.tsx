/**
 * ActiveCallPanel component.
 * Phase 12B & Phase 13 Bundle 2 (§15.1, §15.3, §15.4, §15.6).
 *
 * Full-screen, floating, or minimized active call interface.
 * Shows duration, SAS, controls (mute, speaker, video, camera switch, screenshare, hangup), and diagnostics.
 * Audio and video elements bound via srcObject ref only.
 */

import React, { useRef, useEffect, useState } from 'react';
import type { CallStatus, IceQuality, CallEndReason, CallType } from '../../../domain/call/types';
import { SasBadge } from './SasBadge';
import { CallDiagnostics } from './CallDiagnostics';

export interface ActiveCallPanelProps {
  peerDisplayName: string;
  status: CallStatus;
  endReason: CallEndReason | null;
  duration: number;
  iceQuality: IceQuality;
  isMuted: boolean;
  isSpeakerOn: boolean;
  sasDigits: string | null;
  sasVerified: boolean;
  callType?: CallType;
  isVideoEnabled?: boolean;
  isScreenSharing?: boolean;
  isRemoteVideoMuted?: boolean;
  localVideoStream?: MediaStream | null;
  remoteVideoStream?: MediaStream | null;
  autoplayBlocked?: boolean;
  onToggleMute: () => void;
  onToggleSpeaker: () => void;
  onToggleVideo?: () => void;
  onSwitchCamera?: () => void;
  onToggleScreenShare?: () => void;
  onVerifySas: () => void;
  onEndCall: () => void;
  onRetryAutoplay?: () => void;
  audioRef?: React.RefObject<HTMLAudioElement | null>;
}

export type CallPanelMode = 'normal' | 'minimized' | 'fullscreen';

export const ActiveCallPanel: React.FC<ActiveCallPanelProps> = ({
  peerDisplayName,
  status,
  endReason,
  duration,
  iceQuality,
  isMuted,
  isSpeakerOn,
  sasDigits,
  sasVerified,
  callType,
  isVideoEnabled,
  isScreenSharing,
  isRemoteVideoMuted,
  localVideoStream,
  remoteVideoStream,
  autoplayBlocked,
  onToggleMute,
  onToggleSpeaker,
  onToggleVideo,
  onSwitchCamera,
  onToggleScreenShare,
  onVerifySas,
  onEndCall,
  onRetryAutoplay,
  audioRef,
}) => {
  const localVideoRef = useRef<HTMLVideoElement | null>(null);
  const remoteVideoRef = useRef<HTMLVideoElement | null>(null);
  const pipVideoRef = useRef<HTMLVideoElement | null>(null);

  const [panelMode, setPanelMode] = useState<CallPanelMode>('normal');
  const [isSwapped, setIsSwapped] = useState<boolean>(false);
  const [screenShareError, setScreenShareError] = useState<string | null>(null);

  const handleScreenShareClick = async () => {
    if (!onToggleScreenShare) return;
    setScreenShareError(null);
    try {
      await onToggleScreenShare();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'امکان اشتراک‌گذاری صفحه وجود ندارد.';
      setScreenShareError(msg);
      setTimeout(() => setScreenShareError(null), 6000);
    }
  };

  // Bind video streams to appropriate video elements depending on swapped state
  useEffect(() => {
    const pipStream = isSwapped ? remoteVideoStream : localVideoStream;

    if (!isSwapped && remoteVideoRef.current) {
      remoteVideoRef.current.srcObject = (!isRemoteVideoMuted ? remoteVideoStream : null) ?? null;
    }
    if (isSwapped && localVideoRef.current) {
      localVideoRef.current.srcObject = localVideoStream ?? null;
    }
    if (pipVideoRef.current) {
      pipVideoRef.current.srcObject = pipStream ?? null;
    }
  }, [localVideoStream, remoteVideoStream, isSwapped, isRemoteVideoMuted]);

  const isVideoCall = callType === 'video';
  const hasVideo = isVideoCall && !!(remoteVideoStream || localVideoStream || isVideoEnabled || isScreenSharing);
  const showRemoteLive = Boolean(remoteVideoStream && !isRemoteVideoMuted);

  const formatDuration = (seconds: number) => {
    const mins = Math.floor(seconds / 60).toString().padStart(2, '0');
    const secs = (seconds % 60).toString().padStart(2, '0');
    return `${mins}:${secs}`;
  };

  const getStatusText = () => {
    switch (status) {
      case 'outgoing_ringing':
        return 'در حال برقراری تماس...';
      case 'connecting':
        return 'در حال اتصال...';
      case 'connected':
        return formatDuration(duration);
      case 'reconnecting':
        return 'در حال اتصال مجدد...';
      case 'ended':
        if (endReason === 'timeout') return 'تماس بی‌پاسخ ماند (پایان خودکار)';
        if (endReason === 'remote_reject') return 'تماس رد شد';
        if (endReason === 'remote_busy') return 'کاربر در حال مکالمه است';
        if (endReason === 'ice_failure') return 'خطای اتصال شبکه';
        if (endReason === 'crypto_error') return 'خطای رمزنگاری تماس';
        return `تماس پایان یافت (${endReason ?? 'پایان'})`;
      default:
        return '';
    }
  };

  // Minimized floating pill bar (user can chat and navigate while on a call)
  if (panelMode === 'minimized') {
    return (
      <div
        id="active-call-panel"
        data-testid="active-call-panel"
        className="call-minimized-pill"
      >
        <audio
          ref={audioRef}
          autoPlay
          playsInline
          style={{ display: 'none' }}
        />
        <div className="call-minimized-info" onClick={() => setPanelMode('normal')}>
          <div className="call-minimized-avatar">
            {hasVideo ? '📹' : '📞'}
          </div>
          <div className="call-minimized-text">
            <span className="call-minimized-name">{peerDisplayName}</span>
            <span className="call-minimized-status">{getStatusText()}</span>
          </div>
        </div>

        <div className="call-minimized-actions">
          <button
            type="button"
            data-testid="mute-btn"
            onClick={onToggleMute}
            className={`call-ctrl-btn call-ctrl-btn--icon ${isMuted ? 'call-ctrl-btn--muted' : 'call-ctrl-btn--default'}`}
            title={isMuted ? 'روشن کردن میکروفون' : 'قطع میکروفون'}
          >
            {isMuted ? '🔇' : '🎤'}
          </button>

          <button
            type="button"
            data-testid="speaker-btn"
            onClick={onToggleSpeaker}
            className={`call-ctrl-btn call-ctrl-btn--icon ${isSpeakerOn ? 'call-ctrl-btn--active' : 'call-ctrl-btn--default'}`}
            title="بلندگو"
          >
            {isSpeakerOn ? '🔊' : '🔈'}
          </button>

          <button
            type="button"
            data-testid="expand-call-btn"
            onClick={() => setPanelMode('normal')}
            className="call-ctrl-btn call-ctrl-btn--icon call-ctrl-btn--default"
            title="بزرگ کردن کادر تماس"
          >
            ↗️
          </button>

          <button
            id="call-end-btn"
            type="button"
            data-testid="end-call-btn"
            onClick={onEndCall}
            className="call-ctrl-btn call-ctrl-btn--icon call-ctrl-btn--end"
            title="قطع تماس"
          >
            🛑
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      id="active-call-panel"
      data-testid="active-call-panel"
      className={`call-panel ${hasVideo ? 'call-panel--video' : ''} ${
        panelMode === 'fullscreen' ? 'call-panel--fullscreen' : ''
      }`}
    >
      {/* Audio element for remote stream (srcObject only) */}
      <audio
        ref={audioRef}
        autoPlay
        playsInline
        style={{ display: 'none' }}
      />

      {/* Top Header Actions (Minimize & Fullscreen toggle) */}
      <div className="call-panel-header">
        <button
          type="button"
          data-testid="minimize-call-btn"
          onClick={() => setPanelMode('minimized')}
          className="call-header-btn"
          title="کوچک کردن کادر تماس (امکان چت همزمان)"
        >
          ➖
        </button>
        <button
          type="button"
          data-testid="fullscreen-call-btn"
          onClick={() => setPanelMode((prev) => (prev === 'fullscreen' ? 'normal' : 'fullscreen'))}
          className="call-header-btn"
          title={panelMode === 'fullscreen' ? 'خروج از تمام‌صفحه' : 'تمام‌صفحه'}
        >
          {panelMode === 'fullscreen' ? '🗗' : '⛶'}
        </button>
      </div>

      {screenShareError && (
        <div className="call-warning-banner" role="alert">
          {screenShareError}
        </div>
      )}

      {/* Video Display Viewport */}
      {hasVideo && (
        <div
          data-testid="call-video-viewport"
          className="call-video-viewport"
        >
          {/* Main Video Area */}
          {!isSwapped ? (
            showRemoteLive ? (
              <video
                ref={remoteVideoRef}
                data-testid="remote-video"
                autoPlay
                playsInline
                style={{ width: '100%', height: '100%', objectFit: 'cover' }}
              />
            ) : (
              <div className="call-video-placeholder">
                <span className="call-video-placeholder-icon">📹</span>
                <span className="call-video-placeholder-text">تصویر طرف مقابل خاموش است</span>
              </div>
            )
          ) : (
            localVideoStream ? (
              <video
                ref={localVideoRef}
                data-testid="remote-video"
                autoPlay
                playsInline
                muted
                style={{ width: '100%', height: '100%', objectFit: 'cover' }}
              />
            ) : (
              <div className="call-video-placeholder">
                <span className="call-video-placeholder-icon">📹</span>
                <span className="call-video-placeholder-text">تصویر شما خاموش است</span>
              </div>
            )
          )}

          {/* Local / Remote Swappable PiP Video Thumbnail */}
          {((!isSwapped && localVideoStream) || (isSwapped && (remoteVideoStream || isRemoteVideoMuted))) && (
            <div
              data-testid="local-video-pip"
              className="call-local-pip"
              onClick={() => setIsSwapped((prev) => !prev)}
              title="برای جابجایی تصویر کلیک کنید"
            >
              <video
                ref={pipVideoRef}
                autoPlay
                playsInline
                muted={!isSwapped}
                style={{ width: '100%', height: '100%', objectFit: 'cover' }}
              />
              <span className="call-local-pip-label">
                {!isSwapped
                  ? (isScreenSharing ? 'صفحه شما' : 'شما')
                  : 'طرف مقابل'}
              </span>
            </div>
          )}
        </div>
      )}

      {/* Autoplay blocked affordance (§15.3) */}
      {autoplayBlocked && (
        <button
          type="button"
          data-testid="autoplay-unlock-btn"
          onClick={onRetryAutoplay}
          className="call-autoplay-btn"
        >
          لمس برای فعال‌سازی صدا
        </button>
      )}

      {/* Peer info */}
      <div className="call-peer-info">
        <h3
          data-testid="peer-display-name"
          className="call-peer-name"
        >
          {peerDisplayName}
        </h3>
        <div
          data-testid="call-status-label"
          className={`call-status ${status === 'reconnecting' ? 'call-status--reconnecting' : ''}`}
        >
          {getStatusText()}
        </div>
      </div>

      {/* SAS Badge */}
      {sasDigits && (
        <SasBadge
          sasDigits={sasDigits}
          verified={sasVerified}
          onVerify={onVerifySas}
        />
      )}

      {/* Diagnostics */}
      {status === 'connected' && (
        <CallDiagnostics iceQuality={iceQuality} />
      )}

      {/* Call controls */}
      <div className="call-controls">
        {status !== 'ended' && (
          <>
            <button
              type="button"
              data-testid="mute-btn"
              onClick={onToggleMute}
              className={`call-ctrl-btn ${isMuted ? 'call-ctrl-btn--muted' : 'call-ctrl-btn--default'}`}
            >
              {isMuted ? '🔇 صدا قطع' : '🎤 میکروفون'}
            </button>

            {isVideoCall && onToggleVideo && (
              <button
                type="button"
                data-testid="video-btn"
                onClick={onToggleVideo}
                className={`call-ctrl-btn ${isVideoEnabled ? 'call-ctrl-btn--video' : 'call-ctrl-btn--default'}`}
              >
                {isVideoEnabled ? '🚫 قطع دوربین' : '📹 دوربین'}
              </button>
            )}

            {isVideoCall && isVideoEnabled && onSwitchCamera && (
              <button
                type="button"
                data-testid="switch-camera-btn"
                onClick={onSwitchCamera}
                className="call-ctrl-btn call-ctrl-btn--default"
                title="چرخش دوربین بین جلو و عقب"
              >
                🔄 چرخش
              </button>
            )}

            {isVideoCall && onToggleScreenShare && (
              <button
                type="button"
                data-testid="screenshare-btn"
                onClick={handleScreenShareClick}
                className={`call-ctrl-btn ${isScreenSharing ? 'call-ctrl-btn--screen' : 'call-ctrl-btn--default'}`}
              >
                {isScreenSharing ? '🛑 توقف اشتراک' : '🖥️ اشتراک صفحه'}
              </button>
            )}

            <button
              type="button"
              data-testid="speaker-btn"
              onClick={onToggleSpeaker}
              className={`call-ctrl-btn ${isSpeakerOn ? 'call-ctrl-btn--active' : 'call-ctrl-btn--default'}`}
            >
              {isSpeakerOn ? '🔊 بلندگو روشن' : '🔈 بلندگو'}
            </button>
          </>
        )}

        <button
          id="call-end-btn"
          type="button"
          data-testid="end-call-btn"
          onClick={onEndCall}
          className="call-ctrl-btn call-ctrl-btn--end"
        >
          {status === 'ended' ? 'بستن' : '🛑 قطع تماس'}
        </button>
      </div>
    </div>
  );
};
