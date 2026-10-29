/**
 * TURN Credential Lifecycle.
 * Phase 12B §12.4 + ADR-P12B-21.
 *
 * Rules:
 * - Fetch immediately before constructing RTCPeerConnection.
 * - Never cache across calls. Hold in RAM only.
 * - Zeroize credentials on teardown.
 * - Never persist or log credentials or username.
 */

import type { TurnCredentials } from '../../../domain/call/types';
import { callsRestClient } from '../rest/calls';

export class TurnManager {
  private currentCredentials: { urls: string[]; username: string; credential: string; ttl: number } | null = null;

  async fetchCredentials(identityHash: string): Promise<TurnCredentials> {
    this.teardown();
    const creds = await callsRestClient.getTurnCredentials(identityHash);
    this.currentCredentials = {
      urls: [...creds.urls],
      username: creds.username,
      credential: creds.credential,
      ttl: creds.ttl,
    };
    return creds;
  }

  teardown(): void {
    if (this.currentCredentials) {
      this.currentCredentials.username = '';
      this.currentCredentials.credential = '';
      this.currentCredentials = null;
    }
  }
}

export const turnManager = new TurnManager();
