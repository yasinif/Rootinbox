/**
 * Service Worker Log Ring Buffer (RootInboxLogs)
 *
 * Phone debuggability ring buffer in IndexedDB.
 * Retains the last ~30 SW lifecycle events:
 * - push received
 * - visibility check
 * - sync counts / outcome
 * - showNotification status
 * - pushsubscriptionchange
 * - notificationclick target
 *
 * STRICT PROHIBITIONS:
 * - NO PII
 * - NO message content or ciphertext
 * - NO push endpoint URLs or auth tokens
 */

export interface SWLogEvent {
  id?: number;
  timestamp: number;
  type: string;
  detail?: Record<string, unknown>;
}

const DB_NAME = 'RootInboxLogs';
const STORE_NAME = 'events';
const DB_VERSION = 1;
const MAX_LOG_ENTRIES = 30;

function openLogsDB(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') {
      resolve(null);
      return;
    }
    const timer = setTimeout(() => resolve(null), 500);

    try {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: 'id', autoIncrement: true });
        }
      };
      req.onsuccess = () => {
        if (timer) clearTimeout(timer);
        resolve(req.result);
      };
      req.onerror = () => {
        if (timer) clearTimeout(timer);
        resolve(null);
      };
      req.onblocked = () => {
        if (timer) clearTimeout(timer);
        resolve(null);
      };
    } catch {
      if (timer) clearTimeout(timer);
      resolve(null);
    }
  });
}

/**
 * Record an event in the RootInboxLogs ring buffer.
 * Automatically sanitizes detail to strip sensitive keys.
 * Fire-and-forget safe: always time-boxed to 500ms so logging never blocks notification delivery.
 */
export async function recordSWEvent(type: string, detail?: Record<string, unknown>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, 500);
  });

  const recordPromise = (async () => {
    try {
      const db = await openLogsDB();
      if (!db) return;

      return new Promise<void>((resolve) => {
        try {
          const tx = db.transaction(STORE_NAME, 'readwrite');
          const store = tx.objectStore(STORE_NAME);

          const sanitizedDetail: Record<string, unknown> = {};
          if (detail) {
            for (const [k, v] of Object.entries(detail)) {
              const lower = k.toLowerCase();
              if (
                lower.includes('endpoint') ||
                lower.includes('token') ||
                lower.includes('auth') ||
                lower.includes('key') ||
                lower.includes('content') ||
                lower.includes('payload') ||
                lower.includes('body') ||
                lower.includes('secret')
              ) {
                continue;
              }
              sanitizedDetail[k] = v;
            }
          }

          store.add({
            timestamp: Date.now(),
            type,
            detail: Object.keys(sanitizedDetail).length > 0 ? sanitizedDetail : undefined,
          });

          // Maintain ring buffer cap of MAX_LOG_ENTRIES
          const countReq = store.count();
          countReq.onsuccess = () => {
            if (countReq.result > MAX_LOG_ENTRIES) {
              const openCursor = store.openCursor();
              let toDelete = countReq.result - MAX_LOG_ENTRIES;
              openCursor.onsuccess = () => {
                const cursor = openCursor.result;
                if (cursor && toDelete > 0) {
                  cursor.delete();
                  toDelete--;
                  cursor.continue();
                }
              };
            }
          };

          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onerror = () => {
            db.close();
            resolve();
          };
          tx.onabort = () => {
            db.close();
            resolve();
          };
        } catch {
          db.close();
          resolve();
        }
      });
    } catch {
      // ignore
    }
  })();

  await Promise.race<void>([recordPromise, timeoutPromise]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/**
 * Read all events from RootInboxLogs.
 */
export async function readSWLogs(): Promise<SWLogEvent[]> {
  const db = await openLogsDB();
  if (!db) return [];

  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const req = store.getAll();
      req.onsuccess = () => {
        db.close();
        resolve(req.result || []);
      };
      req.onerror = () => {
        db.close();
        resolve([]);
      };
    } catch {
      db.close();
      resolve([]);
    }
  });
}
