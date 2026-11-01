import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AuthUseCase } from '../../src/usecase/auth';
import type { AuthPort, CryptoPort, MetadataPort, ZKVaultPort, ZKVaultDTO, ZeroKnowledgeVaultPayload } from '../../src/domain';

describe('Stage 1a Auth & ZK-Vault Integration', () => {
  let mockAuthPort: AuthPort;
  let mockCryptoPort: CryptoPort;
  let mockMetadataPort: MetadataPort;
  let mockZKVaultPort: ZKVaultPort;
  let metadataStore: Map<string, string>;
  let vaultStore: ZKVaultDTO | null;

  beforeEach(() => {
    metadataStore = new Map<string, string>();
    vaultStore = null;

    mockMetadataPort = {
      get: vi.fn(async (key: string) => metadataStore.get(key) ?? null),
      set: vi.fn(async (key: string, value: string) => {
        metadataStore.set(key, value);
      }),
      delete: vi.fn(async (key: string) => {
        metadataStore.delete(key);
      }),
    };

    mockAuthPort = {
      requestChallenge: vi.fn(async () => ({ nonce: 'mock-nonce', challengeId: 'mock-chal-id' })),
      register: vi.fn(async () => ({
        session_token: 'mock-token',
        user_id: 'user-alice-123',
        identity_hash: 'mock-id-hash',
      })),
      verify: vi.fn(async () => ({
        session_token: 'mock-token',
        user_id: 'user-alice-123',
        identity_hash: 'mock-id-hash',
      })),
      getKdfParams: vi.fn(async (username: string) => ({
        salt: '0123456789abcdef0123456789abcdef',
        iterations: 4,
        memory_kib: 32768,
        parallelism: 1,
      })),
      getWSTicket: vi.fn(async () => ({ ticket: 'mock-ticket' })),
      listSessions: vi.fn(async () => []),
      terminateSession: vi.fn(async () => {}),
      terminateOtherSessions: vi.fn(async () => {}),
    };

    mockCryptoPort = {
      init: vi.fn(async () => ({ identityHash: 'mock-id-hash', publicKey: 'mock-id-pk' })),
      generateSessionKeys: vi.fn(async () => ({ publicKey: 'mock-session-pk', sessionId: 'mock-session-id' })),
      signSessionKey: vi.fn(async () => ({ signature: 'mock-session-sig', signatureHex: 'mock-session-sig-hex' })),
      signLoginPayload: vi.fn(async () => ({ signature: 'mock-login-sig' })),
      buildRegistrationWire: vi.fn(async () => ({ wireBytes: new Uint8Array(137), wireLength: 137 })),
      encrypt: vi.fn(async () => ({ ciphertextHex: 'aabb', sequence: '1', ivHex: 'ccdd' })),
      decrypt: vi.fn(async () => ({ plaintext: 'hello' })),
      deriveVaultKey: vi.fn(async () => {}),
      vaultEncrypt: vi.fn(async () => ({ ciphertextHex: '1122', ivHex: '3344' })),
      vaultDecrypt: vi.fn(async () => ({ plaintext: '{}' })),
      allocateSequence: vi.fn(async () => ({ sequence: '1' })),
      destroy: vi.fn(async () => {}),
      deriveStage1aKeys: vi.fn(async () => ({
        authPubkey: 'auth-pubkey-hex',
        salt: 'mock-salt-hex',
        recoveryKeyHex: 'mock-recovery-hex',
      })),
      sealZKVault: vi.fn(async (_payload: ZeroKnowledgeVaultPayload, _ver: number) => ({
        ciphertextHex: 'deadbeef-vault-ciphertext',
        signatureHex: 'mock-vault-signature',
      })),
      openZKVault: vi.fn(async () => ({
        schema_version: 1,
        user_id: 'user-alice-123',
        username: 'alice',
        identity_keys: { id_sign_pk: 'pk', id_sign_sk: 'sk', id_dh_pk: 'dh_pk', id_dh_sk: 'dh_sk' },
        devices: [{ device_id: 'default', label: 'Web Device', created_at: 1, last_seen_at: 1 }],
        conversation_epochs: {},
        pinned_identities: {},
        recovery_skipped: false,
      } as ZeroKnowledgeVaultPayload)),
    };

    mockZKVaultPort = {
      getVault: vi.fn(async () => vaultStore),
      saveVault: vi.fn(async (ver: number, ct: string, sig: string) => {
        vaultStore = {
          user_id: 'user-alice-123',
          version: ver + 1,
          ciphertext: ct,
          signature: sig,
          updated_at: Date.now(),
        };
        return vaultStore;
      }),
    };
  });

  it('registration passes auth_pubkey and salt to authPort and uploads initial vault', async () => {
    const authUC = new AuthUseCase(mockAuthPort, mockCryptoPort, mockMetadataPort, mockZKVaultPort);

    await authUC.register('alice', 'Password123!', 'Alice', true);

    expect(mockCryptoPort.deriveStage1aKeys).toHaveBeenCalledWith('Password123!');
    expect(mockAuthPort.register).toHaveBeenCalledWith(
      expect.any(Uint8Array),
      'alice',
      'Alice',
      true,
      'auth-pubkey-hex',
      'mock-salt-hex',
    );
    expect(mockCryptoPort.sealZKVault).toHaveBeenCalledWith(
      expect.objectContaining({
        schema_version: 1,
        user_id: 'user-alice-123',
        username: 'alice',
      }),
      1,
    );
    expect(mockZKVaultPort.saveVault).toHaveBeenCalledWith(
      0,
      'deadbeef-vault-ciphertext',
      'mock-vault-signature',
    );
    expect(metadataStore.get('last_seen_vault_version')).toBe('1');
    expect(metadataStore.get('pending_recovery_key')).toBe('mock-recovery-hex');
  });

  it('login fetches pre-auth KDF params and downloads/opens ZK vault', async () => {
    vaultStore = {
      user_id: 'user-alice-123',
      version: 1,
      ciphertext: 'deadbeef-vault-ciphertext',
      signature: 'mock-vault-signature',
      updated_at: 1000,
    };

    const authUC = new AuthUseCase(mockAuthPort, mockCryptoPort, mockMetadataPort, mockZKVaultPort);

    await authUC.login('alice', 'Password123!', true);

    expect(mockAuthPort.getKdfParams).toHaveBeenCalledWith('alice');
    expect(mockCryptoPort.deriveStage1aKeys).toHaveBeenCalledWith(
      'Password123!',
      '0123456789abcdef0123456789abcdef',
    );
    expect(mockZKVaultPort.getVault).toHaveBeenCalled();
    expect(mockCryptoPort.openZKVault).toHaveBeenCalledWith(
      'deadbeef-vault-ciphertext',
      'mock-vault-signature',
      1,
      'user-alice-123',
    );
    expect(metadataStore.get('last_seen_vault_version')).toBe('1');
  });

  it('login detects rollback if server serves older vault version', async () => {
    metadataStore.set('last_seen_vault_version', '5');
    vaultStore = {
      user_id: 'user-alice-123',
      version: 3, // older than 5 -> Rollback attack!
      ciphertext: 'deadbeef-vault-ciphertext',
      signature: 'mock-vault-signature',
      updated_at: 1000,
    };

    const authUC = new AuthUseCase(mockAuthPort, mockCryptoPort, mockMetadataPort, mockZKVaultPort);

    // Rollback error is caught inside login best-effort warning
    await authUC.login('alice', 'Password123!', true);

    // openZKVault should NOT have been called with rolled-back vault
    expect(mockCryptoPort.openZKVault).not.toHaveBeenCalled();
    // last_seen_vault_version must remain 5, not rolled back
    expect(metadataStore.get('last_seen_vault_version')).toBe('5');
  });
});
