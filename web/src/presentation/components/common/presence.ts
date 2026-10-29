/**
 * Presentation helper for presence and last seen formatting.
 * Spec (Phase 5):
 * - online === true -> "Online"
 * - Today -> "last seen today at HH:MM"
 * - Yesterday -> "last seen yesterday at HH:MM"
 * - Older -> "last seen on YYYY-MM-DD at HH:MM"
 * - Otherwise -> "Offline"
 */

export function formatLastSeen(online?: boolean, lastSeenAt?: number): string {
  if (online) {
    return 'Online';
  }
  if (!lastSeenAt || lastSeenAt <= 0) {
    return 'Offline';
  }
  const ts = lastSeenAt < 10_000_000_000 ? lastSeenAt * 1000 : lastSeenAt;
  const d = new Date(ts);
  if (isNaN(d.getTime())) {
    return 'Offline';
  }

  const hours = d.getHours().toString().padStart(2, '0');
  const minutes = d.getMinutes().toString().padStart(2, '0');
  const timeStr = `${hours}:${minutes}`;

  const now = new Date();
  const isToday =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();

  if (isToday) {
    return `last seen today at ${timeStr}`;
  }

  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const isYesterday =
    d.getFullYear() === yesterday.getFullYear() &&
    d.getMonth() === yesterday.getMonth() &&
    d.getDate() === yesterday.getDate();

  if (isYesterday) {
    return `last seen yesterday at ${timeStr}`;
  }

  const year = d.getFullYear();
  const month = (d.getMonth() + 1).toString().padStart(2, '0');
  const day = d.getDate().toString().padStart(2, '0');
  return `last seen on ${year}-${month}-${day} at ${timeStr}`;
}
