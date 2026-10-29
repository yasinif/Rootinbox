/**
 * X25519 ECDH via libsodium-wrappers-sumo.
 * RFC-0003 §4.3: X25519 key agreement.
 * RFC-0003 §5.2 step 1: Reject low-order points.
 *
 * The -sumo build is required because the standard build omits crypto_scalarmult.
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
 * Generate an X25519 keypair.
 * RFC-0003 §8.1: Only crypto.getRandomValues (via sodium) for RNG.
 */
export async function generateX25519KeyPair(): Promise<{
  publicKey: Uint8Array;
  privateKey: Uint8Array;
}> {
  await ensureSodium();
  const privateKey = new Uint8Array(sodium.randombytes_buf(32));
  const publicKey = new Uint8Array(sodium.crypto_scalarmult_base(privateKey));
  return { publicKey, privateKey };
}

/**
 * Compute shared secret: ECDH(privateKey, peerPublicKey).
 * RFC-0003 §5.2 step 1: Rejects low-order points (all-zero result).
 */
export async function computeSharedSecret(
  privateKey: Uint8Array,
  peerPublicKey: Uint8Array,
): Promise<Uint8Array> {
  await ensureSodium();
  if (peerPublicKey.length !== 32) {
    throw new Error('X25519: peer public key must be 32 bytes');
  }

  // Reject known low-order points before computation.
  if (isLowOrderPoint(peerPublicKey)) {
    throw new Error('X25519: low-order point rejected');
  }

  const shared = new Uint8Array(sodium.crypto_scalarmult(new Uint8Array(privateKey), new Uint8Array(peerPublicKey)));

  // Check for all-zeros result (low-order point contribution).
  if (shared.every((b) => b === 0)) {
    throw new Error('X25519: low-order point rejected (zero shared secret)');
  }

  return shared;
}

/**
 * Known X25519 low-order points that MUST be rejected.
 * These are the 8 small-order points on Curve25519.
 */
const LOW_ORDER_POINTS = [
  '0000000000000000000000000000000000000000000000000000000000000000',
  '0100000000000000000000000000000000000000000000000000000000000000',
  'ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
  'e0eb7a7c3b41b8ae1656e3faf19fc46ada098deb9c32b1fd866205165f49b800',
  '5f9c95bca3508c24b1d0b1559c83ef5b04445cc4581c8e86d8224eddd09f1157',
];

function isLowOrderPoint(point: Uint8Array): boolean {
  const hex = Array.from(point, (b) => b.toString(16).padStart(2, '0')).join('');
  return LOW_ORDER_POINTS.includes(hex);
}
