/**
 * ICE Configuration & TURN URL Normalization.
 * Phase 12B §12.2, §12.3 (Task 9).
 *
 * Rules:
 * - Validate every returned URL's host matches the deployment origin host.
 * - Assert no URL matches a known public STUN provider (Google, etc.).
 * - Violation throws CALL_C08 ("Cannot reach the call relay" / forbidden external host).
 * - Exact RTCConfiguration:
 *   { iceServers, iceTransportPolicy: 'all', bundlePolicy: 'max-bundle', rtcpMuxPolicy: 'require', iceCandidatePoolSize: 0 }
 * - No 'stun:' or 'turn:' literals in business logic.
 */

import type { TurnCredentials } from '../../../domain/call/types';
import { CALL_C08 } from '../../../domain/errors';

const FORBIDDEN_HOST_PATTERNS = [
  'google.com',
  'stun.l.google.com',
  'twilio.com',
  'xirsys.com',
  'cloudflare.com',
  'mozilla.com',
];

/**
 * Extract hostname from a STUN/TURN URL.
 * e.g., "turn:example.com:3478?transport=udp" -> "example.com"
 */
export function extractHostFromIceUrl(url: string): string {
  const withoutScheme = url.replace(/^[a-z]+:/i, '');
  const withoutUser = withoutScheme.replace(/^[^@]+@/, '');
  const withoutQuery = withoutUser.split('?')[0];
  if (withoutQuery.startsWith('[')) {
    const closeBracket = withoutQuery.indexOf(']');
    if (closeBracket !== -1) {
      return withoutQuery.slice(1, closeBracket).toLowerCase();
    }
  }
  const hostPart = withoutQuery.split(':')[0];
  return hostPart.toLowerCase();
}

/**
 * Normalize the raw TurnCredentials from the server into RTCIceServer[].
 * Validates origin host compliance and forbids public STUN/TURN servers.
 */
export function normalizeTurnResponse(
  raw: TurnCredentials,
  originHost?: string,
): RTCIceServer[] {
  if (!raw || !raw.urls || raw.urls.length === 0) {
    return [];
  }
  const allowedHost = (originHost || (typeof window !== 'undefined' && window.location ? window.location.hostname : 'localhost')).toLowerCase();

  for (const url of raw.urls) {
    const host = extractHostFromIceUrl(url);

    // 1. Check forbidden public hosts
    for (const pattern of FORBIDDEN_HOST_PATTERNS) {
      if (host === pattern || host.endsWith('.' + pattern)) {
        throw new Error(`${CALL_C08}: Forbidden external STUN/TURN server detected: ${host}`);
      }
    }

    // 2. Check deployment origin host (Flag C / Option C1)
    if (allowedHost && host !== allowedHost && host !== 'localhost' && host !== '127.0.0.1') {
      throw new Error(`${CALL_C08}: TURN host ${host} does not match deployment origin ${allowedHost}`);
    }
  }

  // Preserve all returned URLs. Attach username and credential for TURN servers.
  return [
    {
      urls: raw.urls,
      username: raw.username,
      credential: raw.credential,
    },
  ];
}

/**
 * Build the exact RFC-0008 / Task 9 RTCConfiguration.
 * iceCandidatePoolSize is strictly 0 to prevent candidate gathering before user consent.
 */
export function buildRtcConfiguration(servers: RTCIceServer[]): RTCConfiguration {
  let iceTransportPolicy: RTCIceTransportPolicy = 'all';
  if (import.meta.env.VITE_E2E === 'true' && typeof window !== 'undefined') {
    if ((window as unknown as Record<string, unknown>).__forceRelayOnly === true) {
      iceTransportPolicy = 'relay';
    }
  }
  return {
    iceServers: servers,
    iceTransportPolicy,
    bundlePolicy: 'max-bundle',
    rtcpMuxPolicy: 'require',
    iceCandidatePoolSize: 0,
  };
}
