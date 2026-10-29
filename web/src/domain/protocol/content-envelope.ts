/**
 * MCE v1 — Message Content Envelope.
 * Phase 12B §7.5 + 12A Amendment 2: Transport format for all chat messages.
 *
 * Format:
 *   {"v":1,"t":"text","b":"<body>"}
 *   {"v":1,"t":"media","m":{<MediaMetadata>}}
 *
 * Rules:
 * - `v` MUST be 1.
 * - `t` MUST be "text" or "media".
 * - Text messages use `b` (string body); media uses `m` (metadata object).
 * - Field order is v → t → b|m (for determinism).
 * - This is the plaintext that feeds into AES-GCM encryption.
 */

import type { MediaMetadata } from '../media';

/** MCE v1 text envelope. */
export interface MCETextEnvelope {
  readonly v: 1;
  readonly t: 'text';
  readonly b: string;
  readonly r?: string;
  readonly e?: string;
}

/** MCE v1 media envelope. */
export interface MCEMediaEnvelope {
  readonly v: 1;
  readonly t: 'media';
  readonly m: MediaMetadata;
  readonly f?: string;
}

/** MCE v1 call history metadata. */
export interface MCECallData {
  callId: string;
  callType: 'audio' | 'video';
  direction: 'incoming' | 'outgoing';
  status: 'completed' | 'missed' | 'rejected' | 'busy' | 'failed';
  duration: number;
}

/** MCE v1 call envelope. */
export interface MCECallEnvelope {
  readonly v: 1;
  readonly t: 'call';
  readonly c: MCECallData;
}

/** MCE v1 system control envelope (e.g. sealed delete-for-both, seen receipts). */
export interface MCESysEnvelope {
  readonly v: 1;
  readonly t: 'sys';
  readonly d?: string;
  readonly s?: string[];
}

/** MCE v1 union type. */
export type MCEEnvelope = MCETextEnvelope | MCEMediaEnvelope | MCECallEnvelope | MCESysEnvelope;

/**
 * Serialize a text message into MCE v1 JSON string.
 * When replyToId is omitted, exact {"v":1,"t":"text","b":"..."} is produced (matching vectors).
 */
export function mceEncodeText(body: string, replyToId?: string): string {
  if (replyToId) {
    return JSON.stringify({ v: 1, t: 'text', b: body, r: replyToId });
  }
  return JSON.stringify({ v: 1, t: 'text', b: body });
}

/**
 * Serialize an edit message into MCE v1 JSON string.
 */
export function mceEncodeEdit(targetMessageId: string, newText: string): string {
  return JSON.stringify({ v: 1, t: 'text', b: newText, e: targetMessageId });
}

/**
 * Serialize a sealed delete-for-both system message into MCE v1 JSON string.
 */
export function mceEncodeDeleteForBoth(targetMessageId: string): string {
  return JSON.stringify({ v: 1, t: 'sys', d: targetMessageId });
}

/**
 * Serialize a sealed seen receipt system message into MCE v1 JSON string.
 */
export function mceEncodeSeen(messageIds: string[]): string {
  return JSON.stringify({ v: 1, t: 'sys', s: messageIds });
}

/**
 * Serialize a media message into MCE v1 JSON string.
 */
export function mceEncodeMedia(metadata: MediaMetadata, fileName?: string): string {
  if (fileName) {
    return JSON.stringify({ v: 1, t: 'media', m: metadata, f: fileName });
  }
  return JSON.stringify({ v: 1, t: 'media', m: metadata });
}

/**
 * Serialize a call history record into MCE v1 JSON string.
 */
export function mceEncodeCall(callData: MCECallData): string {
  return JSON.stringify({ v: 1, t: 'call', c: callData });
}

/**
 * Parse a decrypted plaintext into an MCE envelope.
 * Returns null if the plaintext is not valid MCE v1 JSON.
 *
 * 12A Amendment 2: If parsing fails, treat the raw string as legacy text
 * (pre-MCE messages are plain strings).
 */
export function mceDecode(plaintext: string): MCEEnvelope | null {
  try {
    const obj = JSON.parse(plaintext);
    if (typeof obj !== 'object' || obj === null) return null;
    if (obj.v !== 1) return null;
    if (obj.t === 'text' && typeof obj.b === 'string') {
      const res: MCETextEnvelope = {
        v: 1,
        t: 'text',
        b: obj.b,
        ...(typeof obj.r === 'string' ? { r: obj.r } : {}),
        ...(typeof obj.e === 'string' ? { e: obj.e } : {}),
      };
      return res;
    }
    if (obj.t === 'sys') {
      return {
        v: 1,
        t: 'sys',
        ...(typeof obj.d === 'string' ? { d: obj.d } : {}),
        ...(Array.isArray(obj.s) ? { s: obj.s } : {}),
      };
    }
    if (obj.t === 'media' && typeof obj.m === 'object' && obj.m !== null) {
      return {
        v: 1,
        t: 'media',
        m: obj.m,
        ...(typeof obj.f === 'string' ? { f: obj.f } : {}),
      };
    }
    if (obj.t === 'call' && typeof obj.c === 'object' && obj.c !== null) {
      return obj as MCECallEnvelope;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Extract the display text from an MCE envelope or raw legacy string.
 * Media messages return a placeholder "[Media]" or "[Media: <filename>]".
 * Call messages return a formatted call string.
 * Sys messages return a placeholder "[This message was deleted]".
 * Legacy (non-MCE) strings are returned as-is.
 */
export function mceDisplayText(plaintext: string): string {
  const envelope = mceDecode(plaintext);
  if (!envelope) return plaintext; // Legacy pre-MCE text
  if (envelope.t === 'text') return envelope.b;
  if (envelope.t === 'sys') return envelope.d ? 'This message was deleted' : '';
  if (envelope.t === 'media') {
    const mime = envelope.m?.mime_type?.toLowerCase() || '';
    const caption = envelope.m?.caption?.trim();
    if (!mime) {
      return envelope.f ? `[Media: ${envelope.f}]` : '[Media]';
    }
    let prefix = '📎 File';
    let isVoice = false;
    if (mime.startsWith('image/')) {
      prefix = '📷 Photo';
    } else if (mime.startsWith('video/')) {
      prefix = '🎬 Video';
    } else if (mime.startsWith('audio/')) {
      isVoice = Boolean(
        (envelope.f && envelope.f.startsWith('voice-')) ||
        (envelope.m?.file_name && envelope.m.file_name.startsWith('voice-')) ||
        (envelope.m?.waveform && envelope.m.waveform.length > 0)
      );
      prefix = isVoice ? '🎤 Voice message' : '🎵 Audio';
    }
    if (caption) {
      return `${prefix}: ${caption}`;
    }
    if (envelope.f && !isVoice) {
      return `${prefix}: ${envelope.f}`;
    }
    return prefix;
  }
  if (envelope.t === 'call') {
    const icon = envelope.c.callType === 'video' ? '📹' : '📞';
    const typeLabel = envelope.c.callType === 'video' ? 'Video Call' : 'Voice Call';
    if (envelope.c.status === 'completed') {
      const mins = Math.floor(envelope.c.duration / 60);
      const secs = envelope.c.duration % 60;
      const dur = `${mins}:${secs.toString().padStart(2, '0')}`;
      return `${icon} ${typeLabel} (${dur})`;
    }
    const statusCap = envelope.c.status.charAt(0).toUpperCase() + envelope.c.status.slice(1);
    return `${icon} ${statusCap} ${typeLabel}`;
  }
  return '[Media]';
}
