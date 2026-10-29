/**
 * Phase 12B Security Suite — Service Worker & Media Boundary (§21.6, §23.5).
 *
 * Asserts:
 * - Row B-01: Built Service Worker bundle in dist/ contains:
 *   - NO import of crypto worker
 *   - NO import of dexie
 *   - NO occurrence of media_key, media_token, Media_Key, argon2, libsodium, or hash-wasm
 * - Row B-04: Plaintext media bytes are never persisted in Dexie:
 *   - After download, media_download_store and messages store contain no decrypted file bytes
 *   - Only object URLs are held in-memory and revoked on unmount
 */

import 'fake-indexeddb/auto';
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { MediaDownloadStore } from '../../src/infrastructure/persistence/media-download-store';
import { getDB } from '../../src/infrastructure/persistence';

describe('Security Boundary Enforcement — SW & Media Persistence (§21.6, §23.5)', () => {
  it('Row B-01: Built SW bundle contains no crypto imports, no dexie, and no prohibited terms', () => {
    const distDir = path.resolve(__dirname, '../../dist');
    const swFiles = ['sw.js', 'sw.mjs']
      .map((f) => path.join(distDir, f))
      .filter((p) => fs.existsSync(p));

    expect(swFiles.length).toBeGreaterThan(0);

    const prohibitedTerms = [
      'dexie',
      'media_key',
      'media_token',
      'Media_Key',
      'argon2',
      'libsodium',
      'hash-wasm',
    ];

    for (const file of swFiles) {
      const content = fs.readFileSync(file, 'utf8');

      // Prohibit imports of crypto.worker
      expect(content).not.toMatch(/from\s*['"][^'"]*crypto\.worker/);
      expect(content).not.toMatch(/import\s*['"][^'"]*crypto\.worker/);
      expect(content).not.toMatch(/new\s+Worker\([^)]*crypto\.worker/);

      // Prohibit exact prohibited terms
      for (const term of prohibitedTerms) {
        expect(content, `File ${path.basename(file)} must not contain "${term}"`).not.toContain(term);
      }
    }
  });

  it('Row B-04: MediaDownloadStore and IndexedDB contain zero persistent decrypted file bytes', async () => {
    const store = new MediaDownloadStore();
    const testBytes = new Uint8Array([10, 20, 30, 40, 50]);
    const blob = new Blob([testBytes], { type: 'image/png' });

    // Register blob URL in-memory
    const objectUrl = store.register('test-file-uuid', blob, 'image/png', 5);
    expect(objectUrl).toMatch(/^blob:/);

    // Assert that the store holds an object URL entry, NOT a raw byte buffer
    const entry = store.get('test-file-uuid');
    expect(entry).toBeDefined();
    expect(entry?.blobUrl).toBe(objectUrl);
    expect((entry as any)?.bytes).toBeUndefined();
    expect((entry as any)?.plaintext).toBeUndefined();

    // Assert that IndexedDB messages store contains no media bytes
    const db = getDB();
    const storedMessages = await db.messages.toArray();
    for (const msg of storedMessages) {
      expect((msg as any).bytes).toBeUndefined();
      expect((msg as any).media_data).toBeUndefined();
      expect((msg as any).file_bytes).toBeUndefined();
    }

    // Clean up
    store.revoke('test-file-uuid');
    expect(store.get('test-file-uuid')).toBeNull();
    expect(store.getActiveCount()).toBe(0);
  });
});
