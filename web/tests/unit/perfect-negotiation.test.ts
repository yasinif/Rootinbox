import { describe, it, expect } from 'vitest';
import { MockRTCPeerConnection } from '../../src/__mocks__/webrtc';

describe('Perfect Negotiation State Transitions (§14.2, §23.2)', () => {
  it('polite peer rolls back local description upon collision offer', async () => {
    const pc = new MockRTCPeerConnection();
    let polite = true;
    let makingOffer = false;
    let ignoreOffer = false;

    // Simulate polite peer making offer
    makingOffer = true;
    await pc.setLocalDescription();
    expect(pc.signalingState).toBe('have-local-offer');
    makingOffer = false;

    // Inbound remote offer arrives during collision
    const offerCollision = (makingOffer || pc.signalingState !== 'stable');
    expect(offerCollision).toBe(true);

    if (offerCollision) {
      if (!polite) {
        ignoreOffer = true;
      } else {
        // Polite peer rolls back local description (§14.2)
        await pc.setLocalDescription({ type: 'rollback' });
        expect(pc.signalingState).toBe('stable');
        expect(pc.localDescription).toBeNull();

        // Now safe to accept remote offer
        await pc.setRemoteDescription({
          type: 'offer',
          sdp: 'v=0\r\na=fingerprint:sha-256 ...\r\n',
        });
        expect(pc.signalingState).toBe('have-remote-offer');
      }
    }

    expect(ignoreOffer).toBe(false);
  });

  it('impolite peer ignores colliding inbound offer without rolling back', async () => {
    const pc = new MockRTCPeerConnection();
    let polite = false;
    let makingOffer = false;
    let ignoreOffer = false;

    // Impolite peer has local offer
    makingOffer = true;
    await pc.setLocalDescription();
    expect(pc.signalingState).toBe('have-local-offer');
    makingOffer = false;

    const offerCollision = (makingOffer || pc.signalingState !== 'stable');
    expect(offerCollision).toBe(true);

    if (offerCollision) {
      if (!polite) {
        ignoreOffer = true; // Drop and ignore
      }
    }

    expect(ignoreOffer).toBe(true);
    // Local description and signaling state preserved
    expect(pc.signalingState).toBe('have-local-offer');
    expect(pc.localDescription).not.toBeNull();
  });
});
