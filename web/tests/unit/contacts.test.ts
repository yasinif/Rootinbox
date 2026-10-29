/**
 * Bundle 1.2 Unit Test — Local Dexie Contact Store & Repository.
 */

import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import { getDB, ContactRepository } from '../../src/infrastructure/persistence';
import type { StoredContact } from '../../src/infrastructure/persistence';

describe('Contact Repository Unit Tests (Bundle 1.2)', () => {
  beforeEach(async () => {
    const db = getDB();
    await db.contacts.clear();
  });

  it('saves, retrieves, and updates a contact', async () => {
    const contact: StoredContact = {
      peer_user_id: 'usr-1234',
      identity_hash: 'hash-abcd',
      nickname: 'Alice',
      added_at: Date.now(),
    };

    await ContactRepository.save(contact);

    const retrieved = await ContactRepository.get('usr-1234');
    expect(retrieved).toBeDefined();
    expect(retrieved?.nickname).toBe('Alice');
    expect(retrieved?.identity_hash).toBe('hash-abcd');

    // Update nickname
    await ContactRepository.save({
      ...contact,
      nickname: 'Alice Cooper',
    });

    const updated = await ContactRepository.get('usr-1234');
    expect(updated?.nickname).toBe('Alice Cooper');
  });

  it('retrieves all contacts sorted', async () => {
    await ContactRepository.save({
      peer_user_id: 'usr-1',
      identity_hash: 'hash-1',
      nickname: 'Bob',
      added_at: 1000,
    });
    await ContactRepository.save({
      peer_user_id: 'usr-2',
      identity_hash: 'hash-2',
      nickname: 'Charlie',
      added_at: 2000,
    });

    const all = await ContactRepository.getAll();
    expect(all.length).toBe(2);
    expect(all.map((c) => c.nickname)).toContain('Bob');
    expect(all.map((c) => c.nickname)).toContain('Charlie');
  });

  it('deletes a contact', async () => {
    await ContactRepository.save({
      peer_user_id: 'usr-del',
      identity_hash: 'hash-del',
      nickname: 'ToDelete',
      added_at: 3000,
    });

    let found = await ContactRepository.get('usr-del');
    expect(found).toBeDefined();

    await ContactRepository.delete('usr-del');

    found = await ContactRepository.get('usr-del');
    expect(found).toBeUndefined();
  });
});
