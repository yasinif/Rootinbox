/**
 * Browser Push Subscription Adapter.
 * Phase 12B §19.1, §19.2, Row W-04.
 *
 * Implements PushSubscriptionPort using browser PushManager and ServiceWorker APIs.
 */

import type { PushSubscriptionPort, SWLogEvent } from '../../domain/ports/push';
import { base64UrlDecode } from '../../domain/encoding';
import { readSWLogs } from './swLogs';

export class BrowserPushSubscriptionPort implements PushSubscriptionPort {
  /** Check if push notifications are supported by browser environment. */
  isSupported(): boolean {
    return (
      typeof window !== 'undefined' &&
      'serviceWorker' in navigator &&
      'PushManager' in window &&
      'Notification' in window
    );
  }

  /** Get current notification permission state safely. */
  getPermission(): NotificationPermission {
    if (typeof window === 'undefined') {
      return 'default';
    }
    const win = window as unknown as { Notification?: { permission: NotificationPermission } };
    return win.Notification?.permission ?? 'default';
  }

  /** Request notification permission safely without unhandled rejections. */
  async requestPermission(): Promise<NotificationPermission> {
    if (typeof window === 'undefined' || !('Notification' in window)) {
      return 'denied';
    }
    try {
      const notif = (window as unknown as { Notification: { requestPermission: () => Promise<NotificationPermission> } }).Notification;
      return await notif.requestPermission();
    } catch {
      return 'default';
    }
  }

  /**
   * Subscribe to browser push notifications with VAPID applicationServerKey.
   * Row W-04: decoded key must be EXACTLY 65 bytes, starting 0x04.
   * Passed to PushManager as an ArrayBuffer, never a string.
   */
  async subscribeToPush(vapidKeyBase64URL: string): Promise<PushSubscription> {
    if (!this.isSupported()) {
      throw new Error('PSH_C01: PushManager unsupported');
    }

    const keyBytes = base64UrlDecode(vapidKeyBase64URL);
    if (keyBytes.length !== 65 || keyBytes[0] !== 0x04) {
      throw new Error('PSH_C03: Invalid VAPID key (must be 65 bytes starting with 0x04)');
    }

    const reg = await navigator.serviceWorker.ready;
    if (!reg || !reg.pushManager) {
      throw new Error('PSH_C01: ServiceWorker registration or pushManager unavailable');
    }

    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: keyBytes as unknown as BufferSource,
    });

    return sub;
  }

  /** Get active push subscription if one exists. */
  async getCurrentSubscription(): Promise<PushSubscription | null> {
    if (!this.isSupported()) {
      return null;
    }
    try {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeoutPromise = new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), 2000);
      });
      const readyPromise = (async () => {
        try {
          const reg = await navigator.serviceWorker.ready;
          if (!reg || !reg.pushManager) return null;
          return await reg.pushManager.getSubscription();
        } catch {
          return null;
        }
      })();

      const sub = await Promise.race([readyPromise, timeoutPromise]).finally(() => {
        if (timer) clearTimeout(timer);
      });
      return sub;
    } catch {
      return null;
    }
  }

  /** Unsubscribe current subscription. */
  async unsubscribeFromPush(): Promise<boolean> {
    const sub = await this.getCurrentSubscription();
    if (sub) {
      return sub.unsubscribe();
    }
    return false;
  }

  /** Read recent Service Worker events from the client ring buffer. */
  async getSWLogs(): Promise<SWLogEvent[]> {
    return readSWLogs();
  }
}
