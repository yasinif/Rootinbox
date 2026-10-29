/**
 * Phase 12B Unit Test — Filename Sanitization.
 * §23.2, §18.2, ADR-P12B-38.
 *
 * Asserts:
 * - C0 and C1 control stripping
 * - Bidi override and isolate stripping (U+202A–U+202E, U+2066–U+2069)
 * - Whitespace collapse
 * - 128-grapheme truncation preserving clusters with ellipsis
 */

import { describe, it, expect } from 'vitest';
import { sanitizeFileName } from '../../src/domain/media/filename';

describe('Filename Sanitization Unit Tests (§23.2, §18.2)', () => {
  it('strips C0 controls (0x00-0x1F, 0x7F) and C1 controls (0x80-0x9F)', () => {
    const malicious = 'test\x00\x08\x0b\x1f\x7f\x80\x9fname.pdf';
    expect(sanitizeFileName(malicious)).toBe('testname.pdf');
  });

  it('strips bidi overrides and isolates (U+202A..U+202E, U+2066..U+2069)', () => {
    // RLO (U+202E) attack: tries to spoof "invoice_gpj.exe" into displaying as "invoice_exe.jpg"
    const rloAttack = 'invoice_\u202Egpj.exe';
    expect(sanitizeFileName(rloAttack)).toBe('invoice_gpj.exe');

    // All bidi controls stripped
    const allBidi = 'doc\u202A\u202B\u202C\u202D\u202E\u2066\u2067\u2068\u2069file.png';
    expect(sanitizeFileName(allBidi)).toBe('docfile.png');
  });

  it('collapses multiple whitespace characters and trims', () => {
    const messy = '   my    report   2026   final.docx   ';
    expect(sanitizeFileName(messy)).toBe('my report 2026 final.docx');
  });

  it('truncates to 128 graphemes preserving multi-code-unit emoji clusters', () => {
    // Family emoji with ZWJ is 1 grapheme cluster (multiple code units)
    const familyEmoji = '👨‍👩‍👧‍👦';
    const longName = familyEmoji.repeat(150) + '.png';
    const sanitized = sanitizeFileName(longName);

    // Should be truncated to 127 graphemes + ellipsis
    if (typeof Intl !== 'undefined' && 'Segmenter' in Intl) {
      const segmenter = new (Intl as any).Segmenter(undefined, { granularity: 'grapheme' });
      const count = Array.from(segmenter.segment(sanitized)).length;
      expect(count).toBe(128);
      expect(sanitized.endsWith('…')).toBe(true);
    } else {
      expect(sanitized.endsWith('…')).toBe(true);
    }
  });

  it('handles empty or blank input with safe fallback', () => {
    expect(sanitizeFileName('')).toBe('unnamed_file');
    expect(sanitizeFileName('   ')).toBe('unnamed_file');
    expect(sanitizeFileName('\x00\x01\x1f')).toBe('unnamed_file');
  });
});
