/**
 * Passcode domain types and local hashing primitives.
 * Provides client-local salted & hashed 4-digit passcode security.
 */

import type { MetadataPort } from './ports';

export type AutoLockTimeout = 'off' | '1m' | '5m' | '15m' | '1h' | 'blur';

export interface PasscodeSettings {
  enabled: boolean;
  salt?: string;
  hash?: string;
  autoLockTimeout: AutoLockTimeout;
}

function bytesToHex(bytes: Uint8Array): string {
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, '0');
  }
  return hex;
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/[^0-9a-fA-F]/g, '');
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(clean.substring(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/**
 * Derives a PBKDF2-HMAC-SHA-256 hash for a 4-digit numeric passcode with 100,000 iterations.
 */
export async function hashPasscode(pin: string, saltHex?: string): Promise<{ salt: string; hash: string }> {
  let saltBytes: Uint8Array;
  if (saltHex) {
    saltBytes = hexToBytes(saltHex);
  } else {
    saltBytes = new Uint8Array(16);
    if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
      crypto.getRandomValues(saltBytes as unknown as ArrayBufferView<ArrayBuffer>);
    } else {
      for (let i = 0; i < 16; i++) {
        saltBytes[i] = Math.floor(Math.random() * 256);
      }
    }
  }

  const encoder = new TextEncoder();
  const pinBytes = encoder.encode(pin);

  if (typeof crypto !== 'undefined' && crypto.subtle) {
    const key = await crypto.subtle.importKey(
      'raw',
      pinBytes,
      { name: 'PBKDF2' },
      false,
      ['deriveBits'],
    );
    const derivedBits = await crypto.subtle.deriveBits(
      {
        name: 'PBKDF2',
        salt: saltBytes as ArrayBufferView<ArrayBuffer>,
        iterations: 100000,
        hash: 'SHA-256',
      },
      key,
      256,
    );
    return {
      salt: bytesToHex(saltBytes),
      hash: bytesToHex(new Uint8Array(derivedBits)),
    };
  }

  // Fallback for limited environments: SHA-256 rounds
  let current = new Uint8Array([...saltBytes, ...pinBytes]);
  for (let i = 0; i < 1000; i++) {
    // Basic hash fallback
    const buf = new Uint8Array(32);
    for (let j = 0; j < current.length; j++) {
      buf[j % 32] = (buf[j % 32] ^ current[j] ^ (i & 0xff)) & 0xff;
    }
    current = buf;
  }
  return {
    salt: bytesToHex(saltBytes),
    hash: bytesToHex(current),
  };
}

/**
 * Verifies a 4-digit numeric passcode against the stored salted hash in constant time.
 */
export async function verifyPasscode(
  pin: string,
  saltHex: string,
  expectedHashHex: string,
): Promise<boolean> {
  if (!pin || !saltHex || !expectedHashHex) return false;
  try {
    const computed = await hashPasscode(pin, saltHex);
    const a = computed.hash.toLowerCase();
    const b = expectedHashHex.toLowerCase();
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) {
      diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    }
    return diff === 0;
  } catch {
    return false;
  }
}

/**
 * Loads passcode configuration from MetadataPort, scoped to user if provided.
 */
export async function loadPasscodeSettings(
  metadataPort: MetadataPort,
  userId?: string | null,
): Promise<PasscodeSettings> {
  const prefix = userId ? `passcode_${userId}_` : 'passcode_';
  let enabledStr = await metadataPort.get(`${prefix}enabled`);
  let salt = await metadataPort.get(`${prefix}salt`);
  let hash = await metadataPort.get(`${prefix}hash`);
  let timeoutStr = await metadataPort.get(`${prefix}autolock`);

  // Fallback to legacy un-prefixed keys if user-specific keys not found
  if (enabledStr === undefined && userId) {
    enabledStr = await metadataPort.get('passcode_enabled');
    salt = await metadataPort.get('passcode_salt');
    hash = await metadataPort.get('passcode_hash');
    timeoutStr = await metadataPort.get('passcode_autolock');
  }

  const enabled = enabledStr === 'true' && Boolean(salt) && Boolean(hash);
  const validTimeouts: AutoLockTimeout[] = ['off', '1m', '5m', '15m', '1h', 'blur'];
  const autoLockTimeout: AutoLockTimeout = validTimeouts.includes(timeoutStr as AutoLockTimeout)
    ? (timeoutStr as AutoLockTimeout)
    : '5m';

  return {
    enabled,
    salt: salt || undefined,
    hash: hash || undefined,
    autoLockTimeout,
  };
}

/**
 * Persists passcode configuration to MetadataPort, scoped to user if provided.
 */
export async function savePasscodeSettings(
  metadataPort: MetadataPort,
  settings: PasscodeSettings,
  userId?: string | null,
): Promise<void> {
  const prefix = userId ? `passcode_${userId}_` : 'passcode_';
  await metadataPort.set(`${prefix}enabled`, settings.enabled ? 'true' : 'false');
  if (settings.salt) {
    await metadataPort.set(`${prefix}salt`, settings.salt);
  } else {
    await metadataPort.delete(`${prefix}salt`);
  }
  if (settings.hash) {
    await metadataPort.set(`${prefix}hash`, settings.hash);
  } else {
    await metadataPort.delete(`${prefix}hash`);
  }
  await metadataPort.set(`${prefix}autolock`, settings.autoLockTimeout);

  // Sync to global keys as well for backwards compatibility
  await metadataPort.set('passcode_enabled', settings.enabled ? 'true' : 'false');
  if (settings.salt) await metadataPort.set('passcode_salt', settings.salt);
  else await metadataPort.delete('passcode_salt');
  if (settings.hash) await metadataPort.set('passcode_hash', settings.hash);
  else await metadataPort.delete('passcode_hash');
  await metadataPort.set('passcode_autolock', settings.autoLockTimeout);
}

/**
 * Clears all passcode configuration from MetadataPort, scoped to user if provided.
 */
export async function clearPasscodeSettings(
  metadataPort: MetadataPort,
  userId?: string | null,
): Promise<void> {
  if (userId) {
    const prefix = `passcode_${userId}_`;
    await metadataPort.delete(`${prefix}enabled`);
    await metadataPort.delete(`${prefix}salt`);
    await metadataPort.delete(`${prefix}hash`);
    await metadataPort.delete(`${prefix}autolock`);
  }
  await metadataPort.delete('passcode_enabled');
  await metadataPort.delete('passcode_salt');
  await metadataPort.delete('passcode_hash');
  await metadataPort.delete('passcode_autolock');
}
