/**
 * Timestamp normalization helper.
 * Unifies seconds (10-digit) and milliseconds (13-digit) into standard milliseconds.
 */
export function toMillis(ts?: number | string | null): number {
  if (ts === undefined || ts === null || ts === '') {
    return 0;
  }
  const n = typeof ts === 'string' ? Number(ts) : ts;
  if (isNaN(n) || n <= 0) {
    return 0;
  }
  if (n < 10_000_000_000) {
    return Math.floor(n * 1000);
  }
  return Math.floor(n);
}
