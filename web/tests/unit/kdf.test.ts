import { describe, it, expect } from 'vitest';
import {
  deriveMasterSeed,
  deriveAuthKeypair,
  deriveVaultKey,
  deriveRecoveryKey,
  hkdfExpandSha256,
  toSodiumBytes,
  AUTH_KEYPAIR_INFO,
  VAULT_WRAPPING_KEY_INFO,
  RECOVERY_WRAPPING_KEY_INFO,
} from '../../src/crypto/kdf';
import sodium from 'libsodium-wrappers-sumo';

describe('RootInbox Stage 1a KDF & Derivation (kdf.ts)', () => {
  const testPassphrase = 'CorrectHorseBatteryStaple123!';
  const testSaltHex = '00112233445566778899aabbccddeeff';

  it('deriveMasterSeed produces deterministic 32-byte seed', async () => {
    const seed1 = await deriveMasterSeed(testPassphrase, { salt: testSaltHex });
    const seed2 = await deriveMasterSeed(testPassphrase, { salt: testSaltHex });

    expect(seed1).toHaveLength(32);
    expect(seed2).toHaveLength(32);
    expect(seed1).toEqual(seed2);
  });

  it('deriveMasterSeed produces distinct outputs for differing passphrases or salts', async () => {
    const seedA = await deriveMasterSeed('PasswordOne123!', { salt: testSaltHex });
    const seedB = await deriveMasterSeed('PasswordTwo123!', { salt: testSaltHex });
    const seedC = await deriveMasterSeed('PasswordOne123!', { salt: 'ffeeddccbbaa99887766554433221100' });

    expect(seedA).not.toEqual(seedB);
    expect(seedA).not.toEqual(seedC);
  });

  it('hkdfExpandSha256 produces domain-separated distinct subkeys', async () => {
    const seed = await deriveMasterSeed(testPassphrase, { salt: testSaltHex });

    const keyAuth = await hkdfExpandSha256(seed, AUTH_KEYPAIR_INFO, 32);
    const keyVault = await hkdfExpandSha256(seed, VAULT_WRAPPING_KEY_INFO, 32);
    const keyRecovery = await hkdfExpandSha256(seed, RECOVERY_WRAPPING_KEY_INFO, 32);

    expect(keyAuth).toHaveLength(32);
    expect(keyVault).toHaveLength(32);
    expect(keyRecovery).toHaveLength(32);

    expect(keyAuth).not.toEqual(keyVault);
    expect(keyAuth).not.toEqual(keyRecovery);
    expect(keyVault).not.toEqual(keyRecovery);
  });

  it('deriveAuthKeypair derives a functional Ed25519 signing keypair', async () => {
    await sodium.ready;
    const seed = await deriveMasterSeed(testPassphrase, { salt: testSaltHex });
    const authKp = await deriveAuthKeypair(seed);

    expect(authKp.authPublicKey).toHaveLength(64); // 32 bytes in hex = 64 hex chars
    expect(authKp.authPrivateKey).toHaveLength(128); // 64 bytes in hex = 128 hex chars
    expect(authKp.authPublicKeyBytes).toHaveLength(32);
    expect(authKp.authPrivateKeyBytes).toHaveLength(64);

    // Verify signing with auth private key and verification with auth public key
    const msg = toSodiumBytes(new TextEncoder().encode('challenge-nonce-payload-test'));
    const sig = sodium.crypto_sign_detached(msg, toSodiumBytes(authKp.authPrivateKey));
    const valid = sodium.crypto_sign_verify_detached(sig, msg, toSodiumBytes(authKp.authPublicKey));
    expect(valid).toBe(true);

    // Tampered payload fails verification
    const tampered = toSodiumBytes(new TextEncoder().encode('challenge-nonce-payload-TAMPER'));
    const invalid = sodium.crypto_sign_verify_detached(sig, tampered, toSodiumBytes(authKp.authPublicKey));
    expect(invalid).toBe(false);
  });

  it('deriveVaultKey and deriveRecoveryKey produce deterministic keys', async () => {
    const seed = await deriveMasterSeed(testPassphrase, { salt: testSaltHex });

    const vaultKey1 = await deriveVaultKey(seed);
    const vaultKey2 = await deriveVaultKey(seed);
    expect(vaultKey1).toEqual(vaultKey2);

    const recKey1 = await deriveRecoveryKey(seed);
    const recKey2 = await deriveRecoveryKey(seed);
    expect(recKey1).toEqual(recKey2);

    expect(vaultKey1).not.toEqual(recKey1);
  });
});
