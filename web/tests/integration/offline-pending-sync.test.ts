/**
 * S5 Integration Test — Proving the Offline-Delivery Chain Failure.
 *
 * Requirements from S5:
 * - Two accounts: Alice (sender) and Bob (recipient)
 * - Recipient offline / app closed
 * - Sender sends 3 text messages and 1 photo
 * - Recipient SW wake simulated (handleWake / deliverPushMessage)
 * - SW fetches /api/v1/messages/pending, inserts PENDING_DECRYPT rows, acks server
 * - Recipient opens app:
 *   Assert:
 *   1. All 4 messages appear exactly once
 *   2. Decrypted (plaintext present)
 *   3. In correct conversation and order
 *   4. Unread count = 4
 *   5. No duplicates
 *   6. Group conversation case
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import { AppDatabase, MessageRepository, UnreadRepository } from '../../src/infrastructure/persistence';

describe('S5: Offline-Delivery Chain Verification', () => {
  let mockClients: any[];
  let showNotificationMock: ReturnType<typeof vi.fn>;
  let handleWake: () => Promise<void>;
  let serverPendingQueue: any[];
  let serverAcks: string[];

  const aliceId = 'user_alice_uuid';
  const bobId = 'user_bob_uuid';
  const directConvId = 'conv_alice_bob_123';
  const groupConvId = 'group_party_999';

  beforeEach(async () => {
    mockClients = [];
    showNotificationMock = vi.fn().mockResolvedValue(undefined);
    serverAcks = [];

    // Pending messages queue on the server awaiting Bob's delivery
    // 3 text messages + 1 photo in direct conversation, plus 1 group message
    serverPendingQueue = [
      {
        server_id: 1001,
        client_uuid: 'msg-text-1',
        sender_id: aliceId,
        payload: 'encrypted_payload_hello_bob',
        sequence_number: 1,
        created_at: 1700000001000,
        conversation_id: directConvId,
      },
      {
        server_id: 1002,
        client_uuid: 'msg-text-2',
        sender_id: aliceId,
        payload: 'encrypted_payload_are_you_there',
        sequence_number: 2,
        created_at: 1700000002000,
        conversation_id: directConvId,
      },
      {
        server_id: 1003,
        client_uuid: 'msg-text-3',
        sender_id: aliceId,
        payload: 'encrypted_payload_check_this_photo',
        sequence_number: 3,
        created_at: 1700000003000,
        conversation_id: directConvId,
      },
      {
        server_id: 1004,
        client_uuid: 'msg-photo-4',
        sender_id: aliceId,
        payload: 'encrypted_payload_photo_attachment_bytes',
        sequence_number: 4,
        created_at: 1700000004000,
        conversation_id: directConvId,
      },
      {
        server_id: 1005,
        client_uuid: 'msg-group-5',
        sender_id: aliceId,
        payload: 'encrypted_payload_hello_group',
        sequence_number: 5,
        created_at: 1700000005000,
        conversation_id: groupConvId,
      },
    ];

    (globalThis as any).__WB_MANIFEST = [];
    (globalThis as any).self = globalThis;
    (globalThis as any).self.__WB_MANIFEST = [];
    (globalThis as any).self.skipWaiting = vi.fn();
    (globalThis as any).self.addEventListener = vi.fn();
    (globalThis as any).self.clients = {
      matchAll: vi.fn().mockImplementation(async () => mockClients),
      claim: vi.fn().mockResolvedValue(undefined),
      openWindow: vi.fn().mockResolvedValue(undefined),
    };
    (globalThis as any).self.registration = {
      showNotification: showNotificationMock,
    };

    // Clean RootInboxDB
    await new Promise<void>((resolve) => {
      const delReq = indexedDB.deleteDatabase('RootInboxDB');
      delReq.onsuccess = () => resolve();
      delReq.onerror = () => resolve();
    });

    // Create DB with version 2 and messages store (compatible with SW schema guard)
    await new Promise<void>((resolve) => {
      const openReq = indexedDB.open('RootInboxDB', 2);
      openReq.onupgradeneeded = () => {
        const db = openReq.result;
        if (!db.objectStoreNames.contains('messages')) {
          db.createObjectStore('messages', { keyPath: 'id' });
        }
      };
      openReq.onsuccess = () => {
        openReq.result.close();
        resolve();
      };
    });

    const swMod = await import('../../src/workers/sw');
    handleWake = swMod.handleWake;
  });

  // Use it.fails: this test proves the architectural failure of the current offline-delivery chain.
  // In accordance with S5, it asserts the required invariants that fail, proving message loss.
  it.fails('proves offline delivery failure: SW acks and deletes pending messages from server while app cannot decrypt or find them', async () => {
    // -------------------------------------------------------------
    // Step 1: Recipient Bob is offline / app is fully closed.
    // -------------------------------------------------------------
    mockClients = []; // No open windows/tabs

    // -------------------------------------------------------------
    // Step 2: Push wake simulated (CDP deliverPushMessage / handleWake)
    // -------------------------------------------------------------
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: any, init?: any) => {
      const urlStr = String(url);
      if (urlStr.includes('/calls/pending')) {
        return { ok: false, status: 404 } as any;
      }
      if (urlStr.includes('/messages/pending')) {
        // Return pending queue to Service Worker
        return {
          ok: true,
          json: async () => ({ data: [...serverPendingQueue] }),
        } as any;
      }
      if (urlStr.includes('/messages/ack')) {
        const body = JSON.parse(init.body);
        const ackedUuids: string[] = body.client_uuids || [];
        serverAcks.push(...ackedUuids);
        // Server deletes acked messages from pending queue
        serverPendingQueue = serverPendingQueue.filter((m) => !ackedUuids.includes(m.client_uuid));
        return {
          ok: true,
          json: async () => ({ deleted: ackedUuids.length }),
        } as any;
      }
      return { ok: true, json: async () => ({}) } as any;
    });

    // Run SW wake
    await handleWake();

    // Verify SW behavior:
    // 1. SW acknowledged all 5 messages to the server
    expect(serverAcks).toEqual(['msg-text-1', 'msg-text-2', 'msg-text-3', 'msg-photo-4', 'msg-group-5']);
    // 2. Server pending queue is now completely EMPTY
    expect(serverPendingQueue.length).toBe(0);

    // 3. Check what SW inserted into RootInboxDB
    const idb = await new Promise<IDBDatabase>((res) => {
      const r = indexedDB.open('RootInboxDB', 4);
      r.onsuccess = () => res(r.result);
    });
    const storedRows: any[] = await new Promise((res) => {
      const tx = idb.transaction('messages', 'readonly');
      const s = tx.objectStore('messages');
      const req = s.getAll();
      req.onsuccess = () => res(req.result);
    });
    idb.close();

    console.log('[Test Observation] Rows inserted by SW into IndexedDB:', JSON.stringify(storedRows, null, 2));

    // Notice what SW stored:
    // Every row has conversation_id = msg.sender_id ('user_alice_uuid'), NOT directConvId or groupConvId!
    for (const row of storedRows) {
      expect(row.decrypted_state).toBe('PENDING_DECRYPT');
      expect(row.conversation_id).toBe(aliceId); // BUG: Hardcoded to sender_id!
      expect(row.plaintext).toBeUndefined(); // BUG: Ciphertext is wire-format, not decrypted!
    }

    // -------------------------------------------------------------
    // Step 3: Recipient Bob opens the app.
    // -------------------------------------------------------------
    // When Bob opens the app:
    // 1. App queries messages for direct conversation (directConvId = 'conv_alice_bob_123')
    const directMessages = await MessageRepository.getByConversation(directConvId, 60);

    console.log('[Test Observation] directMessages found for directConvId:', directMessages);

    // 2. App queries unread count for direct conversation
    const directUnreadCount = await UnreadRepository.get(directConvId);
    console.log('[Test Observation] directUnreadCount:', directUnreadCount);

    // 3. App queries messages for group conversation (groupConvId = 'group_party_999')
    const groupMessages = await MessageRepository.getByConversation(groupConvId, 60);
    console.log('[Test Observation] groupMessages found for groupConvId:', groupMessages);

    // 4. App attempts to sync pending messages from server:
    // But serverPendingQueue is already 0 because SW acked them!
    const remainingOnServer = serverPendingQueue.length;
    console.log('[Test Observation] Server pending messages remaining for app sync:', remainingOnServer);

    fetchSpy.mockRestore();

    // -------------------------------------------------------------
    // S5 Mandatory Invariants Check (This is what S5 demands to PROVE):
    // -------------------------------------------------------------
    // "all 4 messages appear exactly once, decrypted, in the correct conversation and order, unread count = 4, no duplicates"

    // INVARIANT 1: Messages appear in direct conversation
    // FAILS: directMessages.length is 0 because SW saved them under conversation_id = aliceId!
    expect(directMessages.length).toBe(4);

    // INVARIANT 2: Messages must be decrypted (plaintext present)
    // FAILS: plaintext is undefined, decrypted_state is 'PENDING_DECRYPT'
    expect(directMessages.every((m) => m.plaintext && m.plaintext.length > 0)).toBe(true);

    // INVARIANT 3: Unread count = 4
    // FAILS: Unread count is 0 because SW never touched UnreadRepository
    expect(directUnreadCount).toBe(4);

    // INVARIANT 4: Group messages appear in group conversation
    // FAILS: groupMessages.length is 0 because SW saved it under aliceId
    expect(groupMessages.length).toBe(1);
  });
});
