/**
 * Crypto Worker — Exclusive Logical Key Custodian.
 * RFC-0010 §5.1: This Worker is the exclusive logical custodian of all
 * application cryptographic keys.
 *
 * KEY CUSTODY RULES (RFC-0010 §5.1 + RFC-0003 §8.3):
 * 1. Identity Private Key: RAM-only, re-derived on init, NEVER persisted.
 * 2. Vault Key: RAM-only, derived on-demand, NEVER persisted.
 * 3. ECDH Shared Secrets: RAM-only, cached keyed ${receiverSessionIdHex}_${senderSessionIdHex}.
 * 4. Plaintext buffers: NEVER persisted or logged.
 * 5. Service Worker: NEVER receives decrypted plaintext or key material.
 *
 * ONE global outgoing sequence counter per local session, allocated in Worker.
 * IV prefix = fresh 4 random bytes per Worker init, RAM-only.
 */

import type { CryptoWorkerRequest, CryptoWorkerResponse } from '../domain';
import { deriveIdentityKey, deriveVaultKey } from './crypto/argon2';
import { ed25519FromSeed, ed25519Sign, ed25519Verify } from './crypto/ed25519';
import { generateX25519KeyPair, computeSharedSecret } from './crypto/x25519';
import { deriveMessageKey, buildMessageKeyInfo, getHKDFSalt } from './crypto/hkdf';
import { aesGcmEncrypt, aesGcmDecrypt } from './crypto/aes';
import { ReplayWindow } from './crypto/replay';
import { detectCapabilities } from './crypto/capabilities';
import type { CapabilityMap } from './crypto/capabilities';
import {
  hexEncode, hexDecode, base64urlEncode, base64urlDecode,
  base64StdEncode, base64StdDecode,
  utf8Encode, utf8Decode,
  buildAAD, buildIV, buildSessionSigPayload, buildLoginPayload,
  encodeCiphertext, decodeCiphertext, encodeRegistration,
  identityHash, sessionIdentifier, sha256,
  CRYPTO_SUITE_V1,
} from './crypto/encoding';
import {
  deriveCallKeys as deriveCallKeysPrimitive,
  deriveCallIVPrefix,
  buildCallIV,
  buildCallAAD,
  buildFingerprintPayload,
  computeSAS,
  buildChunkAAD,
  buildChunkNonce,
  padThumbnailPlaintext,
  unpadThumbnailPlaintext,
  sealThumbnail as sealThumbnailPrimitive,
  openThumbnail as openThumbnailPrimitive,
} from './crypto/primitives';
import { mceEncodeMedia } from '../domain/protocol/content-envelope';
import type { MediaMetadata } from '../domain/media';
import { CHUNK_PLAINTEXT_SIZE, CHUNK_CIPHERTEXT_SIZE } from '../domain/media/constants';

const ctx = self as unknown as DedicatedWorkerGlobalScope;

// ─── In-memory key state — NEVER persisted ───────────────────
let _identityPrivateKey: Uint8Array | null = null;   // 64-byte Ed25519 combined key
let _identityPublicKey: Uint8Array | null = null;    // 32-byte Ed25519 public key
let _identityHashBytes: Uint8Array | null = null;    // 32-byte SHA256(identityPK)
let _vaultKey: Uint8Array | null = null;             // 32-byte AES-256 key
let _capabilities: CapabilityMap | null = null;

// ECDH shared secret cache: key = "${receiverSessionIdHex}_${senderSessionIdHex}"
const _sharedSecretCache = new Map<string, Uint8Array>();

// Per-receiver replay windows
const _replayWindows = new Map<string, ReplayWindow>();

// ONE global outgoing sequence counter per local session
let _outgoingSequence = 0n;

// IV prefix: fresh 4 random bytes per Worker init, RAM-only
let _ivPrefix: Uint8Array | null = null;

// Session key pair (X25519)
let _sessionPublicKey: Uint8Array | null = null;
let _sessionPrivateKey: Uint8Array | null = null;
let _sessionIdBytes: Uint8Array | null = null; // 8-byte session identifier

interface SessionKeyEntry {
  publicKey: Uint8Array;
  privateKey: Uint8Array;
  sessionId: Uint8Array;
}
const _sessionKeyring = new Map<string, SessionKeyEntry>();

// ─── Phase 12B Call & Media In-memory Key Maps (RAM-only) ────
interface CallKeyState {
  c2c: Uint8Array;
  c2r: Uint8Array;
  sendKey: Uint8Array;
  recvKey: Uint8Array;
  sendIVPrefix: Uint8Array;
  recvIVPrefix: Uint8Array;
  sendSeq: bigint;
  recvWindow: ReplayWindow;
}

interface MediaKeyState {
  key: Uint8Array;
  fileIvPrefix: Uint8Array;
}

const _callKeys = new Map<string, CallKeyState>();
const _mediaKeys = new Map<string, MediaKeyState>();

ctx.onmessage = async (event: MessageEvent<CryptoWorkerRequest>) => {
  const { request_id, action, payload } = event.data;

  try {
    const rawResult = await handleAction(action, payload);
    if (rawResult && typeof rawResult === 'object' && '__transferResult' in (rawResult as Record<string, unknown>)) {
      const { result, transfer } = rawResult as { result: unknown; transfer: Transferable[] };
      respond(request_id, result, transfer);
    } else {
      respond(request_id, rawResult);
    }
  } catch (err) {
    respondError(request_id, err instanceof Error ? err.message : String(err));
  }
};

async function handleAction(action: string, payload: unknown): Promise<unknown> {
  switch (action) {
    case 'init': return handleInit(payload as { username: string; password: string });
    case 'generateSessionKeys': return handleGenerateSessionKeys();
    case 'exportSessionKeys': return handleExportSessionKeys();
    case 'importSessionKeys': return handleImportSessionKeys(payload as { publicKey: string; privateKey: string; sessionId?: string });
    case 'importSessionKeyring': return handleImportSessionKeyring(payload as Array<{ publicKey: string; privateKey: string; sessionId?: string }>);
    case 'signSessionKey': return handleSignSessionKey(payload as { sessionPK: string; expiresAt: number });
    case 'signLoginPayload': return handleSignLoginPayload(payload as { nonce: string; sessionPK: string; challengeId: string });
    case 'buildRegistrationWire': return handleBuildRegistrationWire(payload as { sessionPK: string; expiresAt: number });
    case 'encrypt': return handleEncrypt(payload as { plaintext: string; receiverSessionPK: string; senderHash: string; receiverHash: string; convIdHash: string; clientUuid: string });
    case 'decrypt': return handleDecrypt(payload as { ciphertextHex: string; senderSessionPK: string; senderSessionPKs?: string[]; senderHash: string; receiverHash: string; convIdHash: string; clientUuid: string });
    case 'deriveVaultKey': return handleDeriveVaultKey(payload as { username: string; password: string });
    case 'vaultEncrypt': return handleVaultEncrypt(payload as { plaintext: string });
    case 'vaultDecrypt': return handleVaultDecrypt(payload as { ciphertextHex: string; ivHex: string });
    case 'getIdentityInfo': return handleGetIdentityInfo();
    case 'persistKeys': return handlePersistKeys();
    case 'restoreKeys': return handleRestoreKeys();
    case 'clearKeys': return handleClearKeys();
    case 'getCapabilities': return _capabilities;
    case 'allocateSequence': return handleAllocateSequence();
    case 'setOutgoingSequence': return handleSetOutgoingSequence(payload as { sequence: string });
    case 'destroy': return handleDestroy();
    case 'getState': return handleGetState();

    // ─── Phase 12B Call RPCs ─────────────────────────────────────
    case 'deriveCallKeys': return handleDeriveCallKeys(payload as Parameters<typeof handleDeriveCallKeys>[0]);
    case 'signCallFingerprint': return handleSignCallFingerprint(payload as Parameters<typeof handleSignCallFingerprint>[0]);
    case 'verifyCallFingerprint': return handleVerifyCallFingerprint(payload as Parameters<typeof handleVerifyCallFingerprint>[0]);
    case 'computeSas': return handleComputeSas(payload as Parameters<typeof handleComputeSas>[0]);
    case 'sealCallFrame': return handleSealCallFrame(payload as Parameters<typeof handleSealCallFrame>[0]);
    case 'openCallFrame': return handleOpenCallFrame(payload as Parameters<typeof handleOpenCallFrame>[0]);
    case 'dropCall': return handleDropCall(payload as Parameters<typeof handleDropCall>[0]);

    // ─── Phase 12B Media RPCs ────────────────────────────────────
    case 'createMediaKey': return handleCreateMediaKey();
    case 'importMediaKey': return handleImportMediaKey(payload as Parameters<typeof handleImportMediaKey>[0]);
    case 'sealChunk': return handleSealChunk(payload as Parameters<typeof handleSealChunk>[0]);
    case 'openChunk': return handleOpenChunk(payload as Parameters<typeof handleOpenChunk>[0]);
    case 'sealThumbnail': return handleSealThumbnail(payload as Parameters<typeof handleSealThumbnail>[0]);
    case 'openThumbnail': return handleOpenThumbnail(payload as Parameters<typeof handleOpenThumbnail>[0]);
    case 'exportMediaKeyForPeer': return handleExportMediaKeyForPeer(payload as Parameters<typeof handleExportMediaKeyForPeer>[0]);
    case 'dropMediaKey': return handleDropMediaKey(payload as Parameters<typeof handleDropMediaKey>[0]);
    case 'buildMediaMetadata': return handleBuildMediaMetadata(payload as Parameters<typeof handleBuildMediaMetadata>[0]);
    case 'sha256': return handleSha256(payload as { data: Uint8Array | string | ArrayBuffer });

    default: throw new Error(`Unknown action: ${action}`);
  }
}

async function handleInit(p: { username: string; password: string }): Promise<unknown> {
  // Detect capabilities first (probes all primitives with known-answer tests).
  _capabilities = await detectCapabilities();

  // Assert HKDF salt at init.
  await getHKDFSalt();

  // Derive identity key from credentials.
  const seed = await deriveIdentityKey(p.username, p.password);
  const kp = await ed25519FromSeed(seed);
  _identityPrivateKey = kp.privateKey;
  _identityPublicKey = kp.publicKey;
  _identityHashBytes = await identityHash(kp.publicKey);

  // Generate fresh IV prefix (4 random bytes, RAM-only).
  _ivPrefix = new Uint8Array(4);
  crypto.getRandomValues(_ivPrefix as ArrayBufferView<ArrayBuffer>);

  // Reset sequence counter.
  _outgoingSequence = 0n;

  return {
    status: 'initialized',
    identityHash: hexEncode(_identityHashBytes),
    publicKey: hexEncode(_identityPublicKey),
    capabilities: _capabilities,
  };
}

async function handleGenerateSessionKeys(): Promise<unknown> {
  const kp = await generateX25519KeyPair();
  _sessionPublicKey = kp.publicKey;
  _sessionPrivateKey = kp.privateKey;
  _sessionIdBytes = await sessionIdentifier(kp.publicKey);
  const sessHex = hexEncode(_sessionIdBytes);
  _sessionKeyring.set(sessHex, {
    publicKey: kp.publicKey,
    privateKey: kp.privateKey,
    sessionId: _sessionIdBytes,
  });
  return {
    publicKey: hexEncode(kp.publicKey),
    sessionId: sessHex,
  };
}

function handleExportSessionKeys(): unknown {
  if (!_sessionPublicKey || !_sessionPrivateKey || !_sessionIdBytes) {
    throw new Error('No session keys');
  }
  return {
    publicKey: hexEncode(_sessionPublicKey),
    privateKey: hexEncode(_sessionPrivateKey),
    sessionId: hexEncode(_sessionIdBytes),
  };
}

async function handleImportSessionKeys(p: { publicKey: string; privateKey: string; sessionId?: string }): Promise<unknown> {
  const pk = hexDecode(p.publicKey);
  const sk = hexDecode(p.privateKey);
  const sessId = p.sessionId ? hexDecode(p.sessionId) : await sessionIdentifier(pk);
  _sessionPublicKey = pk;
  _sessionPrivateKey = sk;
  _sessionIdBytes = sessId;
  const sessHex = hexEncode(sessId);
  _sessionKeyring.set(sessHex, {
    publicKey: pk,
    privateKey: sk,
    sessionId: sessId,
  });
  return { ok: true, sessionId: sessHex };
}

async function handleImportSessionKeyring(keys: Array<{ publicKey: string; privateKey: string; sessionId?: string }>): Promise<unknown> {
  if (!Array.isArray(keys)) return { ok: false, count: 0 };
  for (const k of keys) {
    try {
      const pk = hexDecode(k.publicKey);
      const sk = hexDecode(k.privateKey);
      const sessId = k.sessionId ? hexDecode(k.sessionId) : await sessionIdentifier(pk);
      const sessHex = hexEncode(sessId);
      _sessionKeyring.set(sessHex, {
        publicKey: pk,
        privateKey: sk,
        sessionId: sessId,
      });
      if (!_sessionPrivateKey) {
        _sessionPublicKey = pk;
        _sessionPrivateKey = sk;
        _sessionIdBytes = sessId;
      }
    } catch {
      // ignore individual invalid entry
    }
  }
  return { ok: true, count: _sessionKeyring.size };
}

async function handleSignSessionKey(p: { sessionPK: string; expiresAt: number }): Promise<unknown> {
  if (!_identityPrivateKey || !_identityHashBytes) throw new Error('Not initialized');
  const sessionPK = hexDecode(p.sessionPK);
  const payload = buildSessionSigPayload(CRYPTO_SUITE_V1, sessionPK, BigInt(p.expiresAt), _identityHashBytes);
  const sig = await ed25519Sign(payload, _identityPrivateKey);
  return { signature: base64urlEncode(sig), signatureHex: hexEncode(sig) };
}

async function handleSignLoginPayload(p: { nonce: string; sessionPK: string; challengeId: string }): Promise<unknown> {
  if (!_identityPrivateKey) throw new Error('Not initialized');
  const nonce = base64urlDecode(p.nonce);
  const sessionPK = p.sessionPK.length === 64 ? hexDecode(p.sessionPK) : base64urlDecode(p.sessionPK);
  const challengeId = base64urlDecode(p.challengeId);
  const payload = buildLoginPayload(nonce, sessionPK, challengeId);
  const sig = await ed25519Sign(payload, _identityPrivateKey);
  return { signature: base64urlEncode(sig) };
}

async function handleBuildRegistrationWire(p: { sessionPK: string; expiresAt: number }): Promise<unknown> {
  if (!_identityPublicKey || !_identityPrivateKey || !_identityHashBytes) throw new Error('Not initialized');
  const sessionPK = hexDecode(p.sessionPK);
  const expiresAt = BigInt(p.expiresAt);

  // Sign the session key.
  const payload = buildSessionSigPayload(CRYPTO_SUITE_V1, sessionPK, expiresAt, _identityHashBytes);
  const sig = await ed25519Sign(payload, _identityPrivateKey);

  // Build the 137-byte wire format.
  const wire = encodeRegistration(_identityPublicKey, sessionPK, sig, CRYPTO_SUITE_V1, expiresAt);
  return { wireBytes: wire, wireLength: wire.length };
}

async function handleEncrypt(p: {
  plaintext: string;
  receiverSessionPK: string;
  senderHash: string;
  receiverHash: string;
  convIdHash: string;
  clientUuid: string;
}): Promise<unknown> {
  if (!_ivPrefix) {
    _ivPrefix = new Uint8Array(4);
    crypto.getRandomValues(_ivPrefix as ArrayBufferView<ArrayBuffer>);
  }
  if (!_sessionPrivateKey && _sessionKeyring.size > 0) {
    const latest = Array.from(_sessionKeyring.values()).pop();
    if (latest) {
      _sessionPublicKey = latest.publicKey;
      _sessionPrivateKey = latest.privateKey;
      _sessionIdBytes = latest.sessionId;
    }
  }
  if (!_sessionPrivateKey || !_sessionIdBytes || !_ivPrefix) throw new Error('No session keys');

  const receiverPK = p.receiverSessionPK.length === 64 ? hexDecode(p.receiverSessionPK) : base64urlDecode(p.receiverSessionPK);
  const receiverSessId = await sessionIdentifier(receiverPK);

  // Get or compute shared secret (cached in Worker RAM).
  const cacheKey = `${hexEncode(receiverSessId)}_${hexEncode(_sessionIdBytes)}`;
  let sharedSecret = _sharedSecretCache.get(cacheKey);
  if (!sharedSecret) {
    sharedSecret = await computeSharedSecret(_sessionPrivateKey, receiverPK);
    _sharedSecretCache.set(cacheKey, sharedSecret);
  }

  // Allocate sequence number.
  _outgoingSequence += 1n;
  const seqNum = _outgoingSequence;

  // Derive per-message key (NEVER cached).
  const senderHash = p.senderHash.length === 64 ? hexDecode(p.senderHash) : base64urlDecode(p.senderHash);
  const receiverHash = p.receiverHash.length === 64 ? hexDecode(p.receiverHash) : base64urlDecode(p.receiverHash);
  const convIdHash = p.convIdHash.length === 64 ? hexDecode(p.convIdHash) : await sha256(utf8Encode(p.convIdHash));
  const info = buildMessageKeyInfo(senderHash, receiverHash, convIdHash, seqNum);
  const messageKey = await deriveMessageKey(sharedSecret, info);

  // Build IV: [prefix(4)][counter(8 BE)] where counter = sequence number.
  const iv = buildIV(_ivPrefix, seqNum);

  // Build AAD (128 bytes).
  const clientUuid = hexDecode(p.clientUuid.replace(/-/g, ''));
  const aad = buildAAD(seqNum, clientUuid, senderHash, receiverHash, convIdHash, _sessionIdBytes);

  // Encrypt.
  const plaintext = utf8Encode(p.plaintext);
  const sealed = await aesGcmEncrypt(messageKey, iv, plaintext, aad);

  // Build ciphertext wire format.
  const wire = encodeCiphertext(_sessionIdBytes, iv, sealed);

  return {
    ciphertextHex: hexEncode(wire),
    sequence: seqNum.toString(),
    ivHex: hexEncode(iv),
  };
}

async function handleDecrypt(p: {
  ciphertextHex: string;
  senderSessionPK: string;
  senderSessionPKs?: string[];
  senderHash: string;
  receiverHash: string;
  convIdHash: string;
  clientUuid: string;
}): Promise<unknown> {
  if (!_sessionPrivateKey && _sessionKeyring.size > 0) {
    const latest = Array.from(_sessionKeyring.values()).pop();
    if (latest) {
      _sessionPublicKey = latest.publicKey;
      _sessionPrivateKey = latest.privateKey;
      _sessionIdBytes = latest.sessionId;
    }
  }
  if (!_sessionPrivateKey && _sessionKeyring.size === 0) throw new Error('No session keys');

  const wire = hexDecode(p.ciphertextHex);

  // Decode wire format — version check FIRST.
  const { senderSessionId, iv, sealed } = decodeCiphertext(wire);

  // Get sender's sequence from the IV (counter is last 8 bytes).
  const seqBytes = iv.slice(4, 12);
  let seqNum = 0n;
  for (let i = 0; i < 8; i++) {
    seqNum = (seqNum << 8n) | BigInt(seqBytes[i]);
  }

  // Replay check (before decrypt).
  const senderSessHex = hexEncode(senderSessionId);
  let rw = _replayWindows.get(senderSessHex);
  if (!rw) {
    rw = new ReplayWindow();
    _replayWindows.set(senderSessHex, rw);
  }
  if (!rw.check(seqNum)) {
    return { dropped: true, reason: 'replay' };
  }

  // Collect candidate sender public keys
  const allCandidateSenderPKs: string[] = [];
  if (p.senderSessionPK) allCandidateSenderPKs.push(p.senderSessionPK);
  if (p.senderSessionPKs && Array.isArray(p.senderSessionPKs)) {
    for (const spk of p.senderSessionPKs) {
      if (spk && !allCandidateSenderPKs.includes(spk)) {
        allCandidateSenderPKs.push(spk);
      }
    }
  }

  // Rank candidate sender public keys: prioritize exact senderSessionId match
  const senderPKList: Uint8Array[] = [];
  for (const rawPK of allCandidateSenderPKs) {
    try {
      const pkBytes = rawPK.length === 64 ? hexDecode(rawPK) : base64urlDecode(rawPK);
      const sid = await sessionIdentifier(pkBytes);
      if (hexEncode(sid) === senderSessHex) {
        senderPKList.unshift(pkBytes); // matching sender key first
      } else {
        senderPKList.push(pkBytes);
      }
    } catch {
      // ignore malformed candidate
    }
  }
  if (senderPKList.length === 0 && p.senderSessionPK) {
    senderPKList.push(p.senderSessionPK.length === 64 ? hexDecode(p.senderSessionPK) : base64urlDecode(p.senderSessionPK));
  }

  // Derive message key info
  const senderHash = p.senderHash.length === 64 ? hexDecode(p.senderHash) : base64urlDecode(p.senderHash);
  const receiverHash = p.receiverHash.length === 64 ? hexDecode(p.receiverHash) : base64urlDecode(p.receiverHash);
  const convIdHash = p.convIdHash.length === 64 ? hexDecode(p.convIdHash) : await sha256(utf8Encode(p.convIdHash));
  const info = buildMessageKeyInfo(senderHash, receiverHash, convIdHash, seqNum);
  const clientUuid = hexDecode(p.clientUuid.replace(/-/g, ''));
  const aad = buildAAD(seqNum, clientUuid, senderHash, receiverHash, convIdHash, senderSessionId);

  // Collect all available receiver session keys on this device
  const receiverEntries: SessionKeyEntry[] = [];
  if (_sessionPrivateKey && _sessionIdBytes && _sessionPublicKey) {
    receiverEntries.push({
      publicKey: _sessionPublicKey,
      privateKey: _sessionPrivateKey,
      sessionId: _sessionIdBytes,
    });
  }
  for (const [keySessHex, entry] of _sessionKeyring) {
    if (!receiverEntries.some((r) => hexEncode(r.sessionId) === keySessHex)) {
      receiverEntries.push(entry);
    }
  }

  let plaintext: Uint8Array | null = null;

  // Try candidate sender PKs against receiver keys
  outerLoop:
  for (const candidateSenderPK of senderPKList) {
    const candSessId = await sessionIdentifier(candidateSenderPK);
    for (const receiverEntry of receiverEntries) {
      try {
        const cacheKey = `${hexEncode(candSessId)}_${hexEncode(receiverEntry.sessionId)}`;
        let sharedSecret = _sharedSecretCache.get(cacheKey);
        if (!sharedSecret) {
          sharedSecret = await computeSharedSecret(receiverEntry.privateKey, candidateSenderPK);
          _sharedSecretCache.set(cacheKey, sharedSecret);
        }
        const messageKey = await deriveMessageKey(sharedSecret, info);
        plaintext = await aesGcmDecrypt(messageKey, iv, sealed, aad);
        if (plaintext) {
          break outerLoop;
        }
      } catch {
        // Try next combination
      }
    }
  }

  if (!plaintext) {
    return { dropped: true, reason: 'decrypt_failed' };
  }

  // Accept into replay window ONLY after successful decryption.
  rw.accept(seqNum);

  return {
    plaintext: utf8Decode(plaintext),
    sequence: seqNum.toString(),
  };
}

async function handleDeriveVaultKey(p: { username: string; password: string }): Promise<unknown> {
  _vaultKey = await deriveVaultKey(p.username, p.password);
  return { status: 'vault_key_derived' };
}

async function handleVaultEncrypt(p: { plaintext: string }): Promise<unknown> {
  if (!_vaultKey) throw new Error('Vault key not derived');
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const plaintext = utf8Encode(p.plaintext);
  const sealed = await aesGcmEncrypt(_vaultKey, iv, plaintext, new Uint8Array(0));
  return { ciphertextHex: hexEncode(sealed), ivHex: hexEncode(iv) };
}

async function handleVaultDecrypt(p: { ciphertextHex: string; ivHex: string }): Promise<unknown> {
  if (!_vaultKey) throw new Error('Vault key not derived');
  const ct = toBytes(p.ciphertextHex);
  const iv = toBytes(p.ivHex);
  const plaintext = await aesGcmDecrypt(_vaultKey, iv, ct, new Uint8Array(0));
  return { plaintext: utf8Decode(plaintext) };
}

function handleGetIdentityInfo(): unknown {
  if (!_identityPublicKey || !_identityHashBytes) throw new Error('Not initialized');
  return {
    publicKey: hexEncode(_identityPublicKey),
    identityHash: hexEncode(_identityHashBytes),
    normalizedUsername: null, // Not stored for security
  };
}

function handleAllocateSequence(): unknown {
  _outgoingSequence += 1n;
  return { sequence: _outgoingSequence.toString() };
}

function handleSetOutgoingSequence(p: { sequence: string }): unknown {
  if (p && p.sequence) {
    try {
      const s = BigInt(p.sequence);
      if (s > _outgoingSequence) {
        _outgoingSequence = s;
      }
    } catch {
      // Ignore invalid sequence strings
    }
  }
  return { sequence: _outgoingSequence.toString() };
}

function handleDestroy(): unknown {
  // Zeroize all in-memory key material.
  if (_identityPrivateKey) _identityPrivateKey.fill(0);
  if (_identityPublicKey) _identityPublicKey.fill(0);
  if (_identityHashBytes) _identityHashBytes.fill(0);
  if (_vaultKey) _vaultKey.fill(0);
  if (_sessionPrivateKey) _sessionPrivateKey.fill(0);
  if (_sessionPublicKey) _sessionPublicKey.fill(0);
  if (_sessionIdBytes) _sessionIdBytes.fill(0);
  if (_ivPrefix) _ivPrefix.fill(0);
  _identityPrivateKey = null;
  _identityPublicKey = null;
  _identityHashBytes = null;
  _vaultKey = null;
  _sessionPublicKey = null;
  _sessionPrivateKey = null;
  _sessionIdBytes = null;
  _ivPrefix = null;
  _outgoingSequence = 0n;
  for (const [, secret] of _sharedSecretCache) secret.fill(0);
  _sharedSecretCache.clear();
  _replayWindows.clear();

  for (const [, entry] of _sessionKeyring) {
    entry.publicKey.fill(0);
    entry.privateKey.fill(0);
  }
  _sessionKeyring.clear();

  for (const [, call] of _callKeys) {
    call.c2c.fill(0);
    call.c2r.fill(0);
    call.sendKey.fill(0);
    call.recvKey.fill(0);
    call.sendIVPrefix.fill(0);
    call.recvIVPrefix.fill(0);
  }
  _callKeys.clear();

  for (const [, mk] of _mediaKeys) {
    mk.key.fill(0);
    mk.fileIvPrefix.fill(0);
  }
  _mediaKeys.clear();

  void handleClearKeys();
  return { status: 'destroyed' };
}

// ─── Remember Keys / Keyring Persistence (RFC-0003 §8.3) ─────
// V2: Seed-based wrapping key derivation for cross-browser compatibility.
// Mobile browsers (iOS Safari, Chrome Android) may fail to persist CryptoKey
// objects via IndexedDB structured clone. We now store a random 256-bit seed
// as raw Uint8Array bytes (universally supported) and derive the wrapping key
// deterministically via HKDF. The derived key is non-extractable.
const KEYRING_DB_NAME = 'rootinbox_keyring';
const KEYRING_STORE_NAME = 'keyring';
const KEYRING_MAGIC = new Uint8Array([0x52, 0x4B]); // 'RK'
const KEYRING_HKDF_INFO = new TextEncoder().encode('rootinbox-keyring-wrap-v2');

function openKeyringDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      return reject(new Error('IndexedDB not supported in this environment'));
    }
    const req = indexedDB.open(KEYRING_DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(KEYRING_STORE_NAME)) {
        db.createObjectStore(KEYRING_STORE_NAME, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/**
 * Derive a non-extractable AES-GCM-256 wrapping key from a random seed.
 * Uses HKDF with SHA-256, no salt (the seed itself is the secret randomness).
 */
async function deriveWrappingKeyFromSeed(seed: Uint8Array): Promise<CryptoKey> {
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    seed as unknown as BufferSource,
    { name: 'HKDF' },
    false, // non-extractable
    ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(32) as unknown as BufferSource, // fixed zero salt — seed IS the randomness
      info: KEYRING_HKDF_INFO as unknown as BufferSource,
    },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false, // derived key non-extractable (RFC-0003 §8.3 contract)
    ['encrypt', 'decrypt'],
  );
}

async function handlePersistKeys(): Promise<unknown> {
  if (!_identityPrivateKey || !_vaultKey || !_identityPublicKey || !_identityHashBytes) {
    throw new Error('Identity and Vault keys must be initialized before persisting');
  }

  // 1. Generate random 256-bit seed (raw bytes — universally IDB-safe)
  const seed = new Uint8Array(32);
  crypto.getRandomValues(seed as ArrayBufferView<ArrayBuffer>);

  // 2. Derive non-extractable wrapping key from seed via HKDF
  const wrappingKey = await deriveWrappingKeyFromSeed(seed);

  // 3. Prepare payload: 2 bytes magic + 64 bytes identityPrivateKey + 32 bytes vaultKey
  const payload = new Uint8Array(2 + 64 + 32);
  payload.set(KEYRING_MAGIC, 0);
  payload.set(_identityPrivateKey, 2);
  payload.set(_vaultKey, 2 + 64);

  // 4. Encrypt with AES-GCM
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv as ArrayBufferView<ArrayBuffer>);
  const encryptedBuf = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    wrappingKey,
    payload
  );

  // 5. Store in dedicated keyring IndexedDB
  //    - 'wrapping_seed': raw Uint8Array (universally supported by structured clone)
  //    - 'wrapped_material': IV + ciphertext + identity metadata
  const db = await openKeyringDB();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(KEYRING_STORE_NAME, 'readwrite');
      const store = tx.objectStore(KEYRING_STORE_NAME);
      // Remove any legacy CryptoKey record if present
      store.delete('wrapping_key');
      // Store seed as raw bytes (works on all browsers including mobile)
      store.put({ id: 'wrapping_seed', seed: new Uint8Array(seed) });
      store.put({
        id: 'wrapped_material',
        iv: new Uint8Array(iv),
        ciphertext: new Uint8Array(encryptedBuf),
        identityPublicKey: new Uint8Array(_identityPublicKey!),
        identityHash: new Uint8Array(_identityHashBytes!),
      });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(new Error('Transaction aborted'));
    });
  } finally {
    db.close();
  }

  return { status: 'keys_persisted' };
}

/**
 * Shared restore logic: given a wrapping CryptoKey and the material record,
 * decrypt and restore in-memory key state. Returns the restore result.
 */
async function restoreFromWrappingKey(
  wrappingKey: CryptoKey,
  materialRecord: { iv: Uint8Array; ciphertext: Uint8Array; identityPublicKey?: Uint8Array },
): Promise<{ status: string; identityHash?: string; publicKey?: string; capabilities?: CapabilityMap | null }> {
  let decryptedBuf: ArrayBuffer;
  try {
    decryptedBuf = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: materialRecord.iv as ArrayBufferView<ArrayBuffer> },
      wrappingKey,
      materialRecord.ciphertext as ArrayBufferView<ArrayBuffer>
    );
  } catch (err) {
    console.error('[crypto.worker] Unwrapping keys failed:', err);
    return { status: 'corrupted_keys' };
  }

  const decrypted = new Uint8Array(decryptedBuf);
  if (decrypted.length !== 2 + 64 + 32 || decrypted[0] !== 0x52 || decrypted[1] !== 0x4B) {
    return { status: 'corrupted_keys' };
  }

  // Restore keys in RAM
  _identityPrivateKey = new Uint8Array(decrypted.slice(2, 66));
  _vaultKey = new Uint8Array(decrypted.slice(66, 98));

  if (materialRecord.identityPublicKey && materialRecord.identityPublicKey.length === 32) {
    _identityPublicKey = new Uint8Array(materialRecord.identityPublicKey);
  } else {
    _identityPublicKey = new Uint8Array(_identityPrivateKey.slice(32, 64));
  }
  _identityHashBytes = await identityHash(_identityPublicKey);

  // Fresh RAM-only transport state
  _capabilities = await detectCapabilities();
  await getHKDFSalt();
  _ivPrefix = new Uint8Array(4);
  crypto.getRandomValues(_ivPrefix as ArrayBufferView<ArrayBuffer>);
  _outgoingSequence = 0n;

  return {
    status: 'restored',
    identityHash: hexEncode(_identityHashBytes),
    publicKey: hexEncode(_identityPublicKey),
    capabilities: _capabilities,
  };
}

async function handleRestoreKeys(): Promise<unknown> {
  let db: IDBDatabase;
  try {
    db = await openKeyringDB();
  } catch {
    return { status: 'no_keys' };
  }

  let seedRecord: { id: string; seed: Uint8Array } | undefined;
  let legacyWrappingRecord: { id: string; key: CryptoKey } | undefined;
  let materialRecord: {
    id: string;
    iv: Uint8Array;
    ciphertext: Uint8Array;
    identityPublicKey?: Uint8Array;
    identityHash?: Uint8Array;
  } | undefined;

  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(KEYRING_STORE_NAME, 'readonly');
      const store = tx.objectStore(KEYRING_STORE_NAME);
      const reqSeed = store.get('wrapping_seed');
      const reqLegacy = store.get('wrapping_key');
      const reqMat = store.get('wrapped_material');
      tx.oncomplete = () => {
        seedRecord = reqSeed.result;
        legacyWrappingRecord = reqLegacy.result;
        materialRecord = reqMat.result;
        resolve();
      };
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(new Error('Transaction aborted'));
    });
  } finally {
    db.close();
  }

  if (!materialRecord?.ciphertext || !materialRecord?.iv) {
    return { status: 'no_keys' };
  }

  // Strategy 1: Seed-based (V2 format — works on all browsers)
  if (seedRecord?.seed && seedRecord.seed.length === 32) {
    const wrappingKey = await deriveWrappingKeyFromSeed(new Uint8Array(seedRecord.seed));
    return restoreFromWrappingKey(wrappingKey, materialRecord);
  }

  // Strategy 2: Legacy CryptoKey fallback (V1 format — desktop sessions)
  if (legacyWrappingRecord?.key) {
    const result = await restoreFromWrappingKey(legacyWrappingRecord.key, materialRecord);
    if (result.status === 'restored') {
      // Auto-migrate: re-persist using seed-based format for future restores
      try {
        await handlePersistKeys();
      } catch (err) {
        console.warn('[crypto.worker] Auto-migration to seed-based keyring failed:', err);
      }
    }
    return result;
  }

  return { status: 'no_keys' };
}

async function handleClearKeys(): Promise<unknown> {
  if (typeof indexedDB === 'undefined') return { status: 'keys_cleared' };
  try {
    const db = await openKeyringDB();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(KEYRING_STORE_NAME, 'readwrite');
      const store = tx.objectStore(KEYRING_STORE_NAME);
      store.clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch {
    // Best effort
  }

  try {
    indexedDB.deleteDatabase(KEYRING_DB_NAME);
  } catch {
    // Best effort
  }

  return { status: 'keys_cleared' };
}

function handleGetState(): unknown {
  return {
    hasIdentityKey: _identityPrivateKey !== null,
    hasVaultKey: _vaultKey !== null,
    hasSessionKey: _sessionPrivateKey !== null,
    sharedSecretCount: _sharedSecretCache.size,
    replayWindowCount: _replayWindows.size,
    callKeyCount: _callKeys.size,
    mediaKeyCount: _mediaKeys.size,
    outgoingSequence: _outgoingSequence.toString(),
  };
}

// ─── Helpers for Phase 12B Handlers ──────────────────────────
function uuidv4(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const h = hexEncode(bytes);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

function toBytes(v: unknown): Uint8Array {
  if (v instanceof Uint8Array) return v;
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  if (typeof v === 'string') {
    const clean = v.replace(/-/g, '');
    if (/^[0-9a-fA-F]+$/.test(clean) && clean.length % 2 === 0) {
      return hexDecode(clean);
    }
    // Handle standard base64 strings (with or without padding)
    if (/^[A-Za-z0-9+/]+={0,2}$/.test(v) && v.length >= 4) {
      try {
        return base64StdDecode(v);
      } catch {
        // Not valid base64; fall through
      }
    }
    // Handle base64url strings (e.g. 43-char 32-byte keys or base64url payloads)
    if (/^[A-Za-z0-9_-]+$/.test(v) && v.length >= 4) {
      try {
        return base64urlDecode(v);
      } catch {
        // Not valid base64url; fall through
      }
    }
    return utf8Encode(v);
  }
  throw new Error('Expected Uint8Array, ArrayBuffer, or string');
}

// ─── Phase 12B Call RPC Handlers ─────────────────────────────

async function handleDeriveCallKeys(p: {
  call_id_bytes: string | Uint8Array;
  peer_identity_hash: string | Uint8Array;
  peer_session_id?: string | Uint8Array;
  peer_session_pk?: string | Uint8Array;
  role: number;
}): Promise<unknown> {
  if (!_sessionPrivateKey && _sessionKeyring.size > 0) {
    const latest = Array.from(_sessionKeyring.values()).pop();
    if (latest) {
      _sessionPrivateKey = latest.privateKey;
      _sessionPublicKey = latest.publicKey;
      _sessionIdBytes = latest.sessionId;
    }
  }
  if (!_sessionIdBytes && _sessionPublicKey) {
    _sessionIdBytes = await sessionIdentifier(_sessionPublicKey);
  }
  if (!_sessionPrivateKey || !_identityHashBytes) {
    throw new Error('Not initialized or no session keys');
  }
  const callId = toBytes(p.call_id_bytes);
  const peerIdentityHash = toBytes(p.peer_identity_hash);

  let sharedSecret: Uint8Array | undefined;
  if (p.peer_session_pk) {
    const peerPK = toBytes(p.peer_session_pk);
    const peerSessionId = await sessionIdentifier(peerPK);
    const cacheKey1 = hexEncode(_sessionIdBytes!) + '_' + hexEncode(peerSessionId);
    const cacheKey2 = hexEncode(peerSessionId) + '_' + hexEncode(_sessionIdBytes!);
    sharedSecret = _sharedSecretCache.get(cacheKey1) || _sharedSecretCache.get(cacheKey2);
    if (!sharedSecret) {
      sharedSecret = await computeSharedSecret(_sessionPrivateKey, peerPK);
      _sharedSecretCache.set(cacheKey1, sharedSecret);
      _sharedSecretCache.set(cacheKey2, sharedSecret);
    }
  } else if (p.peer_session_id) {
    const peerSessionIdHex = typeof p.peer_session_id === 'string'
      ? p.peer_session_id.toLowerCase()
      : hexEncode(p.peer_session_id);
    for (const [key, secret] of _sharedSecretCache.entries()) {
      if (key.includes(peerSessionIdHex)) {
        sharedSecret = secret;
        break;
      }
    }
    if (!sharedSecret && _sharedSecretCache.size === 1) {
      sharedSecret = _sharedSecretCache.values().next().value;
    }
  } else if (_sharedSecretCache.size === 1) {
    sharedSecret = _sharedSecretCache.values().next().value;
  }

  if (!sharedSecret) {
    throw new Error('Cannot derive call keys: missing peer session key or shared secret');
  }

  const callerHash = p.role === 1 ? _identityHashBytes : peerIdentityHash;
  const calleeHash = p.role === 1 ? peerIdentityHash : _identityHashBytes;

  const [c2c, c2r] = await deriveCallKeysPrimitive(sharedSecret, callId, callerHash, calleeHash);
  const sendKey = p.role === 1 ? c2c : c2r;
  const recvKey = p.role === 1 ? c2r : c2c;
  const sendIVPrefix = await deriveCallIVPrefix(sendKey);
  const recvIVPrefix = await deriveCallIVPrefix(recvKey);

  const callIdHex = hexEncode(callId);
  _callKeys.set(callIdHex, {
    c2c,
    c2r,
    sendKey,
    recvKey,
    sendIVPrefix,
    recvIVPrefix,
    sendSeq: 0n,
    recvWindow: new ReplayWindow(),
  });

  return { ok: true };
}

async function handleSignCallFingerprint(p: {
  call_id_bytes: string | Uint8Array;
  fingerprint_bytes: string | Uint8Array;
  role: number;
}): Promise<unknown> {
  if (!_identityPrivateKey) throw new Error('No identity key');
  const callId = toBytes(p.call_id_bytes);
  const fingerprint = toBytes(p.fingerprint_bytes);
  const payload = buildFingerprintPayload(callId, fingerprint, p.role);
  const sig = await ed25519Sign(payload, _identityPrivateKey);
  return { signature: hexEncode(sig) };
}

async function handleVerifyCallFingerprint(p: {
  call_id_bytes: string | Uint8Array;
  fingerprint_bytes: string | Uint8Array;
  role: number;
  signature: string | Uint8Array;
  peer_identity_public_key: string | Uint8Array;
}): Promise<unknown> {
  const callId = toBytes(p.call_id_bytes);
  const fingerprint = toBytes(p.fingerprint_bytes);
  const sig = toBytes(p.signature);
  const peerPK = toBytes(p.peer_identity_public_key);
  const payload = buildFingerprintPayload(callId, fingerprint, p.role);
  const valid = await ed25519Verify(payload, sig, peerPK);
  return { valid };
}

async function handleComputeSas(p: {
  call_id_bytes: string | Uint8Array;
  caller_fingerprint: string | Uint8Array;
  callee_fingerprint: string | Uint8Array;
}): Promise<unknown> {
  const callId = toBytes(p.call_id_bytes);
  const callerFp = toBytes(p.caller_fingerprint);
  const calleeFp = toBytes(p.callee_fingerprint);
  const sas = await computeSAS(callerFp, calleeFp, callId);
  return { sas, iterations: 1 };
}

async function handleSealCallFrame(p: {
  call_id_bytes: string | Uint8Array;
  frame_type: number;
  payload: string | Uint8Array | object;
}): Promise<unknown> {
  const callId = toBytes(p.call_id_bytes);
  const callIdHex = hexEncode(callId);
  const call = _callKeys.get(callIdHex);
  if (!call) throw new Error('Call session not found in Worker');

  call.sendSeq += 1n;
  const seq = call.sendSeq;
  const iv = buildCallIV(call.sendIVPrefix, seq);
  const aad = buildCallAAD(callId, p.frame_type, seq);

  let ptBytes: Uint8Array;
  if (p.payload instanceof Uint8Array) {
    ptBytes = p.payload;
  } else if (typeof p.payload === 'string') {
    ptBytes = utf8Encode(p.payload);
  } else {
    ptBytes = utf8Encode(JSON.stringify(p.payload));
  }

  const sealed = await aesGcmEncrypt(call.sendKey, iv, ptBytes, aad);
  return {
    signal_seq: Number(seq),
    ciphertext: hexEncode(sealed),
  };
}

async function handleOpenCallFrame(p: {
  call_id_bytes: string | Uint8Array;
  frame_type: number;
  signal_seq: number | string | bigint;
  ciphertext: string | Uint8Array;
}): Promise<unknown> {
  const callId = toBytes(p.call_id_bytes);
  const callIdHex = hexEncode(callId);
  const call = _callKeys.get(callIdHex);
  if (!call) throw new Error('Call session not found in Worker');

  const seq = BigInt(p.signal_seq);
  if (!call.recvWindow.check(seq)) {
    throw new Error('CALL_C04: Replay check failed');
  }

  const iv = buildCallIV(call.recvIVPrefix, seq);
  const aad = buildCallAAD(callId, p.frame_type, seq);
  const ctBytes = toBytes(p.ciphertext);

  let ptBytes: Uint8Array;
  try {
    ptBytes = await aesGcmDecrypt(call.recvKey, iv, ctBytes, aad);
  } catch {
    throw new Error('CRY_003: Frame authentication failed');
  }

  call.recvWindow.accept(seq);
  const text = utf8Decode(ptBytes);
  try {
    return { payload: JSON.parse(text) };
  } catch {
    return { payload: text };
  }
}

function handleDropCall(p: { call_id_bytes: string | Uint8Array }): unknown {
  const callId = toBytes(p.call_id_bytes);
  const callIdHex = hexEncode(callId);
  const call = _callKeys.get(callIdHex);
  if (call) {
    call.c2c.fill(0);
    call.c2r.fill(0);
    call.sendKey.fill(0);
    call.recvKey.fill(0);
    call.sendIVPrefix.fill(0);
    call.recvIVPrefix.fill(0);
    _callKeys.delete(callIdHex);
  }
  return { ok: true };
}

// ─── Phase 12B Media RPC Handlers ────────────────────────────

function handleCreateMediaKey(): unknown {
  const key = crypto.getRandomValues(new Uint8Array(32));
  const fileIvPrefix = crypto.getRandomValues(new Uint8Array(4));
  const media_key_id = uuidv4();
  _mediaKeys.set(media_key_id, { key, fileIvPrefix });
  return { media_key_id };
}

function handleImportMediaKey(p: {
  media_key: string | Uint8Array;
  file_iv_prefix: string | Uint8Array;
}): unknown {
  const key = typeof p.media_key === 'string'
    ? (/^[0-9a-fA-F]+$/.test(p.media_key) && p.media_key.length === 64 ? hexDecode(p.media_key) : base64StdDecode(p.media_key))
    : toBytes(p.media_key);
  const fileIvPrefix = typeof p.file_iv_prefix === 'string'
    ? (/^[0-9a-fA-F]+$/.test(p.file_iv_prefix) && p.file_iv_prefix.length === 8 ? hexDecode(p.file_iv_prefix) : base64StdDecode(p.file_iv_prefix))
    : toBytes(p.file_iv_prefix);
  const media_key_id = uuidv4();
  _mediaKeys.set(media_key_id, { key, fileIvPrefix });
  return { media_key_id };
}

async function handleSealChunk(p: {
  media_key_id: string;
  file_id_bytes: string | Uint8Array;
  chunk_index: number;
  total_chunks: number;
  plaintext: string | Uint8Array | ArrayBuffer;
}): Promise<unknown> {
  const mk = _mediaKeys.get(p.media_key_id);
  if (!mk) throw new Error('Media key not found in Worker');

  const fileId = toBytes(p.file_id_bytes);
  const nonce = buildChunkNonce(mk.fileIvPrefix, Number(p.chunk_index));
  const aad = buildChunkAAD(fileId, Number(p.chunk_index), Number(p.total_chunks));
  const ptBytes = toBytes(p.plaintext);
  if (ptBytes.byteLength < 1 || ptBytes.byteLength > CHUNK_PLAINTEXT_SIZE) {
    throw new Error(`Invalid chunk plaintext size: ${ptBytes.byteLength} (must be 1..${CHUNK_PLAINTEXT_SIZE})`);
  }

  const sealed = await aesGcmEncrypt(mk.key, nonce, ptBytes, aad);
  const hash = await sha256(sealed);

  return {
    __transferResult: true,
    result: {
      ciphertext: sealed,
      ciphertext_sha256: hexEncode(hash),
    },
    transfer: [sealed.buffer],
  };
}

async function handleOpenChunk(p: {
  media_key_id: string;
  file_id_bytes: string | Uint8Array;
  chunk_index: number;
  total_chunks: number;
  ciphertext: string | Uint8Array | ArrayBuffer;
}): Promise<unknown> {
  const mk = _mediaKeys.get(p.media_key_id);
  if (!mk) throw new Error('Media key not found in Worker');

  const fileId = toBytes(p.file_id_bytes);
  const nonce = buildChunkNonce(mk.fileIvPrefix, Number(p.chunk_index));
  const aad = buildChunkAAD(fileId, Number(p.chunk_index), Number(p.total_chunks));
  const ctBytes = toBytes(p.ciphertext);
  if (ctBytes.byteLength < 17 || ctBytes.byteLength > CHUNK_CIPHERTEXT_SIZE) {
    throw new Error(`Invalid chunk ciphertext size: ${ctBytes.byteLength} (must be 17..${CHUNK_CIPHERTEXT_SIZE})`);
  }

  const plaintext = await aesGcmDecrypt(mk.key, nonce, ctBytes, aad);

  return {
    __transferResult: true,
    result: {
      plaintext,
    },
    transfer: [plaintext.buffer],
  };
}

async function handleSealThumbnail(p: {
  media_key_id: string;
  file_id_bytes: string | Uint8Array;
  plaintext_padded?: string | Uint8Array | ArrayBuffer;
  image?: string | Uint8Array | ArrayBuffer;
}): Promise<unknown> {
  const mk = _mediaKeys.get(p.media_key_id);
  if (!mk) throw new Error('Media key not found in Worker');

  const fileId = toBytes(p.file_id_bytes);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  let imageBytes: Uint8Array;
  if (p.image) {
    imageBytes = toBytes(p.image);
  } else if (p.plaintext_padded) {
    imageBytes = unpadThumbnailPlaintext(toBytes(p.plaintext_padded));
  } else {
    imageBytes = new Uint8Array(0);
  }
  const wire = await sealThumbnailPrimitive(mk.key, iv, imageBytes, fileId);
  return { wire };
}

async function handleOpenThumbnail(p: {
  media_key_id: string;
  file_id_bytes: string | Uint8Array;
  wire: string | Uint8Array | ArrayBuffer;
}): Promise<unknown> {
  const mk = _mediaKeys.get(p.media_key_id);
  if (!mk) throw new Error('Media key not found in Worker');

  const fileId = toBytes(p.file_id_bytes);
  const wireBytes = toBytes(p.wire);
  const image = await openThumbnailPrimitive(mk.key, wireBytes, fileId);
  return { plaintext_padded: padThumbnailPlaintext(image), image };
}

function handleExportMediaKeyForPeer(p: { media_key_id: string }): unknown {
  const mk = _mediaKeys.get(p.media_key_id);
  if (!mk) throw new Error('Media key not found in Worker');
  return {
    media_key: base64StdEncode(mk.key),
    file_iv_prefix: base64StdEncode(mk.fileIvPrefix),
  };
}

function handleDropMediaKey(p: { media_key_id: string }): unknown {
  const mk = _mediaKeys.get(p.media_key_id);
  if (mk) {
    mk.key.fill(0);
    mk.fileIvPrefix.fill(0);
    _mediaKeys.delete(p.media_key_id);
  }
  return { ok: true };
}

function handleBuildMediaMetadata(p: {
  media_key_id: string;
  fields: Omit<MediaMetadata, 'media_key' | 'file_iv_prefix'>;
}): unknown {
  const mk = _mediaKeys.get(p.media_key_id);
  if (!mk) throw new Error('Media key not found in Worker');
  const metadata: MediaMetadata = {
    ...p.fields,
    media_key: base64StdEncode(mk.key),
    file_iv_prefix: base64StdEncode(mk.fileIvPrefix),
  };
  const plaintext_mce = mceEncodeMedia(metadata);
  return { plaintext_mce };
}

async function handleSha256(p: { data: Uint8Array | string | ArrayBuffer }): Promise<unknown> {
  const bytes = toBytes(p.data);
  const hash = await sha256(bytes);
  return { hash, hex: hexEncode(hash) };
}

function respond(request_id: string, result: unknown, transfer?: Transferable[]): void {
  const msg: CryptoWorkerResponse = { request_id, result };
  if (transfer && transfer.length > 0) {
    ctx.postMessage(msg, transfer);
  } else {
    ctx.postMessage(msg);
  }
}

function respondError(request_id: string, error: string): void {
  const msg: CryptoWorkerResponse = { request_id, error };
  ctx.postMessage(msg);
}
