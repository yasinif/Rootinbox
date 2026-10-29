/**
 * HKDF-SHA256 key derivation via WebCrypto.
 * RFC-0003 §4.3: Per-message key derivation.
 * RFC-0003 §4.3: Derived message keys MUST NOT be cached.
 *
 * WebCrypto is the preferred backend; sodium fallback is available
 * but not needed in any modern browser.
 *
 * Salt = SHA256("rootinbox-hkdf-salt-v1") — asserted at init.
 * Info = 133 bytes: "rootinbox/v1/e2ee-message-key" || senderHash(32) || receiverHash(32) || convIdHash(32) || seqNum(8 BE)
 */

import { createHMAC, createSHA256 } from 'hash-wasm';
import { utf8Encode, writeBigEndian64, sha256 } from './encoding';

const MESSAGE_KEY_INFO_PREFIX = utf8Encode('rootinbox/v1/e2ee-message-key');
const HKDF_SALT_INPUT = utf8Encode('rootinbox-hkdf-salt-v1');

let _cachedSalt: Uint8Array | null = null;

/**
 * Get the precomputed HKDF salt: SHA256("rootinbox-hkdf-salt-v1").
 * Asserted once at init for correctness.
 */
export async function getHKDFSalt(): Promise<Uint8Array> {
  if (_cachedSalt) return _cachedSalt;
  _cachedSalt = await sha256(HKDF_SALT_INPUT);
  return _cachedSalt;
}

/**
 * Build the HKDF Info parameter for message key derivation.
 * RFC-0003 §4.3: "rootinbox/v1/e2ee-message-key" || senderHash(32) || receiverHash(32) || convIdHash(32) || seqNum(8 BE).
 * Total: 29 + 32 + 32 + 32 + 8 = 133 bytes.
 */
export function buildMessageKeyInfo(
  senderHash: Uint8Array,
  receiverHash: Uint8Array,
  convIdHash: Uint8Array,
  seqNum: bigint,
): Uint8Array {
  const info = new Uint8Array(MESSAGE_KEY_INFO_PREFIX.length + 32 + 32 + 32 + 8);
  let offset = 0;
  info.set(MESSAGE_KEY_INFO_PREFIX, offset); offset += MESSAGE_KEY_INFO_PREFIX.length;
  info.set(senderHash, offset); offset += 32;
  info.set(receiverHash, offset); offset += 32;
  info.set(convIdHash, offset); offset += 32;
  writeBigEndian64(info, offset, seqNum);
  return info;
}

/**
 * Derive a per-message AES-256-GCM key using HKDF-SHA256.
 * RFC-0003 §4.3: A new derivation MUST be performed for EVERY message.
 * RFC-0003 §4.3: Derived Message Keys MUST NOT be cached.
 *
 * @returns 32-byte derived key as Uint8Array.
 */
export async function deriveMessageKey(
  sharedSecret: Uint8Array,
  info: Uint8Array,
): Promise<Uint8Array> {
  const salt = await getHKDFSalt();

  if (typeof crypto !== 'undefined' && crypto.subtle) {
    // Import the shared secret as raw HKDF key material.
    const baseKey = await crypto.subtle.importKey(
      'raw',
      sharedSecret as BufferSource,
      { name: 'HKDF' },
      false,
      ['deriveBits'],
    );

    const bits = await crypto.subtle.deriveBits(
      {
        name: 'HKDF',
        hash: 'SHA-256',
        salt: salt as BufferSource,
        info: info as BufferSource,
      },
      baseKey,
      256, // 32 bytes
    );

    return new Uint8Array(bits);
  }

  // Pure WASM fallback: RFC 5869 HKDF-SHA256 via hash-wasm HMAC-SHA256
  const hmac = await createHMAC(createSHA256(), salt);
  hmac.init();
  hmac.update(sharedSecret);
  const prk = hmac.digest('binary');

  const hashLen = 32;
  const length = 32;
  const n = Math.ceil(length / hashLen);
  const okm = new Uint8Array(n * hashLen);
  let prev = new Uint8Array(0);
  for (let i = 1; i <= n; i++) {
    const expandHmac = await createHMAC(createSHA256(), prk);
    expandHmac.init();
    if (prev.length > 0) expandHmac.update(prev);
    expandHmac.update(info);
    expandHmac.update(new Uint8Array([i]));
    prev = new Uint8Array(expandHmac.digest('binary'));
    okm.set(prev, (i - 1) * hashLen);
  }
  const out = new Uint8Array(length);
  out.set(okm.subarray(0, length));
  return out;
}
