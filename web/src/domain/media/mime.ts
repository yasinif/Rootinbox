/**
 * Media MIME Allowlist & Classification.
 * Phase 12B §17.5, ADR-P12B-38.
 *
 * Rules:
 * - Only allowlisted MIME types may render inline.
 * - application/pdf, text/html, and any unrecognized type are download-only.
 * - The Blob type is set from the allowlist entry, never from the raw peer string.
 */

export const INLINE_MIME_ALLOWLIST: readonly string[] = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'image/svg+xml',
  'image/avif',
  'image/bmp',
  'video/mp4',
  'video/webm',
  'video/ogg',
  'video/quicktime',
  'audio/mpeg',
  'audio/mp3',
  'audio/ogg',
  'audio/wav',
  'audio/webm',
  'audio/aac',
  'audio/x-m4a',
  'audio/m4a',
  'audio/flac',
  'audio/mp4',
] as const;

export const DOCUMENT_MIME_ALLOWLIST: readonly string[] = [
  'application/pdf',
  'application/zip',
  'application/x-zip-compressed',
  'application/x-tar',
  'application/gzip',
  'application/x-7z-compressed',
  'application/x-rar-compressed',
  'application/vnd.rar',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'text/plain',
  'text/csv',
  'text/markdown',
  'application/json',
  'application/octet-stream',
] as const;

const ALLOWLIST_SET = new Set<string>(INLINE_MIME_ALLOWLIST);
const DOCUMENT_SET = new Set<string>(DOCUMENT_MIME_ALLOWLIST);

/**
 * Check if a MIME type is permitted to render inline.
 */
export function isInlineRenderable(mimeType: string): boolean {
  if (!mimeType) return false;
  const clean = mimeType.split(';')[0].trim().toLowerCase();
  return ALLOWLIST_SET.has(clean);
}

/**
 * Return the validated MIME type if allowlisted, or 'application/octet-stream' for download-only.
 */
export function getValidatedMimeType(mimeType: string): string {
  const clean = (mimeType || '').split(';')[0].trim().toLowerCase();
  if (ALLOWLIST_SET.has(clean)) {
    return clean;
  }
  return 'application/octet-stream';
}

/**
 * Normalize and validate an uploaded file MIME type.
 * Gracefully falls back to 'application/octet-stream' for generic/empty types.
 * Strips any parameter components (e.g. ;codecs=opus).
 */
export function normalizeUploadMimeType(mimeType?: string | null): string {
  if (!mimeType) return 'application/octet-stream';
  const clean = mimeType.split(';')[0].trim().toLowerCase();
  if (!clean) return 'application/octet-stream';
  if (ALLOWLIST_SET.has(clean) || DOCUMENT_SET.has(clean)) {
    return clean;
  }
  if (
    clean.startsWith('image/') ||
    clean.startsWith('video/') ||
    clean.startsWith('audio/') ||
    clean.startsWith('text/')
  ) {
    return clean;
  }
  return 'application/octet-stream';
}

/**
 * Friendly category label for the UI (never displays raw peer MIME string).
 */
export function getFriendlyTypeLabel(mimeType: string): string {
  const normalized = (mimeType || '').toLowerCase().trim();
  if (normalized.startsWith('image/')) return 'Image';
  if (normalized.startsWith('video/')) return 'Video';
  if (normalized.startsWith('audio/')) return 'Audio';
  if (normalized === 'application/pdf') return 'PDF Document';
  if (
    normalized.includes('word') ||
    normalized.includes('officedocument.wordprocessingml')
  ) {
    return 'Word Document';
  }
  if (
    normalized.includes('excel') ||
    normalized.includes('officedocument.spreadsheetml') ||
    normalized === 'text/csv'
  ) {
    return 'Spreadsheet';
  }
  if (
    normalized.includes('powerpoint') ||
    normalized.includes('officedocument.presentationml')
  ) {
    return 'Presentation';
  }
  if (
    normalized.includes('zip') ||
    normalized.includes('tar') ||
    normalized.includes('compressed') ||
    normalized.includes('rar') ||
    normalized.includes('7z') ||
    normalized.includes('gzip')
  ) {
    return 'Archive';
  }
  if (normalized === 'text/plain' || normalized === 'text/markdown') {
    return 'Text Document';
  }
  return 'File';
}
