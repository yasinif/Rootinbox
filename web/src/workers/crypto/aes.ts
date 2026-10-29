/**
 * AES-256-GCM encryption/decryption via WebCrypto.
 * RFC-0003 §4.5: Auth tag MUST be 128 bits (16 bytes).
 * RFC-0003 §8.2: Decryption failures MUST NOT reveal specific error details.
 *
 * IV = hybrid: [4-byte random prefix][8-byte sequence counter (BigEndian)].
 * The prefix is generated fresh per Worker init and lives in RAM only.
 */

import { gcm } from '@noble/ciphers/aes.js';

/**
 * Encrypt plaintext using AES-256-GCM.
 * @param key 32-byte raw key
 * @param iv 12-byte IV
 * @param plaintext
 * @param aad Additional Authenticated Data
 * @returns Sealed ciphertext (plaintext.length + 16-byte auth tag)
 */
export async function aesGcmEncrypt(
  key: Uint8Array,
  iv: Uint8Array,
  plaintext: Uint8Array,
  aad: Uint8Array,
): Promise<Uint8Array> {
  if (typeof crypto !== 'undefined' && crypto.subtle) {
    const cryptoKey = await crypto.subtle.importKey(
      'raw',
      key as BufferSource,
      { name: 'AES-GCM' },
      false,
      ['encrypt'],
    );

    const sealed = await crypto.subtle.encrypt(
      {
        name: 'AES-GCM',
        iv: iv as BufferSource,
        additionalData: aad as BufferSource,
        tagLength: 128, // RFC-0003 §4.5: Strictly 128 bits
      },
      cryptoKey,
      plaintext as BufferSource,
    );

    return new Uint8Array(sealed);
  }

  const cipher = gcm(key, iv, aad);
  return cipher.encrypt(plaintext);
}

/**
 * Decrypt ciphertext using AES-256-GCM.
 * RFC-0003 §8.2: Auth failures return generic "decryption failed" — no details.
 */
export async function aesGcmDecrypt(
  key: Uint8Array,
  iv: Uint8Array,
  ciphertext: Uint8Array,
  aad: Uint8Array,
): Promise<Uint8Array> {
  if (typeof crypto !== 'undefined' && crypto.subtle) {
    const cryptoKey = await crypto.subtle.importKey(
      'raw',
      key as BufferSource,
      { name: 'AES-GCM' },
      false,
      ['decrypt'],
    );

    try {
      const plaintext = await crypto.subtle.decrypt(
        {
          name: 'AES-GCM',
          iv: iv as BufferSource,
          additionalData: aad as BufferSource,
          tagLength: 128,
        },
        cryptoKey,
        ciphertext as BufferSource,
      );
      return new Uint8Array(plaintext);
    } catch {
      // RFC-0003 §8.2: Do not reveal specific error details.
      throw new Error('decryption failed');
    }
  }

  try {
    const cipher = gcm(key, iv, aad);
    return cipher.decrypt(ciphertext);
  } catch {
    throw new Error('decryption failed');
  }
}
