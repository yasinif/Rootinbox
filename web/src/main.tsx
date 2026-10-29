/**
 * Application entry point — Composition Root.
 * RFC-0010 §15: React 18+, TypeScript strict mode.
 *
 * This is where infrastructure implementations are wired to domain ports
 * and injected into use cases via context providers.
 *
 * Presentation NEVER imports infrastructure (boundary lint = failure).
 * Use cases import domain ports only — concrete implementations injected here.
 */

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './presentation/theme.css';
import { AppContext, PasscodeProvider } from './presentation/context';
import { App } from './presentation/components/App';
import {
  createCryptoPort, createAuthPort, createMessagePort,
  createOutboxPort, createConversationPort, createDirectoryPort,
  createMetadataPort, createUserPort, createContactPort, createUnreadPort,
  createVaultArchivePort,
  WSClient, setSessionInvalidatedCallback, setAuthToken,
} from './infrastructure/adapters';
import { AuthUseCase } from './usecase/auth';
import { ChatUseCase } from './usecase/chat';
import { SyncUseCase } from './usecase/sync';
import type { UserProfile } from './domain';

import {
  CallSessionMachine,
  PlaceCallUseCase,
  AnswerCallUseCase,
  EndCallUseCase,
  ReceiveCallSignalUseCase,
  PendingCallUseCase,
} from './usecase/call';
import {
  UploadMediaUseCase,
  DownloadMediaUseCase,
  SendMediaMessageUseCase,
} from './usecase/media';
import { MediaHttpClient } from './infrastructure/transport/rest/media';
import { DexieMediaRepository, DexieMediaChunkCache } from './infrastructure/persistence/media-store';
import { mediaDownloadStore } from './infrastructure/persistence/media-download-store';
import { WebRtcCallSessionFactory } from './infrastructure/transport/webrtc/call-session';
import { CallsHttpClient } from './infrastructure/transport/rest/calls';
import { CryptoWorkerBridge } from './infrastructure/crypto/bridge';
import { PushSubscriptionUseCase } from './usecase/push/PushSubscriptionUseCase';
import { PushHttpClient } from './infrastructure/transport/rest/push';
import { BrowserPushSubscriptionPort } from './infrastructure/push/subscription';
import { encodeRoutingId, hexToBase64StdPadded, generateUUID, base64UrlEncode } from './domain/encoding';
import { getDB } from './infrastructure/persistence';
import type { CallSignalTransport } from './domain/ports/call';
import { shouldNotifyInbound } from './presentation/utils/inboundNotification';

// Clean up any stale outbox items or corrupted binary messages from IndexedDB
async function cleanupCorruptedStorage(): Promise<void> {
  try {
    const db = getDB();
    await db.outbox.clear();
    const allMsgs = await db.messages.toArray();
    const corruptedIds: string[] = [];
    for (const msg of allMsgs) {
      // eslint-disable-next-line no-control-regex
      if (msg.plaintext && (msg.plaintext.includes('\uFFFD') || /[\x00-\x08\x0E-\x1F]/.test(msg.plaintext))) {
        corruptedIds.push(msg.id);
      }
    }
    if (corruptedIds.length > 0) {
      await db.messages.bulkDelete(corruptedIds);
    }
  } catch (err) {
    console.warn('[Startup] Cleanup corrupted storage error:', err);
  }
}
void cleanupCorruptedStorage();

// ─── Create Port Implementations ────────────────────────────
// Single Exclusive Logical Key Custodian instance (RFC-0010 §5.1)
const bridge = new CryptoWorkerBridge();
const cryptoPort = createCryptoPort(bridge);
const authPort = createAuthPort();
const messagePort = createMessagePort();
const outboxPort = createOutboxPort();
const conversationPort = createConversationPort();
const directoryPort = createDirectoryPort();
const metadataPort = createMetadataPort();
const userPort = createUserPort();
const contactPort = createContactPort();
const unreadPort = createUnreadPort();

// Call infrastructure
const callsHttpClient = new CallsHttpClient();

const callTransport: CallSignalTransport = {
  sendSignal: (callId, frameType, payload, seq, routingId) => {
    const activeState = callMachine.getState();
    const targetUserId = activeState.callId === callId ? activeState.peerId : '';
    const computedRoutingId = routingId || (targetUserId ? encodeRoutingId(targetUserId) : undefined);
    // Wire protocol requires base64-STANDARD-WITH-PADDING per RFC-0005 §5.1 / RFC-0008 §6
    let wirePayload = payload;
    if (typeof payload === 'string' && /^[0-9a-fA-F]+$/.test(payload) && payload.length % 2 === 0) {
      wirePayload = hexToBase64StdPadded(payload);
    }
    wsClient?.send({
      v: 1,
      type: frameType,
      request_id: generateUUID(),
      call_id: callId,
      routing_id: computedRoutingId,
      signal_seq: Number(seq),
      payload: wirePayload,
    });
  },
  onSignal: () => {},
  offSignal: () => {},
};

const sessionFactory = new WebRtcCallSessionFactory(bridge, callTransport);
const callMachine = new CallSessionMachine(sessionFactory, callsHttpClient);
const placeCallUC = new PlaceCallUseCase(callMachine, directoryPort, callTransport, bridge);
const answerCallUC = new AnswerCallUseCase(callMachine, callTransport);
const endCallUC = new EndCallUseCase(callMachine, callTransport, bridge);
let currentIdentityHash = '';
const receiveSignalUC = new ReceiveCallSignalUseCase(
  callMachine,
  directoryPort,
  callTransport,
  bridge,
  () => currentIdentityHash,
  metadataPort,
);
const pendingCallUC = new PendingCallUseCase(callsHttpClient, receiveSignalUC);

// ─── Create Use Cases ───────────────────────────────────────
const authUC = new AuthUseCase(authPort, cryptoPort, metadataPort);
const chatUC = new ChatUseCase(cryptoPort, messagePort, outboxPort, conversationPort, directoryPort, metadataPort, unreadPort);

if (import.meta.env.VITE_E2E === 'true' && typeof window !== 'undefined') {
  (window as unknown as Record<string, unknown>).__authUC = authUC;
  (window as unknown as Record<string, unknown>).__chatUC = chatUC;
  (window as unknown as Record<string, unknown>).__msgPort = messagePort;
  (window as unknown as Record<string, unknown>).__outboxPort = outboxPort;
}

callMachine.onCallEnded((record) => {
  void chatUC.recordCallHistory(record);
});

// Media infrastructure & Use Cases
const mediaHttpClient = new MediaHttpClient();
const mediaRepo = new DexieMediaRepository();
const mediaChunkCache = new DexieMediaChunkCache();

const uploadMediaUC = new UploadMediaUseCase(
  mediaHttpClient,
  mediaRepo,
  mediaChunkCache,
  bridge,
  null,
);
chatUC.setMediaRestClient(mediaHttpClient);
(chatUC as unknown as Record<string, unknown>).uploadMediaUC = uploadMediaUC;
const downloadMediaUC = new DownloadMediaUseCase(
  mediaHttpClient,
  bridge,
  mediaDownloadStore,
);
const sendMediaUC = new SendMediaMessageUseCase(
  uploadMediaUC,
  chatUC,
);

// Push infrastructure & Use Case
const pushHttpClient = new PushHttpClient();
const pushPort = new BrowserPushSubscriptionPort();
const pushUC = new PushSubscriptionUseCase(pushHttpClient, pushPort);

authUC.setBeforeLogoutHook(async () => {
  try {
    await pushUC.unsubscribe();
  } catch (err) {
    console.warn('[Push] Unsubscribe on logout failed:', err);
  }
});

async function syncPushSubscriptionWithServer(): Promise<void> {
  try {
    if (typeof window === 'undefined' || pushPort.getPermission() !== 'granted') {
      return;
    }
    if (!pushPort.isSupported()) return;
    const isAvailable = await pushUC.isAvailable();
    if (!isAvailable) return;
    const sub = await pushPort.getCurrentSubscription();
    if (!sub) return;

    const p256dhBuffer = sub.getKey('p256dh');
    const authBuffer = sub.getKey('auth');
    if (!p256dhBuffer || !authBuffer) return;

    const p256dhKeyB64 = base64UrlEncode(new Uint8Array(p256dhBuffer));
    const authSecretB64 = base64UrlEncode(new Uint8Array(authBuffer));

    await pushHttpClient.subscribe(sub.endpoint, p256dhKeyB64, authSecretB64);
  } catch (err) {
    console.debug('[Push] Sync subscription failed:', err);
  }
}

export async function notifyInboundIfHidden(convId: string, isCall = false, senderId?: string): Promise<void> {
  const isDocumentVisible = typeof document !== 'undefined' && document.visibilityState === 'visible';
  const permissionGranted = typeof window !== 'undefined' && pushPort.getPermission() === 'granted';
  const auth = authUC.getSnapshot();
  const activeConvId = chatUC.getSnapshot().activeConversationId;

  if (!shouldNotifyInbound({
    convId,
    isCall,
    senderId,
    isDocumentVisible,
    permissionGranted,
    activeConversationId: activeConvId,
    currentUser: {
      userId: auth.userId,
      identityHash: auth.identityHash,
      username: auth.username,
    },
  })) {
    return;
  }

  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;

  try {
    const reg = await navigator.serviceWorker.ready;
    if (!reg) return;
    if (isCall) {
      await reg.showNotification('RootInbox', {
        body: 'Incoming call',
        tag: 'rootinbox-call',
        requireInteraction: true,
        icon: '/icon-192x192.png',
        badge: '/favicon.png',
      } as unknown as NotificationOptions);
    } else {
      const data = convId ? { conversationId: convId } : {};
      await reg.showNotification('RootInbox', {
        body: 'New message',
        tag: convId || 'rootinbox-message',
        renotify: true,
        data,
        icon: '/icon-192x192.png',
        badge: '/favicon.png',
      } as unknown as NotificationOptions);
    }
  } catch (err) {
    console.debug('[Push] Failed to show client notification:', err);
  }
}

// ─── WebSocket Client Lifecycle ─────────────────────────────
let wsClient: WSClient | null = null;
let isConnectingWs = false;

async function ensureWsConnected(): Promise<void> {
  if (authUC.getSnapshot().state !== 'authenticated') return;
  if (wsClient && wsClient.getState() !== 'disconnected') return;
  if (isConnectingWs) return;
  isConnectingWs = true;

  try {
    const token = await metadataPort.get('session_token');
    if (!token) return;
    setAuthToken(token);
    if (wsClient && wsClient.getState() !== 'disconnected') return;

    if (wsClient) {
      wsClient.destroy();
      wsClient = null;
    }

    const client = new WSClient({
      getTicket: async () => {
        const res = await authPort.getWSTicket();
        return res.ticket;
      },
      onMessage: async (msg) => {
        try {
          if (msg.type === 'chat.msg') {
            const chatMsg = msg as unknown as { content?: string; payload?: string; conversation_id?: string; request_id?: string; sender_id?: string; created_at?: number; server_id?: number; reply_to_id?: string };
            let targetConvId = chatMsg.conversation_id || '';
            if (!targetConvId && chatMsg.sender_id) {
              const matched = chatUC.getSnapshot().conversations.find((c) =>
                (c.peerId && c.peerId.toLowerCase() === chatMsg.sender_id!.toLowerCase()) ||
                (c.peerIdentityHash && c.peerIdentityHash.toLowerCase() === chatMsg.sender_id!.toLowerCase())
              );
              if (matched) {
                targetConvId = matched.id;
              }
            }
            void notifyInboundIfHidden(targetConvId, false, chatMsg.sender_id);
            if (chatMsg.content) {
              await chatUC.handleGroupMsg({
                id: chatMsg.request_id,
                conversation_id: targetConvId || chatMsg.conversation_id || '',
                sender_id: chatMsg.sender_id || '',
                content: chatMsg.content,
                created_at: chatMsg.created_at,
                server_id: chatMsg.server_id,
                reply_to_id: chatMsg.reply_to_id,
              });
            } else {
              await chatUC.handleInboundRaw(msg as unknown as Parameters<typeof chatUC.handleInboundRaw>[0]);
            }
          } else if (msg.type === 'ack.server') {
            const ackMsg = msg as unknown as { request_id?: string };
            if (ackMsg.request_id) {
              await chatUC.handleAckServer(ackMsg.request_id);
            }
          } else if (msg.type === 'ack.delivered') {
            const ackMsg = msg as unknown as { request_id?: string; conversation_id?: string; delivered_at?: number };
            if (ackMsg.request_id) {
              await chatUC.handleAckDelivered(ackMsg.request_id, ackMsg.conversation_id, ackMsg.delivered_at);
            }
          } else if (msg.type === 'ack.read') {
            const ackMsg = msg as unknown as { conversation_id?: string; reader_id?: string; last_read_at?: number };
            if (ackMsg.conversation_id && ackMsg.last_read_at) {
              await chatUC.handleAckRead(ackMsg.conversation_id, ackMsg.last_read_at, ackMsg.reader_id);
            }
          } else if (msg.type === 'group.msg') {
            const gMsg = msg as unknown as { conversation_id?: string; sender_id?: string };
            void notifyInboundIfHidden(gMsg.conversation_id || '', false, gMsg.sender_id);
            await chatUC.handleGroupMsg(msg as unknown as Parameters<typeof chatUC.handleGroupMsg>[0]);
          } else if (msg.type === 'group.action') {
            const actionMsg = msg as unknown as { action?: string };
            if (actionMsg.action === 'edit') {
              await chatUC.handleGroupEdit(msg as unknown as Parameters<typeof chatUC.handleGroupEdit>[0]);
            } else if (actionMsg.action === 'delete') {
              await chatUC.handleGroupDelete(msg as unknown as Parameters<typeof chatUC.handleGroupDelete>[0]);
            }
          } else if (msg.type === 'group.edit') {
            await chatUC.handleGroupEdit(msg as unknown as Parameters<typeof chatUC.handleGroupEdit>[0]);
          } else if (msg.type === 'group.delete') {
            await chatUC.handleGroupDelete(msg as unknown as Parameters<typeof chatUC.handleGroupDelete>[0]);
          } else if (msg.type === 'conv.cleared') {
            const clearMsg = msg as unknown as { conversation_id?: string; scope?: string; cleared_at?: number };
            if (clearMsg.conversation_id) {
              await chatUC.handleConvCleared(clearMsg.conversation_id, clearMsg.scope, clearMsg.cleared_at);
            }
          } else if (msg.type === 'conv.deleted') {
            const delMsg = msg as unknown as { conversation_id?: string; scope?: string };
            if (delMsg.conversation_id) {
              await chatUC.handleConvDeleted(delMsg.conversation_id, delMsg.scope);
            }
          } else if (msg.type === 'user.presence') {
            const presMsg = msg as unknown as { user_id?: string; online?: boolean; last_seen_at?: number };
            if (presMsg.user_id) {
              chatUC.handleUserPresence(presMsg.user_id, Boolean(presMsg.online), presMsg.last_seen_at ?? 0);
            }
          } else if (msg.type?.startsWith('call.')) {
            if (msg.type === 'call.invite') {
              void notifyInboundIfHidden('', true);
            }
            const callMsg = msg as unknown as {
              call_id?: string;
              type: string;
              sender_id?: string;
              payload?: string;
              signal_seq?: number;
              glare_override?: boolean;
              canonical_call_id?: string;
            };
            await receiveSignalUC.handleSignal({
              callId: callMsg.call_id ?? '',
              frameType: msg.type,
              senderId: callMsg.sender_id ?? '',
              ciphertext: callMsg.payload ?? '',
              signalSeq: BigInt(callMsg.signal_seq ?? 0),
              glareOverride: callMsg.glare_override,
              canonicalCallId: callMsg.canonical_call_id,
            });
          }
        } catch (err) {
          console.error('[WS] Error handling message:', err);
        }
      },
      onStateChange: (state) => {
        if (state !== 'connected') {
          callMachine.handleWsDisconnect();
          if (state === 'reconnecting' || state === 'connecting') {
            syncUC.setPhase('ws_connect');
          }
        } else if (currentIdentityHash) {
          void callMachine.handleWsReconnect(currentIdentityHash);
          void pendingCallUC.checkPendingCall(currentIdentityHash);
          void syncUC.catchUp().then(() => syncUC.setPhase('ready')).catch(() => syncUC.setPhase('ready'));
          void chatUC.fetchMissedCalls();
        }
      },
      onSessionInvalidated: () => {
        authUC.invalidateSession();
        wsClient?.destroy();
        wsClient = null;
      },
    });

    wsClient = client;
    chatUC.setWsSendFn((msg) => wsClient?.send(msg));
    await wsClient.connect();
    void outboxPort.resetInflight?.();
  } finally {
    isConnectingWs = false;
  }
}

const vaultArchivePort = createVaultArchivePort();
const syncUC = new SyncUseCase(
  cryptoPort,
  metadataPort,
  outboxPort,
  async () => {
    await ensureWsConnected();
  },
  vaultArchivePort,
  chatUC,
);

if (import.meta.env.VITE_E2E === 'true' && typeof window !== 'undefined') {
  (window as unknown as Record<string, unknown>).__authUC = authUC;
  (window as unknown as Record<string, unknown>).__chatUC = chatUC;
  (window as unknown as Record<string, unknown>).__syncUC = syncUC;
  (window as unknown as Record<string, unknown>).__uploadMediaUC = uploadMediaUC;
  (window as unknown as Record<string, unknown>).__getWsState = () => wsClient?.getState() ?? 'disconnected';
}

// Register Service Worker for PWA installation & push notifications (RFC-0010 §6)
if (typeof window !== 'undefined' && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).then((reg) => {
      void reg.update();
    }).catch((err: unknown) => {
      console.debug('[SW] Registration failed:', err);
    });

    let refreshing = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      // Loop protection: only abort if more than 3 consecutive controller reloads happen rapidly
      const count = Number(sessionStorage.getItem('sw_reload_guard') || '0');
      if (count >= 3) {
        console.warn('[SW] Reload loop detected on controllerchange; skipping reload');
        return;
      }
      if (refreshing) return;
      refreshing = true;
      sessionStorage.setItem('sw_reload_guard', String(count + 1));
      window.location.reload();
    });

    // Reset loop counter once page has been stably loaded for 10s
    setTimeout(() => {
      try {
        sessionStorage.removeItem('sw_reload_guard');
      } catch {
        // ignore
      }
    }, 10000);

    navigator.serviceWorker.addEventListener('message', async (event) => {
      try {
        const data = event.data;
        if (!data || typeof data !== 'object') return;
        if (data.type === 'wake') {
          void syncUC.catchUp();
        } else if (data.type === 'open-conversation') {
          const convId = data.conversationId;
          if (convId) {
            await chatUC.loadConversations();
            chatUC.selectConversation(convId);
          }
        } else if (data.type === 'pushsubscriptionchange') {
          void syncPushSubscriptionWithServer();
        }
      } catch (err) {
        console.debug('[SW] Message handler error:', err);
      }
    });
  });
}

// React to auth state changes to connect/disconnect WS
authUC.subscribe((authSnapshot) => {
  if (authSnapshot.state === 'authenticated') {
    currentIdentityHash = authSnapshot.identityHash ?? '';
    receiveSignalUC.setLocalIdentityHash(currentIdentityHash);
    if (wsClient) {
      wsClient.destroy();
      wsClient = null;
    }
    void syncUC.boot();
    void syncPushSubscriptionWithServer();
    void pendingCallUC.checkPendingCall(currentIdentityHash);
    void chatUC.fetchMissedCalls();

    if (typeof window !== 'undefined') {
      const urlParams = new URLSearchParams(window.location.search);
      const convParam = urlParams.get('conv');
      if (convParam) {
        void (async () => {
          await chatUC.loadConversations();
          chatUC.selectConversation(convParam);
          const newUrl = window.location.pathname + window.location.hash;
          window.history.replaceState(null, '', newUrl);
        })();
      }
    }
  } else if (authSnapshot.state === 'idle') {
    currentIdentityHash = '';
    if (wsClient) {
      wsClient.destroy();
      wsClient = null;
    }
    chatUC.setWsSendFn(() => {});
    chatUC.resetState();
  }
});

// Periodic and visibility-based pending call checks to guarantee no call is missed
if (typeof document !== 'undefined') {
  const checkPendingOnActive = () => {
    if (!document.hidden && currentIdentityHash && callMachine.getState().status === 'idle') {
      void pendingCallUC.checkPendingCall(currentIdentityHash);
      void ensureWsConnected();
    }
  };
  document.addEventListener('visibilitychange', checkPendingOnActive);
  window.addEventListener('focus', checkPendingOnActive);
  window.addEventListener('online', () => {
    wsClient?.reconnectNow();
    void ensureWsConnected();
  });

  setInterval(() => {
    if (currentIdentityHash && !document.hidden && callMachine.getState().status === 'idle') {
      void pendingCallUC.checkPendingCall(currentIdentityHash);
    }
  }, 3500);
}

// Initial boot check: probe cookie with GET /api/v1/users/me and stored session
void (async () => {
  try {
    const isSessionOnly = typeof sessionStorage !== 'undefined' && sessionStorage.getItem('is_session_only') === 'true';
    const sessionOnlyToken = isSessionOnly ? sessionStorage.getItem('session_token') : null;
    const savedToken = sessionOnlyToken || (await metadataPort.get('session_token'));
    if (savedToken) {
      setAuthToken(savedToken);
    }
    const authUser = (isSessionOnly ? sessionStorage.getItem('auth_username') : null) || (await metadataPort.get('auth_username')) || (await metadataPort.get('username'));
    const savedHash = (isSessionOnly ? sessionStorage.getItem('identity_hash') : null) || (await metadataPort.get('identity_hash'));
    const savedUserId = (isSessionOnly ? sessionStorage.getItem('user_id') : null) || (await metadataPort.get('user_id'));
    const savedDisplayName = (isSessionOnly ? sessionStorage.getItem('display_name') : null) || (await metadataPort.get('display_name'));

    let me: UserProfile | null = null;
    try {
      me = await userPort.getMe();
    } catch {
      // Best effort if offline or backend slow
    }

    const finalUsername = authUser || (me?.username ?? undefined);
    const finalUserId = me?.user_id || savedUserId;
    const finalDisplayName = me?.display_name || savedDisplayName || finalUsername;
    const finalIdentityHash = me?.identity_hash || savedHash;

    if (savedToken && (finalUsername || finalIdentityHash)) {
      if (!isSessionOnly) {
        if (finalUserId) await metadataPort.set('user_id', finalUserId);
        if (finalUsername) {
          await metadataPort.set('auth_username', finalUsername);
          await metadataPort.set('username', finalUsername);
        }
        if (finalDisplayName) await metadataPort.set('display_name', finalDisplayName);
        if (finalIdentityHash) await metadataPort.set('identity_hash', finalIdentityHash);
      }

      // Attempt zero-password session restoration (RFC-0003 §8.3 Remember Keys)
      const restored = await authUC.tryRestoreSession({
        username: finalUsername,
        displayName: finalDisplayName,
        userId: finalUserId,
      });

      if (!restored) {
        authUC.setLocked({
          username: finalUsername,
          displayName: finalDisplayName,
          userId: finalUserId,
          identityHash: finalIdentityHash,
        });
      }
    }
  } catch {
    // No active session cookie or storage error, remain idle
  }
})();

// Wire session-invalidated callback for REST 401.
setSessionInvalidatedCallback(() => {
  authUC.invalidateSession();
  wsClient?.destroy();
  wsClient = null;
});

// ─── Initialize Theme ───────────────────────────────────────
void (async () => {
  try {
    const savedTheme = await metadataPort.get('theme');
    if (savedTheme === 'light' || savedTheme === 'dark') {
      document.documentElement.setAttribute('data-theme', savedTheme);
    }
  } catch { /* Use system preference as fallback */ }
})();

// ─── Render ─────────────────────────────────────────────────
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AppContext.Provider value={{
      authUC,
      chatUC,
      syncUC,
      callMachine,
      placeCallUC,
      answerCallUC,
      endCallUC,
      receiveSignalUC,
      pendingCallUC,
      uploadMediaUC,
      downloadMediaUC,
      sendMediaUC,
      metadataPort,
      userPort,
      contactPort,
      conversationPort,
      pushUC,
    }}>
      <PasscodeProvider>
        <App />
      </PasscodeProvider>
    </AppContext.Provider>
  </StrictMode>,
);

