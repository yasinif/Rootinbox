/**
 * Media Manifest Hash.
 * Phase 12B §8.9: SHA256(concat of raw chunk hashes in index order).
 *
 * Each chunk hash is the SHA-256 of the ciphertext.
 * Manifest = SHA-256(hash_0 || hash_1 || ... || hash_N-1).
 * V-3: result is encoded as **lowercase hex** for the server.
 */

import { sha256 } from '../encoding';
import { hexEncode } from '../encoding';

/**
 * Compute the file manifest hash from ordered chunk hashes.
 * @param chunkHashes Array of 32-byte chunk hashes in index order.
 * @returns 32-byte manifest hash.
 */
export async function computeManifestHash(chunkHashes: Uint8Array[]): Promise<Uint8Array> {
  const totalLen = chunkHashes.length * 32;
  const concat = new Uint8Array(totalLen);
  for (let i = 0; i < chunkHashes.length; i++) {
    concat.set(chunkHashes[i], i * 32);
  }
  return sha256(concat);
}

/**
 * Compute the file manifest hash as a lowercase hex string (for the server).
 */
export async function computeManifestHashHex(chunkHashes: Uint8Array[]): Promise<string> {
  const hash = await computeManifestHash(chunkHashes);
  return hexEncode(hash);
}
