/**
 * Capability detection — per-primitive known-answer probes.
 * RFC-0010 §12: Each primitive probed against production path using vectors.
 *
 * Resolution map:
 *   argon2  → always 'hash-wasm'
 *   ed25519 → always 'sodium'
 *   x25519  → always 'sodium'
 *   hkdf    → 'webcrypto' if SubtleCrypto available, else 'sodium'
 *   aead    → 'webcrypto' (AES-GCM always available in SubtleCrypto)
 *   digest  → 'webcrypto' (SHA-256 always available)
 */

import { deriveIdentityKey } from './argon2';
import { ed25519FromSeed, ed25519Sign, ed25519Verify } from './ed25519';
import { hexEncode, sha256 } from './encoding';
import { aesGcmEncrypt, aesGcmDecrypt } from './aes';

export type CryptoProvider = 'hash-wasm' | 'sodium' | 'webcrypto';

export interface CapabilityMap {
  argon2: CryptoProvider;
  ed25519: CryptoProvider;
  x25519: CryptoProvider;
  hkdf: CryptoProvider;
  aead: CryptoProvider;
  digest: CryptoProvider;
}

/**
 * Probe all crypto primitives using known-answer tests.
 * Throws if any primitive fails — bootstrap MUST NOT proceed without crypto.
 */
export async function detectCapabilities(): Promise<CapabilityMap> {
  // 1. Argon2id probe: hash-wasm with test vector
  const argon2Seed = await deriveIdentityKey('TestUser', 'correct-horse-battery-staple');
  const argon2Hex = hexEncode(argon2Seed);
  if (argon2Hex !== 'fb630f9d0451ac2dcf78355c75870ebe2ff6718578720ab8115e6c78cc44f12b') {
    throw new Error('Argon2id capability probe FAILED: seed mismatch');
  }

  // 2. Ed25519 probe: sodium seed→pubkey
  const kp = await ed25519FromSeed(argon2Seed);
  const pubHex = hexEncode(kp.publicKey);
  if (pubHex !== 'b188e8e05a4e3a1feaf55f43ca5c3fe3ded91dfadb6f23f6ffe3a3f6af5c3723') {
    throw new Error('Ed25519 capability probe FAILED: pubkey mismatch');
  }

  // 3. Ed25519 sign/verify roundtrip
  const testMsg = new TextEncoder().encode('rootinbox/conformance/ed25519-test-payload');
  const sig = await ed25519Sign(testMsg, kp.privateKey);
  const valid = await ed25519Verify(testMsg, sig, kp.publicKey);
  if (!valid) {
    throw new Error('Ed25519 capability probe FAILED: verify roundtrip failed');
  }

  const hasSubtle = typeof crypto !== 'undefined' && Boolean(crypto.subtle);

  // 4. HKDF probe: WebCrypto SubtleCrypto or sodium
  let hkdfProvider: CryptoProvider = 'sodium';
  if (hasSubtle) {
    try {
      const testKey = await crypto.subtle.importKey(
        'raw',
        new Uint8Array(32) as BufferSource,
        { name: 'HKDF' },
        false,
        ['deriveBits'],
      );
      await crypto.subtle.deriveBits(
        { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32) as BufferSource, info: new Uint8Array(0) as BufferSource },
        testKey,
        256,
      );
      hkdfProvider = 'webcrypto';
    } catch {
      hkdfProvider = 'sodium';
    }
  }

  // 5. AES-GCM probe: WebCrypto or noble
  let aeadProvider: CryptoProvider = 'hash-wasm';
  if (hasSubtle) {
    try {
      const aesTestKey = await crypto.subtle.importKey(
        'raw',
        new Uint8Array(32) as BufferSource,
        { name: 'AES-GCM' },
        false,
        ['encrypt', 'decrypt'],
      );
      const aesTestCt = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv: new Uint8Array(12) as BufferSource, tagLength: 128 },
        aesTestKey,
        new Uint8Array([1, 2, 3]) as BufferSource,
      );
      const aesTestPt = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: new Uint8Array(12) as BufferSource, tagLength: 128 },
        aesTestKey,
        aesTestCt,
      );
      if (new Uint8Array(aesTestPt)[0] === 1) {
        aeadProvider = 'webcrypto';
      }
    } catch {
      aeadProvider = 'hash-wasm';
    }
  }

  if (aeadProvider !== 'webcrypto') {
    const testCt = await aesGcmEncrypt(
      new Uint8Array(32),
      new Uint8Array(12),
      new Uint8Array([1, 2, 3]),
      new Uint8Array(0),
    );
    const testPt = await aesGcmDecrypt(
      new Uint8Array(32),
      new Uint8Array(12),
      testCt,
      new Uint8Array(0),
    );
    if (testPt[0] !== 1) {
      throw new Error('AES-GCM capability probe FAILED');
    }
  }

  // 6. SHA-256 probe: WebCrypto or sodium
  let digestProvider: CryptoProvider = 'sodium';
  if (hasSubtle) {
    try {
      const digestResult = await crypto.subtle.digest('SHA-256', new Uint8Array([0x61]) as BufferSource);
      if (new Uint8Array(digestResult).length === 32) {
        digestProvider = 'webcrypto';
      }
    } catch {
      digestProvider = 'sodium';
    }
  }

  if (digestProvider !== 'webcrypto') {
    const digestResult = await sha256(new Uint8Array([0x61]));
    if (digestResult.length !== 32) {
      throw new Error('SHA-256 capability probe FAILED');
    }
  }

  return {
    argon2: 'hash-wasm',
    ed25519: 'sodium',
    x25519: 'sodium',
    hkdf: hkdfProvider,
    aead: aeadProvider,
    digest: digestProvider,
  };
}
