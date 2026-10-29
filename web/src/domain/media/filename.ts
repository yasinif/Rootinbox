/**
 * Media Filename Sanitization.
 * Phase 12B §18.2, ADR-P12B-38.
 *
 * Security rules:
 * - Strip C0 and C1 control characters ([\u0000-\u001F\u007F-\u009F])
 * - Strip bidi overrides and isolates (U+202A–U+202E, U+2066–U+2069) to prevent extension spoofing
 * - Collapse consecutive whitespace to single space and trim
 * - Truncate to 128 grapheme clusters with visible ellipsis
 */

export function sanitizeFileName(fileName: string): string {
  if (!fileName || typeof fileName !== 'string') {
    return 'unnamed_file';
  }

  // 1. Strip C0 and C1 control characters (0x00-0x1F, 0x7F-0x9F)
  let clean = '';
  for (const ch of fileName) {
    const code = ch.charCodeAt(0);
    if (code > 0x1f && (code < 0x7f || code > 0x9f)) {
      clean += ch;
    }
  }

  // 2. Strip bidi overrides and isolates (U+202A..U+202E, U+2066..U+2069)
  clean = clean.replace(/[\u202A-\u202E\u2066-\u2069]/g, '');

  // 3. Collapse whitespace
  clean = clean.replace(/\s+/g, ' ').trim();

  if (!clean) {
    return 'unnamed_file';
  }

  // 4. Truncate to 128 grapheme clusters preserving clusters
  type IntlWithSegmenter = typeof Intl & {
    Segmenter: new (
      locales?: string | string[],
      options?: { granularity?: 'grapheme' | 'word' | 'sentence' },
    ) => {
      segment: (input: string) => Iterable<{ segment: string }>;
    };
  };

  if (typeof Intl !== 'undefined' && 'Segmenter' in Intl) {
    const intlSegmenter = Intl as unknown as IntlWithSegmenter;
    const segmenter = new intlSegmenter.Segmenter(undefined, { granularity: 'grapheme' });
    const graphemes = Array.from(segmenter.segment(clean)).map((s) => s.segment);
    if (graphemes.length > 128) {
      return graphemes.slice(0, 127).join('') + '…';
    }
    return clean;
  }

  const chars = Array.from(clean);
  if (chars.length > 128) {
    return chars.slice(0, 127).join('') + '…';
  }

  return clean;
}
