import { argon2id } from 'hash-wasm';
import sodium from 'libsodium-wrappers-sumo';

export interface CryptoProbeResults {
  argon2Real: {
    status: 'PASS' | 'FAIL' | 'UNKNOWN';
    durationMs: number;
    error?: string;
  };
  capabilityProbe: {
    status: 'PASS' | 'FAIL' | 'UNKNOWN';
    seedHex?: string;
    error?: string;
  };
  sodiumProbe: {
    status: 'PASS' | 'FAIL' | 'UNKNOWN';
    ed25519Valid: boolean;
    x25519Valid: boolean;
    error?: string;
  };
}

export async function runCryptoProbes(): Promise<CryptoProbeResults> {
  const enc = new TextEncoder();

  // 1. Real Argon2id probe (64 MiB, 3 iterations, 4 parallelism)
  const startArgon = performance.now();
  let argonStatus: 'PASS' | 'FAIL' | 'UNKNOWN' = 'PASS';
  let argonDuration = 0;
  let argonError: string | undefined;

  try {
    const salt = new Uint8Array(32);
    crypto.getRandomValues(salt);
    await argon2id({
      password: 'diagnostic-probe-test-password',
      salt,
      parallelism: 4,
      iterations: 3,
      memorySize: 65536,
      hashLength: 32,
      outputType: 'hex',
    });
    argonDuration = Math.round(performance.now() - startArgon);
  } catch (err) {
    argonStatus = 'FAIL';
    argonError = err instanceof Error ? err.message : String(err);
  }

  // 2. Capability probe known-answer test
  let capStatus: 'PASS' | 'FAIL' | 'UNKNOWN' = 'PASS';
  let capSeedHex: string | undefined;
  let capError: string | undefined;
  try {
    const saltInput = enc.encode('testuserIDENTITY');
    const saltBuf = await crypto.subtle.digest('SHA-256', saltInput);
    const salt = new Uint8Array(saltBuf);
    const result = await argon2id({
      password: enc.encode('correct-horse-battery-staple'),
      salt,
      parallelism: 4,
      iterations: 3,
      memorySize: 65536,
      hashLength: 32,
      outputType: 'hex',
    });
    capSeedHex = result;
    if (result !== 'fb630f9d0451ac2dcf78355c75870ebe2ff6718578720ab8115e6c78cc44f12b') {
      capStatus = 'FAIL';
      capError = `Seed mismatch: expected fb630f... got ${result.slice(0, 12)}...`;
    }
  } catch (err) {
    capStatus = 'FAIL';
    capError = err instanceof Error ? err.message : String(err);
  }

  // 3. Libsodium Ed25519 & X25519 self-tests
  let sodiumStatus: 'PASS' | 'FAIL' | 'UNKNOWN' = 'PASS';
  let edValid = false;
  let xValid = false;
  let sodiumError: string | undefined;
  try {
    await sodium.ready;
    const testSeed = new Uint8Array(32);
    testSeed.fill(0x42);
    const kp = sodium.crypto_sign_seed_keypair(testSeed);
    const msg = enc.encode('rootinbox-device-check-signature');
    const sig = sodium.crypto_sign_detached(msg, kp.privateKey);
    edValid = sodium.crypto_sign_verify_detached(sig, msg, kp.publicKey);

    const alice = sodium.crypto_kx_keypair();
    const bob = sodium.crypto_kx_keypair();
    const aliceShared = sodium.crypto_kx_client_session_keys(alice.publicKey, alice.privateKey, bob.publicKey);
    const bobShared = sodium.crypto_kx_server_session_keys(bob.publicKey, bob.privateKey, alice.publicKey);
    xValid = sodium.memcmp(aliceShared.sharedRx, bobShared.sharedTx) && sodium.memcmp(aliceShared.sharedTx, bobShared.sharedRx);

    if (!edValid || !xValid) {
      sodiumStatus = 'FAIL';
      sodiumError = 'Signature or key exchange verification failed';
    }
  } catch (err) {
    sodiumStatus = 'FAIL';
    sodiumError = err instanceof Error ? err.message : String(err);
  }

  return {
    argon2Real: { status: argonStatus, durationMs: argonDuration, error: argonError },
    capabilityProbe: { status: capStatus, seedHex: capSeedHex, error: capError },
    sodiumProbe: { status: sodiumStatus, ed25519Valid: edValid, x25519Valid: xValid, error: sodiumError },
  };
}

