package crypto

// ReplayWindow implements RFC-0003 §7 bitmap sliding window replay protection.
// Uses two uint64 values: highest_sequence and bitmap.
// The bitmap tracks the presence of the last 64 messages relative to highest_sequence.
// RFC-0003 §7: Messages falling outside this 64-bit window, or where the
// corresponding bit is already set to 1, MUST be dropped silently.
type ReplayWindow struct {
	HighestSequence uint64
	Bitmap          uint64
}

const replayWindowSize = 64

// Check returns true if the sequence number is new (not replayed).
// Returns false if: seqNum is 0, already received, or outside the window.
func (rw *ReplayWindow) Check(seqNum uint64) bool {
	if seqNum == 0 {
		return false // Sequence numbers start at 1.
	}

	if seqNum > rw.HighestSequence {
		return true // New message ahead of window — always accept.
	}

	diff := rw.HighestSequence - seqNum
	if diff >= replayWindowSize {
		return false // Too old, outside the 64-message window.
	}

	// Check if bit is already set (message already received).
	mask := uint64(1) << diff
	return (rw.Bitmap & mask) == 0
}

// Accept marks a sequence number as received and advances the window if needed.
// MUST only be called after Check() returns true and decryption succeeds.
func (rw *ReplayWindow) Accept(seqNum uint64) {
	if seqNum > rw.HighestSequence {
		diff := seqNum - rw.HighestSequence
		if diff >= replayWindowSize {
			rw.Bitmap = 0 // Entire window shifted out.
		} else {
			rw.Bitmap <<= diff // Shift existing bits.
		}
		rw.HighestSequence = seqNum
		rw.Bitmap |= 1 // Mark new highest as received (bit 0).
	} else {
		diff := rw.HighestSequence - seqNum
		if diff < replayWindowSize {
			rw.Bitmap |= uint64(1) << diff
		}
	}
}

// NeedsRotation returns true if the sequence number is approaching uint64 overflow.
// RFC-0003 §7: Exhaustion Rule — Sequence number exhaustion MUST trigger a mandatory
// Session Key rotation before the 64-bit integer overflows.
func NeedsRotation(currentSeq uint64) bool {
	// Trigger rotation when within 1000 of overflow.
	return currentSeq >= ^uint64(0)-1000
}
