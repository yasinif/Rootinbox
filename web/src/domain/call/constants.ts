/**
 * Call Domain Constants.
 * Phase 12B §7.1: Pure constants, zero imports.
 */

// ── Frame types (WS envelope `type` field) ──
export const CALL_FRAME_INVITE = 'call.invite' as const;
export const CALL_FRAME_ACCEPT = 'call.accept' as const;
export const CALL_FRAME_REJECT = 'call.reject' as const;
export const CALL_FRAME_ICE = 'call.ice' as const;
export const CALL_FRAME_END = 'call.end' as const;
export const CALL_FRAME_BUSY = 'call.busy' as const;
export const CALL_FRAME_RENEGOTIATE = 'call.renegotiate' as const;

export type CallFrameType =
  | typeof CALL_FRAME_INVITE
  | typeof CALL_FRAME_ACCEPT
  | typeof CALL_FRAME_REJECT
  | typeof CALL_FRAME_ICE
  | typeof CALL_FRAME_END
  | typeof CALL_FRAME_BUSY
  | typeof CALL_FRAME_RENEGOTIATE;

// ── Encrypted frame type bytes (AAD position 17) ──
export const FRAME_TYPE_OFFER = 0x01;
export const FRAME_TYPE_ANSWER = 0x02;
export const FRAME_TYPE_ICE_CANDIDATE = 0x03;
export const FRAME_TYPE_END = 0x04;
export const FRAME_TYPE_REJECT = 0x05;
export const FRAME_TYPE_RENEGOTIATE_OFFER = 0x06;
export const FRAME_TYPE_RENEGOTIATE_ANSWER = 0x07;

// ── Role bytes (fingerprint payload position 72) ──
export const ROLE_CALLER = 0x01;
export const ROLE_CALLEE = 0x02;

// ── HKDF info prefixes ──
export const CALL_KEY_PREFIX_CALLER_TO_CALLEE = 'e2ee/v1/call-signal-key/caller-to-callee';
export const CALL_KEY_PREFIX_CALLEE_TO_CALLER = 'e2ee/v1/call-signal-key/callee-to-caller';
export const CALL_IV_PREFIX_INFO = 'e2ee/v1/call-iv-prefix';
export const CALL_FINGERPRINT_PREFIX = 'e2ee/v1/call-fingerprint';

// ── Structural constants ──
/** Call key HKDF info length: prefix(40) + call_id(16) + callerHash(32) + calleeHash(32) = 120 */
export const CALL_KEY_INFO_LENGTH = 120;
/** Fingerprint signing payload length: prefix(24) + call_id(16) + fingerprint(32) + role(1) = 73 */
export const CALL_FINGERPRINT_PAYLOAD_LENGTH = 73;
/** Call AAD length: version(1) + call_id(16) + frame_type(1) + seq(8) = 26 */
export const CALL_AAD_LENGTH = 26;
/** SAS input length: callerFP(32) + calleeFP(32) + call_id(16) = 80 */
export const CALL_SAS_INPUT_LENGTH = 80;

// ── Timeouts (milliseconds) ──
/** ADR-P12B-16: Offer transmission timeout. */
export const CALL_OFFER_TIMEOUT_MS = 30_000;
/** ADR-P12B-19: Answer transmission timeout. */
export const CALL_ANSWER_TIMEOUT_MS = 30_000;
/** ADR-P12B-17: ICE gathering timeout. */
export const CALL_ICE_GATHERING_TIMEOUT_MS = 10_000;
/** Flag B / Option B2: WS drop grace period. */
export const CALL_CONTROL_PLANE_GRACE_MS = 20_000;
/** ADR-P12B-24: Ring duration (server-enforced). */
export const CALL_RING_DURATION_MS = 60_000;
/** ADR-P12B-20: ICE restart max attempts. */
export const CALL_ICE_RESTART_MAX = 3;

// ── SAS ──
/** SAS modular-reduction bias threshold. */
export const SAS_BIAS_THRESHOLD = 4_294_000_000;

// ── Crypto suite version ──
export const CALL_CRYPTO_SUITE_V1 = 0x01;
