/**
 * Phase 12B Domain Error Codes.
 * Pure string constants, zero imports.
 */

// ── Call errors (CALL_C01..C09) ──
/** No active call session. */
export const CALL_C01 = 'CALL_C01' as const;
/** Peer unreachable (directory lookup failed). */
export const CALL_C02 = 'CALL_C02' as const;
/** Crypto key derivation failed. */
export const CALL_C03 = 'CALL_C03' as const;
/** Fingerprint verification failed — MUST abort. */
export const CALL_C04 = 'CALL_C04' as const;
/** SAS computation failed (all rehash attempts exhausted). */
export const CALL_C05 = 'CALL_C05' as const;
/** ICE connection failure (all restart attempts exhausted). */
export const CALL_C06 = 'CALL_C06' as const;
/** Signaling frame decryption failed. */
export const CALL_C07 = 'CALL_C07' as const;
/** Signaling replay detected. */
export const CALL_C08 = 'CALL_C08' as const;
/** Glare resolution — this side yields. */
export const CALL_C09 = 'CALL_C09' as const;

// ── Media errors (MED_C01..C07) ──
/** Upload initialization failed. */
export const MED_C01 = 'MED_C01' as const;
/** Chunk encryption/upload failed. */
export const MED_C02 = 'MED_C02' as const;
/** Finalization failed (manifest hash mismatch). */
export const MED_C03 = 'MED_C03' as const;
/** Download/decryption failed. */
export const MED_C04 = 'MED_C04' as const;
/** Thumbnail generation/encoding failed. */
export const MED_C05 = 'MED_C05' as const;
/** File exceeds maximum size. */
export const MED_C06 = 'MED_C06' as const;
/** Quota exceeded. */
export const MED_C07 = 'MED_C07' as const;

// ── Push errors (PSH_C01..C03) ──
/** Push subscription failed. */
export const PSH_C01 = 'PSH_C01' as const;
/** VAPID key fetch failed. */
export const PSH_C02 = 'PSH_C02' as const;
/** Service worker registration failed. */
export const PSH_C03 = 'PSH_C03' as const;

/** Union type of all Phase 12B error codes. */
export type Phase12BErrorCode =
  | typeof CALL_C01 | typeof CALL_C02 | typeof CALL_C03
  | typeof CALL_C04 | typeof CALL_C05 | typeof CALL_C06
  | typeof CALL_C07 | typeof CALL_C08 | typeof CALL_C09
  | typeof MED_C01 | typeof MED_C02 | typeof MED_C03
  | typeof MED_C04 | typeof MED_C05 | typeof MED_C06
  | typeof MED_C07
  | typeof PSH_C01 | typeof PSH_C02 | typeof PSH_C03;
