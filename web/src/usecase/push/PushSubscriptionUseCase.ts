/**
 * Push Subscription Use Case.
 * Phase 12B §19.2 (9-step subscription flow, opt-in only, ADR-P12B-34), §22.4, Row W-04.
 *
 * Rules:
 * - Entry point is user-gesture driven (/settings/security), never automatic on load
 * - Capability probe: PSH_C01 if unsupported or push disabled server-side
 * - VAPID key: 65 bytes, starting 0x04; invalid -> PSH_C03
 * - Notification permission: denied -> PSH_C02, never re-prompt automatically
 * - Key lengths: p256dh must be 65 bytes, auth must be 16 bytes; invalid -> PSH_C03
 * - POST /push/subscribe: retry once, then PSH_C03 and subscription.unsubscribe()
 * - Unsubscribe: DELETE /push/subscribe first, then subscription.unsubscribe()
 */

import type { PushRestClient, PushSubscriptionPort, SWLogEvent } from '../../domain/ports/push';
import { base64UrlEncode, base64UrlDecode } from '../../domain/encoding';

export class PushSubscriptionUseCase {
  private readonly client: PushRestClient;
  private readonly port: PushSubscriptionPort;

  constructor(client: PushRestClient, port: PushSubscriptionPort) {
    this.client = client;
    this.port = port;
  }

  /**
   * Check if push is supported by the client browser and enabled on the server.
   * Silently degrades if unsupported or server disabled (ADR-P12B-34).
   */
  async isAvailable(): Promise<boolean> {
    if (!this.port.isSupported()) {
      return false;
    }
    try {
      const key = await this.client.getVapidPublicKey();
      return Boolean(key && key.length > 0);
    } catch {
      return false;
    }
  }

  /**
   * Subscribe to Web Push notifications (9-step flow, ADR-P12B-34).
   */
  async subscribe(): Promise<boolean> {
    // 1. Capability probe (Step 2)
    if (!this.port.isSupported()) {
      throw new Error('PSH_C01: Push notifications are not supported by this browser');
    }

    // 2. Fetch VAPID public key (Step 3)
    let vapidKey: string;
    try {
      vapidKey = await this.client.getVapidPublicKey();
    } catch (err) {
      throw new Error('PSH_C01: Push disabled or unavailable server-side', { cause: err });
    }
    if (!vapidKey) {
      throw new Error('PSH_C01: Push disabled server-side');
    }

    // 3. Validate VAPID key (Step 4, Row W-04)
    const keyBytes = base64UrlDecode(vapidKey);
    if (keyBytes.length !== 65 || keyBytes[0] !== 0x04) {
      throw new Error('PSH_C03: VAPID public key must be exactly 65 bytes starting with 0x04');
    }

    // 4. Permission probe and request (Step 5)
    const perm = await this.port.requestPermission();
    if (perm === 'denied') {
      throw new Error('PSH_C02: Notification permission denied by user');
    }
    if (perm !== 'granted') {
      return false;
    }

    // 5. Browser subscription (Step 5)
    const sub = await this.port.subscribeToPush(vapidKey);

    // 6. Extract and validate browser transport keys (Step 6)
    const p256dhBuffer = sub.getKey('p256dh');
    const authBuffer = sub.getKey('auth');
    if (!p256dhBuffer || !authBuffer) {
      await sub.unsubscribe();
      throw new Error('PSH_C03: Browser subscription missing transport key material');
    }

    const p256dhBytes = new Uint8Array(p256dhBuffer);
    const authBytes = new Uint8Array(authBuffer);

    if (p256dhBytes.length !== 65) {
      await sub.unsubscribe();
      throw new Error('PSH_C03: Invalid p256dh key length (must be 65 bytes)');
    }
    if (authBytes.length !== 16) {
      await sub.unsubscribe();
      throw new Error('PSH_C03: Invalid auth secret length (must be 16 bytes)');
    }

    const p256dhKeyB64 = base64UrlEncode(p256dhBytes);
    const authSecretB64 = base64UrlEncode(authBytes);

    // 7. POST /push/subscribe with 1 retry (Step 7)
    try {
      await this.client.subscribe(sub.endpoint, p256dhKeyB64, authSecretB64);
    } catch {
      // Retry once
      try {
        await this.client.subscribe(sub.endpoint, p256dhKeyB64, authSecretB64);
      } catch (retryErr) {
        // Rollback browser subscription to prevent local/server state divergence
        await sub.unsubscribe();
        throw new Error('PSH_C03: Failed to register subscription with server after retry', { cause: retryErr });
      }
    }

    return true;
  }

  /**
   * Unsubscribe from push notifications (Step 8).
   * Calls DELETE /push/subscribe first, then subscription.unsubscribe().
   */
  async unsubscribe(): Promise<boolean> {
    const sub = await this.port.getCurrentSubscription();
    if (!sub) {
      return true;
    }

    try {
      await this.client.unsubscribe(sub.endpoint);
    } catch {
      // Server error or 404 treated as already deleted
    }

    return await sub.unsubscribe();
  }

  /**
   * Handle pushsubscriptionchange event (Step 9).
   */
  async handleSubscriptionChange(oldEndpoint?: string): Promise<boolean> {
    if (oldEndpoint) {
      try {
        await this.client.unsubscribe(oldEndpoint);
      } catch {
        // ignore
      }
    }
    return this.subscribe();
  }

  isSupported(): boolean {
    return this.port.isSupported();
  }

  getPermission(): NotificationPermission {
    return this.port.getPermission();
  }

  async getCurrentSubscription(): Promise<PushSubscription | null> {
    return this.port.getCurrentSubscription();
  }

  async getVapidPublicKey(): Promise<string> {
    return this.client.getVapidPublicKey();
  }

  async getSWLogs(): Promise<SWLogEvent[]> {
    return this.port.getSWLogs?.() ?? [];
  }
}
