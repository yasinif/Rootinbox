/**
 * Conformance Tests — W-05, W-06, W-07 (ICE & TURN Configuration).
 */

import { describe, it, expect } from 'vitest';
import {
  normalizeTurnResponse,
  buildRtcConfiguration,
  extractHostFromIceUrl,
} from '../../src/infrastructure/transport/webrtc/ice-config';
import type { TurnCredentials } from '../../src/domain/call/types';
import { base64urlEncode, base64urlDecode } from '../../src/workers/crypto/encoding';

describe('W-05: ZERO external ICE servers', () => {
  const originHost = 'chat.internal.net';

  it('accepts servers matching deployment origin host', () => {
    const raw: TurnCredentials = {
      urls: [
        `turn:${originHost}:3478?transport=udp`,
        `turn:${originHost}:3478?transport=tcp`,
      ],
      username: '1700000000:YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXoxMjM0NTY',
      credential: 'secretcredential123',
      ttl: 86400,
    };

    const servers = normalizeTurnResponse(raw, originHost);
    expect(servers.length).toBe(1);
    expect(servers[0].urls).toEqual(raw.urls);
    expect(servers[0].username).toBe(raw.username);
    expect(servers[0].credential).toBe(raw.credential);
  });

  it('rejects forbidden public STUN providers (google, twilio, etc.) with CALL_C08', () => {
    const forbidden = [
      'stun:stun.l.google.com:19302',
      'turn:global.turn.twilio.com:3478',
      'turn:turn.xirsys.com:3478',
      'stun:stun.cloudflare.com:3478',
    ];

    for (const url of forbidden) {
      const raw: TurnCredentials = {
        urls: [url],
        username: 'user',
        credential: 'pwd',
        ttl: 86400,
      };
      expect(() => normalizeTurnResponse(raw, originHost)).toThrowError(/CALL_C08/);
    }
  });

  it('rejects servers whose host does not match origin host with CALL_C08', () => {
    const raw: TurnCredentials = {
      urls: ['turn:otherhost.com:3478'],
      username: 'user',
      credential: 'pwd',
      ttl: 86400,
    };
    expect(() => normalizeTurnResponse(raw, originHost)).toThrowError(/CALL_C08/);
  });
});

describe('W-06: RTCConfiguration field values', () => {
  it('builds exact RFC-0008 configuration', () => {
    const servers = [
      {
        urls: ['turn:chat.internal.net:3478'],
        username: 'user',
        credential: 'pwd',
      },
    ];

    const config = buildRtcConfiguration(servers);
    expect(config.iceServers).toEqual(servers);
    expect(config.iceTransportPolicy).toBe('all');
    expect(config.bundlePolicy).toBe('max-bundle');
    expect(config.rtcpMuxPolicy).toBe('require');
    expect(config.iceCandidatePoolSize).toBe(0);
  });
});

describe('W-07: TURN credential shape', () => {
  it('validates username regex pattern and 32-byte identity hash', () => {
    // 32-byte identity hash encoded as unpadded base64url = 43 chars
    const rawHash = new Uint8Array(32);
    for (let i = 0; i < 32; i++) rawHash[i] = (i * 7) & 0xff;
    const b64urlHash = base64urlEncode(rawHash);

    const username = `1773322110:${b64urlHash}`;
    const usernameRegex = /^\d+:[A-Za-z0-9_-]+$/;
    expect(username).toMatch(usernameRegex);

    const parts = username.split(':');
    expect(parts.length).toBe(2);
    const decodedHash = base64urlDecode(parts[1]);
    expect(decodedHash.length).toBe(32);
    expect(Array.from(decodedHash)).toEqual(Array.from(rawHash));
  });
});
