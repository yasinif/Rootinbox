/**
 * Ed25519 operations via libsodium-wrappers-sumo.
 * RFC-0003 §4.1: Ed25519 seed→keypair is ALWAYS sodium.
 * crypto_sign_seed_keypair is the ONLY correct derivation.
 *
 * FORBIDDEN: @noble/ed25519, tweetnacl.
 */

import sodium from 'libsodium-wrappers-sumo';

let _sodiumReady = false;

async function ensureSodium(): Promise<void> {
  if (!_sodiumReady) {
    await sodium.ready;
    _sodiumReady = true;
  }
}

/**
 * Derive Ed25519 keypair from a 32-byte seed.
 * Returns { publicKey (32 bytes), privateKey (64 bytes) }.
 */
export async function ed25519FromSeed(seed: Uint8Array): Promise<{
  publicKey: Uint8Array;
  privateKey: Uint8Array;
}> {
  await ensureSodium();
  const kp = sodium.crypto_sign_seed_keypair(new Uint8Array(seed));
  return {
    publicKey: new Uint8Array(kp.publicKey),
    privateKey: new Uint8Array(kp.privateKey),
  };
}

/**
 * Sign a message with an Ed25519 private key (64-byte combined key).
 * Returns 64-byte detached signature.
 */
export async function ed25519Sign(
  message: Uint8Array,
  privateKey: Uint8Array,
): Promise<Uint8Array> {
  await ensureSodium();
  return new Uint8Array(sodium.crypto_sign_detached(new Uint8Array(message), new Uint8Array(privateKey)));
}

/**
 * Verify a detached Ed25519 signature.
 */
export async function ed25519Verify(
  message: Uint8Array,
  signature: Uint8Array,
  publicKey: Uint8Array,
): Promise<boolean> {
  await ensureSodium();
  try {
    return sodium.crypto_sign_verify_detached(new Uint8Array(signature), new Uint8Array(message), new Uint8Array(publicKey));
  } catch {
    return false;
  }
}
