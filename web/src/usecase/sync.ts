/**
 * SyncUseCase — boot sequence orchestration.
 * RFC-0010 §12: Sacred boot order:
 *   1. Vault Recovery (only if DB empty/invalid)
 *   2. REST Pending Sync (cursor advances ONLY after successful ack)
 *   3. Outbox Preparation (no network I/O)
 *   4. WS connect LAST
 *
 * Persists boot state for crash recovery.
 */

import type { CryptoPort, MetadataPort, OutboxPort, MessagePort as MsgPort, StoredMessageDTO, VaultArchivePort } from '../domain';
import type { ChatUseCase } from './chat';
import * as pako from 'pako';

export type BootPhase = 'idle' | 'vault_recovery' | 'pending_sync' | 'outbox_prep' | 'ws_connect' | 'ready' | 'error';

export interface SyncState {
  phase: BootPhase;
  error: string | null;
  isOnline: boolean;
}

type SyncListener = (state: SyncState) => void;

export class SyncUseCase {
  private cryptoPort: CryptoPort;
  private metadataPort: MetadataPort;
  private outboxPort: OutboxPort;
  private connectWs: () => Promise<void>;
  private vaultPort?: VaultArchivePort;
  private chatUC?: ChatUseCase;
  private listeners = new Set<SyncListener>();
  private isBooting = false;
  private cachedCredentials?: { u?: string; p?: string };

  private state: SyncState = {
    phase: 'idle',
    error: null,
    isOnline: typeof navigator !== 'undefined' ? navigator.onLine : true,
  };

  constructor(
    cryptoPort: CryptoPort,
    metadataPort: MetadataPort,
    outboxPort: OutboxPort,
    connectWs: () => Promise<void>,
    vaultPort?: VaultArchivePort,
    chatUC?: ChatUseCase,
  ) {
    this.cryptoPort = cryptoPort;
    this.metadataPort = metadataPort;
    this.outboxPort = outboxPort;
    this.connectWs = connectWs;
    this.vaultPort = vaultPort;
    this.chatUC = chatUC;

    if (typeof window !== 'undefined') {
      window.addEventListener('online', () => {
        this.emit({ isOnline: true });
        void this.boot(this.cachedCredentials?.u, this.cachedCredentials?.p);
      });
      window.addEventListener('offline', () => {
        this.emit({ isOnline: false, phase: 'error', error: 'No Internet Connection' });
      });
    }
  }

  setChatUseCase(chatUC: ChatUseCase): void {
    this.chatUC = chatUC;
  }

  subscribe(listener: SyncListener): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  getSnapshot(): SyncState {
    return this.state;
  }

  private emit(patch: Partial<SyncState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener(this.state);
  }

  setPhase(phase: BootPhase, error: string | null = null): void {
    this.emit({ phase, error });
  }

  /**
   * Catch up on pending messages, server read watermarks, and outbox when reconnecting.
   */
  async catchUp(): Promise<void> {
    if (this.isBooting) return;
    this.emit({ phase: 'pending_sync' });
    const chat = this.chatUC || (import.meta.env.VITE_E2E === 'true' && typeof window !== 'undefined' ? ((window as unknown as Record<string, unknown>).__chatUC as typeof this.chatUC) : undefined);

    try {
      if (chat) {
        await chat.syncReadWatermarks?.().catch((e) => console.warn('[SyncUseCase] syncReadWatermarks error:', e));
        await this.outboxPort.resetInflight?.().catch(() => {});
        await chat.loadConversations(true).catch(() => {});
        await chat.flushOutbox?.().catch((e) => console.warn('[SyncUseCase] flushOutbox error:', e));
        const activeId = chat.getSnapshot?.().activeConversationId;
        if (activeId) {
          await chat.loadMessages(activeId).catch(() => {});
        }
      }
    } catch (err) {
      console.warn('[SyncUseCase] catchUp error:', err);
    } finally {
      this.emit({ phase: 'ready', error: null });
      await this.metadataPort.set('boot_phase', 'ready').catch(() => {});
    }
  }

  /**
   * Execute boot sequence:
   * 1. Vault Key derivation (if needed)
   * 2. Populate conversations & watermarks upfront
   * 3. Outbox preparation (reset in-flight)
   * 4. WebSocket connect
   * 5. Transition to 'ready'
   */
  async boot(username?: string, password?: string): Promise<void> {
    if (username || password) {
      this.cachedCredentials = { u: username, p: password };
    }

    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      this.emit({ phase: 'error', error: 'No Internet Connection', isOnline: false });
      return;
    }

    if (this.isBooting) return;
    this.isBooting = true;

    try {
      // Phase 1: Vault Key
      this.emit({ phase: 'vault_recovery', error: null });
      await this.metadataPort.set('boot_phase', 'vault_recovery');
      const hasVault = await this.metadataPort.get('vault_initialized');
      if (!hasVault && username && password) {
        await this.cryptoPort.deriveVaultKey(username, password);
        await this.metadataPort.set('vault_initialized', 'true');
      }

      const chat = this.chatUC || (import.meta.env.VITE_E2E === 'true' && typeof window !== 'undefined' ? ((window as unknown as Record<string, unknown>).__chatUC as typeof this.chatUC) : undefined);

      // Pre-condition: Populate server read watermarks BEFORE calculating unread counts
      if (chat) {
        await chat.syncReadWatermarks?.();
        await chat.loadConversations(true);
      }

      // Phase 2: Conversations & watermarks sync
      this.emit({ phase: 'pending_sync' });
      await this.metadataPort.set('boot_phase', 'pending_sync');

      // Phase 3: Outbox Preparation
      this.emit({ phase: 'outbox_prep' });
      await this.metadataPort.set('boot_phase', 'outbox_prep');
      await this.outboxPort.resetInflight?.().catch(() => {});

      // Phase 4: WS connect
      this.emit({ phase: 'ws_connect' });
      await this.metadataPort.set('boot_phase', 'ws_connect');
      await this.connectWs();

      // Final synchronization & ready transition
      if (chat) {
        await chat.loadConversations(true);
        void chat.flushOutbox?.().catch(() => {});
      }
      this.emit({ phase: 'ready', error: null });
      await this.metadataPort.set('boot_phase', 'ready');
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Boot failed';
      this.emit({ phase: 'error', error: msg });
      await this.metadataPort.set('boot_phase', 'error');
    } finally {
      this.isBooting = false;
    }
  }

  /**
   * Download and restore monthly vault archives from the server.
   */
  async restoreVaultArchives(msgPort: MsgPort): Promise<number> {
    if (!this.vaultPort) return 0;
    try {
      const archives = await this.vaultPort.list();
      if (!archives || archives.length === 0) return 0;
      let restoredCount = 0;
      for (const arch of archives) {
        try {
          const buffer = await this.vaultPort.download(arch.month_year);
          const decompressedBytes = pako.ungzip(new Uint8Array(buffer));
          const decompressed = new TextDecoder().decode(decompressedBytes);
          const messages = JSON.parse(decompressed) as StoredMessageDTO[];
          if (Array.isArray(messages)) {
            for (const m of messages) {
              const inserted = await msgPort.insertIfAbsent(m);
              if (inserted) restoredCount++;
            }
          }
        } catch (e) {
          console.warn('[SyncUseCase] Failed to restore vault archive for', arch.month_year, e);
        }
      }
      return restoredCount;
    } catch {
      return 0;
    }
  }

  /**
   * Gzip and upload monthly archive to the server.
   */
  async uploadMonthlyVault(monthYear: string, messages: StoredMessageDTO[]): Promise<void> {
    if (!this.vaultPort || !messages || messages.length === 0) return;
    const jsonStr = JSON.stringify(messages);
    const compressed = pako.gzip(jsonStr);
    const hashBuffer = await crypto.subtle.digest('SHA-256', compressed);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const hashHex = hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
    await this.vaultPort.upload(monthYear, compressed, hashHex, 1);
  }
}
