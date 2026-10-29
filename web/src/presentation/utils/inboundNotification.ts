/**
 * Decision helper for client-side push / tab notifications (S1).
 *
 * Rules:
 * - Do not notify if document is visible
 * - Do not notify if push permission is not granted
 * - Do not notify for messages sent by the current user (other-device echo of own messages, including group.msg)
 * - Do not notify for the conversation that is currently open
 * - Calls bypass own-message and open-conversation suppression
 */

export interface ShouldNotifyParams {
  convId: string;
  isCall?: boolean;
  senderId?: string;
  isDocumentVisible: boolean;
  permissionGranted: boolean;
  activeConversationId: string | null;
  currentUser: {
    userId?: string | null;
    identityHash?: string | null;
    username?: string | null;
  };
}

export function shouldNotifyInbound(params: ShouldNotifyParams): boolean {
  if (params.isDocumentVisible) return false;
  if (!params.permissionGranted) return false;
  if (params.isCall) return true;

  // 1. Do not notify for messages sent by the current user (echoes from another device or self)
  if (params.senderId) {
    const s = params.senderId.trim().toLowerCase();
    if (s === 'self') return false;
    const user = params.currentUser || {};
    if (user.userId && s === user.userId.trim().toLowerCase()) return false;
    if (user.identityHash && s === user.identityHash.trim().toLowerCase()) return false;
    if (user.username && s === user.username.trim().toLowerCase()) return false;
  }

  // 2. Do not notify for the conversation that is currently open
  if (params.activeConversationId) {
    const active = params.activeConversationId.trim().toLowerCase();
    if (params.convId && active === params.convId.trim().toLowerCase()) return false;
    if (params.senderId && active === `draft:${params.senderId.trim().toLowerCase()}`) return false;
  }

  return true;
}
