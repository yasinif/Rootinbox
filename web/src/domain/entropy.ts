/**
 * Passphrase Entropy & Strength Estimation (Domain logic).
 * Stage 1a / RFC-0004 §2.1: Enforces minimum 12 chars and >= 60 bits entropy.
 * Zero external dependencies.
 */

export interface EntropyResult {
  bits: number;
  length: number;
  isStrong: boolean;
  feedback: string | null;
}

export function estimatePassphraseEntropy(passphrase: string): EntropyResult {
  const length = passphrase.length;
  if (length === 0) {
    return { bits: 0, length: 0, isStrong: false, feedback: 'Passphrase is required' };
  }

  if (length < 12) {
    return {
      bits: Math.round(length * 3),
      length,
      isStrong: false,
      feedback: 'Passphrase must be at least 12 characters',
    };
  }

  let poolSize = 0;
  if (/[a-z]/.test(passphrase)) poolSize += 26;
  if (/[A-Z]/.test(passphrase)) poolSize += 26;
  if (/[0-9]/.test(passphrase)) poolSize += 10;
  if (/[^a-zA-Z0-9]/.test(passphrase)) poolSize += 33;

  if (poolSize === 0) poolSize = 1;

  // Bits of entropy: L * log2(poolSize)
  const bitsPerChar = Math.log2(poolSize);
  let totalBits = length * bitsPerChar;

  // Deduct penalty for character repetitions
  const uniqueChars = new Set(passphrase).size;
  const repetitionRatio = uniqueChars / length;
  if (repetitionRatio < 0.6) {
    totalBits *= repetitionRatio;
  }

  const roundedBits = Math.round(totalBits);
  const isStrong = length >= 12 && roundedBits >= 60;

  let feedback: string | null = null;
  if (!isStrong) {
    feedback = 'Passphrase needs more variety (letters, numbers, symbols; min 60 bits entropy)';
  }

  return {
    bits: roundedBits,
    length,
    isStrong,
    feedback,
  };
}
