import { describe, it, expect, vi } from 'vitest';
import { AuthUseCase } from '../../src/usecase/auth';
import type { AuthPort, CryptoPort, MetadataPort } from '../../src/domain';

describe('Remember Keys & Zero-Password Session Restoration (RFC-0003 §8.3)', () => {
  const createMockPorts = () => {
    const metaStore: Record<string, string> = {
      session_token: 'valid-session-token-hex',
      identity_hash: 'ident-hash-123',
      username: 'alice',
      display_name: 'Alice W',
      user_id: 'usr-alice-uuid',
    };

    const authPort: AuthPort = {
      requestChallenge: vi.fn(),
      register: vi.fn(),
      verify: vi.fn(),
      getWSTicket: vi.fn(),
      listSessions: vi.fn(),
      terminateSession: vi.fn(),
      terminateOtherSessions: vi.fn(),
    };

    const cryptoPort: CryptoPort = {
      init: vi.fn(),
      generateSessionKeys: vi.fn().mockResolvedValue({ publicKey: 'session-pk', sessionId: 'sess-1' }),
      exportSessionKeys: vi.fn().mockResolvedValue({ publicKey: 'session-pk', privateKey: 'session-sk', sessionId: 'sess-1' }),
      signSessionKey: vi.fn(),
      signLoginPayload: vi.fn(),
      buildRegistrationWire: vi.fn(),
      encrypt: vi.fn(),
      decrypt: vi.fn(),
      deriveVaultKey: vi.fn(),
      vaultEncrypt: vi.fn(),
      vaultDecrypt: vi.fn(),
      allocateSequence: vi.fn(),
      persistKeys: vi.fn().mockResolvedValue(undefined),
      restoreKeys: vi.fn().mockResolvedValue({
        identityHash: 'ident-hash-123',
        publicKey: 'pubkey-123',
      }),
      clearKeys: vi.fn().mockResolvedValue(undefined),
      destroy: vi.fn().mockResolvedValue(undefined),
    };

    const metadataPort: MetadataPort = {
      get: vi.fn().mockImplementation((k: string) => Promise.resolve(metaStore[k] ?? null)),
      set: vi.fn().mockImplementation((k: string, v: string) => {
        metaStore[k] = v;
        return Promise.resolve();
      }),
      delete: vi.fn().mockImplementation((k: string) => {
        delete metaStore[k];
        return Promise.resolve();
      }),
    };

    return { authPort, cryptoPort, metadataPort, metaStore };
  };

  it('restores authenticated session without password when wrapped keys exist in keyring', async () => {
    const { authPort, cryptoPort, metadataPort } = createMockPorts();
    const authUC = new AuthUseCase(authPort, cryptoPort, metadataPort);

    const states: string[] = [];
    authUC.subscribe((snapshot) => states.push(snapshot.state));

    const restored = await authUC.tryRestoreSession();
    expect(restored).toBe(true);
    expect(cryptoPort.restoreKeys).toHaveBeenCalled();
    expect(authUC.snapshot.state).toBe('authenticated');
    expect(authUC.snapshot.identityHash).toBe('ident-hash-123');
    expect(authUC.snapshot.username).toBe('alice');
    expect(authUC.snapshot.displayName).toBe('Alice W');
  });

  it('fails restore gracefully if keyring returns null (no wrapped keys)', async () => {
    const { authPort, cryptoPort, metadataPort } = createMockPorts();
    cryptoPort.restoreKeys = vi.fn().mockResolvedValue(null);
    const authUC = new AuthUseCase(authPort, cryptoPort, metadataPort);

    const restored = await authUC.tryRestoreSession();
    expect(restored).toBe(false);
    expect(authUC.snapshot.state).toBe('idle');
  });

  it('fails restore gracefully if session_token is missing from metadata', async () => {
    const { authPort, cryptoPort, metadataPort, metaStore } = createMockPorts();
    delete metaStore.session_token;
    const authUC = new AuthUseCase(authPort, cryptoPort, metadataPort);

    const restored = await authUC.tryRestoreSession();
    expect(restored).toBe(false);
  });

  it('purges keyring and wipes all keys completely on logout', async () => {
    const { authPort, cryptoPort, metadataPort } = createMockPorts();
    const authUC = new AuthUseCase(authPort, cryptoPort, metadataPort);

    await authUC.tryRestoreSession();
    expect(authUC.snapshot.state).toBe('authenticated');

    await authUC.logout();

    expect(cryptoPort.clearKeys).toHaveBeenCalled();
    expect(cryptoPort.destroy).toHaveBeenCalled();
    expect(metadataPort.delete).toHaveBeenCalledWith('session_token');
    expect(metadataPort.delete).toHaveBeenCalledWith('identity_hash');
    expect(metadataPort.delete).toHaveBeenCalledWith('user_id');
    expect(authUC.snapshot.state).toBe('idle');
    expect(authUC.snapshot.identityHash).toBeNull();
  });
});
