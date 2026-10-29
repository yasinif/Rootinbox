/**
 * CryptoWorkerBridge — Main-thread client for the Crypto Worker.
 * RFC-0010 §5.2: All Worker calls correlated via request_id (UUIDv4).
 * RFC-0010 §12 F1: 10s timeout → Worker crash rehydration.
 *
 * Infrastructure layer — may import domain only.
 */

import type { CryptoWorkerRequest, CryptoWorkerResponse } from '../../domain';
import type { MediaCryptoPort } from '../../domain/ports/media';
import type { MediaMetadata } from '../../domain/media';

/** Generate a UUIDv4. Uses crypto.randomUUID when available. */
function uuidv4(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  // Fallback for older environments
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const WORKER_TIMEOUT_MS = 10_000; // RFC-0010 §12 F1

export class CryptoWorkerBridge implements MediaCryptoPort {
  private worker: Worker;
  private pending = new Map<string, PendingCall>();

  constructor() {
    this.worker = this.createWorker();
  }

  private createWorker(): Worker {
    const w = new Worker(
      new URL('../../workers/crypto.worker.ts', import.meta.url),
      { type: 'module' },
    );
    w.onmessage = (event: MessageEvent<CryptoWorkerResponse>) => {
      this.handleResponse(event.data);
    };
    w.onerror = (err) => {
      console.error('[CryptoWorkerBridge] Worker error:', err);
    };
    return w;
  }

  private handleResponse(data: CryptoWorkerResponse): void {
    const entry = this.pending.get(data.request_id);
    if (!entry) return;

    clearTimeout(entry.timer);
    this.pending.delete(data.request_id);

    if (data.error) {
      entry.reject(new Error(data.error));
    } else {
      entry.resolve(data.result);
    }
  }

  /**
   * Send a request to the Crypto Worker and await the response.
   * @param action - The action name (init, encrypt, decrypt, destroy).
   * @param payload - Optional payload data.
   * @param transfer - Optional Transferable objects (ArrayBuffers) for zero-copy.
   * @returns Promise resolved with the Worker's result.
   * @throws Error if Worker does not respond within 10s (triggers rehydration).
   */
  async call(
    action: string,
    payload?: unknown,
    transfer?: Transferable[],
  ): Promise<unknown> {
    const request_id = uuidv4();

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        // RFC-0010 §12 F1: Worker loss → re-instantiate and reject pending.
        this.pending.delete(request_id);
        this.rehydrate();
        reject(new Error(`Crypto Worker timeout (${WORKER_TIMEOUT_MS}ms) for action: ${action}`));
      }, WORKER_TIMEOUT_MS);

      this.pending.set(request_id, { resolve, reject, timer });

      const msg: CryptoWorkerRequest = { request_id, action, payload };
      if (transfer && transfer.length > 0) {
        this.worker.postMessage(msg, transfer);
      } else {
        this.worker.postMessage(msg);
      }
    });
  }

  /**
   * RFC-0010 §12 F1: Crash Rehydration.
   * Terminates the dead Worker, creates a fresh one, and rejects all pending calls.
   */
  private rehydrate(): void {
    console.warn('[CryptoWorkerBridge] Rehydrating Worker after crash/timeout');

    // Terminate the old worker
    this.worker.terminate();

    // Reject all remaining pending calls
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error('Crypto Worker was rehydrated'));
      this.pending.delete(id);
    }

    // Create a new worker
    this.worker = this.createWorker();
  }

  /** Gracefully destroy the Worker and zeroize keys. */
  async destroy(): Promise<void> {
    try {
      await this.call('destroy');
    } finally {
      this.worker.terminate();
      this.pending.clear();
      this.worker = this.createWorker();
    }
  }

  // ─── Phase 12B Call Methods ─────────────────────────────────

  async deriveCallKeys(params: {
    call_id_bytes: string | Uint8Array;
    peer_identity_hash: string | Uint8Array;
    peer_session_id?: string | Uint8Array;
    peer_session_pk?: string | Uint8Array;
    role: number;
  }): Promise<{ ok: boolean }> {
    return (await this.call('deriveCallKeys', params)) as { ok: boolean };
  }

  async signCallFingerprint(params: {
    call_id_bytes: string | Uint8Array;
    fingerprint_bytes: string | Uint8Array;
    role: number;
  }): Promise<{ signature: string }> {
    return (await this.call('signCallFingerprint', params)) as { signature: string };
  }

  async verifyCallFingerprint(params: {
    call_id_bytes: string | Uint8Array;
    fingerprint_bytes: string | Uint8Array;
    role: number;
    signature: string | Uint8Array;
    peer_identity_public_key: string | Uint8Array;
  }): Promise<{ valid: boolean }> {
    return (await this.call('verifyCallFingerprint', params)) as { valid: boolean };
  }

  async computeSas(params: {
    call_id_bytes: string | Uint8Array;
    caller_fingerprint: string | Uint8Array;
    callee_fingerprint: string | Uint8Array;
  }): Promise<{ sas: string; iterations: number }> {
    return (await this.call('computeSas', params)) as { sas: string; iterations: number };
  }

  async sealCallFrame(params: {
    call_id_bytes: string | Uint8Array;
    frame_type: number;
    payload: string | Uint8Array | object;
  }): Promise<{ signal_seq: number; ciphertext: string }> {
    return (await this.call('sealCallFrame', params)) as { signal_seq: number; ciphertext: string };
  }

  async openCallFrame(params: {
    call_id_bytes: string | Uint8Array;
    frame_type: number;
    signal_seq: number | string | bigint;
    ciphertext: string | Uint8Array;
  }): Promise<{ payload: Record<string, unknown> }> {
    return (await this.call('openCallFrame', params)) as { payload: Record<string, unknown> };
  }

  async dropCall(params: { call_id_bytes: string | Uint8Array }): Promise<{ ok: boolean }> {
    return (await this.call('dropCall', params)) as { ok: boolean };
  }

  // ─── Phase 12B Media Methods ────────────────────────────────

  async createMediaKey(): Promise<{ media_key_id: string }> {
    return (await this.call('createMediaKey')) as { media_key_id: string };
  }

  async importMediaKey(params: {
    media_key: string | Uint8Array;
    file_iv_prefix: string | Uint8Array;
  }): Promise<{ media_key_id: string }> {
    return (await this.call('importMediaKey', params)) as { media_key_id: string };
  }

  async sealChunk(
    params: {
      media_key_id: string;
      file_id_bytes: string | Uint8Array;
      chunk_index: number;
      total_chunks: number;
      plaintext: Uint8Array | ArrayBuffer;
    },
    transfer?: Transferable[],
  ): Promise<{ ciphertext: Uint8Array; ciphertext_sha256: string }> {
    const t = transfer || (params.plaintext instanceof ArrayBuffer ? [params.plaintext] : [params.plaintext.buffer]);
    return (await this.call('sealChunk', params, t)) as {
      ciphertext: Uint8Array;
      ciphertext_sha256: string;
    };
  }

  async openChunk(
    params: {
      media_key_id: string;
      file_id_bytes: string | Uint8Array;
      chunk_index: number;
      total_chunks: number;
      ciphertext: Uint8Array | ArrayBuffer;
    },
    transfer?: Transferable[],
  ): Promise<{ plaintext: Uint8Array }> {
    const t = transfer || (params.ciphertext instanceof ArrayBuffer ? [params.ciphertext] : [params.ciphertext.buffer]);
    return (await this.call('openChunk', params, t)) as { plaintext: Uint8Array };
  }

  async sealThumbnail(params: {
    media_key_id: string;
    file_id_bytes: string | Uint8Array;
    plaintext_padded: Uint8Array | ArrayBuffer;
  }): Promise<{ wire: Uint8Array }> {
    return (await this.call('sealThumbnail', params)) as { wire: Uint8Array };
  }

  async openThumbnail(params: {
    media_key_id: string;
    file_id_bytes: string | Uint8Array;
    wire: Uint8Array | ArrayBuffer;
  }): Promise<{ plaintext_padded: Uint8Array }> {
    return (await this.call('openThumbnail', params)) as { plaintext_padded: Uint8Array };
  }

  async exportMediaKeyForPeer(params: { media_key_id: string }): Promise<{
    media_key: string;
    file_iv_prefix: string;
  }> {
    return (await this.call('exportMediaKeyForPeer', params)) as {
      media_key: string;
      file_iv_prefix: string;
    };
  }

  async dropMediaKey(params: { media_key_id: string }): Promise<{ ok: boolean }> {
    return (await this.call('dropMediaKey', params)) as { ok: boolean };
  }

  async buildMediaMetadata(params: {
    media_key_id: string;
    fields: Omit<MediaMetadata, 'media_key' | 'file_iv_prefix'>;
  }): Promise<{ plaintext_mce: string }> {
    return (await this.call('buildMediaMetadata', params)) as { plaintext_mce: string };
  }

  async computeTokenHash(token: Uint8Array): Promise<string> {
    if (typeof crypto !== 'undefined' && crypto.subtle) {
      const hashBuf = await crypto.subtle.digest('SHA-256', token as unknown as ArrayBuffer);
      const hash = new Uint8Array(hashBuf);
      return Array.from(hash, (b) => b.toString(16).padStart(2, '0')).join('');
    }
    const res = (await this.call('sha256', { data: token })) as { hex: string };
    return res.hex;
  }

  async computeManifestHash(
    chunkHashes: Uint8Array[],
  ): Promise<{ raw: Uint8Array; hex: string; base64: string }> {
    const totalLen = chunkHashes.length * 32;
    const concat = new Uint8Array(totalLen);
    for (let i = 0; i < chunkHashes.length; i++) {
      concat.set(chunkHashes[i], i * 32);
    }
    let raw: Uint8Array;
    let hex: string;
    if (typeof crypto !== 'undefined' && crypto.subtle) {
      const hashBuf = await crypto.subtle.digest('SHA-256', concat);
      raw = new Uint8Array(hashBuf);
      hex = Array.from(raw, (b) => b.toString(16).padStart(2, '0')).join('');
    } else {
      const res = (await this.call('sha256', { data: concat })) as { hash: Uint8Array; hex: string };
      raw = new Uint8Array(res.hash);
      hex = res.hex;
    }
    let binary = '';
    for (let i = 0; i < raw.length; i++) {
      binary += String.fromCharCode(raw[i]);
    }
    const base64 = btoa(binary);
    return { raw, hex, base64 };
  }

  async sha256(data: Uint8Array): Promise<Uint8Array> {
    if (typeof crypto !== 'undefined' && crypto.subtle) {
      const hashBuf = await crypto.subtle.digest('SHA-256', data as unknown as ArrayBuffer);
      return new Uint8Array(hashBuf);
    }
    const res = (await this.call('sha256', { data })) as { hash: Uint8Array };
    return new Uint8Array(res.hash);
  }
}
