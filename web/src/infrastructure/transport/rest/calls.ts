/**
 * Calls REST Client.
 * Phase 12B §11.2 + Task 8.
 *
 * Implements CallRestClient and CallStateProbe.
 * Uses rateBudgets.restGeneral for rate governance.
 */

import type { CallRestClient, CallStateProbe } from '../../../domain/ports/call';
import type { TurnCredentials, PendingCall } from '../../../domain/call/types';
import { apiGet, isApiError } from './client';
import { rateBudgets } from './budget';

export class CallsHttpClient implements CallRestClient, CallStateProbe {
  async getTurnCredentials(identityHash: string): Promise<TurnCredentials> {
    await rateBudgets.restGeneral.acquire();
    try {
      const path = `/api/v1/calls/turn-credentials?identity_hash=${encodeURIComponent(identityHash)}`;
      const res = await apiGet<TurnCredentials>(path);
      return res.data;
    } catch (err) {
      if (isApiError(err)) {
        if (err.status === 429) {
          rateBudgets.restGeneral.empty();
        }
        if (err.status === 400 || err.status === 404) {
          // TURN not configured / disabled on server (e.g. dev mode) — return empty credentials so direct/host WebRTC can establish
          return { urls: [], username: '', credential: '', ttl: 0 };
        }
      }
      throw err;
    }
  }

  async getPendingCall(identityHash?: string): Promise<PendingCall | null> {
    await rateBudgets.restGeneral.acquire();
    try {
      const query = identityHash ? `?identity_hash=${encodeURIComponent(identityHash)}` : '';
      const res = await apiGet<PendingCall>(`/api/v1/calls/pending${query}`);
      if (!res.data || !res.data.call_id) {
        return null;
      }
      return res.data;
    } catch (err) {
      if (isApiError(err)) {
        if (err.status === 404 || err.status === 204) {
          return null;
        }
        if (err.status === 429) {
          rateBudgets.restGeneral.empty();
        }
      }
      return null;
    }
  }

  /**
   * Probe seam for checking if a call is still alive (Flag B / Option B2).
   * Checks pending or active state during the 20s grace period.
   */
  async isCallAlive(callId: string, identityHash: string): Promise<boolean> {
    try {
      const pending = await this.getPendingCall(identityHash);
      if (pending && pending.call_id === callId) {
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }
}

export const callsRestClient = new CallsHttpClient();
