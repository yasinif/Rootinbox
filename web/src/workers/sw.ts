/**
 * Service Worker entry point.
 * Phase 12B §19.4, §19.6, RFC-0009 §8.1, RFC-0010 §6, Row B-01.
 *
 * STRICT PROHIBITIONS (§19.6, Row B-01):
 * - NO crypto worker import
 * - NO dexie import (raw IndexedDB only)
 * - NO key material, NO CryptoKey handle, NO plaintext, NO decryption
 * - NO thumbnail decode
 * - NO caching of /api/* responses (RFC-0010 §6.2 NetworkOnly stands)
 * - NO sender name or message content in any notification
 * - NO ack of un-persisted message rows (ADR-P12B-33)
 * - NO schema migration
 */

/// <reference lib="webworker" />

import { precacheAndRoute, cleanupOutdatedCaches } from 'workbox-precaching';
import { registerRoute } from 'workbox-routing';
import { NetworkFirst, NetworkOnly } from 'workbox-strategies';

declare const self: ServiceWorkerGlobalScope;

import { SW_CACHE_VERSION } from '../domain/version';
import { recordSWEvent } from '../infrastructure/push/swLogs';
export { SW_CACHE_VERSION, recordSWEvent };

// §6.1: Precache the app shell (static assets) and evict outdated caches.
precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();

// §6.2: All /api/* routes MUST use NetworkOnly strategy.
registerRoute(
  ({ url }) => url.pathname.startsWith('/api/'),
  new NetworkOnly(),
);

// HTML navigation requests: NetworkFirst to guarantee fresh index.html
registerRoute(
  ({ request }) => request.mode === 'navigate',
  new NetworkFirst({
    cacheName: `rootinbox-nav-${SW_CACHE_VERSION}`,
  }),
);

const EXPECTED_DB_VERSION = 2;

/**
 * Open IndexedDB read-only with schema guard (Step 5).
 * If on-disk DB is newer than SW expected version, abort to prevent schema downgrade.
 */
function openIndexedDB(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') {
      resolve(null);
      return;
    }
    const timer = setTimeout(() => resolve(null), 500);

    try {
      const req = indexedDB.open('RootInboxDB');
      req.onsuccess = () => {
        if (timer) clearTimeout(timer);
        const db = req.result;
        if (db.version > EXPECTED_DB_VERSION) {
          db.close();
          resolve(null);
        } else {
          resolve(db);
        }
      };
      req.onerror = () => {
        if (timer) clearTimeout(timer);
        resolve(null);
      };
      req.onblocked = () => {
        if (timer) clearTimeout(timer);
        resolve(null);
      };
      req.onupgradeneeded = () => {
        if (timer) clearTimeout(timer);
        // SW is strictly forbidden from migrating schema (§19.6)
        req.transaction?.abort();
        resolve(null);
      };
    } catch {
      if (timer) clearTimeout(timer);
      resolve(null);
    }
  });
}

interface PendingMessageItem {
  server_id?: number;
  id?: string;
  client_uuid?: string;
  sender_id: string;
  payload: string;
  sequence_number?: number;
  created_at?: number;
  conversation_id?: string;
}

/**
 * Insert pending messages with decrypted_state = PENDING_DECRYPT (Step 6, ADR-P12B-30).
 * Returns only client UUIDs that were durably inserted (ADR-P12B-33).
 */
function insertPendingMessages(db: IDBDatabase, messages: PendingMessageItem[]): Promise<string[]> {
  return new Promise((resolve) => {
    if (!db.objectStoreNames.contains('messages')) {
      resolve([]);
      return;
    }
    const tx = db.transaction('messages', 'readwrite');
    const store = tx.objectStore('messages');
    const insertedUuids: string[] = [];

    let pendingCount = messages.length;
    if (pendingCount === 0) {
      resolve([]);
      return;
    }

    tx.oncomplete = () => {
      resolve(insertedUuids);
    };
    tx.onerror = () => {
      resolve(insertedUuids);
    };
    tx.onabort = () => {
      resolve([]);
    };

    for (const msg of messages) {
      const uuid = msg.client_uuid || msg.id;
      if (!uuid) {
        pendingCount--;
        continue;
      }
      const getReq = store.get(uuid);
      getReq.onsuccess = () => {
        if (!getReq.result) {
          const row = {
            id: uuid,
            conversation_id: msg.sender_id,
            sender_id: msg.sender_id,
            ciphertext: msg.payload,
            sequence_str: String(msg.sequence_number ?? 0),
            created_at: msg.created_at || Date.now(),
            status: 'pending',
            decrypted_state: 'PENDING_DECRYPT',
          };
          const addReq = store.add(row);
          addReq.onsuccess = () => {
            insertedUuids.push(uuid);
            pendingCount--;
          };
          addReq.onerror = (e) => {
            e.preventDefault();
            pendingCount--;
          };
        } else {
          pendingCount--;
        }
      };
      getReq.onerror = (e) => {
        e.preventDefault();
        pendingCount--;
      };
    }
  });
}

/**
 * Helper to convert a base64url string to Uint8Array for PushManager.subscribe.
 */
function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

/**
 * Safe notification helper with precached icons and fallback protection.
 */
async function safeShowNotification(title: string, options: NotificationOptions): Promise<boolean> {
  try {
    const opts: NotificationOptions = {
      icon: '/icon-192x192.png',
      badge: '/favicon.png',
      ...options,
    };
    await self.registration.showNotification(title, opts);
    void recordSWEvent('show_notification', { tag: options.tag, success: true });
    return true;
  } catch (err) {
    console.error('[SW] showNotification failed:', err);
    void recordSWEvent('show_notification', { tag: options.tag, success: false });
    return false;
  }
}

/**
 * 8-step push handler (RFC-0009 §8.1, §19.4).
 * Always ends with showNotification when no visible client exists.
 */
async function handleWake(): Promise<void> {
  // Step 2: matchAll window clients. Visible client -> postMessage('wake') and return (ADR-P12B-32)
  const windowClients = await self.clients.matchAll({
    type: 'window',
    includeUncontrolled: true,
  });

  const hasVisible = windowClients.some((c) => c.visibilityState === 'visible');
  void recordSWEvent('visibility_check', { hasVisible, clientCount: windowClients.length });
  if (hasVisible) {
    for (const client of windowClients) {
      client.postMessage({ type: 'wake' });
    }
    return;
  }

  let showedNotification = false;

  // Step 3: Web lock 'rootinbox-sync' (ADR-P12B-41)
  const syncOperation = async () => {
    showedNotification = await performSync(windowClients);
  };

  try {
    if (typeof navigator !== 'undefined' && navigator.locks && navigator.locks.request) {
      await navigator.locks.request('rootinbox-sync', syncOperation);
    } else {
      await syncOperation();
    }
  } catch (err) {
    console.error('[SW] Wake sync failed:', err);
  }

  // Guarantee: handleWake() must always end with showNotification when no visible client exists
  // (including when IndexedDB cannot be opened or 0 pending messages are inserted)
  if (!showedNotification) {
    await safeShowNotification('RootInbox', {
      body: 'New message',
      tag: 'rootinbox-wake',
      renotify: true,
    } as unknown as NotificationOptions);
  }
}

async function performSync(windowClients: readonly WindowClient[]): Promise<boolean> {
  let showed = false;

  // Step 4: GET /api/v1/calls/pending
  try {
    const callRes = await fetch('/api/v1/calls/pending', { credentials: 'include' });
    if (callRes.ok) {
      const callData = await callRes.json();
      const call = callData.data || callData;
      if (call && (call.call_id || call.encrypted_offer)) {
        await safeShowNotification('RootInbox', {
          body: 'Incoming call',
          tag: 'rootinbox-call',
          requireInteraction: true,
        } as unknown as NotificationOptions);
        showed = true;
        for (const client of windowClients) {
          client.postMessage({ type: 'incoming-call' });
        }
      }
    }
  } catch (err) {
    console.error('[SW] Call probe failed:', err);
  }

  // Step 5: Schema guard
  const db = await openIndexedDB();
  if (!db) {
    return showed;
  }

  let totalInserted = 0;

  // Step 6: Pending sync subset, max 3 pages of 100
  try {
    let cursor = 0;
    for (let page = 0; page < 3; page++) {
      const url = `/api/v1/messages/pending?limit=100${cursor > 0 ? `&cursor=${cursor}` : ''}`;
      const res = await fetch(url, { credentials: 'include' });
      if (!res.ok) break;

      const body = await res.json();
      const rawData = (body && typeof body === 'object' && 'data' in body) ? (body as { data: unknown }).data : body;
      const messages: PendingMessageItem[] = Array.isArray(rawData) ? (rawData as PendingMessageItem[]) : [];
      if (messages.length === 0) break;

      const inserted = await insertPendingMessages(db, messages);
      if (inserted.length > 0) {
        await fetch('/api/v1/messages/ack', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ client_uuids: inserted }),
        });
        totalInserted += inserted.length;
      }

      const lastMsg = messages[messages.length - 1];
      if (lastMsg) {
        if (lastMsg.server_id || lastMsg.id) {
          cursor = Number(lastMsg.server_id || lastMsg.id);
        }
      }
      if (messages.length < 100) break;
    }
    void recordSWEvent('sync_completed', {
      insertedCount: totalInserted,
    });
  } catch (err) {
    console.error('[SW] Pending sync failed:', err);
    void recordSWEvent('sync_failed');
  } finally {
    db.close();
  }

  // Step 7: Show generic message notification if N > 0 (ADR-P12B-40, Requirement 3)
  // Fix F: SW cannot distinguish direct from group chats (pending rows only carry sender_id).
  // SW-originated notifications must NEVER deep-link; always open the app root.
  // Deep links are allowed only for client-side notifications created in main.tsx.
  if (totalInserted > 0) {
    const options = {
      body: 'New message',
      tag: 'rootinbox-message',
      renotify: true,
      data: {},
    };
    await safeShowNotification('RootInbox', options as unknown as NotificationOptions);
    return true;
  }

  return showed;
}

// Step 1: event.waitUntil(handleWake())
self.addEventListener('push', (event) => {
  event.waitUntil(
    (async () => {
      void recordSWEvent('push_received');
      await handleWake();
    })(),
  );
});

// Step 8: notificationclick handler
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const convId = (event.notification as unknown as { data?: { conversationId?: string } })?.data?.conversationId;
  event.waitUntil(
    (async () => {
      void recordSWEvent('notificationclick', { hasConversationId: Boolean(convId) });
      const allClients = await self.clients.matchAll({
        type: 'window',
        includeUncontrolled: true,
      });
      for (const client of allClients) {
        if ('focus' in client) {
          if (convId) {
            client.postMessage({ type: 'open-conversation', conversationId: convId });
          }
          return client.focus();
        }
      }
      if (self.clients.openWindow) {
        const url = convId ? `/?conv=${encodeURIComponent(convId)}` : '/';
        return self.clients.openWindow(url);
      }
    })(),
  );
});

// pushsubscriptionchange event listener (RFC-0009 §8.1)
self.addEventListener('pushsubscriptionchange', (event: Event) => {
  const extendable = event as ExtendableEvent;
  extendable.waitUntil(
    (async () => {
      try {
        const res = await fetch('/api/v1/push/vapid-public-key', { credentials: 'include' });
        if (!res.ok) return;
        const data = await res.json();
        const vapidPublicKey = data.public_key || data.vapid_public_key || data.data?.public_key;
        if (!vapidPublicKey) return;

        const keyBytes = urlBase64ToUint8Array(vapidPublicKey);
        const newSub = await self.registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: keyBytes as unknown as BufferSource,
        });

        const json = newSub.toJSON();
        if (json.keys?.p256dh && json.keys?.auth) {
          await fetch('/api/v1/push/subscribe', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({
              endpoint: newSub.endpoint,
              p256dh_key: json.keys.p256dh,
              auth_secret: json.keys.auth,
            }),
          });
        }

        const windowClients = await self.clients.matchAll({ type: 'window' });
        for (const client of windowClients) {
          client.postMessage({ type: 'pushsubscriptionchange', endpoint: newSub.endpoint });
        }
        void recordSWEvent('pushsubscriptionchange', { success: true });
      } catch (err) {
        console.error('[SW] pushsubscriptionchange failed:', err);
        void recordSWEvent('pushsubscriptionchange', { success: false });
      }
    })(),
  );
});

// Skip waiting & client claim
self.addEventListener('install', (event) => {
  if (event && typeof event.waitUntil === 'function') {
    event.waitUntil(self.skipWaiting());
  } else {
    void self.skipWaiting();
  }
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      if (typeof caches !== 'undefined') {
        const cacheKeys = await caches.keys();
        await Promise.all(
          cacheKeys
            .filter(
              (key) =>
                !key.includes(SW_CACHE_VERSION) &&
                (key.startsWith('rootinbox-') ||
                  key.startsWith('workbox-') ||
                  key.includes('v1') ||
                  key.includes('v2') ||
                  key.includes('app-shell')),
            )
            .map((key) => caches.delete(key)),
        );
      }
      await self.clients.claim();
    })(),
  );
});

export { handleWake };
