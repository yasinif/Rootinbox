import { describe, it, expect } from 'vitest';
import { parseSdpFingerprint, buildFingerprintPayload } from '../../src/workers/crypto/primitives/call-fingerprint';
import { computeSAS } from '../../src/workers/crypto/primitives/call-sas';
import { MockRTCPeerConnection } from '../../src/__mocks__/webrtc';
import { ed25519FromSeed, ed25519Sign, ed25519Verify } from '../../src/workers/crypto/ed25519';
import { hexDecode } from '../../src/workers/crypto/encoding';

describe('Call E2E Integration Test (§23.3)', () => {
  it('two in-process peers complete offer -> answer -> identical SAS -> fingerprint gate -> end', async () => {
    // Generate Ed25519 keypair for Alice (caller) and Bob (callee)
    const aliceSeed = new Uint8Array(32).fill(1);
    const bobSeed = new Uint8Array(32).fill(2);
    const aliceKp = await ed25519FromSeed(aliceSeed);
    const bobKp = await ed25519FromSeed(bobSeed);

    const callId = '112233445566778899aabbccddeeff00';
    const callIdBytes = hexDecode(callId);

    // 1. Peer A (Alice) PeerConnection
    const pcA = new MockRTCPeerConnection();
    const pcB = new MockRTCPeerConnection();

    // Alice creates offer
    const offerInit = await pcA.createOffer();
    await pcA.setLocalDescription(offerInit);
    const offerSdp = pcA.localDescription!.sdp;

    // Alice extracts and signs DTLS fingerprint (role 0x01 = caller)
    const aliceFp = parseSdpFingerprint(offerSdp)!;
    expect(aliceFp).not.toBeNull();
    const alicePayload = buildFingerprintPayload(callIdBytes, aliceFp, 0x01);
    const aliceSig = await ed25519Sign(alicePayload, aliceKp.privateKey);

    // 2. Peer B receives offer + sig.
    // Callee MUST verify fingerprint BEFORE setRemoteDescription (§14.3)
    expect(pcB.setRemoteDescriptionCallCount).toBe(0);
    const bobVerifiedAlice = await ed25519Verify(alicePayload, aliceSig, aliceKp.publicKey);
    expect(bobVerifiedAlice).toBe(true);

    // After verification succeeds, call setRemoteDescription
    await pcB.setRemoteDescription({ type: 'offer', sdp: offerSdp });
    expect(pcB.setRemoteDescriptionCallCount).toBe(1);

    // Callee creates answer
    const answerInit = await pcB.createAnswer();
    await pcB.setLocalDescription(answerInit);
    const answerSdp = pcB.localDescription!.sdp;

    // Bob extracts and signs DTLS fingerprint (role 0x02 = callee)
    const bobFp = parseSdpFingerprint(answerSdp)!;
    expect(bobFp).not.toBeNull();
    const bobPayload = buildFingerprintPayload(callIdBytes, bobFp, 0x02);
    const bobSig = await ed25519Sign(bobPayload, bobKp.privateKey);

    // Callee computes SAS
    const bobSas = await computeSAS(aliceFp, bobFp, callIdBytes);

    // 3. Peer A receives answer + sig.
    // Caller MUST verify fingerprint BEFORE setRemoteDescription (§14.3)
    expect(pcA.setRemoteDescriptionCallCount).toBe(0);
    const aliceVerifiedBob = await ed25519Verify(bobPayload, bobSig, bobKp.publicKey);
    expect(aliceVerifiedBob).toBe(true);

    await pcA.setRemoteDescription({ type: 'answer', sdp: answerSdp });
    expect(pcA.setRemoteDescriptionCallCount).toBe(1);

    // Caller computes SAS (caller's fingerprint always first per §14.4)
    const aliceSas = await computeSAS(aliceFp, bobFp, callIdBytes);

    // 4. Assert identical SAS on both sides
    expect(aliceSas).toBeDefined();
    expect(bobSas).toBeDefined();
    expect(aliceSas).toHaveLength(6);
    expect(bobSas).toHaveLength(6);
    expect(aliceSas).toBe(bobSas);

    // 5. Termination
    pcA.connectionState = 'closed';
    pcB.connectionState = 'closed';
    expect(pcA.connectionState).toBe('closed');
    expect(pcB.connectionState).toBe('closed');
  });
});
