/**
 * Shared cryptographically secure random helper for test fixtures and credentials.
 * Replaces Math.random() in tests to satisfy CodeQL js/insecure-randomness.
 */
import * as nodeCrypto from 'node:crypto';

const cryptoSource = typeof globalThis.crypto !== 'undefined' ? globalThis.crypto : (nodeCrypto as any).webcrypto;

/**
 * Returns a cryptographically secure random lowercase alphanumeric string (similar to Math.random().toString(36).substring(2)).
 */
export function secureRandomAlphanumeric(length = 8): string {
  const chars = '0123456789abcdefghijklmnopqrstuvwxyz';
  const bytes = new Uint8Array(length);
  if (cryptoSource && typeof cryptoSource.getRandomValues === 'function') {
    cryptoSource.getRandomValues(bytes);
  } else if (typeof nodeCrypto.randomFillSync === 'function') {
    nodeCrypto.randomFillSync(bytes);
  } else {
    throw new Error('No cryptographically secure random source available');
  }

  let result = '';
  for (let i = 0; i < length; i++) {
    result += chars[bytes[i] % chars.length];
  }
  return result;
}

/**
 * Returns a cryptographically secure UUIDv4 string.
 */
export function secureRandomUUID(): string {
  if (cryptoSource && typeof cryptoSource.randomUUID === 'function') {
    return cryptoSource.randomUUID();
  }
  if (typeof nodeCrypto.randomUUID === 'function') {
    return nodeCrypto.randomUUID();
  }
  throw new Error('crypto.randomUUID not available');
}

/**
 * Generates a random username with prefix, e.g. "alice_a1b2c3" or "user_x8y9z0w1".
 */
export function randomTestUsername(prefix = 'user', length = 8): string {
  return `${prefix}_${secureRandomAlphanumeric(length)}`;
}
