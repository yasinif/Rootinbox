import { describe, it, expect } from 'vitest';
import { estimatePassphraseEntropy } from '../../src/domain/entropy';

describe('estimatePassphraseEntropy', () => {
  it('rejects empty passphrase', () => {
    const res = estimatePassphraseEntropy('');
    expect(res.isStrong).toBe(false);
    expect(res.bits).toBe(0);
    expect(res.feedback).toBe('Passphrase is required');
  });

  it('rejects passphrases shorter than 12 characters', () => {
    const res = estimatePassphraseEntropy('Short1!');
    expect(res.isStrong).toBe(false);
    expect(res.feedback).toBe('Passphrase must be at least 12 characters');
  });

  it('rejects 12-char passphrase with single pool (too low entropy < 60 bits)', () => {
    // 12 lowercase letters: 12 * log2(26) = 12 * 4.7 = ~56 bits < 60 bits
    const res = estimatePassphraseEntropy('abcdefghijkl');
    expect(res.isStrong).toBe(false);
    expect(res.bits).toBeLessThan(60);
    expect(res.feedback).toContain('60 bits entropy');
  });

  it('accepts strong 12-char mixed passphrase (>= 60 bits entropy)', () => {
    // 12 chars with upper, lower, digits, symbols: pool 95, 12 * log2(95) = ~78 bits >= 60 bits
    const res = estimatePassphraseEntropy('Password123!');
    expect(res.isStrong).toBe(true);
    expect(res.bits).toBeGreaterThanOrEqual(60);
    expect(res.feedback).toBeNull();
  });

  it('accepts long diverse passphrase', () => {
    const res = estimatePassphraseEntropy('correct-horse-battery-staple-99!');
    expect(res.isStrong).toBe(true);
    expect(res.bits).toBeGreaterThan(80);
    expect(res.feedback).toBeNull();
  });
});
