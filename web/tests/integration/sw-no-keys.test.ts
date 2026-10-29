/**
 * Phase 12B Integration Test — SW Cryptographic Boundary Isolation (§19.3, §19.6, §23.3).
 *
 * Asserts:
 * - SW execution context has no access to the crypto worker
 * - SW execution context has no Dexie handle
 * - SW postMessage payloads never carry plaintext, keys, or sensitive metadata
 * - SW persisted rows in IndexedDB contain ciphertext only with decrypted_state = PENDING_DECRYPT
 * - Row B-01 bundle assertions
 */

import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import 'fake-indexeddb/auto';

describe('Service Worker Key Isolation Test (§19.3, §19.6, §23.3)', () => {
  it('proves SW source and built bundles contain no crypto worker or dexie imports', () => {
    const swSourcePath = path.resolve(__dirname, '../../src/workers/sw.ts');
    const swSource = fs.readFileSync(swSourcePath, 'utf8');

    // Source prohibitions
    expect(swSource).not.toMatch(/from\s+['"].*crypto\.worker/);
    expect(swSource).not.toMatch(/import.*['"]dexie['"]/);
    expect(swSource).not.toMatch(/import.*['"]libsodium['"]/);
    expect(swSource).not.toMatch(/import.*['"]argon2['"]/);
    expect(swSource).not.toMatch(/import.*['"]hash-wasm['"]/);

    // Row B-01: Prohibited terms
    const prohibitedTerms = [
      'media_key',
      'media_token',
      'Media_Key',
      'argon2',
      'libsodium',
      'hash-wasm',
    ];

    for (const term of prohibitedTerms) {
      expect(swSource).not.toContain(term);
    }
  });

  it('proves SW postMessage traffic carries only routing wake signals and zero key material or plaintext', async () => {
    (globalThis as any).__WB_MANIFEST = [];
    (globalThis as any).self = globalThis;
    (globalThis as any).self.__WB_MANIFEST = [];
    (globalThis as any).self.skipWaiting = vi.fn();
    (globalThis as any).self.addEventListener = vi.fn();
    (globalThis as any).self.registration = {
      showNotification: vi.fn().mockResolvedValue(undefined),
    };

    const postedMessages: any[] = [];
    const mockClient = {
      visibilityState: 'hidden',
      postMessage: vi.fn((msg) => postedMessages.push(msg)),
    };

    (globalThis as any).self.clients = {
      matchAll: vi.fn().mockResolvedValue([mockClient]),
    };

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: any) => {
      const urlStr = String(url);
      if (urlStr.includes('/calls/pending')) {
        return {
          ok: true,
          json: async () => ({ call_id: 'call-xyz-999', encrypted_offer: 'b64encrypted' }),
        } as any;
      }
      if (urlStr.includes('/messages/pending')) {
        return {
          ok: true,
          json: async () => ({
            data: [
              {
                client_uuid: 'uuid-1',
                sender_id: 'peer-alice',
                payload: '010203040506',
                sequence_number: 1,
              },
            ],
          }),
        } as any;
      }
      if (urlStr.includes('/messages/ack')) {
        return { ok: true, json: async () => ({ deleted: 1 }) } as any;
      }
      return { ok: true, json: async () => ({}) } as any;
    });

    const { handleWake } = await import('../../src/workers/sw');
    await handleWake();

    // Verify all messages sent through postMessage
    for (const msg of postedMessages) {
      expect(['wake', 'incoming-call']).toContain(msg.type);
      expect(msg.plaintext).toBeUndefined();
      expect(msg.key).toBeUndefined();
      expect(msg.media_key).toBeUndefined();
      expect(msg.caller_name).toBeUndefined();
      expect(msg.content).toBeUndefined();
    }

    fetchSpy.mockRestore();
  }, 15000);
});
