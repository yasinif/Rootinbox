/**
 * Client-side Rate Governance Token Buckets.
 * Phase 12B §11.5: RAM-only advisory pre-throttles.
 *
 * Three buckets:
 * - mediaChunkUpload: 30/min (uploadChunk)
 * - restGeneral: 60/min (downloadChunk, all other REST)
 * - pushSubscribe: 5/min (subscribePush, unsubscribePush)
 */

export class TokenBucket {
  private capacity: number;
  private fillPerMs: number;
  private tokens: number;
  private lastUpdate: number;

  constructor(perMinute: number) {
    this.capacity = perMinute;
    this.fillPerMs = perMinute / 60_000;
    this.tokens = perMinute;
    this.lastUpdate = Date.now();
  }

  private replenish(): void {
    const now = Date.now();
    const elapsed = now - this.lastUpdate;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.fillPerMs);
    this.lastUpdate = now;
  }

  /**
   * Check and consume one token if available.
   * Returns true if token was consumed, false if bucket is exhausted.
   */
  tryConsume(): boolean {
    this.replenish();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }

  /**
   * Acquire a token, waiting until one is available if necessary.
   */
  async acquire(): Promise<void> {
    this.replenish();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return;
    }
    const needed = 1 - this.tokens;
    const waitMs = Math.ceil(needed / this.fillPerMs);
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    this.replenish();
    this.tokens = Math.max(0, this.tokens - 1);
  }

  /**
   * Drain bucket to empty (called when a 429 response is received).
   */
  empty(): void {
    this.tokens = 0;
    this.lastUpdate = Date.now();
  }
}

export const rateBudgets = {
  mediaChunkUpload: new TokenBucket(30),
  restGeneral: new TokenBucket(60),
  pushSubscribe: new TokenBucket(5),
};
