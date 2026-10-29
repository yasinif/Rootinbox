/**
 * Media Token.
 * Phase 12B §8.11 + V-1: token_hash = lowercase hex SHA-256 of the token.
 *
 * DEVIATION FROM RFC-0007 §7.1: The RFC says "Base64(SHA256(token))" but
 * the server implementation at media_usecase.go:391 uses hex.EncodeToString.
 * The client MUST follow the server implementation.
 */

import { sha256, hexEncode } from '../encoding';

/**
 * Compute the token_hash as lowercase hex.
 * @param token Raw 32-byte media token.
 * @returns Lowercase hex string of SHA-256(token).
 */
export async function computeTokenHash(token: Uint8Array): Promise<string> {
  const hash = await sha256(token);
  return hexEncode(hash);
}
