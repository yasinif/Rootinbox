import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AuthUseCase } from '../../src/usecase/auth';
import { BrowserPushSubscriptionPort } from '../../src/infrastructure/push/subscription';
import { PushSubscriptionUseCase } from '../../src/usecase/push/PushSubscriptionUseCase';
import type { AuthPort, CryptoPort, MetadataPort } from '../../src/domain';
import type { PushRestClient } from '../../src/domain/ports/push';

describe('M1: Logout & Push Subscription Non-Hanging Invariants', () => {
  let sessionStore: Record<string, string>;
  let originalNavigator: unknown;

  beforeEach(() => {
    sessionStore = {};
    const mockSessionStorage: Storage = {
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
    originalNavigator = globalThis.navigator;
  });

  afterEach(() => {
    Object.defineProperty(globalThis, 'navigator', {
      value: originalNavigator,
      writable: true,
      configurable: true,
    });
  });

  const createMockAuthPorts = () => {
    const metaStore: Record<string, string> = {};
    const authPort: AuthPort = {
      requestChallenge: vi.fn().mockResolvedValue({ challengeId: 'c1', nonce: 'nonce1' }),
      register: vi.fn().mockResolvedValue({ user_id: 'usr-1', session_token: 'token-reg-1' }),
      verify: vi.fn().mockResolvedValue({ user_id: 'usr-1', session_token: 'token-v-1', displayName: 'U' }),
      getWSTicket: vi.fn().mockResolvedValue({ ticket: 't1' }),
      listSessions: vi.fn().mockResolvedValue([]),
      terminateSession: vi.fn().mockResolvedValue(undefined),
      terminateOtherSessions: vi.fn().mockResolvedValue(undefined),
    };
    const cryptoPort: CryptoPort = {
      init: vi.fn().mockResolvedValue({ identityHash: 'ident-1', publicKey: 'pub1' }),
      generateSessionKeys: vi.fn().mockResolvedValue({ publicKey: 'pk1', sessionId: 'sess1' }),
      restoreSession: vi.fn().mockResolvedValue(true),
      persistKeys: vi.fn().mockResolvedValue(undefined),
      loadKeys: vi.fn().mockResolvedValue(true),
      clearKeys: vi.fn().mockResolvedValue(undefined),
      destroy: vi.fn().mockResolvedValue(undefined),
      signWithSessionKey: vi.fn().mockResolvedValue('sig1'),
      deriveVaultKey: vi.fn().mockResolvedValue(undefined),
    };
    const metadataPort: MetadataPort = {
      get: vi.fn().mockImplementation(async (k: string) => metaStore[k] ?? null),
      set: vi.fn().mockImplementation(async (k: string, v: string) => {
        metaStore[k] = v;
      }),
      delete: vi.fn().mockImplementation(async (k: string) => {
        delete metaStore[k];
      }),
    };
    return { authPort, cryptoPort, metadataPort, metaStore };
  };

  it('logout completes and clears session in under 5 s with a never-resolving onBeforeLogout hook', async () => {
    const { authPort, cryptoPort, metadataPort, metaStore } = createMockAuthPorts();
    metaStore.session_token = 'token-active';
    metaStore.active_session_keypair = JSON.stringify({ sessionId: 'sess-1' });
    sessionStore.session_token = 'token-active';

    const authUC = new AuthUseCase(authPort, cryptoPort, metadataPort);

    // Set a never-resolving hook
    const neverResolvingHook = () => new Promise<void>(() => {});
    authUC.setBeforeLogoutHook(neverResolvingHook);

    const start = Date.now();
    await authUC.logout();
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(5000);
    expect(authUC.getSnapshot().state).toBe('idle');
    expect(cryptoPort.clearKeys).toHaveBeenCalled();
    expect(sessionStore.session_token).toBeUndefined();
  }, 10000);

  it('getCurrentSubscription returns null and completes in under 3 s when serviceWorker.ready never resolves', async () => {
    // Mock navigator.serviceWorker.ready as a never-resolving Promise
    Object.defineProperty(globalThis, 'navigator', {
      value: {
        serviceWorker: {
          ready: new Promise(() => {}),
        },
      },
      writable: true,
      configurable: true,
    });
    Object.defineProperty(globalThis, 'Notification', {
      value: { permission: 'granted' },
      writable: true,
      configurable: true,
    });
    Object.defineProperty(globalThis, 'window', {
      value: {
        isSecureContext: true,
        Notification: { permission: 'granted' },
        PushManager: class {},
      },
      writable: true,
      configurable: true,
    });

    const port = new BrowserPushSubscriptionPort();
    expect(port.isSupported()).toBe(true);

    const start = Date.now();
    const sub = await port.getCurrentSubscription();
    const elapsed = Date.now() - start;

    expect(sub).toBeNull();
    expect(elapsed).toBeLessThan(3500);
    expect(elapsed).toBeGreaterThanOrEqual(1900);
  }, 10000);

  it('logout completes in under 5 s when hook calls pushUC.unsubscribe() with a never-resolving serviceWorker.ready', async () => {
    Object.defineProperty(globalThis, 'navigator', {
      value: {
        serviceWorker: {
          ready: new Promise(() => {}),
        },
      },
      writable: true,
      configurable: true,
    });
    Object.defineProperty(globalThis, 'Notification', {
      value: { permission: 'granted' },
      writable: true,
      configurable: true,
    });
    Object.defineProperty(globalThis, 'window', {
      value: {
        isSecureContext: true,
        Notification: { permission: 'granted' },
        PushManager: class {},
      },
      writable: true,
      configurable: true,
    });

    const { authPort, cryptoPort, metadataPort, metaStore } = createMockAuthPorts();
    metaStore.session_token = 'token-active';
    sessionStore.session_token = 'token-active';

    const authUC = new AuthUseCase(authPort, cryptoPort, metadataPort);
    const mockHttpClient: PushRestClient = {
      getVapidPublicKey: vi.fn().mockResolvedValue('key'),
      subscribe: vi.fn().mockResolvedValue(undefined),
      unsubscribe: vi.fn().mockResolvedValue(undefined),
    };
    const pushPort = new BrowserPushSubscriptionPort();
    const pushUC = new PushSubscriptionUseCase(mockHttpClient, pushPort);

    authUC.setBeforeLogoutHook(async () => {
      try {
        await pushUC.unsubscribe();
      } catch (err) {
        console.warn('[Push] Unsubscribe on logout failed:', err);
      }
    });

    const start = Date.now();
    await authUC.logout();
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(5000);
    expect(authUC.getSnapshot().state).toBe('idle');
    expect(cryptoPort.clearKeys).toHaveBeenCalled();
    expect(sessionStore.session_token).toBeUndefined();
  }, 10000);

  it('logout handles hook that rejects after 3s timeout without unhandled promise rejection', async () => {
    const { authPort, cryptoPort, metadataPort, metaStore } = createMockAuthPorts();
    metaStore.session_token = 'token-active';
    sessionStore.session_token = 'token-active';

    const authUC = new AuthUseCase(authPort, cryptoPort, metadataPort);

    // Hook that rejects after 3.2 seconds
    const lateRejectingHook = () =>
      new Promise<void>((_, reject) => {
        setTimeout(() => reject(new Error('late hook rejection')), 3200);
      });
    authUC.setBeforeLogoutHook(lateRejectingHook);

    const start = Date.now();
    await authUC.logout();
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(5000);
    expect(authUC.getSnapshot().state).toBe('idle');
    expect(sessionStore.session_token).toBeUndefined();

    // Wait until late rejection fires to confirm no unhandled rejection crashes test
    await new Promise((r) => setTimeout(r, 400));
  }, 10000);

  it('getCurrentSubscription handles serviceWorker.ready rejecting after 2s timeout without crash', async () => {
    Object.defineProperty(globalThis, 'navigator', {
      value: {
        serviceWorker: {
          ready: new Promise((_, reject) => {
            setTimeout(() => reject(new Error('late ready rejection')), 2200);
          }),
        },
      },
      writable: true,
      configurable: true,
    });
    Object.defineProperty(globalThis, 'Notification', {
      value: { permission: 'granted' },
      writable: true,
      configurable: true,
    });
    Object.defineProperty(globalThis, 'window', {
      value: {
        isSecureContext: true,
        Notification: { permission: 'granted' },
        PushManager: class {},
      },
      writable: true,
      configurable: true,
    });

    const port = new BrowserPushSubscriptionPort();
    const start = Date.now();
    const sub = await port.getCurrentSubscription();
    const elapsed = Date.now() - start;

    expect(sub).toBeNull();
    expect(elapsed).toBeLessThan(3500);

    // Wait past late rejection
    await new Promise((r) => setTimeout(r, 400));
  }, 10000);
});
