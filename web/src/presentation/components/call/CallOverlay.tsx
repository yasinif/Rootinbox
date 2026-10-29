/**
 * CallOverlay — Root-level call interface manager.
 * Phase 12B Task 12 (ADR-P12B-42, §15.1, §15.2).
 *
 * Mounts once at app root above the router outlet.
 * Never unmounted by route navigation.
 */

import React, { useEffect } from 'react';
import { useCallSession } from '../../hooks/useCallSession';
import { useCallMedia } from '../../hooks/useCallMedia';
import { useCallRingtone } from '../../hooks/useCallRingtone';
import { IncomingCallSheet } from './IncomingCallSheet';
import { ActiveCallPanel } from './ActiveCallPanel';
import { useAppContext } from '../../context';

export const CallOverlay: React.FC = () => {
  const session = useCallSession();
  const { receiveSignalUC } = useAppContext();
  const { mediaRef, autoplayBlocked, retryPlay } = useCallMedia(session.remoteStream ?? null);

  // Play synthesized ringtone (incoming) or ringback tone (outgoing)
  useCallRingtone({
    incoming: session.status === 'incoming_ringing',
    outgoing: session.status === 'outgoing_ringing',
  });

  useEffect(() => {
    if (session.status === 'ended') {
      const timer = setTimeout(() => {
        session.resetToIdle();
      }, 3500);
      return () => clearTimeout(timer);
    }
  }, [session.status, session.resetToIdle]);

  if (session.status === 'idle') {
    return null;
  }

  const handleAccept = async () => {
    try {
      const pending = receiveSignalUC?.getPendingOffer();
      if (pending) {
        await session.answerCall(pending.sdp, pending.sig);
        receiveSignalUC?.clearPendingOffer();
      } else {
        console.warn('[CallOverlay] handleAccept: No pending offer found');
      }
    } catch (err) {
      console.error('[CallOverlay] Error answering call:', err);
    }
  };

  const handleDecline = async () => {
    try {
      await session.endCall('remote_reject');
      receiveSignalUC?.clearPendingOffer();
    } catch (err) {
      console.error('[CallOverlay] Error declining call:', err);
    }
  };

  if (session.status === 'incoming_ringing') {
    return (
      <div id="call-overlay" data-testid="call-overlay">
        <IncomingCallSheet
          callerName={session.peerDisplayName || 'Unknown Caller'}
          callType={session.callType}
          onAccept={handleAccept}
          onDecline={handleDecline}
        />
      </div>
    );
  }

  return (
    <div id="call-overlay" data-testid="call-overlay">
      <ActiveCallPanel
        peerDisplayName={session.peerDisplayName}
        status={session.status}
        endReason={session.endReason}
        duration={session.duration}
        iceQuality={session.iceQuality}
        isMuted={session.isMuted}
        isSpeakerOn={session.isSpeakerOn}
        sasDigits={session.sasDigits}
        sasVerified={session.sasVerified}
        callType={session.callType}
        isVideoEnabled={session.isVideoEnabled}
        isScreenSharing={session.isScreenSharing}
        isRemoteVideoMuted={session.isRemoteVideoMuted}
        localVideoStream={session.localVideoStream}
        remoteVideoStream={session.remoteVideoStream}
        autoplayBlocked={autoplayBlocked}
        onToggleMute={() => session.setMuted(!session.isMuted)}
        onToggleSpeaker={() => session.setSpeaker(!session.isSpeakerOn)}
        onToggleVideo={() => void session.toggleVideo()}
        onSwitchCamera={() => void session.switchCamera()}
        onToggleScreenShare={() => void session.toggleScreenShare()}
        onVerifySas={() => session.verifySas()}
        onEndCall={() => {
          if (session.status === 'ended') {
            session.resetToIdle();
          } else {
            session.endCall('local_hangup');
          }
        }}
        onRetryAutoplay={retryPlay}
        audioRef={mediaRef as React.RefObject<HTMLAudioElement>}
      />
    </div>
  );
};
