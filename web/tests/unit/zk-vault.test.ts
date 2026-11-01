import { describe, it, expect } from 'vitest';
import {
  encryptZKVault,
  decryptZKVault,
  verifyZKVaultSignature,
  createInitialVaultPayload,
  buildVaultAAD,
  ZeroKnowledgeVaultPayload,
} from '../../src/crypto/zk-vault';
import {
  deriveMasterSeed,
  deriveAuthKeypair,
  deriveVaultKey,
} from '../../src/crypto/kdf';

describe('RootInbox Stage 1a Sealed Zero-Knowledge Vault (zk-vault.ts)', () => {
  const testPassphrase = 'CorrectHorseBatteryStaple123!';
  const testSaltHex = '00112233445566778899aabbccddeeff';
  const testUserId = 'user-alice-uuid-456';
  const testUsername = 'alice';

  async function setupKeys() {
    const seed = await deriveMasterSeed(testPassphrase, { salt: testSaltHex });
    const authKp = await deriveAuthKeypair(seed);
    const vaultKey = await deriveVaultKey(seed);
    return { seed, authKp, vaultKey };
  }

  function mockVaultPayload(): ZeroKnowledgeVaultPayload {
    return createInitialVaultPayload(
      testUserId,
      testUsername,
      {
        id_sign_pk: '111122223333444455556666777788889999aaaabbbbccccddddeeeeffff0000',
        id_sign_sk: '0000ffff111122223333444455556666777788889999aaaabbbbccccddddeeee' +
                    '111122223333444455556666777788889999aaaabbbbccccddddeeeeffff0000',
        id_dh_pk: 'aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899',
        id_dh_sk: '99887766554433221100ffeeddccbbaa99887766554433221100ffeeddccbbaa',
      },
      {
        device_id: 'dev-primary-chrome',
        label: 'Chrome on Windows',
        created_at: 1714500000,
        last_seen_at: 1714500000,
      },
    );
  }

  it('buildVaultAAD formats AAD with strict binding', () => {
    const aad = buildVaultAAD('user-123', 5);
    const text = new TextDecoder().decode(aad);
    expect(text).toBe('rootinbox:zk_vault:v1:user-123:5');
  });

  it('encryptZKVault and decryptZKVault roundtrip preserves exact payload', async () => {
    const { authKp, vaultKey } = await setupKeys();
    const original = mockVaultPayload();

    const encrypted = await encryptZKVault(original, vaultKey, authKp.authPrivateKey, 1);
    expect(encrypted.version).toBe(1);
    expect(encrypted.ciphertext.length).toBeGreaterThan(64);
    expect(encrypted.signature).toHaveLength(128); // 64 bytes hex

    const decrypted = await decryptZKVault(encrypted.ciphertext, vaultKey, testUserId, 1);
    expect(decrypted).toEqual(original);
  });

  it('verifyZKVaultSignature verifies signature over wire bytes', async () => {
    const { authKp, vaultKey } = await setupKeys();
    const original = mockVaultPayload();

    const encrypted = await encryptZKVault(original, vaultKey, authKp.authPrivateKey, 1);
    const valid = await verifyZKVaultSignature(encrypted.ciphertext, encrypted.signature, authKp.authPublicKey);
    expect(valid).toBe(true);

    // Tampered signature fails
    const tamperedSig = '00' + encrypted.signature.substring(2);
    const invalid = await verifyZKVaultSignature(encrypted.ciphertext, tamperedSig, authKp.authPublicKey);
    expect(invalid).toBe(false);
  });

  it('AAD mismatch (version tamper) rejects decryption', async () => {
    const { authKp, vaultKey } = await setupKeys();
    const original = mockVaultPayload();

    const encrypted = await encryptZKVault(original, vaultKey, authKp.authPrivateKey, 1);

    // Attempting to decrypt with version 2 when encrypted with version 1 fails
    await expect(
      decryptZKVault(encrypted.ciphertext, vaultKey, testUserId, 2),
    ).rejects.toThrow(/Vault decryption failed/);
  });

  it('AAD mismatch (cross-user ciphertext swap) rejects decryption', async () => {
    const { authKp, vaultKey } = await setupKeys();
    const original = mockVaultPayload();

    const encrypted = await encryptZKVault(original, vaultKey, authKp.authPrivateKey, 1);

    // Attempting to decrypt for user-eve fails MAC check
    await expect(
      decryptZKVault(encrypted.ciphertext, vaultKey, 'user-eve-victim', 1),
    ).rejects.toThrow(/Vault decryption failed/);
  });

  it('Ciphertext tampering rejects decryption', async () => {
    const { authKp, vaultKey } = await setupKeys();
    const original = mockVaultPayload();

    const encrypted = await encryptZKVault(original, vaultKey, authKp.authPrivateKey, 1);
    const wireBytes = new Uint8Array(encrypted.wireBytes);

    // Flip a bit in the ciphertext portion (after 24-byte nonce)
    wireBytes[30] ^= 0x01;

    await expect(
      decryptZKVault(wireBytes, vaultKey, testUserId, 1),
    ).rejects.toThrow(/Vault decryption failed/);
  });

  it('Wrong vault key rejects decryption', async () => {
    const { authKp } = await setupKeys();
    const wrongVaultKey = new Uint8Array(32).fill(0xee);
    const original = mockVaultPayload();

    const { vaultKey: correctVaultKey } = await setupKeys();
    const encrypted = await encryptZKVault(original, correctVaultKey, authKp.authPrivateKey, 1);

    await expect(
      decryptZKVault(encrypted.ciphertext, wrongVaultKey, testUserId, 1),
    ).rejects.toThrow(/Vault decryption failed/);
  });
});
