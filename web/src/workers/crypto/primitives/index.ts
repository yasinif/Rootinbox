/**
 * Phase 12B Crypto Primitives barrel export.
 */

// Call primitives
export { buildCallKeyInfo, deriveCallKeys } from './call-keys';
export { deriveCallIVPrefix, buildCallIV } from './call-iv';
export { buildCallAAD } from './call-aad';
export { buildFingerprintPayload, parseSdpFingerprint } from './call-fingerprint';
export { computeSAS } from './call-sas';
export { sealCallFrame, openCallFrame } from './call-frame';

// Media primitives
export { buildChunkAAD } from './media-aad';
export { buildChunkNonce } from './media-nonce';
export { computeManifestHash, computeManifestHashHex } from './media-manifest';
export {
  buildThumbnailAAD, padThumbnailPlaintext, unpadThumbnailPlaintext,
  sealThumbnail, openThumbnail,
} from './media-thumbnail-wire';
export { computeTokenHash } from './media-token';
export { computeChunkCount, padChunkPlaintext, unpadChunkPlaintext } from './media-padding';
