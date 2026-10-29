import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AuthUseCase } from '../../src/usecase/auth';
import type { AuthPort, CryptoPort, MetadataPort } from '../../src/domain';

describe('Option 3: Remember Me & Ephemeral Session Storage', () => {
  let sessionStore: Record<string, string>;
  let mockSessionStorage: Storage;

  beforeEach(() => {
    sessionStore = {};
    mockSessionStorage = {
      getItem: (k: string) => sessionStore[k] ?? null,
      setItem: (k: string, v: string) => {
        sessionStore[k] = v;
      },
      removeItem: (k: string) => {
        delete sessionStore[k];
      },
      clear: () => {
        sessionStore = {};
      },
      key: (i: number) => Object.keys(sessionStore)[i] ?? null,
      length: 0,
    };
    Object.defineProperty(globalThis, 'sessionStorage', {
      value: mockSessionStorage,
      writable: true,
      configurable: true,
    });
  });

  const createMockPorts = () => {
    const metaStore: Record<string, string> = {};

    const authPort: AuthPort = {
      requestChallenge: vi.fn().mockResolvedValue({
        challengeId: 'c1',
        nonce: 'nonce1',
      }),
      register: vi.fn().mockResolvedValue({
        user_id: 'usr-1',
        session_token: 'token-reg-1',
      }),
      verify: vi.fn().mockResolvedValue({
        user_id: 'usr-1',
        session_token: 'token-verify-1',
        displayName: 'Test User',
      }),
      getWSTicket: vi.fn().mockResolvedValue({ ticket: 't1' }),
      listSessions: vi.fn().mockResolvedValue([]),
      terminateSession: vi.fn().mockResolvedValue(undefined),
      terminateOtherSessions: vi.fn().mockResolvedValue(undefined),
    };

    const cryptoPort: CryptoPort = {
      init: vi.fn().mockResolvedValue({
        identityHash: 'ident-hash-1',
        publicKey: 'pub1',
      }),
      generateSessionKeys: vi.fn().mockResolvedValue({ publicKey: 'pk1', sessionId: 'sess1' }),
      exportSessionKeys: vi.fn().mockResolvedValue({ publicKey: 'pk1', privateKey: 'sk1', sessionId: 'sess1' }),
      signSessionKey: vi.fn().mockResolvedValue({ signature: 'sig1' }),
      signLoginPayload: vi.fn().mockResolvedValue({ signature: 'login-sig1' }),
      buildRegistrationWire: vi.fn().mockResolvedValue({
        wireBytes: new Uint8Array([1, 2, 3]),
        identityHash: 'ident-hash-1',
      }),
      encrypt: vi.fn(),
      decrypt: vi.fn(),
      deriveVaultKey: vi.fn().mockResolvedValue(undefined),
      vaultEncrypt: vi.fn(),
      vaultDecrypt: vi.fn(),
      allocateSequence: vi.fn(),
      persistKeys: vi.fn().mockResolvedValue(undefined),
      restoreKeys: vi.fn().mockResolvedValue({
        identityHash: 'ident-hash-1',
        publicKey: 'pub1',
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

  it('register with rememberMe=true persists keys to IndexedDB and stores token in MetadataPort', async () => {
    const { authPort, cryptoPort, metadataPort, metaStore } = createMockPorts();
    const authUC = new AuthUseCase(authPort, cryptoPort, metadataPort);

    await authUC.register('alice', 'password123', 'Alice W', true);

    expect(authPort.register).toHaveBeenCalledWith(
      expect.any(Uint8Array),
      'alice',
      'Alice W',
      true,
    );
    expect(cryptoPort.persistKeys).toHaveBeenCalled();
    expect(metaStore.session_token).toBe('token-reg-1');
    expect(sessionStore.session_token).toBeUndefined();
  });

  it('register with rememberMe=false skips key persistence, clears keyring, and keeps token in sessionStorage only', async () => {
    const { authPort, cryptoPort, metadataPort, metaStore } = createMockPorts();
    const authUC = new AuthUseCase(authPort, cryptoPort, metadataPort);

    await authUC.register('bob', 'password123', 'Bob W', false);

    expect(authPort.register).toHaveBeenCalledWith(
      expect.any(Uint8Array),
      'bob',
      'Bob W',
      false,
    );
    // Keys must NOT be persisted to disk
    expect(cryptoPort.persistKeys).not.toHaveBeenCalled();
    // Keyring on disk is actively cleared
    expect(cryptoPort.clearKeys).toHaveBeenCalled();
    // Persistent Dexie metadata does NOT contain session_token
    expect(metaStore.session_token).toBeUndefined();
    // Session token is isolated in sessionStorage
    expect(sessionStore.session_token).toBe('token-reg-1');
    expect(sessionStore.is_session_only).toBe('true');
  });

  it('login with rememberMe=false passes rememberMe to verify and isolates token in sessionStorage', async () => {
    const { authPort, cryptoPort, metadataPort, metaStore } = createMockPorts();
    const authUC = new AuthUseCase(authPort, cryptoPort, metadataPort);

    await authUC.login('carol', 'password123', false);

    expect(authPort.verify).toHaveBeenCalledWith(
      'ident-hash-1',
      'c1',
      'login-sig1',
      'pk1',
      'sig1',
      expect.any(Number),
      false,
    );
    expect(cryptoPort.persistKeys).not.toHaveBeenCalled();
    expect(cryptoPort.clearKeys).toHaveBeenCalled();
    expect(metaStore.session_token).toBeUndefined();
    expect(sessionStore.session_token).toBe('token-verify-1');
    expect(sessionStore.auth_username).toBe('carol');
    expect(sessionStore.is_session_only).toBe('true');
  });

  it('tryRestoreSession restores seamlessly from sessionStorage on active tab when is_session_only is true', async () => {
    const { authPort, cryptoPort, metadataPort } = createMockPorts();
    sessionStore.is_session_only = 'true';
    sessionStore.session_token = 'sess-tab-token';
    sessionStore.identity_hash = 'ident-sess-hash';
    sessionStore.auth_username = 'dan';
    sessionStore.display_name = 'Dan W';
    sessionStore.user_id = 'usr-dan';

    const authUC = new AuthUseCase(authPort, cryptoPort, metadataPort);
    const restored = await authUC.tryRestoreSession();

    expect(restored).toBe(true);
    expect(authUC.snapshot.state).toBe('authenticated');
    expect(authUC.snapshot.username).toBe('dan');
    expect(authUC.snapshot.displayName).toBe('Dan W');
  });

  it('logout cleans both persistent storage and sessionStorage completely', async () => {
    const { authPort, cryptoPort, metadataPort, metaStore } = createMockPorts();
    metaStore.session_token = 'meta-token';
    sessionStore.is_session_only = 'true';
    sessionStore.session_token = 'sess-token';
    sessionStore.auth_username = 'eve';

    const authUC = new AuthUseCase(authPort, cryptoPort, metadataPort);
    await authUC.logout();

    expect(cryptoPort.clearKeys).toHaveBeenCalled();
    expect(metadataPort.delete).toHaveBeenCalledWith('session_token');
    expect(sessionStore.session_token).toBeUndefined();
    expect(sessionStore.auth_username).toBeUndefined();
    expect(sessionStore.is_session_only).toBeUndefined();
    expect(authUC.snapshot.state).toBe('idle');
  });

  it('unlock with is_session_only=true strictly avoids persisting keys to disk or writing metadata', async () => {
    const { authPort, cryptoPort, metadataPort, metaStore } = createMockPorts();
    sessionStore.is_session_only = 'true';
    sessionStore.session_token = 'sess-tab-token';
    sessionStore.auth_username = 'frank';
    sessionStore.identity_hash = 'ident-hash-1';

    const authUC = new AuthUseCase(authPort, cryptoPort, metadataPort);
    await authUC.unlock('password123');

    // Keys must NOT be persisted to disk
    expect(cryptoPort.persistKeys).not.toHaveBeenCalled();
    // Dexie metadata must NOT have auth_username
    expect(metaStore.auth_username).toBeUndefined();
    // Session storage has auth_username
    expect(sessionStore.auth_username).toBe('frank');
    expect(authUC.snapshot.state).toBe('authenticated');
    expect(authUC.snapshot.username).toBe('frank');
  });
});
