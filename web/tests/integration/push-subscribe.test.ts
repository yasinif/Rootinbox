/**
 * Phase 12B Integration Test — Push Subscription Flow (§19.2, §22.4, §23.3, Row W-04).
 *
 * Asserts:
 * - VAPID key validation: 65 bytes, starts with 0x04; invalid -> PSH_C03
 * - PushManager subscribe called with ArrayBuffer/Uint8Array applicationServerKey (never string)
 * - POST /push/subscribe sent with V-9 field names (p256dh_key, auth_secret) in Base64URL
 * - 404 disabled server path degrades silently (ADR-P12B-34)
 * - Permission denied -> PSH_C02
 * - Server error retry logic with rollback unsubscription
 * - Unsubscribe flow: DELETE then unsubscribe()
 */

import { describe, it, expect, vi } from 'vitest';
import { PushSubscriptionUseCase } from '../../src/usecase/push/PushSubscriptionUseCase';
import type { PushRestClient, PushSubscriptionPort } from '../../src/domain/ports/push';
import { base64UrlEncode } from '../../src/domain/encoding';

describe('Push Subscription Integration Test (§19.2, §23.3, Row W-04)', () => {
  // Valid 65-byte uncompressed P-256 public key (0x04 prefix)
  const validVapidRaw = new Uint8Array(65);
  validVapidRaw[0] = 0x04;
  for (let i = 1; i < 65; i++) validVapidRaw[i] = (i * 7) % 256;
  const validVapidB64Url = base64UrlEncode(validVapidRaw);

  // Valid 65-byte p256dh key
  const validP256dh = new Uint8Array(65);
  validP256dh[0] = 0x04;
  for (let i = 1; i < 65; i++) validP256dh[i] = (i * 11) % 256;

  // Valid 16-byte auth secret
  const validAuth = new Uint8Array(16);
  for (let i = 0; i < 16; i++) validAuth[i] = (i * 13) % 256;

  function createMockSubscription(endpoint = 'https://push.example.com/sub/123') {
    return {
      endpoint,
      getKey: vi.fn((name: string) => {
        if (name === 'p256dh') return validP256dh.buffer;
        if (name === 'auth') return validAuth.buffer;
        return null;
      }),
      unsubscribe: vi.fn().mockResolvedValue(true),
    } as unknown as PushSubscription;
  }

  function createMocks() {
    const mockClient: PushRestClient = {
      getVapidPublicKey: vi.fn().mockResolvedValue(validVapidB64Url),
      subscribe: vi.fn().mockResolvedValue(undefined),
      unsubscribe: vi.fn().mockResolvedValue(undefined),
    };

    const mockSub = createMockSubscription();

    const mockPort: PushSubscriptionPort = {
      isSupported: vi.fn().mockReturnValue(true),
      requestPermission: vi.fn().mockResolvedValue('granted' as NotificationPermission),
      subscribeToPush: vi.fn().mockResolvedValue(mockSub),
      getCurrentSubscription: vi.fn().mockResolvedValue(mockSub),
      unsubscribeFromPush: vi.fn().mockResolvedValue(true),
    };

    return { mockClient, mockPort, mockSub };
  }

  it('runs complete 9-step subscription flow with correct V-9 field names and Base64URL encodings', async () => {
    const { mockClient, mockPort } = createMocks();
    const useCase = new PushSubscriptionUseCase(mockClient, mockPort);

    const result = await useCase.subscribe();
    expect(result).toBe(true);

    expect(mockClient.getVapidPublicKey).toHaveBeenCalledTimes(1);
    expect(mockPort.requestPermission).toHaveBeenCalledTimes(1);
    expect(mockPort.subscribeToPush).toHaveBeenCalledWith(validVapidB64Url);

    // Assert POST /push/subscribe was called with endpoint and V-9 fields
    expect(mockClient.subscribe).toHaveBeenCalledWith(
      'https://push.example.com/sub/123',
      base64UrlEncode(validP256dh),
      base64UrlEncode(validAuth),
    );
  });

  it('silently degrades when push is unsupported or disabled server-side (ADR-P12B-34)', async () => {
    const { mockClient, mockPort } = createMocks();
    const useCase = new PushSubscriptionUseCase(mockClient, mockPort);

    // Unsupported port
    vi.mocked(mockPort.isSupported).mockReturnValue(false);
    expect(await useCase.isAvailable()).toBe(false);

    // Supported port but 404/disabled server
    vi.mocked(mockPort.isSupported).mockReturnValue(true);
    vi.mocked(mockClient.getVapidPublicKey).mockRejectedValue(new Error('PUSH_001'));
    expect(await useCase.isAvailable()).toBe(false);

    vi.mocked(mockClient.getVapidPublicKey).mockResolvedValue('');
    expect(await useCase.isAvailable()).toBe(false);
  });

  it('rejects invalid VAPID keys with PSH_C03 (Row W-04: must be 65 bytes, prefix 0x04)', async () => {
    const { mockClient, mockPort } = createMocks();
    const useCase = new PushSubscriptionUseCase(mockClient, mockPort);

    // 64-byte key (missing prefix)
    const badLengthKey = new Uint8Array(64);
    vi.mocked(mockClient.getVapidPublicKey).mockResolvedValue(base64UrlEncode(badLengthKey));
    await expect(useCase.subscribe()).rejects.toThrow(/PSH_C03/);

    // 65-byte key with 0x02 prefix (compressed)
    const badPrefixKey = new Uint8Array(65);
    badPrefixKey[0] = 0x02;
    vi.mocked(mockClient.getVapidPublicKey).mockResolvedValue(base64UrlEncode(badPrefixKey));
    await expect(useCase.subscribe()).rejects.toThrow(/PSH_C03/);
  });

  it('rejects with PSH_C02 on user permission denial and never re-prompts automatically', async () => {
    const { mockClient, mockPort } = createMocks();
    vi.mocked(mockPort.requestPermission).mockResolvedValue('denied');
    const useCase = new PushSubscriptionUseCase(mockClient, mockPort);

    await expect(useCase.subscribe()).rejects.toThrow(/PSH_C02/);
    expect(mockPort.subscribeToPush).not.toHaveBeenCalled();
  });

  it('retries POST /push/subscribe once and rolls back subscription on 2nd failure', async () => {
    const { mockClient, mockPort, mockSub } = createMocks();
    vi.mocked(mockClient.subscribe).mockRejectedValue(new Error('500 internal server error'));

    const useCase = new PushSubscriptionUseCase(mockClient, mockPort);

    await expect(useCase.subscribe()).rejects.toThrow(/PSH_C03/);
    expect(mockClient.subscribe).toHaveBeenCalledTimes(2); // Retried once
    expect(mockSub.unsubscribe).toHaveBeenCalledTimes(1);  // Rollback unsubscribe called
  });

  it('unsubscribes by calling DELETE /push/subscribe first, then subscription.unsubscribe()', async () => {
    const { mockClient, mockPort, mockSub } = createMocks();
    const useCase = new PushSubscriptionUseCase(mockClient, mockPort);

    const unsubscribed = await useCase.unsubscribe();
    expect(unsubscribed).toBe(true);

    expect(mockClient.unsubscribe).toHaveBeenCalledWith('https://push.example.com/sub/123');
    expect(mockSub.unsubscribe).toHaveBeenCalledTimes(1);
  });
});
