/**
 * Dexie database schema for local persistence.
 * RFC-0010 §4.2: Infrastructure layer.
 *
 * RULES:
 * - insertIfAbsent on all message writes (never bare put)
 * - BigInt is NOT a valid IndexedDB key — NEVER index sequence_number
 * - QuotaExceededError surfaced, never swallowed
 */

import Dexie from 'dexie';
import type { Table } from 'dexie';

export interface StoredMessage {
  id: string;
  conversation_id: string;
  sender_id: string;
  ciphertext: string;        // Hex-encoded ciphertext wire
  plaintext?: string;         // Decrypted plaintext (ephemeral, cleared on cold restart)
  vault_ciphertext?: string;  // At-rest sealed with Vault Key (Fix 6)
  vault_iv?: string;          // IV for vault_ciphertext
  sequence_str: string;       // BigInt as string (NOT indexed — BigInt is not a valid IDB key)
  created_at: number;
  status: 'pending' | 'sent' | 'delivered' | 'seen' | 'failed';
  decrypted_state?: 'PENDING_DECRYPT' | 'DECRYPTED' | 'FAILED';
  reply_to_id?: string;
  edited_at?: number;
  deleted_at?: number;
  server_id?: number;
}

export interface OutboxEntry {
  id: string;
  conversation_id: string;
  receiver_id: string;
  ciphertext_hex: string;    // Pre-encrypted, byte-identical retransmission
  sequence_str: string;       // BigInt as string
  created_at: number;
  retry_count: number;
  status: 'queued' | 'inflight' | 'sent' | 'failed';
  inflight_at?: number;
}

export interface MetadataEntry {
  key: string;
  value: string;
}

export interface MediaUploadRow {
  file_id: string;
  state: 'INITIALIZED' | 'UPLOADING' | 'FINALIZING' | 'COMPLETE' | 'FAILED';
  total_chunks: number;
  uploaded_indices: number[];
  client_uuid: string;
  created_at: number;
}

export interface MediaChunkCacheRow {
  file_id: string;
  chunk_index: number;
  ciphertext_blob: Blob;
  chunk_hash: string;
}

export interface StoredContact {
  peer_user_id: string;
  identity_hash: string;
  nickname: string;
  added_at: number;
}

export interface UnreadCountRow {
  conversation_id: string;
  count: number;
}

export class AppDatabase extends Dexie {
  messages!: Table<StoredMessage, string>;
  outbox!: Table<OutboxEntry, string>;
  metadata!: Table<MetadataEntry, string>;
  media_uploads!: Table<MediaUploadRow, string>;
  media_chunk_cache!: Table<MediaChunkCacheRow, [string, number]>;
  contacts!: Table<StoredContact, string>;
  unread_counts!: Table<UnreadCountRow, string>;

  constructor() {
    super('RootInboxDB');

    this.version(1).stores({
      // Indexed fields only — sequence_str deliberately NOT indexed (BigInt rule).
      messages: 'id, conversation_id, created_at, [conversation_id+created_at]',
      outbox: 'id, conversation_id, status, created_at',
      metadata: 'key',
    });

    this.version(2).stores({
      // Phase 12B Task 13 (§16.2): Dexie additions
      media_uploads: 'file_id, state, created_at',
      media_chunk_cache: '[file_id+chunk_index], file_id',
    });

    this.version(3).stores({
      // Bundle 1.2: Local contacts store
      contacts: 'peer_user_id, identity_hash, nickname, added_at',
    });

    this.version(4).stores({
      // Fix 4: Local unread counts store per conversation
      unread_counts: 'conversation_id',
    });
  }
}

/** Singleton database instance. */
let _db: AppDatabase | null = null;

export function getDB(): AppDatabase {
  if (!_db) {
    _db = new AppDatabase();
  }
  return _db;
}

/**
 * MessageRepository: idempotent upsert, cursor pagination.
 * insertIfAbsent on all writes — never bare put.
 */
export const MessageRepository = {
  /**
   * Insert a message only if it doesn't already exist (idempotent).
   * Returns true if inserted, false if already present.
   * Surfaces QuotaExceededError — NEVER swallows it.
   */
  async insertIfAbsent(msg: StoredMessage): Promise<boolean> {
    const db = getDB();
    const existing = await db.messages.get(msg.id);
    if (existing) {
      if ((!existing.plaintext || existing.status === 'failed') && msg.plaintext) {
        await db.messages.update(msg.id, {
          plaintext: msg.plaintext,
          vault_ciphertext: msg.vault_ciphertext,
          vault_iv: msg.vault_iv,
          status: msg.status,
          sequence_str: msg.sequence_str,
        });
        return true;
      }
      return false;
    }

    try {
      await db.messages.add(msg);
      return true;
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'QuotaExceededError') {
        throw err; // Surface, never swallow.
      }
      // Dexie ConstraintError means concurrent insert — idempotent success.
      if (err instanceof Error && err.name === 'ConstraintError') {
        return false;
      }
      throw err;
    }
  },

  /**
   * Get messages for a conversation, cursor-paginated, newest first.
   */
  async getByConversation(
    conversationId: string,
    limit: number,
    beforeCreatedAt?: number,
  ): Promise<StoredMessage[]> {
    const db = getDB();
    const query = db.messages
      .where('[conversation_id+created_at]')
      .between(
        [conversationId, Dexie.minKey],
        [conversationId, beforeCreatedAt ?? Dexie.maxKey],
        true,
        beforeCreatedAt !== undefined,
      )
      .reverse();

    const results = await query.limit(limit).toArray();
    return results;
  },

  async getById(id: string): Promise<StoredMessage | undefined> {
    return getDB().messages.get(id);
  },

  async updatePlaintext(id: string, plaintext: string): Promise<void> {
    await getDB().messages.update(id, { plaintext });
  },

  async updateVaultCiphertext(id: string, vault_ciphertext: string, vault_iv: string): Promise<void> {
    await getDB().messages.update(id, { vault_ciphertext, vault_iv });
  },

  /**
   * Strictly monotonic status update.
   * Progression: failed (0) -> pending (1) -> sent (2) -> delivered (3) -> seen (4).
   * Prevents delayed or out-of-order network acks from clobbering higher-ranked states.
   */
  async updateStatus(id: string, newStatus: StoredMessage['status']): Promise<void> {
    const statusRank: Record<string, number> = {
      failed: 0,
      pending: 1,
      sent: 2,
      delivered: 3,
      seen: 4,
    };
    await getDB().messages.where('id').equals(id).modify((msg) => {
      const currentRank = statusRank[msg.status || 'pending'] ?? 0;
      const targetRank = statusRank[newStatus || 'pending'] ?? 0;
      if (targetRank > currentRank || newStatus === 'failed') {
        msg.status = newStatus;
      }
    });
  },

  async updateGroupMessage(id: string, updates: Partial<StoredMessage>): Promise<void> {
    await getDB().messages.update(id, updates);
  },

  async deleteMessage(id: string): Promise<void> {
    await getDB().messages.delete(id);
  },

  async deleteByConversation(conversationId: string): Promise<void> {
    await getDB().messages.where('conversation_id').equals(conversationId).delete();
  },
};

/**
 * UnreadRepository: tracks unread message count per conversation.
 */
export const UnreadRepository = {
  async get(conversationId: string): Promise<number> {
    const row = await getDB().unread_counts.get(conversationId);
    return row ? row.count : 0;
  },

  async set(conversationId: string, count: number): Promise<void> {
    await getDB().unread_counts.put({ conversation_id: conversationId, count: Math.max(0, count) });
  },

  async increment(conversationId: string): Promise<number> {
    const current = await this.get(conversationId);
    const updated = current + 1;
    await this.set(conversationId, updated);
    return updated;
  },

  async clear(conversationId: string): Promise<void> {
    // Write count: 0 so unreads[conversationId] remains explicitly 0 on app reload,
    // strictly suppressing fallback recalculation from reviving ghost badges.
    await getDB().unread_counts.put({ conversation_id: conversationId, count: 0 });
  },

  async getAll(): Promise<Record<string, number>> {
    const rows = await getDB().unread_counts.toArray();
    const map: Record<string, number> = {};
    for (const row of rows) {
      map[row.conversation_id] = row.count;
    }
    return map;
  },
};

/**
 * OutboxRepository: queue, status tracking, retry count.
 * Retransmits byte-identical persisted ciphertext (never re-encrypt).
 * One in-flight per receiver.
 */
export const OutboxRepository = {
  async enqueue(entry: OutboxEntry): Promise<void> {
    const db = getDB();
    try {
      await db.outbox.add(entry);
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'QuotaExceededError') throw err;
      if (err instanceof Error && err.name === 'ConstraintError') return; // idempotent
      throw err;
    }
  },

  async getQueued(limit: number): Promise<OutboxEntry[]> {
    const entries = await getDB().outbox
      .where('status').equals('queued')
      .toArray();
    entries.sort((a, b) => (a.created_at || 0) - (b.created_at || 0));
    return limit ? entries.slice(0, limit) : entries;
  },

  async getById(id: string): Promise<OutboxEntry | undefined> {
    return getDB().outbox.get(id);
  },

  async markInflight(id: string): Promise<void> {
    await getDB().outbox.update(id, {
      status: 'inflight',
      inflight_at: Date.now(),
    });
  },

  async markSent(id: string): Promise<void> {
    await getDB().outbox.update(id, { status: 'sent' });
  },

  async markFailed(id: string): Promise<boolean> {
    const db = getDB();
    const entry = await db.outbox.get(id);
    if (entry) {
      const isTerminal = entry.retry_count >= 3;
      await db.outbox.update(id, {
        status: isTerminal ? 'failed' : 'queued',
        retry_count: entry.retry_count + 1,
      });
      return isTerminal;
    }
    return false;
  },

  async removeCompleted(): Promise<void> {
    await getDB().outbox.where('status').equals('sent').delete();
  },

  async deleteByConversation(conversationId: string): Promise<void> {
    await getDB().outbox.where('conversation_id').equals(conversationId).delete();
  },

  async delete(id: string): Promise<void> {
    await getDB().outbox.delete(id);
  },

  async markPermanentFailed(id: string): Promise<void> {
    await getDB().outbox.update(id, { status: 'failed' });
  },

  /**
   * Check if there's already an in-flight entry for a receiver.
   * One in-flight per receiver rule.
   * Stale in-flight entries (>5s since inflight_at) are automatically recovered to 'queued'.
   */
  async hasInflightForReceiver(receiverId: string): Promise<boolean> {
    const db = getDB();
    const inflightEntries = await db.outbox
      .where('status').equals('inflight')
      .filter((e) => e.receiver_id === receiverId)
      .toArray();

    const now = Date.now();
    let hasActive = false;
    for (const entry of inflightEntries) {
      const activeSince = entry.inflight_at || entry.created_at || now;
      if (now - activeSince > 5000) {
        await db.outbox.update(entry.id, { status: 'queued' });
      } else {
        hasActive = true;
      }
    }
    return hasActive;
  },

  async resetInflight(): Promise<void> {
    await getDB().outbox.where('status').equals('inflight').modify({ status: 'queued' });
  },

  async resetInflightEntry(id: string): Promise<void> {
    await getDB().outbox.where('id').equals(id).modify((e) => {
      if (e.status === 'inflight') {
        e.status = 'queued';
      }
    });
  },
};

/**
 * MetadataRepository: boot state, sync cursors, etc.
 */
export const MetadataRepository = {
  async get(key: string): Promise<string | undefined> {
    const entry = await getDB().metadata.get(key);
    return entry?.value;
  },

  async set(key: string, value: string): Promise<void> {
    await getDB().metadata.put({ key, value });
  },

  async delete(key: string): Promise<void> {
    await getDB().metadata.delete(key);
  },

  async getByPrefix(prefix: string): Promise<Record<string, string>> {
    const entries = await getDB().metadata.where('key').startsWith(prefix).toArray();
    const result: Record<string, string> = {};
    for (const entry of entries) {
      result[entry.key] = entry.value;
    }
    return result;
  },
};

/**
 * ContactRepository: local Dexie contact management (Bundle 1.2).
 * Device-local Zero-Knowledge storage.
 */
export const ContactRepository = {
  async getAll(): Promise<StoredContact[]> {
    const db = getDB();
    return db.contacts.orderBy('added_at').reverse().toArray();
  },

  async get(peerUserId: string): Promise<StoredContact | undefined> {
    const db = getDB();
    return db.contacts.get(peerUserId);
  },

  async save(contact: StoredContact): Promise<void> {
    const db = getDB();
    await db.contacts.put(contact);
  },

  async delete(peerUserId: string): Promise<void> {
    const db = getDB();
    await db.contacts.delete(peerUserId);
  },
};
