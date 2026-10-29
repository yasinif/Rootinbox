/**
 * Presentation hooks — useSyncExternalStore pattern.
 * RFC-0010 §4.1: Hooks import domain + usecase only.
 */

import { useSyncExternalStore, useCallback, useState, useEffect } from 'react';
import { useAppContext } from '../context';
import type { AuthStateSnapshot } from '../../usecase/auth';
import type { ChatState, ChatMessage } from '../../usecase/chat';
import type { SyncState } from '../../usecase/sync';

// ─── useAuth ─────────────────────────────────────────────────
export function useAuth(): AuthStateSnapshot & {
  register: (username: string, password: string, displayName?: string, rememberMe?: boolean) => Promise<void>;
  login: (username: string, password: string, rememberMe?: boolean) => Promise<void>;
  unlock: (password: string) => Promise<void>;
  logout: () => Promise<void>;
} {
  const { authUC } = useAppContext();

  const snapshot = useSyncExternalStore(
    useCallback((cb: () => void) => authUC.subscribe(cb), [authUC]),
    () => authUC.getSnapshot(),
  );

  return {
    ...snapshot,
    register: useCallback((u: string, p: string, d?: string, r?: boolean) => authUC.register(u, p, d, r), [authUC]),
    login: useCallback((u: string, p: string, r?: boolean) => authUC.login(u, p, r), [authUC]),
    unlock: useCallback((p: string) => authUC.unlock(p), [authUC]),
    logout: useCallback(() => authUC.logout(), [authUC]),
  };
}

// ─── useChat ─────────────────────────────────────────────────
export function useChat(): ChatState & {
  selectConversation: (id: string) => Promise<void>;
  loadConversations: () => Promise<void>;
  createConversation: (peerIdentityHash: string) => Promise<string>;
  getOrCreateSelfConversation: () => Promise<string>;
  sendMessage: (conversationId: string, plaintext: string, peerIdentityHash?: string, replyToId?: string) => Promise<void>;
  editMessage: (conversationId: string, messageId: string, content: string) => Promise<void>;
  deleteMessage: (conversationId: string, messageId: string, mode?: 'me' | 'both') => Promise<void>;
  forwardMessage: (targetConversationId: string, message: ChatMessage) => Promise<void>;
  clearHistory: (conversationId: string, mode?: 'me' | 'both') => Promise<void>;
  deleteConversation: (conversationId: string, mode?: 'me' | 'both') => Promise<void>;
  uploadMediaMessage: (
    cid: string,
    file: File | Blob,
    fileName: string,
    uploadUC: import('../../usecase/media/UploadMediaUseCase').UploadMediaUseCase,
    caption?: string,
    previewDataUrl?: string,
    mimeType?: string,
    existingMsgId?: string,
  ) => Promise<void>;
    loadEarlierMessages: (conversationId: string) => Promise<boolean>;
  cancelSending: (messageId: string) => Promise<void>;
  retryMessage: (messageId: string) => Promise<void>;
  deleteFailedMessage: (messageId: string) => Promise<void>;
} {
  const { chatUC } = useAppContext();

  const snapshot = useSyncExternalStore(
    useCallback((cb: () => void) => chatUC.subscribe(cb), [chatUC]),
    () => chatUC.getSnapshot(),
  );

  return {
    ...snapshot,
    selectConversation: useCallback((id: string) => chatUC.selectConversation(id), [chatUC]),
    loadConversations: useCallback(() => chatUC.loadConversations(), [chatUC]),
    createConversation: useCallback((h: string) => chatUC.createConversation(h), [chatUC]),
    getOrCreateSelfConversation: useCallback(() => chatUC.getOrCreateSelfConversation(), [chatUC]),
    sendMessage: useCallback(
      (cid: string, text: string, peerHash?: string, replyId?: string) =>
        chatUC.sendMessage(cid, text, peerHash, replyId),
      [chatUC],
    ),
    editMessage: useCallback(
      (cid: string, mid: string, content: string) => chatUC.editMessage(cid, mid, content),
      [chatUC],
    ),
    deleteMessage: useCallback(
      (cid: string, mid: string, mode?: 'me' | 'both') => chatUC.deleteMessage(cid, mid, mode),
      [chatUC],
    ),
    forwardMessage: useCallback(
      (targetId: string, msg: ChatMessage) => chatUC.forwardMessage(targetId, msg),
      [chatUC],
    ),
    clearHistory: useCallback(
      (cid: string, mode?: 'me' | 'both') => chatUC.clearHistory(cid, mode),
      [chatUC],
    ),
    deleteConversation: useCallback(
      (cid: string, mode?: 'me' | 'both') => chatUC.deleteConversation(cid, mode),
      [chatUC],
    ),
    uploadMediaMessage: useCallback(
      (
        cid: string,
        file: File | Blob,
        fileName: string,
        uploadUC: import('../../usecase/media/UploadMediaUseCase').UploadMediaUseCase,
        caption?: string,
        previewDataUrl?: string,
        mimeType?: string,
        existingMsgId?: string,
      ) => chatUC.uploadMediaMessage(cid, file, fileName, uploadUC, caption, previewDataUrl, mimeType, existingMsgId),
      [chatUC],
    ),
    loadEarlierMessages: useCallback(
      (cid: string) => chatUC.loadEarlierMessages(cid),
      [chatUC],
    ),
    cancelSending: useCallback(
      (mid: string) => chatUC.cancelSending(mid),
      [chatUC],
    ),
    retryMessage: useCallback(
      (mid: string) => chatUC.retryMessage(mid),
      [chatUC],
    ),
    deleteFailedMessage: useCallback(
      (mid: string) => chatUC.deleteFailedMessage(mid),
      [chatUC],
    ),
  };
}

// ─── useContacts ─────────────────────────────────────────────
const CONTACTS_CHANGED_EVENT = 'contacts-changed';

export function useContacts(): {
  contacts: import('../../domain').ContactDTO[];
  loadContacts: () => Promise<void>;
  saveContact: (contact: import('../../domain').ContactDTO) => Promise<void>;
  deleteContact: (peerUserId: string) => Promise<void>;
} {
  const { contactPort } = useAppContext();
  const [contacts, setContacts] = useState<import('../../domain').ContactDTO[]>([]);

  const loadContacts = useCallback(async () => {
    if (!contactPort) return;
    const list = await contactPort.getAll();
    setContacts(list);
  }, [contactPort]);

  useEffect(() => {
    void loadContacts();
    const handler = () => {
      void loadContacts();
    };
    window.addEventListener(CONTACTS_CHANGED_EVENT, handler);
    return () => window.removeEventListener(CONTACTS_CHANGED_EVENT, handler);
  }, [loadContacts]);

  const saveContact = useCallback(async (contact: import('../../domain').ContactDTO) => {
    if (!contactPort) return;
    await contactPort.save(contact);
    await loadContacts();
    window.dispatchEvent(new CustomEvent(CONTACTS_CHANGED_EVENT));
  }, [contactPort, loadContacts]);

  const deleteContact = useCallback(async (peerUserId: string) => {
    if (!contactPort) return;
    await contactPort.delete(peerUserId);
    await loadContacts();
    window.dispatchEvent(new CustomEvent(CONTACTS_CHANGED_EVENT));
  }, [contactPort, loadContacts]);

  return {
    contacts,
    loadContacts,
    saveContact,
    deleteContact,
  };
}

// ─── useSync ─────────────────────────────────────────────────
export function useSync(): SyncState {
  const { syncUC } = useAppContext();

  return useSyncExternalStore(
    useCallback((cb: () => void) => syncUC.subscribe(cb), [syncUC]),
    () => syncUC.getSnapshot(),
  );
}

// ─── Phase 12B Call Hooks ────────────────────────────────────
export * from './useCallSession';
export * from './useCallMedia';
export * from './useSas';
export * from './useMediaDevices';
export * from './useCallRingtone';
export * from './usePwaInstall';
export { usePasscodeLock } from '../context/PasscodeContext';


