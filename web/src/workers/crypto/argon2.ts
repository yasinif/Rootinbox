/**
 * Argon2id key derivation via hash-wasm.
 * RFC-0003 §4.1: Argon2id v0x13, Memory 65536 KiB, Time 3, Parallelism 4, Output 32 bytes.
 *
 * LIBRARY: hash-wasm — accepts arbitrary-length salts (SHA256 = 32 bytes).
 * FORBIDDEN: argon2-browser (16-byte salt hard limit), @noble/* , libsodium (same).
 *
 * Username normalization: NFC then toLowerCase (NEVER toLocaleLowerCase).
 * Password: raw UTF-8, never normalized.
 */

import { argon2id } from 'hash-wasm';
import { hexDecode, utf8Encode } from './encoding';
import { sha256 } from './encoding';

const ARGON2_MEMORY = 65536;   // KiB (64 MB)
const ARGON2_TIME = 3;
const ARGON2_PARALLELISM = 4;
const ARGON2_KEY_LENGTH = 32;

/**
 * RFC-0003 §4.1: NormalizedUsername = lowercase(Unicode_NFC(Username)).
 * MUST use String.prototype.normalize('NFC') then toLowerCase() — NEVER toLocaleLowerCase.
 */
export function normalizeUsername(username: string): string {
  return username.normalize('NFC').toLowerCase();
}

/**
 * Derive the Ed25519 Identity seed.
 * RFC-0003 §4.1: Salt = SHA256(NormalizedUsername || "IDENTITY").
 */
export async function deriveIdentityKey(username: string, password: string): Promise<Uint8Array> {
  const normalized = normalizeUsername(username);
  const saltInput = utf8Encode(normalized + 'IDENTITY');
  const salt = await sha256(saltInput);

  const result = await argon2id({
    password: utf8Encode(password),
    salt,
    parallelism: ARGON2_PARALLELISM,
    iterations: ARGON2_TIME,
    memorySize: ARGON2_MEMORY,
    hashLength: ARGON2_KEY_LENGTH,
    outputType: 'hex',
  });

  return hexDecode(result);
}

/**
 * Derive the AES-256-GCM Vault key.
 * RFC-0003 §4.2: Salt = SHA256(NormalizedUsername || "VAULT").
 * Identical Argon2id parameters as identity key.
 */
export async function deriveVaultKey(username: string, password: string): Promise<Uint8Array> {
  const normalized = normalizeUsername(username);
  const saltInput = utf8Encode(normalized + 'VAULT');
  const salt = await sha256(saltInput);

  const result = await argon2id({
    password: utf8Encode(password),
    salt,
    parallelism: ARGON2_PARALLELISM,
    iterations: ARGON2_TIME,
    memorySize: ARGON2_MEMORY,
    hashLength: ARGON2_KEY_LENGTH,
    outputType: 'hex',
  });

  return hexDecode(result);
}
