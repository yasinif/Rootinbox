/**
 * RootInbox Stage 1a Deterministic Cryptographic Derivation
 * Argon2id Key Derivation & HKDF-SHA256 Expansion
 * Reference: E2EE-1A-SPEC.md §2
 */

import { argon2id, createHMAC, createSHA256 } from 'hash-wasm';
import sodium from 'libsodium-wrappers-sumo';

export const AUTH_KEYPAIR_INFO = 'rootinbox:auth:ed25519';
export const VAULT_WRAPPING_KEY_INFO = 'rootinbox:vault:xchacha20';
export const RECOVERY_WRAPPING_KEY_INFO = 'rootinbox:recovery:xchacha20';

export interface KDFParams {
  salt: string | Uint8Array;
  iterations?: number;
  memorySize?: number; // in KiB
  parallelism?: number;
  hashLength?: number;
}

export interface AuthKeypairResult {
  authPublicKey: string; // Hex 32-byte Ed25519 public key
  authPrivateKey: string; // Hex 64-byte Ed25519 secret key
  authPublicKeyBytes: Uint8Array;
  authPrivateKeyBytes: Uint8Array;
}

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error('Invalid hex string length');
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Bridges any Uint8Array (including across VM / JSDOM realms) into libsodium-compatible memory.
 */
export function toSodiumBytes(arr: Uint8Array | string): Uint8Array {
  if (typeof arr === 'string') {
    return sodium.from_hex(arr);
  }
  return sodium.from_hex(bytesToHex(arr));
}

/**
 * Derives a 32-byte Master Seed from user passphrase and salt using calibrated Argon2id.
 * E2EE-1A-SPEC.md §2.1: Argon2id (t=4, m=32768 KiB, p=1, out=32 bytes).
 */
export async function deriveMasterSeed(
  passphrase: string,
  params: KDFParams,
): Promise<Uint8Array> {
  let saltBytes: Uint8Array;
  if (typeof params.salt === 'string') {
    const trimmed = params.salt.trim();
    if (/^[0-9a-fA-F]{32,}$/.test(trimmed) && trimmed.length % 2 === 0) {
      saltBytes = hexToBytes(trimmed);
    } else {
      saltBytes = new TextEncoder().encode(trimmed);
    }
  } else {
    saltBytes = params.salt;
  }

  const resultHex = await argon2id({
    password: new TextEncoder().encode(passphrase),
    salt: saltBytes,
    parallelism: params.parallelism ?? 1,
    iterations: params.iterations ?? 4,
    memorySize: params.memorySize ?? 32768,
    hashLength: params.hashLength ?? 32,
    outputType: 'hex',
  });

  return hexToBytes(resultHex);
}

/**
 * RFC 5869 HKDF-Expand with SHA-256.
 * E2EE-1A-SPEC.md §2.2: Standardized domain separation context labels.
 */
export async function hkdfExpandSha256(
  prk: Uint8Array,
  info: string | Uint8Array,
  length = 32,
): Promise<Uint8Array> {
  const infoBytes = typeof info === 'string' ? new TextEncoder().encode(info) : info;
  const hashLen = 32;
  const n = Math.ceil(length / hashLen);
  const okm = new Uint8Array(n * hashLen);
  let prev = new Uint8Array(0);

  for (let i = 1; i <= n; i++) {
    const hmac = await createHMAC(createSHA256(), prk);
    hmac.init();
    if (prev.length > 0) {
      hmac.update(prev);
    }
    hmac.update(infoBytes);
    hmac.update(new Uint8Array([i]));
    prev = new Uint8Array(hmac.digest('binary'));
    okm.set(prev, (i - 1) * hashLen);
  }

  return okm.subarray(0, length);
}

let sodiumInitialized = false;
async function ensureSodium(): Promise<void> {
  if (!sodiumInitialized) {
    await sodium.ready;
    sodiumInitialized = true;
  }
}

/**
 * Derives the server authentication keypair from the master seed.
 * E2EE-1A-SPEC.md §2.1: HKDF-Expand(seed, "rootinbox:auth:ed25519", 32) -> crypto_sign_seed_keypair.
 */
export async function deriveAuthKeypair(masterSeed: Uint8Array): Promise<AuthKeypairResult> {
  await ensureSodium();
  const authSeed = await hkdfExpandSha256(masterSeed, AUTH_KEYPAIR_INFO, 32);
  const kp = sodium.crypto_sign_seed_keypair(authSeed);
  const pkBytes = new Uint8Array(kp.publicKey);
  const skBytes = new Uint8Array(kp.privateKey);

  return {
    authPublicKey: bytesToHex(pkBytes),
    authPrivateKey: bytesToHex(skBytes),
    authPublicKeyBytes: pkBytes,
    authPrivateKeyBytes: skBytes,
  };
}

/**
 * Derives the 32-byte Vault Wrapping Key from the master seed.
 * E2EE-1A-SPEC.md §2.1: HKDF-Expand(seed, "rootinbox:vault:xchacha20", 32).
 */
export async function deriveVaultKey(masterSeed: Uint8Array): Promise<Uint8Array> {
  return hkdfExpandSha256(masterSeed, VAULT_WRAPPING_KEY_INFO, 32);
}

/**
 * Derives the 32-byte Recovery Wrapping Key from the master seed.
 * E2EE-1A-SPEC.md §2.2: HKDF-Expand(seed, "rootinbox:recovery:xchacha20", 32).
 */
export async function deriveRecoveryKey(masterSeed: Uint8Array): Promise<Uint8Array> {
  return hkdfExpandSha256(masterSeed, RECOVERY_WRAPPING_KEY_INFO, 32);
}
