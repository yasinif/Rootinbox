import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { formatLastSeen } from '../../src/presentation/components/common/presence';

describe('formatLastSeen Specification Tests (Phase 5)', () => {
  const baseTime = new Date(2026, 9, 19, 15, 30, 0); // 2026-10-19 15:30:00

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(baseTime);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns "Online" when online is true regardless of timestamp', () => {
    expect(formatLastSeen(true)).toBe('Online');
    expect(formatLastSeen(true, 1000)).toBe('Online');
    expect(formatLastSeen(true, baseTime.getTime())).toBe('Online');
  });

  it('returns "Offline" when lastSeenAt is undefined, null, 0, or negative', () => {
    expect(formatLastSeen(false)).toBe('Offline');
    expect(formatLastSeen(false, 0)).toBe('Offline');
    expect(formatLastSeen(false, -100)).toBe('Offline');
    expect(formatLastSeen(undefined, undefined)).toBe('Offline');
  });

  it('formats "last seen today at HH:MM" for timestamps today', () => {
    const earlierToday = new Date(2026, 9, 19, 14, 5, 0).getTime();
    expect(formatLastSeen(false, earlierToday)).toBe('last seen today at 14:05');

    const midnightToday = new Date(2026, 9, 19, 0, 0, 0).getTime();
    expect(formatLastSeen(false, midnightToday)).toBe('last seen today at 00:00');
  });

  it('formats "last seen yesterday at HH:MM" for timestamps yesterday', () => {
    const yesterday = new Date(2026, 9, 18, 22, 45, 0).getTime();
    expect(formatLastSeen(false, yesterday)).toBe('last seen yesterday at 22:45');

    const yesterdayMorning = new Date(2026, 9, 18, 8, 15, 0).getTime();
    expect(formatLastSeen(false, yesterdayMorning)).toBe('last seen yesterday at 08:15');
  });

  it('formats "last seen on YYYY-MM-DD at HH:MM" for older dates', () => {
    const older = new Date(2026, 9, 15, 9, 30, 0).getTime();
    expect(formatLastSeen(false, older)).toBe('last seen on 2026-10-15 at 09:30');

    const lastYear = new Date(2025, 11, 31, 23, 59, 0).getTime();
    expect(formatLastSeen(false, lastYear)).toBe('last seen on 2025-12-31 at 23:59');
  });

  it('handles epoch seconds properly by multiplying to milliseconds', () => {
    const earlierTodaySec = Math.floor(new Date(2026, 9, 19, 11, 20, 0).getTime() / 1000);
    expect(formatLastSeen(false, earlierTodaySec)).toBe('last seen today at 11:20');
  });
});
