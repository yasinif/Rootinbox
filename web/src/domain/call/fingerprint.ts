/**
 * Pure domain SDP fingerprint parsing.
 * Phase 12B §8.4.
 */

/**
 * Parse a DTLS fingerprint from an SDP string.
 * Extracts the SHA-256 fingerprint bytes from a line like:
 *   a=fingerprint:sha-256 AB:CD:EF:...
 *
 * Returns null if the line doesn't contain a valid SHA-256 fingerprint.
 */
export function parseSdpFingerprint(sdp: string): Uint8Array | null {
  const lines = sdp.split(/\r?\n/);
  for (const line of lines) {
    const match = line.match(/^a=fingerprint:sha-256\s+([0-9A-Fa-f:]+)/);
    if (match) {
      const hexParts = match[1].split(':');
      if (hexParts.length !== 32) continue;
      const bytes = new Uint8Array(32);
      for (let i = 0; i < 32; i++) {
        bytes[i] = parseInt(hexParts[i], 16);
      }
      return bytes;
    }
  }
  return null;
}
