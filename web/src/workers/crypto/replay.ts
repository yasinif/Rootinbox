/**
 * Replay Window — exact port of pkg/crypto/replay.go.
 * RFC-0003 §7: Bitmap sliding window replay protection.
 *
 * BigInt everywhere for sequence/bitmap arithmetic.
 * Masked & 0xFFFFFFFFFFFFFFFFn after every shift/OR.
 *
 * CRITICAL RULES:
 * - check/accept are SEPARATE — accept ONLY after successful GCM auth
 * - Failed decrypt leaves window UNCHANGED
 * - seq 0 is INVALID (always returns false)
 * - diff >= 64 → rejected (outside window)
 */

const WINDOW_SIZE = 64n;
const MASK_64 = 0xFFFFFFFFFFFFFFFFn;

export class ReplayWindow {
  highestSequence = 0n;
  bitmap = 0n;

  /**
   * Check if a sequence number is new (not replayed).
   * Returns true if the message should be processed.
   * Does NOT modify the window state.
   */
  check(seqNum: bigint): boolean {
    if (seqNum === 0n) return false; // Sequence numbers start at 1.

    if (seqNum > this.highestSequence) return true; // New, ahead of window.

    const diff = this.highestSequence - seqNum;
    if (diff >= WINDOW_SIZE) return false; // Too old, outside window.

    // Check if bit is already set (message already received).
    const mask = (1n << diff) & MASK_64;
    return (this.bitmap & mask) === 0n;
  }

  /**
   * Mark a sequence number as received and advance the window if needed.
   * MUST only be called after check() returns true AND decryption succeeds.
   */
  accept(seqNum: bigint): void {
    if (seqNum > this.highestSequence) {
      const diff = seqNum - this.highestSequence;
      if (diff >= WINDOW_SIZE) {
        this.bitmap = 0n; // Entire window shifted out.
      } else {
        this.bitmap = (this.bitmap << diff) & MASK_64; // Shift existing bits.
      }
      this.highestSequence = seqNum;
      this.bitmap = (this.bitmap | 1n) & MASK_64; // Mark new highest (bit 0).
    } else {
      const diff = this.highestSequence - seqNum;
      if (diff < WINDOW_SIZE) {
        this.bitmap = (this.bitmap | ((1n << diff) & MASK_64)) & MASK_64;
      }
    }
  }
}

/**
 * RFC-0003 §7: Exhaustion Rule.
 * Returns true when near uint64 overflow (within 1000).
 */
export function needsRotation(currentSeq: bigint): boolean {
  return currentSeq >= MASK_64 - 1000n;
}
