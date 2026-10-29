/**
 * Pure domain encoding utilities.
 * RFC-0010 §4.1: Domain layer has zero external dependencies.
 * BASE64 DISCIPLINE:
 * - routing_id = base64URL-UNPADDED encoding of the UTF-8 bytes of the receiver's user_id UUID STRING
 * - payload = base64-STANDARD-WITH-PADDING of the ciphertext bytes
 */

/**
 * routing_id = base64URL-UNPADDED encoding of the UTF-8 bytes of the receiver's user_id UUID STRING.
 * (36-char hyphenated string, NOT the raw 16 bytes).
 */
export function encodeRoutingId(receiverUserId: string): string {
  const bytes = new TextEncoder().encode(receiverUserId);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * payload = base64-STANDARD-WITH-PADDING of the ciphertext bytes.
 */
export function hexToBase64StdPadded(hex: string): string {
  if (hex.length % 2 !== 0) throw new Error('Invalid hex length');
  let binary = '';
  for (let i = 0; i < hex.length; i += 2) {
    binary += String.fromCharCode(parseInt(hex.substring(i, i + 2), 16));
  }
  return btoa(binary);
}

/**
 * Decode base64-STANDARD-WITH-PADDING payload from inbound WS frame to hex string.
 */
export function base64StdToHex(b64: string): string {
  const binary = atob(b64);
  let hex = '';
  for (let i = 0; i < binary.length; i++) {
    hex += binary.charCodeAt(i).toString(16).padStart(2, '0');
  }
  return hex;
}

/**
 * Base64URL unpadded encode (RFC 4648 §5).
 */
export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * Base64URL unpadded decode (RFC 4648 §5).
 */
export function base64UrlDecode(str: string): Uint8Array {
  let b64 = str.replace(/-/g, '+').replace(/_/g, '/');
  while (b64.length % 4 !== 0) {
    b64 += '=';
  }
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Safe UUIDv4 generator compatible with secure contexts and insecure contexts (LAN HTTP).
 */
export function generateUUID(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

