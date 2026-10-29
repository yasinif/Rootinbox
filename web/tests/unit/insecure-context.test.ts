import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { detectCapabilities } from '../../src/workers/crypto/capabilities';
import { sha256 } from '../../src/workers/crypto/encoding';
import { aesGcmEncrypt, aesGcmDecrypt } from '../../src/workers/crypto/aes';
import { deriveMessageKey, getHKDFSalt } from '../../src/workers/crypto/hkdf';

describe('Insecure Context Cryptographic Fallbacks', () => {
  const originalSubtle = globalThis.crypto.subtle;

  beforeEach(() => {
    Object.defineProperty(globalThis.crypto, 'subtle', {
      value: undefined,
      configurable: true,
      writable: true,
    });
  });

  afterEach(() => {
    Object.defineProperty(globalThis.crypto, 'subtle', {
      value: originalSubtle,
      configurable: true,
      writable: true,
    });
  });

  it('detectCapabilities succeeds without crypto.subtle', async () => {
    expect(globalThis.crypto.subtle).toBeUndefined();
    const caps = await detectCapabilities();
    expect(caps.argon2).toBe('hash-wasm');
    expect(caps.ed25519).toBe('sodium');
    expect(caps.x25519).toBe('sodium');
    expect(caps.hkdf).toBe('sodium');
    expect(caps.aead).toBe('hash-wasm');
    expect(caps.digest).toBe('sodium');
  });

  it('sha256 falls back to sodium correctly', async () => {
    expect(globalThis.crypto.subtle).toBeUndefined();
    const hash = await sha256(new Uint8Array([0x61]));
    const hex = Array.from(hash, (b) => b.toString(16).padStart(2, '0')).join('');
    expect(hex).toBe('ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb');
  });

  it('aesGcmEncrypt and aesGcmDecrypt roundtrip without crypto.subtle', async () => {
    expect(globalThis.crypto.subtle).toBeUndefined();
    const key = new Uint8Array(32).fill(42);
    const iv = new Uint8Array(12).fill(7);
    const plaintext = new TextEncoder().encode('hello mobile world');
    const aad = new Uint8Array([1, 2, 3]);

    const ct = await aesGcmEncrypt(key, iv, plaintext, aad);
    expect(ct.length).toBe(plaintext.length + 16);

    const decrypted = await aesGcmDecrypt(key, iv, ct, aad);
    expect(new TextDecoder().decode(decrypted)).toBe('hello mobile world');
  });

  it('deriveMessageKey succeeds via sodium HKDF without crypto.subtle', async () => {
    expect(globalThis.crypto.subtle).toBeUndefined();
    const salt = await getHKDFSalt();
    expect(salt.length).toBe(32);

    const secret = new Uint8Array(32).fill(99);
    const info = new Uint8Array([1, 2, 3, 4, 5]);
    const key = await deriveMessageKey(secret, info);
    expect(key.length).toBe(32);
  });
});
