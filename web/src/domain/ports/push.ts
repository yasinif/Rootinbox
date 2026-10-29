/**
 * Push Domain Ports.
 * Phase 12B §7.9: Interfaces for push notification subscription.
 */

/** REST client for push endpoints. */
export interface PushRestClient {
  /** GET /api/v1/push/vapid-public-key → returns Base64URL-unpadded 65-byte key. */
  getVapidPublicKey(): Promise<string>;
  /** POST /api/v1/push/subscribe */
  subscribe(endpoint: string, p256dhKey: string, authSecret: string): Promise<void>;
  /** DELETE /api/v1/push/subscribe */
  unsubscribe(endpoint: string): Promise<void>;
}

/** Service Worker ring buffer log entry. */
export interface SWLogEvent {
  id?: number;
  timestamp: number;
  type: string;
  detail?: Record<string, unknown>;
}

/** Browser Push API adapter. */
export interface PushSubscriptionPort {
  /** Check if push notifications are supported and permission is granted. */
  isSupported(): boolean;
  /** Get current notification permission state ('granted', 'denied', or 'default'). */
  getPermission(): NotificationPermission;
  /** Request notification permission. Returns 'granted', 'denied', or 'default'. */
  requestPermission(): Promise<NotificationPermission>;
  /** Subscribe to push notifications using the VAPID key. */
  subscribeToPush(vapidKeyBase64URL: string): Promise<PushSubscription>;
  /** Get the current push subscription, or null. */
  getCurrentSubscription(): Promise<PushSubscription | null>;
  /** Unsubscribe from push notifications. */
  unsubscribeFromPush(): Promise<boolean>;
  /** Read recent Service Worker events from the ring buffer. */
  getSWLogs?(): Promise<SWLogEvent[]>;
}
