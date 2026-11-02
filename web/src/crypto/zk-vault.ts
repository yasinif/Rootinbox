/**
 * RootInbox Stage 1a Sealed Zero-Knowledge Vault Storage
 * XChaCha20-Poly1305-IETF Encryption, Authenticated AAD Binding, and OCC
 * Reference: E2EE-1A-SPEC.md §2.3, §4.4, §4.5, §5
 */

import sodium from 'libsodium-wrappers-sumo';
import { bytesToHex } from './kdf';

export interface ZeroKnowledgeVaultPayload {
  schema_version: 1;
  user_id: string;
  username: string;
  identity_keys: {
    id_sign_pk: string; // Hex Ed25519 public identity key
    id_sign_sk: string; // Hex Ed25519 secret identity key
    id_dh_pk: string;   // Hex X25519 public DH key
    id_dh_sk: string;   // Hex X25519 secret DH key
  };
  devices: Array<{
    device_id: string;
    label: string;
    created_at: number;
    last_seen_at: number;
  }>;
  conversation_epochs: Record<string, {
    epoch_number: number;
    epoch_key: string;  // Hex 32-byte conversation symmetric key
  }>;
  pinned_identities: Record<string, {
    pinned_pubkey: string;
    pinned_at: number;
    verified: boolean;
  }>;
  recovery_skipped: boolean;
}

export interface EncryptedZKVaultResult {
  version: number;
  ciphertext: string; // Hex wire format: nonce (24 bytes) || ciphertext || poly1305 tag (16 bytes)
  signature: string;  // Hex Ed25519 signature over wire bytes by auth_sk
  wireBytes: Uint8Array;
}

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error('Invalid hex string length');
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function toUint8Array(val: string | Uint8Array): Uint8Array {
  if (typeof val === 'string') {
    return hexToBytes(val);
  }
  return val;
}

let sodiumInitialized = false;
async function ensureSodium(): Promise<void> {
  if (!sodiumInitialized) {
    await sodium.ready;
    sodiumInitialized = true;
  }
}

/**
 * Bridges any Uint8Array (including across VM / JSDOM realms) into libsodium-compatible memory.
 */
function toSodiumBytes(arr: Uint8Array | string): Uint8Array {
  if (typeof arr === 'string') {
    return sodium.from_hex(arr);
  }
  return sodium.from_hex(bytesToHex(arr));
}

/**
 * Constructs AAD: "rootinbox:zk_vault:v1:" || user_id || ":" || version
 * E2EE-1A-SPEC.md §2.3: Guarantees that ciphertext cannot be copied between users or versions.
 */
export function buildVaultAAD(userId: string, version: number): Uint8Array {
  return new TextEncoder().encode(`rootinbox:zk_vault:v1:${userId}:${version}`);
}

/**
 * Encrypts a Zero-Knowledge Vault Payload using XChaCha20-Poly1305 IETF.
 * E2EE-1A-SPEC.md §2.3: Nonce (24 bytes) || Ciphertext || Poly1305 Tag (16 bytes).
 */
export async function encryptZKVault(
  payload: ZeroKnowledgeVaultPayload,
  vaultKey: Uint8Array,
  authPrivateKey: Uint8Array | string,
  version: number,
): Promise<EncryptedZKVaultResult> {
  await ensureSodium();

  const skBytes = toUint8Array(authPrivateKey);
  if (vaultKey.length !== 32) {
    throw new Error(`Vault wrapping key must be 32 bytes, got ${vaultKey.length}`);
  }
  if (skBytes.length !== 64) {
    throw new Error(`Auth private key must be 64 bytes, got ${skBytes.length}`);
  }

  const nonce = sodium.randombytes_buf(24);
  const aad = toSodiumBytes(buildVaultAAD(payload.user_id, version));
  const plaintext = toSodiumBytes(new TextEncoder().encode(JSON.stringify(payload)));
  const sodiumKey = toSodiumBytes(vaultKey);
  const sodiumSk = toSodiumBytes(skBytes);

  const ciphertextAndTag = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
    plaintext,
    aad,
    null,
    nonce,
    sodiumKey,
  );

  // Binary wire format: Nonce (24 bytes) || CiphertextAndTag
  const wireBytes = new Uint8Array(24 + ciphertextAndTag.length);
  wireBytes.set(nonce, 0);
  wireBytes.set(ciphertextAndTag, 24);

  // Detached Ed25519 signature over wireBytes by auth_sk
  const signatureBytes = sodium.crypto_sign_detached(toSodiumBytes(wireBytes), sodiumSk);

  return {
    version,
    ciphertext: bytesToHex(wireBytes),
    signature: bytesToHex(signatureBytes),
    wireBytes,
  };
}

/**
 * Decrypts a Zero-Knowledge Vault Payload and verifies AAD integrity.
 * Throws error if ciphertext or tag was tampered with, or if wrong key/version/user_id is used.
 */
export async function decryptZKVault(
  ciphertextWire: string | Uint8Array,
  vaultKey: Uint8Array,
  userId: string,
  version: number,
): Promise<ZeroKnowledgeVaultPayload> {
  await ensureSodium();

  const wireBytes = toUint8Array(ciphertextWire);
  if (wireBytes.length < 24 + 16) {
    throw new Error('Ciphertext wire format too short (must be >= 40 bytes)');
  }

  const nonce = toSodiumBytes(wireBytes.subarray(0, 24));
  const ciphertextAndTag = toSodiumBytes(wireBytes.subarray(24));
  const aad = toSodiumBytes(buildVaultAAD(userId, version));
  const sodiumKey = toSodiumBytes(vaultKey);

  let decryptedBytes: Uint8Array;
  try {
    decryptedBytes = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
      null,
      ciphertextAndTag,
      aad,
      nonce,
      sodiumKey,
    );
  } catch (err) {
    throw new Error(`Vault decryption failed: MAC verification failure or corrupted ciphertext (${err})`, {
      cause: err,
    });
  }

  const jsonStr = sodium.to_string(decryptedBytes);
  const payload = JSON.parse(jsonStr) as ZeroKnowledgeVaultPayload;

  if (payload.schema_version !== 1) {
    throw new Error(`Unsupported vault schema version: ${payload.schema_version}`);
  }
  if (payload.user_id !== userId) {
    throw new Error(`Vault user_id mismatch: expected ${userId}, found ${payload.user_id}`);
  }

  return payload;
}

/**
 * Verifies detached Ed25519 signature of the vault wire bytes using auth_pk.
 */
export async function verifyZKVaultSignature(
  ciphertextWire: string | Uint8Array,
  signature: string | Uint8Array,
  authPublicKey: string | Uint8Array,
): Promise<boolean> {
  await ensureSodium();

  const wireBytes = toSodiumBytes(ciphertextWire);
  const sigBytes = toSodiumBytes(signature);
  const pkBytes = toSodiumBytes(authPublicKey);

  try {
    return sodium.crypto_sign_verify_detached(sigBytes, wireBytes, pkBytes);
  } catch {
    return false;
  }
}

/**
 * Factory for constructing a fresh initial vault payload.
 */
export function createInitialVaultPayload(
  userId: string,
  username: string,
  identityKeys: {
    id_sign_pk: string;
    id_sign_sk: string;
    id_dh_pk: string;
    id_dh_sk: string;
  },
  initialDevice: {
    device_id: string;
    label: string;
    created_at: number;
    last_seen_at: number;
  },
): ZeroKnowledgeVaultPayload {
  return {
    schema_version: 1,
    user_id: userId,
    username,
    identity_keys: identityKeys,
    devices: [initialDevice],
    conversation_epochs: {},
    pinned_identities: {},
    recovery_skipped: false,
  };
}
