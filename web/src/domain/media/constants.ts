/**
 * Media Domain Constants.
 * Phase 12B §7.3: Pure constants, zero imports.
 */

// ── Chunk sizing ──
/** RFC-0007 §3.1: Each chunk plaintext is exactly 5,242,880 bytes (5 MiB). */
export const CHUNK_PLAINTEXT_SIZE = 5_242_880;
/** RFC-0007 §3.1: Ciphertext = plaintext + 16-byte GCM tag. */
export const CHUNK_CIPHERTEXT_SIZE = 5_242_896;
/** RFC-0007 §3.2: GCM authentication tag size. */
export const GCM_TAG_SIZE = 16;
/** RFC-0007 §8.1: Maximum number of chunks per file. */
export const MAX_TOTAL_CHUNKS = 400;
/** Derived: maximum file size in bytes (5 MiB * 400). */
export const MAX_FILE_SIZE = CHUNK_PLAINTEXT_SIZE * MAX_TOTAL_CHUNKS;

// ── Chunk AAD layout ──
/** Chunk AAD length: version(1) + file_id(16) + chunk_index(4) + total_chunks(4) = 25 */
export const CHUNK_AAD_LENGTH = 25;

// ── Thumbnail (ADR-P12B-35) ──
/** Fixed padded thumbnail plaintext size. */
export const THUMBNAIL_PADDED_SIZE = 32_768;
/** Maximum image payload within a thumbnail (32768 - 4 = 32764). */
export const THUMBNAIL_MAX_IMAGE_SIZE = 32_764;
/** Thumbnail AAD length: version(1) + file_id(16) = 17 */
export const THUMBNAIL_AAD_LENGTH = 17;
/** Thumbnail wire size: version(1) + IV(12) + ciphertext(32768+16) = 32797 */
export const THUMBNAIL_WIRE_SIZE = 32_797;

// ── Media token ──
/** V-1: token_hash uses lowercase hex, NOT Base64. */
export const TOKEN_HASH_ENCODING = 'lowercase-hex' as const;

// ── Upload budget ──
/** Client-side defense-in-depth upload bucket: 30 chunks/minute. */
export const UPLOAD_BUDGET_PER_MINUTE = 30;

// ── Crypto suite version ──
export const MEDIA_CRYPTO_SUITE_V1 = 0x01;
