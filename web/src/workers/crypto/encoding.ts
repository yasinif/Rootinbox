/**
 * Encoding utilities for the crypto layer.
 * RFC-0003 §6: Wire format, AAD, base64, hex codecs.
 *
 * FOUR separate codecs:
 * 1. hex lowercase — all key material, hashes
 * 2. base64url unpadded — routing_id, nonce, signature, identity_hash
 * 3. base64 standard padded — payload (ciphertext transport)
 * 4. UTF-8 — username normalization, plaintext
 */

import { createSHA256 } from 'hash-wasm';

// ─── Hex ─────────────────────────────────────────────────────
export function hexEncode(buf: Uint8Array): string {
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function hexDecode(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error('Invalid hex length');
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
  }
  return out;
}

// ─── Base64URL unpadded (RFC 4648 §5) ────────────────────────
const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

export function base64urlEncode(buf: Uint8Array): string {
  let out = '';
  for (let i = 0; i < buf.length; i += 3) {
    const b0 = buf[i];
    const b1 = i + 1 < buf.length ? buf[i + 1] : 0;
    const b2 = i + 2 < buf.length ? buf[i + 2] : 0;
    out += B64URL[(b0 >> 2) & 0x3f];
    out += B64URL[((b0 << 4) | (b1 >> 4)) & 0x3f];
    if (i + 1 < buf.length) out += B64URL[((b1 << 2) | (b2 >> 6)) & 0x3f];
    if (i + 2 < buf.length) out += B64URL[b2 & 0x3f];
  }
  return out;
}

export function base64urlDecode(str: string): Uint8Array {
  const lookup = new Uint8Array(128);
  for (let i = 0; i < B64URL.length; i++) lookup[B64URL.charCodeAt(i)] = i;

  const pad = (4 - (str.length % 4)) % 4;
  const len = ((str.length + pad) * 3) / 4 - pad;
  const out = new Uint8Array(len);
  let j = 0;
  for (let i = 0; i < str.length; i += 4) {
    const a = lookup[str.charCodeAt(i)];
    const b = i + 1 < str.length ? lookup[str.charCodeAt(i + 1)] : 0;
    const c = i + 2 < str.length ? lookup[str.charCodeAt(i + 2)] : 0;
    const d = i + 3 < str.length ? lookup[str.charCodeAt(i + 3)] : 0;
    out[j++] = (a << 2) | (b >> 4);
    if (j < len) out[j++] = ((b << 4) | (c >> 2)) & 0xff;
    if (j < len) out[j++] = ((c << 6) | d) & 0xff;
  }
  return out;
}

// ─── Base64 standard padded (RFC 4648 §4) ────────────────────
const B64STD = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function base64StdEncode(buf: Uint8Array): string {
  let out = '';
  for (let i = 0; i < buf.length; i += 3) {
    const b0 = buf[i];
    const b1 = i + 1 < buf.length ? buf[i + 1] : 0;
    const b2 = i + 2 < buf.length ? buf[i + 2] : 0;
    out += B64STD[(b0 >> 2) & 0x3f];
    out += B64STD[((b0 << 4) | (b1 >> 4)) & 0x3f];
    out += i + 1 < buf.length ? B64STD[((b1 << 2) | (b2 >> 6)) & 0x3f] : '=';
    out += i + 2 < buf.length ? B64STD[b2 & 0x3f] : '=';
  }
  return out;
}

export function base64StdDecode(str: string): Uint8Array {
  const lookup = new Uint8Array(128);
  for (let i = 0; i < B64STD.length; i++) lookup[B64STD.charCodeAt(i)] = i;

  let len = (str.length * 3) / 4;
  if (str.endsWith('==')) len -= 2;
  else if (str.endsWith('=')) len -= 1;

  const out = new Uint8Array(len);
  let j = 0;
  for (let i = 0; i < str.length; i += 4) {
    const a = lookup[str.charCodeAt(i)];
    const b = lookup[str.charCodeAt(i + 1)];
    const c = str[i + 2] !== '=' ? lookup[str.charCodeAt(i + 2)] : 0;
    const d = str[i + 3] !== '=' ? lookup[str.charCodeAt(i + 3)] : 0;
    out[j++] = (a << 2) | (b >> 4);
    if (j < len) out[j++] = ((b << 4) | (c >> 2)) & 0xff;
    if (j < len) out[j++] = ((c << 6) | d) & 0xff;
  }
  return out;
}

// ─── UTF-8 ───────────────────────────────────────────────────
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export function utf8Encode(s: string): Uint8Array {
  return textEncoder.encode(s);
}

export function utf8Decode(buf: Uint8Array): string {
  return textDecoder.decode(buf);
}

// ─── BigEndian 64-bit ────────────────────────────────────────
export function writeBigEndian64(buf: Uint8Array, offset: number, value: bigint): void {
  let v = value & 0xFFFFFFFFFFFFFFFFn;
  for (let i = 7; i >= 0; i--) {
    buf[offset + i] = Number(v & 0xFFn);
    v >>= 8n;
  }
}

export function readBigEndian64(buf: Uint8Array, offset: number): bigint {
  let val = 0n;
  for (let i = 0; i < 8; i++) {
    val = (val << 8n) | BigInt(buf[offset + i]);
  }
  return val & 0xFFFFFFFFFFFFFFFFn;
}

// ─── Wire Format (RFC-0003 §6.2) ────────────────────────────
export const CRYPTO_SUITE_V1 = 0x01;
export const MAX_CIPHERTEXT_SIZE = 5_242_880; // 5 MB
export const CIPHERTEXT_HEADER_SIZE = 1 + 8 + 12; // version + senderSessionId + IV = 21

export function encodeCiphertext(
  senderSessionId: Uint8Array,  // 8 bytes
  iv: Uint8Array,               // 12 bytes
  sealed: Uint8Array,
): Uint8Array {
  const total = CIPHERTEXT_HEADER_SIZE + sealed.length;
  if (total > MAX_CIPHERTEXT_SIZE) {
    throw new Error(`Ciphertext exceeds max size: ${total} > ${MAX_CIPHERTEXT_SIZE}`);
  }
  const buf = new Uint8Array(total);
  buf[0] = CRYPTO_SUITE_V1;
  buf.set(senderSessionId, 1);
  buf.set(iv, 9);
  buf.set(sealed, 21);
  return buf;
}

export function decodeCiphertext(data: Uint8Array): {
  version: number;
  senderSessionId: Uint8Array;
  iv: Uint8Array;
  sealed: Uint8Array;
} {
  if (data.length < CIPHERTEXT_HEADER_SIZE) {
    throw new Error(`Ciphertext too short: ${data.length} bytes`);
  }
  if (data.length > MAX_CIPHERTEXT_SIZE) {
    throw new Error('Ciphertext exceeds max size');
  }
  const version = data[0];
  if (version !== CRYPTO_SUITE_V1) {
    throw new Error(`Unsupported crypto suite version: 0x${version.toString(16).padStart(2, '0')}`);
  }
  return {
    version,
    senderSessionId: data.slice(1, 9),
    iv: data.slice(9, 21),
    sealed: data.slice(21),
  };
}

// ─── AAD Construction (RFC-0003 §6.5) ────────────────────────
export const AAD_SIZE = 128;

export function buildAAD(
  seqNum: bigint,
  clientUuid: Uint8Array,       // 16 bytes raw
  senderHash: Uint8Array,       // 32 bytes
  receiverHash: Uint8Array,     // 32 bytes
  convIdHash: Uint8Array,       // 32 bytes
  senderSessionId: Uint8Array,  // 8 bytes
): Uint8Array {
  const aad = new Uint8Array(AAD_SIZE);
  writeBigEndian64(aad, 0, seqNum);
  aad.set(clientUuid, 8);
  aad.set(senderHash, 24);
  aad.set(receiverHash, 56);
  aad.set(convIdHash, 88);
  aad.set(senderSessionId, 120);
  return aad;
}

// ─── Registration Wire Format (RFC-0003 §5.1) ───────────────
export const REGISTRATION_WIRE_SIZE = 137; // 32+32+64+1+8

export function encodeRegistration(
  identityPK: Uint8Array,
  sessionPK: Uint8Array,
  sig: Uint8Array,
  version: number,
  expiresAt: bigint,
): Uint8Array {
  const buf = new Uint8Array(REGISTRATION_WIRE_SIZE);
  buf.set(identityPK, 0);
  buf.set(sessionPK, 32);
  buf.set(sig, 64);
  buf[128] = version;
  writeBigEndian64(buf, 129, expiresAt);
  return buf;
}

// ─── Session Signature Payload (73 bytes) ────────────────────
export function buildSessionSigPayload(
  version: number,
  sessionPK: Uint8Array,
  expiresAt: bigint,
  identityPKHash: Uint8Array,
): Uint8Array {
  const payload = new Uint8Array(73);
  payload[0] = version;
  payload.set(sessionPK, 1);
  writeBigEndian64(payload, 33, expiresAt);
  payload.set(identityPKHash, 41);
  return payload;
}

// ─── Auth Payload (RFC-0004 §5.3) ───────────────────────────
const AUTH_LOGIN_PREFIX = utf8Encode('rootinbox/v1/login');

export function buildLoginPayload(
  nonce: Uint8Array,
  sessionPK: Uint8Array,
  challengeId: Uint8Array,
): Uint8Array {
  const payload = new Uint8Array(AUTH_LOGIN_PREFIX.length + 32 + 32 + challengeId.length);
  payload.set(AUTH_LOGIN_PREFIX, 0);
  let offset = AUTH_LOGIN_PREFIX.length;
  payload.set(nonce, offset); offset += 32;
  payload.set(sessionPK, offset); offset += 32;
  payload.set(challengeId, offset);
  return payload;
}

// ─── IV Construction (RFC-0003 §8.1) ─────────────────────────
export function buildIV(prefix: Uint8Array, counter: bigint): Uint8Array {
  const iv = new Uint8Array(12);
  iv.set(prefix.subarray(0, 4), 0);
  writeBigEndian64(iv, 4, counter);
  return iv;
}

// ─── Identity/Conversation Hashes ────────────────────────────
export async function sha256(data: Uint8Array): Promise<Uint8Array> {
  if (typeof crypto !== 'undefined' && crypto.subtle) {
    const hash = await crypto.subtle.digest('SHA-256', data as BufferSource);
    return new Uint8Array(hash);
  }
  const hasher = await createSHA256();
  hasher.init();
  hasher.update(data);
  return hasher.digest('binary');
}

export async function identityHash(publicKey: Uint8Array): Promise<Uint8Array> {
  return sha256(publicKey);
}

export function sessionIdentifier(sessionPubKey: Uint8Array): Promise<Uint8Array> {
  return sha256(sessionPubKey).then((h) => h.slice(0, 8));
}

export async function conversationIdHash(uuid: Uint8Array): Promise<Uint8Array> {
  return sha256(uuid);
}
