/**
 * WebSocket client with ticket auth, reconnect backoff, and keep-alive.
 *
 * RULES:
 * - Auth frame FIRST on open; no auth.ok — first inbound frame or 5s-without-close = AUTHENTICATED
 * - Fresh ticket every reconnect (after the delay)
 * - Backoff: [1s, 2s, 4s, 8s, 15s, 30s] ±20% jitter, reset after 30s stable
 * - 60s inactivity watchdog
 * - Frame ceiling 7,000,000 bytes asserted before send
 * - Serialize ALL inbound processing through one async chain
 *
 * routing_id = base64url-UNPADDED of UTF8(receiver user_id UUID string)
 * payload = base64-STANDARD-padded
 */

const BACKOFF_SCHEDULE = [1000, 2000, 4000, 8000, 15000, 30000];
const JITTER_FACTOR = 0.2;
const INACTIVITY_TIMEOUT_MS = 60_000;
const AUTH_TIMEOUT_MS = 5_000;
const MAX_FRAME_SIZE = 7_000_000;
const STABLE_RESET_MS = 30_000;

export type WSState = 'disconnected' | 'connecting' | 'authenticating' | 'connected' | 'reconnecting';

export interface WSMessage {
  type: string;
  [key: string]: unknown;
}

export interface WSClientOptions {
  getTicket: () => Promise<string>;
  onMessage: (msg: WSMessage) => Promise<void>;
  onStateChange: (state: WSState) => void;
  onSessionInvalidated: () => void;
}

export class WSClient {
  private ws: WebSocket | null = null;
  private state: WSState = 'disconnected';
  private retryIndex = 0;
  private inactivityTimer: ReturnType<typeof setTimeout> | null = null;
  private authTimer: ReturnType<typeof setTimeout> | null = null;
  private stableTimer: ReturnType<typeof setTimeout> | null = null;
  private processingChain: Promise<void> = Promise.resolve();
  private destroyed = false;
  private options: WSClientOptions;

  constructor(options: WSClientOptions) {
    this.options = options;
  }

  async connect(): Promise<void> {
    if (this.destroyed) return;
    this.setState('connecting');

    try {
      const ticket = await this.options.getTicket();
      const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const url = `${protocol}//${location.host}/api/v1/ws`;

      this.ws = new WebSocket(url);
      this.ws.onopen = () => this.handleOpen(ticket);
      this.ws.onmessage = (ev: MessageEvent) => this.enqueueInbound(ev);
      this.ws.onclose = (ev: CloseEvent) => this.handleClose(ev);
      this.ws.onerror = () => { /* onclose will fire */ };
    } catch {
      this.scheduleReconnect();
    }
  }

  private handleOpen(ticket: string): void {
    if (!this.ws) return;
    this.setState('authenticating');

    // Auth frame FIRST on open.
    this.ws.send(JSON.stringify({ type: 'auth', ticket }));

    // No auth.ok — first inbound frame or 5s-without-close = AUTHENTICATED.
    this.authTimer = setTimeout(() => {
      if (this.state === 'authenticating') {
        this.setState('connected');
        this.resetInactivityWatchdog();
        this.startStableTimer();
      }
    }, AUTH_TIMEOUT_MS);
  }

  private enqueueInbound(ev: MessageEvent): void {
    // Serialize ALL inbound processing through one async chain.
    this.processingChain = this.processingChain.then(async () => {
      try {
        // First inbound frame = authenticated.
        if (this.state === 'authenticating') {
          if (this.authTimer) { clearTimeout(this.authTimer); this.authTimer = null; }
          this.setState('connected');
          this.startStableTimer();
        }

        this.resetInactivityWatchdog();

        if (typeof ev.data === 'string') {
          const msg = JSON.parse(ev.data) as WSMessage;
          await this.options.onMessage(msg);
        }
      } catch (err) {
        console.error('[WSClient] Error processing inbound frame:', err);
      }
    });
  }

  private handleClose(ev: CloseEvent): void {
    this.cleanup();

    if (ev.code === 4001) {
      // Server rejected auth — session invalid.
      this.options.onSessionInvalidated();
      this.setState('disconnected');
      return;
    }

    if (!this.destroyed) {
      this.scheduleReconnect();
    }
  }

  send(msg: WSMessage): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket not connected');
    }
    const data = JSON.stringify(msg);
    if (data.length > MAX_FRAME_SIZE) {
      throw new Error(`Frame exceeds max size: ${data.length} > ${MAX_FRAME_SIZE}`);
    }
    this.ws.send(data);
  }

  reconnectNow(): void {
    if (this.destroyed) return;
    if (this.state === 'connected' || this.state === 'connecting' || this.state === 'authenticating') return;
    this.retryIndex = 0;
    void this.connect();
  }

  private scheduleReconnect(): void {
    if (this.destroyed) return;
    this.setState('reconnecting');

    const base = BACKOFF_SCHEDULE[Math.min(this.retryIndex, BACKOFF_SCHEDULE.length - 1)];
    const jitter = base * JITTER_FACTOR * (Math.random() * 2 - 1);
    const delay = Math.round(base + jitter);
    this.retryIndex++;

    setTimeout(() => {
      if (!this.destroyed) {
        this.connect();
      }
    }, delay);
  }

  private startStableTimer(): void {
    if (this.stableTimer) clearTimeout(this.stableTimer);
    this.stableTimer = setTimeout(() => {
      // Reset after 30s stable connection.
      this.retryIndex = 0;
    }, STABLE_RESET_MS);
  }

  private resetInactivityWatchdog(): void {
    if (this.inactivityTimer) clearTimeout(this.inactivityTimer);
    this.inactivityTimer = setTimeout(() => {
      // 60s inactivity → close and reconnect.
      console.warn('[WSClient] Inactivity timeout, reconnecting');
      this.ws?.close(4000, 'inactivity');
    }, INACTIVITY_TIMEOUT_MS);
  }

  private cleanup(): void {
    if (this.inactivityTimer) { clearTimeout(this.inactivityTimer); this.inactivityTimer = null; }
    if (this.authTimer) { clearTimeout(this.authTimer); this.authTimer = null; }
    if (this.stableTimer) { clearTimeout(this.stableTimer); this.stableTimer = null; }
    this.ws = null;
  }

  private setState(newState: WSState): void {
    this.state = newState;
    this.options.onStateChange(newState);
  }

  getState(): WSState { return this.state; }

  destroy(): void {
    this.destroyed = true;
    const socket = this.ws;
    this.cleanup();
    if (socket) {
      socket.onopen = null;
      socket.onmessage = null;
      socket.onclose = null;
      socket.onerror = null;
      try {
        socket.close(1000, 'client destroyed');
      } catch {
        // ignore
      }
    }
    this.setState('disconnected');
  }
}
