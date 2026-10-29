import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  hashPasscode,
  verifyPasscode,
  loadPasscodeSettings,
  savePasscodeSettings,
  clearPasscodeSettings,
  type PasscodeSettings,
} from '../../src/domain/passcode';
import type { MetadataPort } from '../../src/domain';

describe('Passcode Domain & Local Hashing (Option 2)', () => {
  let mockStore: Record<string, string>;
  let mockMetadataPort: MetadataPort;

  beforeEach(() => {
    mockStore = {};
    mockMetadataPort = {
      get: vi.fn().mockImplementation((k: string) => Promise.resolve(mockStore[k] ?? null)),
      set: vi.fn().mockImplementation((k: string, v: string) => {
        mockStore[k] = v;
        return Promise.resolve();
      }),
      delete: vi.fn().mockImplementation((k: string) => {
        delete mockStore[k];
        return Promise.resolve();
      }),
    };
  });

  describe('hashPasscode', () => {
    it('generates a 16-byte hex salt and 32-byte hex hash', async () => {
      const res = await hashPasscode('1234');
      expect(res.salt).toBeDefined();
      expect(res.salt.length).toBe(32); // 16 bytes = 32 hex chars
      expect(res.hash).toBeDefined();
      expect(res.hash.length).toBe(64); // 32 bytes = 64 hex chars
    });

    it('derives deterministically with the same salt', async () => {
      const fixedSalt = '0123456789abcdef0123456789abcdef';
      const res1 = await hashPasscode('4321', fixedSalt);
      const res2 = await hashPasscode('4321', fixedSalt);

      expect(res1.salt).toBe(fixedSalt);
      expect(res2.salt).toBe(fixedSalt);
      expect(res1.hash).toBe(res2.hash);
    });

    it('produces different hashes for different PINs with same salt', async () => {
      const fixedSalt = 'aabbccddeeff00112233445566778899';
      const res1 = await hashPasscode('1111', fixedSalt);
      const res2 = await hashPasscode('2222', fixedSalt);

      expect(res1.hash).not.toBe(res2.hash);
    });

    it('produces different hashes for same PIN with different salts', async () => {
      const res1 = await hashPasscode('9999');
      const res2 = await hashPasscode('9999');

      expect(res1.salt).not.toBe(res2.salt);
      expect(res1.hash).not.toBe(res2.hash);
    });
  });

  describe('verifyPasscode', () => {
    it('returns true for matching PIN and false for wrong PIN', async () => {
      const { salt, hash } = await hashPasscode('5678');

      const ok = await verifyPasscode('5678', salt, hash);
      expect(ok).toBe(true);

      const wrong = await verifyPasscode('1234', salt, hash);
      expect(wrong).toBe(false);
    });

    it('safely handles empty or missing inputs without throwing', async () => {
      expect(await verifyPasscode('', 'salt', 'hash')).toBe(false);
      expect(await verifyPasscode('1234', '', 'hash')).toBe(false);
      expect(await verifyPasscode('1234', 'salt', '')).toBe(false);
    });
  });

  describe('Storage persistence helpers via MetadataPort', () => {
    it('returns default null/false state when unconfigured', async () => {
      const settings = await loadPasscodeSettings(mockMetadataPort);
      expect(settings.enabled).toBe(false);
      expect(settings.salt).toBeUndefined();
      expect(settings.hash).toBeUndefined();
      expect(settings.autoLockTimeout).toBe('5m'); // default fallback
    });

    it('saves and reloads settings correctly', async () => {
      const data: PasscodeSettings = {
        enabled: true,
        salt: 'abcd',
        hash: '1234',
        autoLockTimeout: '15m',
      };
      await savePasscodeSettings(mockMetadataPort, data);

      const loaded = await loadPasscodeSettings(mockMetadataPort);
      expect(loaded.enabled).toBe(true);
      expect(loaded.salt).toBe('abcd');
      expect(loaded.hash).toBe('1234');
      expect(loaded.autoLockTimeout).toBe('15m');
    });

    it('clears passcode settings cleanly', async () => {
      await savePasscodeSettings(mockMetadataPort, {
        enabled: true,
        salt: 'abcd',
        hash: '1234',
        autoLockTimeout: '1m',
      });
      await clearPasscodeSettings(mockMetadataPort);

      const reloaded = await loadPasscodeSettings(mockMetadataPort);
      expect(reloaded.enabled).toBe(false);
      expect(reloaded.salt).toBeUndefined();
    });

    it('isolates passcode settings between multiple users on the same device', async () => {
      // User A (alice) configures passcode
      await savePasscodeSettings(
        mockMetadataPort,
        { enabled: true, salt: 'salt_alice', hash: 'hash_alice', autoLockTimeout: '1m' },
        'user_alice',
      );

      // User B (bob) has no passcode configured
      const bobSettings = await loadPasscodeSettings(mockMetadataPort, 'user_bob');
      expect(bobSettings.enabled).toBe(false);

      // User A's settings are preserved
      const aliceSettings = await loadPasscodeSettings(mockMetadataPort, 'user_alice');
      expect(aliceSettings.enabled).toBe(true);
      expect(aliceSettings.salt).toBe('salt_alice');
      expect(aliceSettings.hash).toBe('hash_alice');
      expect(aliceSettings.autoLockTimeout).toBe('1m');

      // Clearing user_alice does not affect other keys
      await clearPasscodeSettings(mockMetadataPort, 'user_alice');
      const aliceCleared = await loadPasscodeSettings(mockMetadataPort, 'user_alice');
      expect(aliceCleared.enabled).toBe(false);
    });
  });
});
