/**
 * Push REST Client.
 * Phase 12B §11.4 + Task 8.
 *
 * Implements PushRestClient.
 * Follows V-9 field names (p256dh_key, auth_secret) and endpoint query parameter.
 */

import type { PushRestClient } from '../../../domain/ports/push';
import { apiGet, apiPost, apiDelete, isApiError } from './client';
import { rateBudgets } from './budget';

export class PushHttpClient implements PushRestClient {
  /**
   * GET /api/v1/push/vapid-public-key
   * Returns Base64URL-unpadded 65-byte public key.
   * If push is disabled (404), throws PUSH_001 or returns empty.
   */
  async getVapidPublicKey(): Promise<string> {
    await rateBudgets.restGeneral.acquire();
    try {
      const res = await apiGet<{ public_key: string }>('/api/v1/push/vapid-public-key');
      return res.data.public_key;
    } catch (err) {
      if (isApiError(err)) {
        if (err.status === 404) {
          return '';
        }
        if (err.status === 429) {
          rateBudgets.restGeneral.empty();
        }
      }
      throw err;
    }
  }

  /**
   * POST /api/v1/push/subscribe
   * Uses p256dh_key and auth_secret fields per verification item V-9.
   */
  async subscribe(endpoint: string, p256dhKey: string, authSecret: string): Promise<void> {
    await rateBudgets.pushSubscribe.acquire();
    try {
      await apiPost('/api/v1/push/subscribe', {
        endpoint,
        p256dh_key: p256dhKey,
        auth_secret: authSecret,
      });
    } catch (err) {
      if (isApiError(err) && err.status === 429) {
        rateBudgets.pushSubscribe.empty();
      }
      throw err;
    }
  }

  /**
   * DELETE /api/v1/push/subscribe?endpoint=...
   * Uses endpoint query param per verification item V-9.
   */
  async unsubscribe(endpoint: string): Promise<void> {
    await rateBudgets.pushSubscribe.acquire();
    try {
      const path = `/api/v1/push/subscribe?endpoint=${encodeURIComponent(endpoint)}`;
      await apiDelete(path);
    } catch (err) {
      if (isApiError(err) && err.status === 429) {
        rateBudgets.pushSubscribe.empty();
      }
      throw err;
    }
  }
}

export const pushRestClient = new PushHttpClient();
