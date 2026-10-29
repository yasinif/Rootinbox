/**
 * useCallSession hook.
 * Phase 12B Task 12 (§15.1).
 *
 * Exposes reactive CallSessionState and call control actions.
 */

import { useSyncExternalStore, useCallback } from 'react';
import { useAppContext } from '../context';
import type { CallSessionState, CallEndReason } from '../../domain/call/types';

export function useCallSession(): CallSessionState & {
  placeCall: (peerIdentityHash: string, peerDisplayName: string, localIdentityHash: string, callType?: import('../../domain/call/types').CallType) => Promise<string>;
  answerCall: (remoteSdp: string, remoteSig: string) => Promise<void>;
  endCall: (reason?: CallEndReason) => Promise<void>;
  setMuted: (muted: boolean) => void;
  setSpeaker: (speaker: boolean) => void;
  toggleVideo: () => Promise<void>;
  switchCamera: () => Promise<void>;
  toggleScreenShare: () => Promise<void>;
  resetToIdle: () => void;
  verifySas: () => void;
} {
  const { callMachine, placeCallUC, answerCallUC, endCallUC } = useAppContext();

  const state = useSyncExternalStore(
    useCallback((cb: () => void) => callMachine.subscribe(cb), [callMachine]),
    () => callMachine.getState(),
  );

  const placeCall = useCallback(
    (peerIdentityHash: string, peerDisplayName: string, localIdentityHash: string, callType?: import('../../domain/call/types').CallType) =>
      placeCallUC.execute({ peerIdentityHash, peerDisplayName, localIdentityHash, callType }),
    [placeCallUC],
  );

  const answerCall = useCallback(
    (remoteSdp: string, remoteSig: string) => answerCallUC.execute({ remoteSdp, remoteSig }),
    [answerCallUC],
  );

  const endCall = useCallback(
    (reason?: CallEndReason) => endCallUC.execute(reason),
    [endCallUC],
  );

  const setMuted = useCallback((muted: boolean) => callMachine.setMuted(muted), [callMachine]);
  const setSpeaker = useCallback((speaker: boolean) => callMachine.setSpeaker(speaker), [callMachine]);
  const toggleVideo = useCallback(() => callMachine.toggleVideo(), [callMachine]);
  const switchCamera = useCallback(() => callMachine.switchCamera(), [callMachine]);
  const toggleScreenShare = useCallback(() => callMachine.toggleScreenShare(), [callMachine]);
  const resetToIdle = useCallback(() => callMachine.resetToIdle(), [callMachine]);
  const verifySas = useCallback(() => callMachine.verifySas(), [callMachine]);

  return {
    ...state,
    placeCall,
    answerCall,
    endCall,
    setMuted,
    setSpeaker,
    toggleVideo,
    switchCamera,
    toggleScreenShare,
    resetToIdle,
    verifySas,
  };
}
