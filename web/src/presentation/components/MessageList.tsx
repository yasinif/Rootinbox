/**
 * MessageList — virtualized message list via react-virtuoso + message compose bar.
 * RFC-0010 §9.2: Plain JSX text interpolation only.
 * dangerouslySetInnerHTML FORBIDDEN anywhere.
 * Links: rel="noopener noreferrer" with click-confirm.
 *
 * Integrated with:
 * - WebRTC E2EE voice calling (📞 Call) via useCallSession
 * - Encrypted Chunked Media upload (📎) via useMediaUpload
 * - Rich media bubble rendering via MediaAttachmentBubble
 */

import { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso';
import { useChat, useAuth, useCallSession, useContacts, usePasscodeLock } from '../hooks';
import { useMediaUpload } from '../hooks/useMediaUpload';
import { useAppContext } from '../context';
import { MediaAttachmentBubble } from './media/MediaAttachmentBubble';
import { AttachmentMenu } from './media/AttachmentMenu';
import { SendMediaPreviewModal } from './media/SendMediaPreviewModal';
import { GroupMembersModal } from './group/GroupMembersModal';
import { Avatar } from './common/Avatar';
import { ForwardModal } from './message/ForwardModal';
import { PeerProfileModal } from './user/PeerProfileModal';
import { formatLastSeen } from './common/presence';
import type { ChatMessage } from '../../usecase/chat';
import type { UserProfile, ConversationMemberDTO } from '../../domain';
import { toMillis } from '../../domain';

interface MessageListProps {
  conversationId: string;
}

const URL_REGEX = /https?:\/\/[^\s]+/g;

function formatDateDivider(timestamp: number): string {
  const ms = toMillis(timestamp);
  const date = new Date(ms);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);

  if (date.toDateString() === today.toDateString()) {
    return 'Today';
  }
  if (date.toDateString() === yesterday.toDateString()) {
    return 'Yesterday';
  }
  return date.toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    year: date.getFullYear() !== today.getFullYear() ? 'numeric' : undefined,
  });
}

export function MessageList({ conversationId }: MessageListProps) {
  const {
    messages,
    sending,
    sendMessage,
    conversations,
    editMessage,
    deleteMessage,
    forwardMessage,
    clearHistory,
    deleteConversation,
    createConversation,
    selectConversation,
    firstUnreadMessageId,
    unreadDividerTimestamp,
    uploadMediaMessage,
    loadEarlierMessages,
    cancelSending,
    retryMessage,
    deleteFailedMessage,
  } = useChat();
  const { identityHash } = useAuth();
  const { placeCall, status: callStatus } = useCallSession();
  const { uploading, progress: uploadProgress, error: uploadError } = useMediaUpload();
  const { downloadMediaUC, uploadMediaUC, metadataPort, chatUC, userPort } = useAppContext();
  const { contacts, saveContact } = useContacts();
  const { isPasscodeEnabled, lock: lockApp } = usePasscodeLock();

  const [isLoadingEarlier, setIsLoadingEarlier] = useState(false);
  const [hasMoreEarlier, setHasMoreEarlier] = useState(true);

  useEffect(() => {
    setHasMoreEarlier(true);
  }, [conversationId]);

  const handleLoadEarlier = useCallback(async () => {
    if (isLoadingEarlier || !hasMoreEarlier || !conversationId) return;
    setIsLoadingEarlier(true);
    try {
      const loaded = await loadEarlierMessages(conversationId);
      if (!loaded) {
        setHasMoreEarlier(false);
      }
    } finally {
      setIsLoadingEarlier(false);
    }
  }, [isLoadingEarlier, hasMoreEarlier, conversationId, loadEarlierMessages]);

  const [inputText, setInputText] = useState('');
  const [peerNickname, setPeerNickname] = useState<string | null>(null);
  const [peerUsername, setPeerUsername] = useState<string | null>(null);
  const [peerUserId, setPeerUserId] = useState<string | null>(null);
  const [peerProfile, setPeerProfile] = useState<UserProfile | null>(null);
  const [showPeerProfileModal, setShowPeerProfileModal] = useState(false);
  const [showMembersModal, setShowMembersModal] = useState(false);
  const [showAttachmentMenu, setShowAttachmentMenu] = useState(false);
  const [pendingMediaQueue, setPendingMediaQueue] = useState<File[]>([]);
  const pendingMediaFile = pendingMediaQueue[0] || null;
  const [replyingTo, setReplyingTo] = useState<ChatMessage | null>(null);
  const [channelRole, setChannelRole] = useState<string | null>(null);
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [editContent, setEditContent] = useState('');
  const [copiedMsgId, setCopiedMsgId] = useState<string | null>(null);
  const [forwardingMsg, setForwardingMsg] = useState<ChatMessage | null>(null);
  const [deleteTargetMsg, setDeleteTargetMsg] = useState<ChatMessage | null>(null);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [currentUsername, setCurrentUsername] = useState<string | null>(null);
  const [showCallPicker, setShowCallPicker] = useState(false);
  const [showOverflowMenu, setShowOverflowMenu] = useState(false);
  const [showClearHistoryDialog, setShowClearHistoryDialog] = useState(false);
  const [showDeleteConvDialog, setShowDeleteConvDialog] = useState(false);
  const [activeActionMsgId, setActiveActionMsgId] = useState<string | null>(null);
  const [groupMembers, setGroupMembers] = useState<ConversationMemberDTO[]>([]);
  const callPickerRef = useRef<HTMLDivElement | null>(null);
  const overflowMenuRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const galleryInputRef = useRef<HTMLInputElement | null>(null);
  const cameraInputRef = useRef<HTMLInputElement | null>(null);
  const audioInputRef = useRef<HTMLInputElement | null>(null);
  const [isRecordingVoice, setIsRecordingVoice] = useState(false);
  const [voiceDuration, setVoiceDuration] = useState(0);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const voiceTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const retryUploadMap = useRef(new Map<string, () => void>());
  const isSendingMediaRef = useRef(false);
  const chatInputRef = useRef<HTMLInputElement | null>(null);
  const virtuosoRef = useRef<VirtuosoHandle>(null);

  const activeConv = (conversations || []).find((c) => c?.id === conversationId);
  const effectivePeerIdentityHash = activeConv?.peerIdentityHash || (conversationId.startsWith('draft:') ? conversationId.slice(6) : undefined);
  const isSelf = activeConv?.type === 'SELF';
  const isGroup = activeConv?.type === 'GROUP';
  const isChannel = activeConv?.type === 'CHANNEL';
  const isGroupOrChannel = isGroup || isChannel;

  useEffect(() => {
    void metadataPort.get('user_id').then((val) => setCurrentUserId(val ?? null));
    void metadataPort.get('username').then((val) => setCurrentUsername(val ?? null));
    const targetHash = effectivePeerIdentityHash;
    if (targetHash) {
      void metadataPort.get(`peer_name_${targetHash}`).then((v) => setPeerNickname(v ?? null));
      void metadataPort.get(`peer_user_${targetHash}`).then((v) => setPeerUsername(v ?? null));
      void metadataPort.get(`peer_id_${targetHash}`).then((v) => setPeerUserId(v ?? null));
    } else {
      setPeerNickname(null);
      setPeerUsername(null);
      setPeerUserId(null);
    }
  }, [conversationId, effectivePeerIdentityHash, metadataPort]);
  const isSubscriber = isChannel && (
    channelRole === 'SUBSCRIBER' ||
    (channelRole !== 'ADMIN' && channelRole !== 'OWNER' && Boolean(activeConv?.createdBy && currentUserId && activeConv.createdBy !== currentUserId))
  );
  const canViewMembers = isGroup || (isChannel && (
    channelRole === 'OWNER' ||
    channelRole === 'ADMIN' ||
    Boolean(activeConv?.createdBy && currentUserId && activeConv.createdBy === currentUserId)
  ));
  const [copiedLink, setCopiedLink] = useState(false);

  const handleCopyLink = () => {
    let link = '';
    if (activeConv?.isPublic && activeConv?.username) {
      link = `${window.location.origin}/#@${activeConv.username}`;
    } else if (activeConv?.inviteCode) {
      link = `${window.location.origin}/#/join/${activeConv.inviteCode}`;
    }
    if (link) {
      void navigator.clipboard.writeText(link);
      setCopiedLink(true);
      setTimeout(() => setCopiedLink(false), 2500);
    }
  };

  const peerInContacts = effectivePeerIdentityHash
    ? contacts.some((c) => c.identity_hash === effectivePeerIdentityHash || c.peer_user_id === activeConv?.peerId)
    : false;

  const filtered = (messages || [])
    .filter((m) => m && m.conversationId === conversationId)
    .sort((a, b) => {
      const timeA = toMillis(a.createdAt);
      const timeB = toMillis(b.createdAt);
      if (timeA !== timeB) return timeA - timeB;
      if (a.sequence !== undefined && b.sequence !== undefined && a.sequence !== b.sequence) {
        return a.sequence - b.sequence;
      }
      return a.id.localeCompare(b.id);
    });

  const firstUnreadIndex = useMemo(() => {
    if (!firstUnreadMessageId) return -1;
    return filtered.findIndex((m) => m.id === firstUnreadMessageId);
  }, [filtered, firstUnreadMessageId]);

  const initialTopIndex = useMemo(() => {
    if (firstUnreadIndex !== -1) {
      return firstUnreadIndex;
    }
    return Math.max(0, filtered.length - 1);
  }, [firstUnreadIndex, filtered.length]);

  const initialScrollDoneRef = useRef<string | null>(null);
  const prevFilteredLenRef = useRef(filtered.length);

  // Automatically scroll when message list initializes or new messages arrive
  useEffect(() => {
    if (filtered.length === 0 || !virtuosoRef.current) return;

    // First mount or conversation change
    if (initialScrollDoneRef.current !== conversationId) {
      initialScrollDoneRef.current = conversationId;
      prevFilteredLenRef.current = filtered.length;

      if (firstUnreadIndex !== -1) {
        virtuosoRef.current.scrollToIndex({
          index: firstUnreadIndex,
          align: 'start',
          behavior: 'auto',
        });
        requestAnimationFrame(() => {
          virtuosoRef.current?.scrollToIndex({
            index: firstUnreadIndex,
            align: 'start',
            behavior: 'auto',
          });
        });
      } else {
        virtuosoRef.current.scrollToIndex({
          index: filtered.length - 1,
          align: 'end',
          behavior: 'auto',
        });
        requestAnimationFrame(() => {
          virtuosoRef.current?.scrollToIndex({
            index: filtered.length - 1,
            align: 'end',
            behavior: 'auto',
          });
        });
      }
      return;
    }

    // Subsequent updates: live messages added while inside this conversation
    if (filtered.length > prevFilteredLenRef.current) {
      prevFilteredLenRef.current = filtered.length;
      virtuosoRef.current.scrollToIndex({
        index: filtered.length - 1,
        align: 'end',
        behavior: 'auto',
      });
    }
  }, [filtered, conversationId, firstUnreadIndex, identityHash]);

  // Expose scroll-to-bottom helper for testing and virtualizer sync
  useEffect(() => {
    if (import.meta.env.VITE_E2E === 'true' && typeof window !== 'undefined') {
      (window as unknown as Record<string, unknown>).__virtuosoScrollToBottom = () => {
        if (virtuosoRef.current && filtered.length > 0) {
          virtuosoRef.current.scrollToIndex({
            index: filtered.length - 1,
            align: 'end',
            behavior: 'auto',
          });
        }
      };
    }
    return () => {
      if (import.meta.env.VITE_E2E === 'true' && typeof window !== 'undefined') {
        delete (window as unknown as Record<string, unknown>).__virtuosoScrollToBottom;
      }
    };
  }, [filtered.length]);

  // Load peer profile (display_name, last_name, bio)
  useEffect(() => {
    const contactPeer = effectivePeerIdentityHash
      ? contacts.find((c) => c.identity_hash?.toLowerCase() === effectivePeerIdentityHash.toLowerCase() || (activeConv?.peerId && c.peer_user_id === activeConv.peerId))
      : undefined;
    const targetUserId = activeConv?.peerId || peerUserId || contactPeer?.peer_user_id;
    if (!isSelf && !isGroupOrChannel && targetUserId) {
      void userPort.getProfile(targetUserId).then((p) => {
        setPeerProfile(p);
      }).catch(() => {
        setPeerProfile(null);
      });
    } else {
      setPeerProfile(null);
    }
  }, [activeConv?.peerId, peerUserId, effectivePeerIdentityHash, contacts, isSelf, isGroupOrChannel, userPort]);

  // Load channel/group member role for the current user
  useEffect(() => {
    if (isGroupOrChannel) {
      void chatUC.getGroupMembers(conversationId).then(async (members) => {
        setGroupMembers(members || []);
        const rawHash = identityHash || (await metadataPort.get('identity_hash')) || '';
        const myHash = rawHash.toLowerCase();
        const rawUser = (await metadataPort.get('username')) || '';
        const myUser = rawUser.toLowerCase();
        const rawUserId = (await metadataPort.get('user_id')) || '';
        const myMember = (members || []).find((m) =>
          (m.identity_hash && myHash && m.identity_hash.toLowerCase() === myHash) ||
          (m.username && myUser && m.username.toLowerCase() === myUser) ||
          (m.user_id && rawUserId && m.user_id === rawUserId)
        );
        setChannelRole(myMember?.role ?? null);
      }).catch(() => {
        setGroupMembers([]);
        setChannelRole(null);
      });
    } else {
      setGroupMembers([]);
      setChannelRole(null);
    }
  }, [isGroupOrChannel, conversationId, identityHash, chatUC, metadataPort]);

  // Click-away listener for popups and menus
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (showCallPicker && callPickerRef.current && !callPickerRef.current.contains(e.target as Node)) {
        setShowCallPicker(false);
      }
      if (showOverflowMenu && overflowMenuRef.current && !overflowMenuRef.current.contains(e.target as Node)) {
        setShowOverflowMenu(false);
      }
      if (activeActionMsgId) {
        const actionEl = document.getElementById(`msg-actions-popover-${activeActionMsgId}`);
        const btnEl = document.getElementById(`msg-actions-btn-${activeActionMsgId}`);
        if (
          actionEl && !actionEl.contains(e.target as Node) &&
          btnEl && !btnEl.contains(e.target as Node)
        ) {
          setActiveActionMsgId(null);
        }
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showCallPicker, showOverflowMenu, activeActionMsgId]);

  const handleSend = async (e?: React.FormEvent | React.MouseEvent) => {
    if (e) e.preventDefault();
    const inputEl = document.getElementById('chat-input') as HTMLInputElement | null;
    const text = (inputText || inputEl?.value || '').trim();
    if (!text || sending) return;
    setInputText('');
    if (inputEl) inputEl.value = '';
    const repId = replyingTo?.id;
    setReplyingTo(null);

    let targetConvId = conversationId;
    let targetPeerHash = activeConv?.peerIdentityHash;
    if (conversationId.startsWith('draft:')) {
      targetPeerHash = conversationId.slice(6);
      targetConvId = await createConversation(targetPeerHash);
    }
    await sendMessage(targetConvId, text, targetPeerHash, repId);
    chatInputRef.current?.focus();
  };

  const handleEdit = async (msgId: string) => {
    const trimmed = editContent.trim();
    if (!trimmed) return;
    try {
      await editMessage(conversationId, msgId, trimmed);
      setEditingMessageId(null);
      setEditContent('');
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to edit message');
    }
  };

  const handleCopy = async (msg: ChatMessage) => {
    try {
      await navigator.clipboard.writeText(msg.plaintext || '');
      setCopiedMsgId(msg.id);
      setTimeout(() => setCopiedMsgId(null), 2000);
    } catch (err) {
      console.error('Failed to copy text:', err);
    }
  };

  const handleConfirmDelete = async (mode: 'me' | 'both') => {
    if (!deleteTargetMsg) return;
    const msgId = deleteTargetMsg.id;
    setDeleteTargetMsg(null);
    try {
      await deleteMessage(conversationId, msgId, mode);
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to delete message');
    }
  };

  const handleClearHistory = () => {
    setShowOverflowMenu(false);
    setShowClearHistoryDialog(true);
  };

  const handleConfirmClearHistory = async (mode: 'me' | 'both') => {
    setShowClearHistoryDialog(false);
    try {
      await clearHistory(conversationId, mode);
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to clear message history');
    }
  };

  const handleDeleteConversation = () => {
    setShowOverflowMenu(false);
    setShowDeleteConvDialog(true);
  };

  const handleConfirmDeleteConversation = async (mode: 'me' | 'both') => {
    setShowDeleteConvDialog(false);
    try {
      await deleteConversation(conversationId, mode);
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to delete conversation');
    }
  };

  const isTechnical = (str?: string) => Boolean(str && /^[0-9a-fA-F-]{32,64}$/.test(str));
  const cleanConvName = isTechnical(activeConv?.name) ? undefined : activeConv?.name;

  const contactPeer = effectivePeerIdentityHash
    ? contacts.find((c) => c.identity_hash?.toLowerCase() === effectivePeerIdentityHash.toLowerCase() || (activeConv?.peerId && c.peer_user_id === activeConv.peerId))
    : undefined;
  const contactNick = contactPeer?.nickname;

  const profileFullName = [peerProfile?.display_name, peerProfile?.last_name].filter(Boolean).join(' ') || peerProfile?.display_name;
  const convFullName = [activeConv?.peer_display_name, activeConv?.peer_last_name].filter(Boolean).join(' ') || activeConv?.peer_display_name;

  const peerFullName = profileFullName || convFullName;
  const effectiveUsername = peerProfile?.username || activeConv?.peer_username || peerUsername;
  const peerDisplayName = peerFullName || contactNick || peerNickname || cleanConvName || (effectiveUsername ? (effectiveUsername.startsWith('@') ? effectiveUsername : `@${effectiveUsername}`) : undefined);

  const handleCall = async (type: 'audio' | 'video' = 'audio') => {
    const peerHash = effectivePeerIdentityHash;
    if (isSelf || !peerHash || !identityHash || callStatus !== 'idle') return;
    const displayName = peerDisplayName || (effectiveUsername ? `@${effectiveUsername}` : 'Peer');
    try {
      await placeCall(peerHash, displayName, identityHash, type);
    } catch (err) {
      console.error('[MessageList] Call initiation failed:', err instanceof Error ? (err.stack || err.message) : String(err));
    }
  };

  const handleAddContact = async () => {
    if (!activeConv?.peerIdentityHash) return;
    const defaultNick = peerDisplayName || (effectiveUsername ? `@${effectiveUsername}` : 'Contact');
    const nick = window.prompt('Save contact nickname:', defaultNick);
    if (!nick) return;
    const trimmed = nick.trim();
    if (!trimmed) return;
    try {
      await saveContact({
        peer_user_id: activeConv.peerId || activeConv.peerIdentityHash,
        identity_hash: activeConv.peerIdentityHash,
        nickname: trimmed,
        added_at: Date.now(),
      });
      await metadataPort.set(`peer_name_${activeConv.peerIdentityHash}`, trimmed);
      setPeerNickname(trimmed);
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to save contact');
    }
  };

  const handleFilesSelected = (e: React.ChangeEvent<HTMLInputElement>) => {
    // CRITICAL SAFEGUARD 1: Avoid the Live FileList Mutation Trap
    // In DOM browsers, e.currentTarget.files is a live FileList reference.
    // Copy into a static array FIRST, then reset e.currentTarget.value = ''.
    const selectedFiles = Array.from(e.currentTarget.files ?? []);
    e.currentTarget.value = '';
    if (selectedFiles.length === 0) return;

    setPendingMediaQueue((prev) => [...prev, ...selectedFiles]);
  };

  const handleSendMedia = async (
    file: File,
    caption?: string,
    previewDataUrl?: string,
    existingMsgId?: string,
  ) => {
    if (!uploadMediaUC) {
      console.error('[MessageList] uploadMediaUC not available in AppContext');
      return;
    }
    // If the compose bar text was submitted as caption, clear compose bar
    if (inputText && caption && inputText.trim() === caption.trim()) {
      setInputText('');
    }
    try {
      let targetConvId = conversationId;
      if (conversationId.startsWith('draft:')) {
        const targetPeerHash = conversationId.slice(6);
        targetConvId = await createConversation(targetPeerHash);
      }
      const targetMsgId =
        existingMsgId ||
        (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
          ? crypto.randomUUID()
          : `msg-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`);

      const retryClosure = () => {
        void handleSendMedia(file, caption, previewDataUrl, targetMsgId);
      };
      retryUploadMap.current.set(file.name, retryClosure);
      retryUploadMap.current.set(targetMsgId, retryClosure);

      await uploadMediaMessage(
        targetConvId,
        file,
        file.name,
        uploadMediaUC,
        caption,
        previewDataUrl,
        file.type,
        targetMsgId,
      );
    } catch (err) {
      console.error('[MessageList] uploadMediaMessage failed:', err);
    }
  };

  const handleStartVoiceRecording = async (e: React.PointerEvent) => {
    e.preventDefault();
    try {
      if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
        alert('Microphone access is not supported in this browser.');
        return;
      }
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      audioChunksRef.current = [];
      const mr = new MediaRecorder(stream);
      mediaRecorderRef.current = mr;

      mr.ondataavailable = (evt) => {
        if (evt.data && evt.data.size > 0) {
          audioChunksRef.current.push(evt.data);
        }
      };

      mr.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        if (voiceTimerRef.current) {
          clearInterval(voiceTimerRef.current);
          voiceTimerRef.current = null;
        }
        const mimeType = mr.mimeType || 'audio/webm';
        const blob = new Blob(audioChunksRef.current, { type: mimeType });
        if (blob.size > 0) {
          const file = new File([blob], `voice-${Date.now()}.webm`, { type: mimeType });
          void handleSendMedia(file);
        }
      };

      mr.start(250);
      setIsRecordingVoice(true);
      setVoiceDuration(0);
      voiceTimerRef.current = setInterval(() => {
        setVoiceDuration((d) => d + 1);
      }, 1000);
    } catch (err) {
      console.warn('[VoiceRecord] Failed to start voice recording:', err);
      setIsRecordingVoice(false);
    }
  };

  const handleStopVoiceRecording = (e: React.PointerEvent) => {
    e.preventDefault();
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
    }
    setIsRecordingVoice(false);
    if (voiceTimerRef.current) {
      clearInterval(voiceTimerRef.current);
      voiceTimerRef.current = null;
    }
  };

  const handleCancelVoiceRecording = (e: React.PointerEvent) => {
    e.preventDefault();
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      audioChunksRef.current = [];
      mediaRecorderRef.current.stop();
    }
    setIsRecordingVoice(false);
    if (voiceTimerRef.current) {
      clearInterval(voiceTimerRef.current);
      voiceTimerRef.current = null;
    }
  };

  const peerLabel = isSelf
    ? '📝 My Notes'
    : isGroup
      ? `👥 ${activeConv?.name || 'Group Chat'}`
      : isChannel
        ? `📢 ${activeConv?.name || 'Channel'}`
        : peerDisplayName || (effectiveUsername ? (effectiveUsername.startsWith('@') ? effectiveUsername : `@${effectiveUsername}`) : 'Direct Message');

  const getSenderDisplayName = (msg: ChatMessage): string => {
    if (msg.senderId === identityHash || msg.senderId === currentUserId) {
      return 'You';
    }
    if (isGroupOrChannel) {
      const member = groupMembers.find(
        (m) =>
          (m.identity_hash && m.identity_hash.toLowerCase() === msg.senderId.toLowerCase()) ||
          (m.user_id && m.user_id === msg.senderId)
      );
      if (member) {
        const mFull = [member.display_name, member.last_name].filter(Boolean).join(' ') || member.display_name;
        return mFull || (member.username ? `@${member.username}` : 'Member');
      }
      return 'Member';
    }
    return peerDisplayName || (effectiveUsername ? (effectiveUsername.startsWith('@') ? effectiveUsername : `@${effectiveUsername}`) : 'Peer');
  };

  return (
    <div id="message-list" style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minHeight: 0, height: '100%' }}>
      {/* Header */}
      <div className="msg-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
          <button
            id="chat-mobile-back-btn"
            type="button"
            className="mobile-back-btn"
            onClick={() => void selectConversation('')}
            aria-label="Back to chats"
            title="Back to chats"
          >
            <svg
              width="22"
              height="22"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <line x1="19" y1="12" x2="5" y2="12"></line>
              <polyline points="12 19 5 12 12 5"></polyline>
            </svg>
          </button>
          <div
            id="chat-header-user-info"
            className="msg-header-left"
            onClick={() => {
              if (!isSelf && !isGroupOrChannel && (activeConv?.peerId || peerUserId)) {
                setShowPeerProfileModal(true);
              }
            }}
            title={!isSelf && !isGroupOrChannel ? 'Click to view profile' : undefined}
          >
            <Avatar
              userId={!isSelf && !isGroupOrChannel ? (activeConv?.peerId || peerUserId || undefined) : undefined}
              avatarUpdatedAt={!isSelf && !isGroupOrChannel ? peerProfile?.avatar_updated_at : undefined}
              name={peerLabel}
              icon={isSelf ? '📝' : isGroup ? '👥' : isChannel ? '📢' : undefined}
              size="md"
            />
            <div className="header-info">
              <div className="header-title chat-header-title">
                <span id="chat-active-peer-name">{peerLabel}</span>
              </div>
              {!isSelf && !isGroupOrChannel && (
                <div
                  id="chat-header-presence"
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '5px',
                    fontSize: '12px',
                    color: activeConv?.peerOnline ? 'var(--color-primary, #10b981)' : 'var(--color-text-tertiary, #94a3b8)',
                    marginTop: '1px',
                  }}
                >
                  {activeConv?.peerOnline && (
                    <span
                      style={{
                        width: '7px',
                        height: '7px',
                        borderRadius: '50%',
                        backgroundColor: '#10b981',
                        display: 'inline-block',
                      }}
                    />
                  )}
                  <span>{formatLastSeen(activeConv?.peerOnline, activeConv?.peerLastSeenAt)}</span>
                </div>
              )}
            </div>
          </div>
        </div>
        <div className="header-actions">
          {isGroupOrChannel && (activeConv?.isPublic || activeConv?.inviteCode) && (
            <button
              id="copy-invite-link-btn"
              type="button"
              onClick={handleCopyLink}
              className="header-action-btn header-action-btn--invite"
              title={activeConv?.isPublic ? `Share @${activeConv.username}` : 'Copy invite link'}
            >
              {copiedLink ? '✓ Copied!' : activeConv?.isPublic ? `🔗 @${activeConv.username}` : '🔗 Invite Link'}
            </button>
          )}
          {isGroupOrChannel && canViewMembers && (
            <button
              id="group-members-btn"
              type="button"
              onClick={() => setShowMembersModal(true)}
              className="header-action-btn header-action-btn--members"
              title="View and manage members"
            >
              👥 Members
            </button>
          )}
          {!isSelf && !isGroupOrChannel && (
            <div ref={callPickerRef} style={{ position: 'relative' }}>
              <button
                id="call-btn"
                data-testid="call-btn"
                type="button"
                disabled={callStatus !== 'idle' || !effectivePeerIdentityHash}
                onClick={() => setShowCallPicker((prev) => !prev)}
                className="header-action-btn header-action-btn--call"
                title={callStatus === 'idle' ? 'Start a voice or video call' : 'Call in progress'}
              >
                📞 {callStatus === 'idle' ? 'Call ▾' : 'Calling...'}
              </button>
              {showCallPicker && callStatus === 'idle' && (
                <div id="call-type-picker" data-testid="call-type-picker" className="dropdown-menu">
                  <button
                    id="call-option-voice"
                    data-testid="call-option-voice"
                    type="button"
                    className="dropdown-item"
                    onClick={() => {
                      setShowCallPicker(false);
                      void handleCall('audio');
                    }}
                  >
                    📞 Voice Call
                  </button>
                  <button
                    id="call-option-video"
                    data-testid="call-option-video"
                    type="button"
                    className="dropdown-item"
                    onClick={() => {
                      setShowCallPicker(false);
                      void handleCall('video');
                    }}
                  >
                    📹 Video Call
                  </button>
                </div>
              )}
            </div>
          )}
          {isPasscodeEnabled && (
            <button
              id="chat-quick-lock-btn"
              data-testid="chat-quick-lock-btn"
              type="button"
              onClick={lockApp}
              className="header-action-btn quick-lock-btn"
              title="Lock RootInbox instantly"
              aria-label="Lock app"
            >
              🔒
            </button>
          )}
          <div ref={overflowMenuRef} style={{ position: 'relative' }}>
            <button
              id="chat-overflow-btn"
              data-testid="chat-overflow-btn"
              type="button"
              onClick={() => setShowOverflowMenu((prev) => !prev)}
              className="header-action-btn header-action-btn--overflow"
              title="More actions"
            >
              ⋮
            </button>
            {showOverflowMenu && (
              <div id="chat-overflow-menu" data-testid="chat-overflow-menu" className="dropdown-menu">
                {!isSelf && !isGroupOrChannel && activeConv?.peerIdentityHash && !peerInContacts && (
                  <button
                    id="add-contact-from-chat-btn"
                    data-testid="add-contact-from-chat-btn"
                    type="button"
                    className="dropdown-item"
                    onClick={() => {
                      setShowOverflowMenu(false);
                      void handleAddContact();
                    }}
                  >
                    👤 Add to Contacts
                  </button>
                )}
                <button
                  id="menu-clear-history"
                  data-testid="menu-clear-history"
                  type="button"
                  className="dropdown-item"
                  onClick={() => {
                    setShowOverflowMenu(false);
                    void handleClearHistory();
                  }}
                >
                  🧹 Clear History
                </button>
                <button
                  id="menu-delete-chat"
                  data-testid="menu-delete-chat"
                  type="button"
                  className="dropdown-item dropdown-item--danger"
                  onClick={() => {
                    setShowOverflowMenu(false);
                    void handleDeleteConversation();
                  }}
                >
                  🗑️ Delete Chat
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Messages */}
      <div className="list-wrapper" dir="ltr" style={{ direction: 'ltr' }}>
        {filtered.length === 0 ? (
          <div className="empty-messages">
            <p className="empty-text">No messages yet. Send the first message below!</p>
          </div>
        ) : (
          <Virtuoso
            ref={virtuosoRef}
            data-testid="virtuoso-scroller"
            style={{ height: '100%' }}
            data={filtered}
            initialTopMostItemIndex={initialTopIndex}
            overscan={200}
            startReached={handleLoadEarlier}
            followOutput={(isAtBottom) => (isAtBottom ? 'auto' : false)}
            computeItemKey={(_index, msg) => msg?.id ?? String(_index)}
            components={{
              Header: () => (
                hasMoreEarlier ? (
                  <div style={{ textAlign: 'center', padding: '8px' }}>
                    <button
                      id="load-earlier-btn"
                      data-testid="load-earlier-btn"
                      type="button"
                      className="modal-btn modal-btn--secondary"
                      style={{ fontSize: '12px', padding: '4px 12px', margin: '4px auto' }}
                      disabled={isLoadingEarlier}
                      onClick={() => void handleLoadEarlier()}
                    >
                      {isLoadingEarlier ? 'Loading earlier messages...' : 'Load earlier messages'}
                    </button>
                  </div>
                ) : null
              ),
            }}
            itemContent={(_index, msg) => {
              if (!msg) return null;

              const sId = (msg.senderId || '').toLowerCase();
              const myIdLower = (currentUserId || '').toLowerCase();
              const myHashLower = (identityHash || '').toLowerCase();
              const myUserLower = (currentUsername || '').toLowerCase();
              const peerIdLower = (activeConv?.peerId || '').toLowerCase();
              const peerHashLower = (activeConv?.peerIdentityHash || '').toLowerCase();

              let isMe: boolean;
              if (isSelf || msg.isOutgoing || sId === 'self') {
                isMe = true;
              } else if (sId && myIdLower && sId === myIdLower) {
                isMe = true;
              } else if (sId && myHashLower && sId === myHashLower) {
                isMe = true;
              } else if (sId && myUserLower && sId === myUserLower) {
                isMe = true;
              } else if (sId && peerIdLower && sId === peerIdLower) {
                isMe = false;
              } else if (sId && peerHashLower && sId === peerHashLower) {
                isMe = false;
              } else {
                isMe = false;
              }

              const curTime = toMillis(msg.createdAt);
              const prevTime = toMillis(filtered[_index - 1]?.createdAt);
              const showDateDivider = _index === 0 || (
                Boolean(curTime && prevTime && new Date(curTime).toDateString() !== new Date(prevTime).toDateString())
              );
              const hasDividerTimestamp = unreadDividerTimestamp !== null && unreadDividerTimestamp !== undefined;
              const showUnreadSeparator = !isMe && (
                (Boolean(firstUnreadMessageId) && msg.id === firstUnreadMessageId) ||
                (hasDividerTimestamp &&
                  curTime > unreadDividerTimestamp! &&
                  (_index === 0 || (prevTime !== undefined && prevTime <= unreadDividerTimestamp!)))
              );

              if (msg.messageType === 'call' && msg.callMetadata) {
                const meta = msg.callMetadata;
                const isVideo = meta.callType === 'video';
                const icon = isVideo ? '📹' : '📞';
                const isOutgoing = meta.direction === 'outgoing';
                const mins = Math.floor((meta.duration || 0) / 60);
                const secs = (meta.duration || 0) % 60;
                const durStr = `${mins}:${secs.toString().padStart(2, '0')}`;

                let statusText: string;
                let statusColor: string;
                if (meta.status === 'completed') {
                  statusText = `${isOutgoing ? 'Outgoing' : 'Incoming'} ${isVideo ? 'Video' : 'Voice'} Call (${durStr})`;
                  statusColor = 'var(--color-success)';
                } else if (meta.status === 'missed') {
                  statusText = `Missed ${isVideo ? 'Video' : 'Voice'} Call`;
                  statusColor = 'var(--color-danger)';
                } else if (meta.status === 'rejected') {
                  statusText = `Declined Call`;
                  statusColor = 'var(--color-danger)';
                } else if (meta.status === 'busy') {
                  statusText = `Line Busy`;
                  statusColor = 'var(--color-warning)';
                } else {
                  statusText = `Call Failed`;
                  statusColor = 'var(--color-danger)';
                }

                return (
                  <div key={msg.id ?? _index}>
                    {showDateDivider && msg.createdAt && (
                      <div className="date-divider">
                        <span className="date-divider-pill">
                          {formatDateDivider(msg.createdAt)}
                        </span>
                      </div>
                    )}
                    {showUnreadSeparator && (
                      <div className="unread-separator" id="unread-messages-separator">
                        <span className="unread-separator-line" />
                        <div className="unread-separator-badge">
                          <svg className="unread-separator-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                            <polyline points="7 13 12 18 17 13"></polyline>
                            <polyline points="7 6 12 11 17 6"></polyline>
                          </svg>
                          <span>Unread Messages</span>
                        </div>
                        <span className="unread-separator-line" />
                      </div>
                    )}
                    <div
                      id={`msg-${msg.id ?? _index}`}
                      className="msg-row msg-row--center"
                      dir="ltr"
                      style={{ direction: 'ltr' }}
                    >
                      <div className="call-bubble">
                        <span style={{ fontSize: '18px' }}>{icon}</span>
                        <div style={{ display: 'flex', flexDirection: 'column' }}>
                          <span style={{ fontSize: '13px', fontWeight: 600, color: statusColor }}>
                            {statusText}
                          </span>
                          <span style={{ fontSize: '11px', color: 'var(--color-text-tertiary)', marginTop: '2px' }}>
                            {msg.createdAt ? new Date(toMillis(msg.createdAt)).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''}
                          </span>
                        </div>
                        {!isSelf && activeConv?.peerIdentityHash && callStatus === 'idle' && (
                          <button
                            type="button"
                            onClick={() => void handleCall(isVideo ? 'video' : 'audio')}
                            className="call-again-btn"
                            title={`Call back (${isVideo ? 'video' : 'voice'})`}
                          >
                            Call back
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                );
              }

              const isMedia = msg.messageType === 'media' && !!msg.mediaMetadata;
              const isDeleted = Boolean(msg.deletedAt && msg.deletedAt > 0);
              const isEditing = editingMessageId === msg.id;

              // Quoted reply resolution
              const replyTarget = msg.replyToId ? filtered.find((m) => m.id === msg.replyToId) : null;

              return (
                <div key={msg.id ?? _index}>
                  {showDateDivider && msg.createdAt && (
                    <div className="date-divider">
                      <span className="date-divider-pill">
                        {formatDateDivider(msg.createdAt)}
                      </span>
                    </div>
                  )}
                  {showUnreadSeparator && (
                    <div className="unread-separator" id="unread-messages-separator">
                      <span className="unread-separator-line" />
                      <div className="unread-separator-badge">
                        <svg className="unread-separator-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                          <polyline points="7 13 12 18 17 13"></polyline>
                          <polyline points="7 6 12 11 17 6"></polyline>
                        </svg>
                        <span>Unread Messages</span>
                      </div>
                      <span className="unread-separator-line" />
                    </div>
                  )}
                  <div
                    id={`msg-${msg.id ?? _index}`}
                    className={`msg-row ${isMe ? 'msg-row--own' : 'msg-row--peer'}`}
                    dir="ltr"
                    style={{ direction: 'ltr' }}
                  >
                    {!isMe && (
                      <div className="msg-avatar-col">
                        <Avatar
                          userId={msg.senderId}
                          name={getSenderDisplayName(msg)}
                          size="xs"
                        />
                      </div>
                    )}
                    <div
                      id={`msg-bubble-${msg.id}`}
                      data-testid={`msg-bubble-${msg.id}`}
                      onDoubleClick={() => {
                        if (!isDeleted) {
                          setReplyingTo(msg);
                        }
                      }}
                      title={!isDeleted ? 'Double-click to reply' : undefined}
                      className={`bubble ${isMedia ? 'bubble--media' : isMe ? 'bubble--own' : 'bubble--peer'}`}
                      style={{ cursor: !isDeleted ? 'pointer' : 'default' }}
                    >
                      {!isMe && (
                        <div className="sender-label">
                          {getSenderDisplayName(msg)}
                        </div>
                      )}

                      {/* Quoted Reply Box */}
                      {msg.replyToId && (
                        <div className="quoted-reply">
                          <div className="quoted-reply-content">
                            <span className="quoted-reply-author">
                              ↩️ {replyTarget ? getSenderDisplayName(replyTarget) : 'Reply'}
                            </span>
                            <span className="quoted-reply-text">
                              {replyTarget?.plaintext ? replyTarget.plaintext.substring(0, 60) : 'Original message not available'}
                            </span>
                          </div>
                        </div>
                      )}

                      {/* Message Body or Inline Editor or Deleted Placeholder */}
                      {isDeleted ? (
                        <div className="deleted-msg-body">
                          🚫 <em>[This message was deleted]</em>
                        </div>
                      ) : isEditing ? (
                        <div className="inline-edit-box">
                          <input
                            id={`edit-input-${msg.id}`}
                            type="text"
                            value={editContent}
                            onChange={(e) => setEditContent(e.target.value)}
                            className="edit-input"
                            autoFocus
                          />
                          <div className="edit-btn-row">
                            <button
                              id={`save-edit-${msg.id}`}
                              type="button"
                              className="edit-save-btn"
                              onClick={() => void handleEdit(msg.id)}
                            >
                              Save
                            </button>
                            <button
                              id={`cancel-edit-${msg.id}`}
                              type="button"
                              className="edit-cancel-btn"
                              onClick={() => setEditingMessageId(null)}
                            >
                              Cancel
                            </button>
                          </div>
                        </div>
                      ) : (
                        <div className="msg-body" dir="auto" style={{ unicodeBidi: 'plaintext', overflowWrap: 'anywhere', wordBreak: 'break-word' }}>
                          {isMedia ? (
                            <MediaAttachmentBubble
                              metadata={msg.mediaMetadata}
                              fileName={msg.fileName || (msg.plaintext && !msg.plaintext.startsWith('[Media]') ? msg.plaintext : 'attachment')}
                              downloadUseCase={downloadMediaUC}
                              status={msg.status}
                              uploadProgress={msg.uploadProgress}
                              uploadProgressBytes={msg.uploadProgressBytes}
                              uploadTotalBytes={msg.uploadTotalBytes}
                              uploadError={msg.uploadError}
                              onRetryUpload={
                                retryUploadMap.current.get(msg.id) ||
                                (msg.fileName ? retryUploadMap.current.get(msg.fileName) : undefined) ||
                                (msg.mediaMetadata?.file_name ? retryUploadMap.current.get(msg.mediaMetadata.file_name) : undefined)
                              }
                              onCancelUpload={() => void cancelSending(msg.id)}
                            />
                          ) : msg.messageType === 'call' ? (
                            <div
                              className={`call-message-bubble ${
                                msg.callMetadata?.status === 'missed' ? 'call-message-bubble--missed' : ''
                              }`}
                            >
                              <span className="call-bubble-icon">
                                {msg.callMetadata?.callType === 'video' ? '📹' : '📞'}
                              </span>
                              <div className="call-bubble-content">
                                <span className="call-bubble-title">
                                  {msg.callMetadata?.status === 'missed'
                                    ? `تماس ${msg.callMetadata?.callType === 'video' ? 'تصویری' : 'صوتی'} بی‌پاسخ`
                                    : msg.callMetadata?.status === 'rejected'
                                      ? `تماس ${msg.callMetadata?.callType === 'video' ? 'تصویری' : 'صوتی'} رد شده`
                                      : `تماس ${msg.callMetadata?.callType === 'video' ? 'تصویری' : 'صوتی'}`}
                                </span>
                                {msg.callMetadata?.status === 'completed' && typeof msg.callMetadata?.duration === 'number' && (
                                  <span className="call-bubble-duration">
                                    {Math.floor(msg.callMetadata.duration / 60)}:{(msg.callMetadata.duration % 60).toString().padStart(2, '0')}
                                  </span>
                                )}
                              </div>
                            </div>
                          ) : (
                            renderPlaintext(msg.plaintext)
                          )}
                        </div>
                      )}

                      {/* Meta & Actions Bar */}
                      <div className={`msg-meta ${isMe ? '' : 'msg-meta--peer'}`}>
                        <span className="meta-time">
                          {msg.createdAt ? new Date(toMillis(msg.createdAt)).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''}
                          {msg.editedAt && !isDeleted ? ' (edited)' : ''}
                        </span>
                        {isMe && !isDeleted && (() => {
                          let computedStatus = msg.status;
                          const peerDelivered = activeConv?.peerLastDeliveredAt;
                          const peerRead = activeConv?.peerLastReadAt;
                          const msgCreatedAt = toMillis(msg.createdAt);

                          if (computedStatus !== 'failed') {
                            if (peerRead && msgCreatedAt <= peerRead) {
                              computedStatus = 'seen';
                            } else if (peerDelivered && msgCreatedAt <= peerDelivered) {
                              if (computedStatus !== 'seen') {
                                computedStatus = 'delivered';
                              }
                            } else if (msg.serverId && msg.serverId > 0) {
                              if (computedStatus === 'pending') {
                                computedStatus = 'sent';
                              }
                            }
                          }

                          return (
                            <>
                              <span
                                id={`msg-status-${msg.id}`}
                                className={`meta-status ${
                                  computedStatus === 'seen'
                                    ? 'meta-status--read'
                                    : computedStatus === 'delivered'
                                      ? 'meta-status--delivered'
                                      : computedStatus === 'sent'
                                        ? 'meta-status--sent'
                                        : computedStatus === 'failed'
                                          ? 'meta-status--failed'
                                          : 'meta-status--pending'
                                }`}
                                title={`Status: ${computedStatus}`}
                              >
                                {computedStatus === 'seen'
                                  ? '✓✓'
                                  : computedStatus === 'delivered'
                                    ? '✓✓'
                                    : computedStatus === 'sent'
                                      ? '✓'
                                      : computedStatus === 'failed'
                                        ? '✗'
                                        : '⏳'}
                              </span>

                              {/* H5: Visible cancel button on pending / in-progress message */}
                              {computedStatus === 'pending' && (
                                <button
                                  id={`msg-cancel-btn-${msg.id}`}
                                  data-testid={`msg-cancel-btn-${msg.id}`}
                                  type="button"
                                  className="msg-cancel-btn"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    void cancelSending(msg.id);
                                  }}
                                  style={{
                                    marginLeft: '4px',
                                    padding: '1px 5px',
                                    fontSize: '10px',
                                    color: '#ef4444',
                                    backgroundColor: 'rgba(239, 68, 68, 0.12)',
                                    border: '1px solid rgba(239, 68, 68, 0.3)',
                                    borderRadius: '4px',
                                    cursor: 'pointer',
                                    lineHeight: '1.2',
                                  }}
                                  title="Cancel message"
                                >
                                  ✕ Cancel
                                </button>
                              )}

                              {/* H4: Visible retry & delete actions on failed message */}
                              {computedStatus === 'failed' && (
                                <span style={{ display: 'inline-flex', gap: '4px', marginLeft: '4px' }}>
                                  <button
                                    id={`msg-retry-btn-${msg.id}`}
                                    data-testid={`msg-retry-btn-${msg.id}`}
                                    type="button"
                                    className="msg-retry-btn"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      const retryFn = retryUploadMap.current.get(msg.id) || (msg.fileName ? retryUploadMap.current.get(msg.fileName) : undefined);
                                      if (retryFn) {
                                        retryFn();
                                      } else {
                                        void retryMessage(msg.id);
                                      }
                                    }}
                                    style={{
                                      padding: '1px 5px',
                                      fontSize: '10px',
                                      color: '#38bdf8',
                                      backgroundColor: 'rgba(56, 189, 248, 0.12)',
                                      border: '1px solid rgba(56, 189, 248, 0.3)',
                                      borderRadius: '4px',
                                      cursor: 'pointer',
                                      lineHeight: '1.2',
                                    }}
                                    title="Retry sending message"
                                  >
                                    🔄 Retry
                                  </button>
                                  <button
                                    id={`msg-delete-btn-${msg.id}`}
                                    data-testid={`msg-delete-btn-${msg.id}`}
                                    type="button"
                                    className="msg-delete-btn"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      void deleteFailedMessage(msg.id);
                                    }}
                                    style={{
                                      padding: '1px 5px',
                                      fontSize: '10px',
                                      color: '#ef4444',
                                      backgroundColor: 'rgba(239, 68, 68, 0.12)',
                                      border: '1px solid rgba(239, 68, 68, 0.3)',
                                      borderRadius: '4px',
                                      cursor: 'pointer',
                                      lineHeight: '1.2',
                                    }}
                                    title="Delete failed message"
                                  >
                                    🗑️ Delete
                                  </button>
                                </span>
                              )}
                            </>
                          );
                        })()}

                        {/* Action trigger button ("!" or "⋯") + popover */}
                        {!isDeleted && (
                          <div style={{ position: 'relative', display: 'inline-flex', alignItems: 'center', marginLeft: '6px' }}>
                            <button
                              id={`msg-actions-btn-${msg.id}`}
                              data-testid={`msg-actions-btn-${msg.id}`}
                              type="button"
                              className="action-trigger-btn"
                              onClick={(e) => {
                                e.stopPropagation();
                                setActiveActionMsgId(activeActionMsgId === msg.id ? null : msg.id);
                              }}
                              title="Message actions"
                            >
                              ⋯
                            </button>
                            {activeActionMsgId === msg.id && (
                              <div
                                id={`msg-actions-popover-${msg.id}`}
                                data-testid={`msg-actions-popover-${msg.id}`}
                                className="msg-actions-popover"
                                onClick={(e) => e.stopPropagation()}
                              >
                                {isMe && (
                                  <button
                                    id={`edit-btn-${msg.id}`}
                                    data-testid={`edit-btn-${msg.id}`}
                                    type="button"
                                    className="popover-action-btn"
                                    onClick={() => {
                                      setActiveActionMsgId(null);
                                      setEditingMessageId(msg.id);
                                      setEditContent(msg.plaintext || '');
                                    }}
                                    title="Edit message"
                                  >
                                    ✏️ Edit
                                  </button>
                                )}
                                <button
                                  id={`copy-btn-${msg.id}`}
                                  data-testid={`copy-btn-${msg.id}`}
                                  type="button"
                                  className="popover-action-btn"
                                  onClick={() => {
                                    setActiveActionMsgId(null);
                                    void handleCopy(msg);
                                  }}
                                  title={copiedMsgId === msg.id ? 'Copied!' : 'Copy message text'}
                                >
                                  {copiedMsgId === msg.id ? '✓ Copied' : '📋 Copy'}
                                </button>
                                <button
                                  id={`forward-btn-${msg.id}`}
                                  data-testid={`forward-btn-${msg.id}`}
                                  type="button"
                                  className="popover-action-btn"
                                  onClick={() => {
                                    setActiveActionMsgId(null);
                                    setForwardingMsg(msg);
                                  }}
                                  title="Forward message"
                                >
                                  ➡️ Forward
                                </button>
                                <button
                                  id={`delete-btn-${msg.id}`}
                                  data-testid={`delete-btn-${msg.id}`}
                                  type="button"
                                  className="popover-action-btn popover-action-btn--danger"
                                  onClick={() => {
                                    setActiveActionMsgId(null);
                                    setDeleteTargetMsg(msg);
                                  }}
                                  title="Delete message"
                                >
                                  🗑️ Delete
                                </button>
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              );
            }}
          />
        )}
      </div>

      {/* Upload Progress Indicator */}
      {uploading && (
        <div className="upload-progress-banner">
          <span>Encrypting & uploading attachment...</span>
          {uploadProgress && (
            <span className="progress-percent">
              {Math.round((uploadProgress.bytesUploaded / Math.max(1, uploadProgress.totalBytes)) * 100)}%
            </span>
          )}
        </div>
      )}
      {uploadError && (
        <div className="upload-error-banner">
          <span>Upload failed: {uploadError}</span>
        </div>
      )}

      {/* Replying Banner */}
      {replyingTo && (
        <div className="replying-bar">
          <div className="replying-text">
            ↩️ Replying to <strong>{replyingTo.senderId === identityHash || replyingTo.senderId === currentUserId ? 'yourself' : getSenderDisplayName(replyingTo)}</strong>: "{replyingTo.plaintext.substring(0, 45)}..."
          </div>
          <button
            id="cancel-reply-btn"
            type="button"
            className="cancel-reply-btn"
            onClick={() => setReplyingTo(null)}
            title="Cancel reply"
          >
            ✕
          </button>
        </div>
      )}

      {/* Message Compose Form or Read-Only Channel Banner */}
      {isSubscriber ? (
        <div id="channel-read-only-banner" className="subscriber-read-only-banner">
          📢 Only channel administrators can post in this channel
        </div>
      ) : (
        <form id="chat-form" onSubmit={(e) => void handleSend(e)} className="compose-form">
          {/* Attachment Button */}
          <button
            id="attach-file-btn"
            data-testid="attach-file-btn"
            type="button"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setShowAttachmentMenu((prev) => !prev);
            }}
            className="attach-btn"
            title={isGroupOrChannel ? 'Attach file or image' : 'Attach file, image, or document (E2EE encrypted)'}
          >
            📎
          </button>

          {isRecordingVoice ? (
            <div
              id="voice-recording-indicator"
              data-testid="voice-recording-indicator"
              style={{
                flex: 1,
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                padding: '0 12px',
                color: '#ef4444',
                fontWeight: 600,
                fontSize: '14px',
              }}
            >
              <span className="recording-dot">🔴</span>
              <span>Recording... {Math.floor(voiceDuration / 60)}:{(voiceDuration % 60).toString().padStart(2, '0')}</span>
              <button
                type="button"
                id="cancel-voice-btn"
                data-testid="cancel-voice-btn"
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  handleCancelVoiceRecording(e as unknown as React.PointerEvent);
                }}
                style={{
                  background: 'transparent',
                  border: 'none',
                  color: '#94a3b8',
                  fontSize: '16px',
                  cursor: 'pointer',
                  padding: '2px 6px',
                  lineHeight: 1,
                }}
                title="Cancel recording"
              >
                ✕
              </button>
              <span style={{ fontSize: '12px', color: '#94a3b8', marginLeft: 'auto' }}>Release to send</span>
            </div>
          ) : (
            <input
              id="chat-input"
              dir="auto"
              type="text"
              placeholder="Type a message..."
              ref={chatInputRef}
              value={inputText}
              onChange={(e) => setInputText(e.target.value)}
              className="compose-input"
              autoComplete="off"
            />
          )}

          <button
            id="voice-record-btn"
            data-testid="voice-record-btn"
            type="button"
            className={`voice-record-btn ${isRecordingVoice ? 'voice-record-btn--recording' : ''}`}
            title="Hold to record voice message"
            onPointerDown={handleStartVoiceRecording}
            onPointerUp={handleStopVoiceRecording}
            onPointerCancel={handleCancelVoiceRecording}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: '38px',
              height: '38px',
              borderRadius: '50%',
              border: 'none',
              background: isRecordingVoice ? '#ef4444' : 'rgba(255, 255, 255, 0.08)',
              color: '#ffffff',
              fontSize: '18px',
              cursor: 'pointer',
              userSelect: 'none',
              touchAction: 'none',
              marginRight: '6px',
            }}
          >
            🎤
          </button>

          <button
            id="chat-send-btn"
            data-testid="chat-send"
            type="submit"
            disabled={sending}
            onMouseDown={(e) => e.preventDefault()}
            onTouchStart={(e) => e.preventDefault()}
            onClick={(e) => void handleSend(e)}
            className="send-btn"
          >
            {sending ? '...' : 'Send'}
          </button>
        </form>
      )}

      {/* 4 Persistent Offscreen File Inputs for Mobile & Desktop (Outside Form) */}
      <input
        id="attach-gallery-input"
        data-testid="attach-gallery-input"
        type="file"
        ref={galleryInputRef}
        accept="image/*,video/*"
        multiple
        className="visually-hidden-file-input"
        onChange={handleFilesSelected}
      />
      <input
        id="attach-camera-input"
        data-testid="attach-camera-input"
        type="file"
        ref={cameraInputRef}
        accept="image/*,video/*"
        capture="environment"
        className="visually-hidden-file-input"
        onChange={handleFilesSelected}
      />
      <input
        id="attach-file-input"
        data-testid="attach-file-input"
        type="file"
        ref={fileInputRef}
        accept="*/*"
        multiple
        className="visually-hidden-file-input"
        onChange={handleFilesSelected}
      />
      <input
        id="attach-audio-input"
        data-testid="attach-audio-input"
        type="file"
        ref={audioInputRef}
        accept="audio/*"
        multiple
        className="visually-hidden-file-input"
        onChange={handleFilesSelected}
      />

      {/* Attachment Menu (Outside Form, Portaled to document.body) */}
      <AttachmentMenu
        isOpen={showAttachmentMenu}
        onClose={() => setShowAttachmentMenu(false)}
        onTriggerGallery={() => galleryInputRef.current?.click()}
        onTriggerCamera={() => cameraInputRef.current?.click()}
        onTriggerFile={() => fileInputRef.current?.click()}
        onTriggerAudio={() => audioInputRef.current?.click()}
        onSelectFile={(file) => {
          setPendingMediaQueue((prev) => [...prev, file]);
        }}
      />

      {/* Send Media Preview Modal */}
      <SendMediaPreviewModal
        file={pendingMediaFile}
        isOpen={!!pendingMediaFile}
        initialCaption={inputText}
        onClose={() => {
          if (isSendingMediaRef.current) {
            isSendingMediaRef.current = false;
            setPendingMediaQueue((prev) => prev.slice(1));
          } else {
            setPendingMediaQueue([]);
          }
        }}
        onSend={(file, caption, previewDataUrl) => {
          isSendingMediaRef.current = true;
          void handleSendMedia(file, caption, previewDataUrl);
        }}
      />

      {/* Group Members Modal */}
      <GroupMembersModal
        isOpen={showMembersModal}
        onClose={() => setShowMembersModal(false)}
        conversationId={conversationId}
        conversationName={activeConv?.name}
        conversationType={activeConv?.type}
      />

      {/* Delete Message Dialog */}
      {deleteTargetMsg && (
        <div className="modal-backdrop" onClick={() => setDeleteTargetMsg(null)}>
          <div className="modal-card modal-card--narrow" onClick={(e) => e.stopPropagation()}>
            <div className="modal-title">Delete Message</div>
            <div style={{ fontSize: 'var(--font-sm)', color: 'var(--color-text-secondary)', marginBottom: 'var(--space-4)', lineHeight: 1.4 }}>
              {deleteTargetMsg.senderId === identityHash && !isSelf
                ? 'Would you like to delete this message only for yourself, or for both participants?'
                : 'Are you sure you want to delete this message from this device?'}
            </div>
            <div className="modal-footer">
              <button
                id="cancel-delete-msg-btn"
                type="button"
                className="modal-btn modal-btn--cancel"
                onClick={() => setDeleteTargetMsg(null)}
              >
                Cancel
              </button>
              <button
                id="delete-for-me-btn"
                type="button"
                className="modal-btn modal-btn--secondary"
                onClick={() => void handleConfirmDelete('me')}
              >
                Delete for me
              </button>
              {((deleteTargetMsg.senderId === identityHash && !isSelf) || (isGroupOrChannel && (channelRole === 'ADMIN' || channelRole === 'OWNER'))) && (
                <button
                  id="delete-for-both-btn"
                  type="button"
                  className="modal-btn modal-btn--danger"
                  onClick={() => void handleConfirmDelete('both')}
                >
                  {isGroupOrChannel ? 'Delete for everyone' : 'Delete for both'}
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Clear History Dialog */}
      {showClearHistoryDialog && (
        <div className="modal-backdrop" onClick={() => setShowClearHistoryDialog(false)}>
          <div className="modal-card modal-card--narrow" onClick={(e) => e.stopPropagation()}>
            <div className="modal-title">Clear Message History</div>
            <div style={{ fontSize: 'var(--font-sm)', color: 'var(--color-text-secondary)', marginBottom: 'var(--space-4)', lineHeight: 1.4 }}>
              {!isSelf
                ? 'Would you like to clear history only for yourself, or for both participants?'
                : 'Are you sure you want to clear message history? All messages in this chat will be deleted from this device.'}
            </div>
            <div className="modal-footer">
              <button
                id="cancel-clear-history-btn"
                type="button"
                className="modal-btn modal-btn--cancel"
                onClick={() => setShowClearHistoryDialog(false)}
              >
                Cancel
              </button>
              <button
                id="clear-for-me-btn"
                data-testid="clear-for-me-btn"
                type="button"
                className="modal-btn modal-btn--secondary"
                onClick={() => void handleConfirmClearHistory('me')}
              >
                Clear for me
              </button>
              {!isSelf && (
                <button
                  id="clear-for-both-btn"
                  data-testid="clear-for-both-btn"
                  type="button"
                  className="modal-btn modal-btn--danger"
                  onClick={() => void handleConfirmClearHistory('both')}
                >
                  {isGroupOrChannel ? 'Clear for everyone' : 'Clear for both'}
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Delete Conversation Dialog */}
      {showDeleteConvDialog && (
        <div className="modal-backdrop" onClick={() => setShowDeleteConvDialog(false)}>
          <div className="modal-card modal-card--narrow" onClick={(e) => e.stopPropagation()}>
            <div className="modal-title">Delete Conversation</div>
            <div style={{ fontSize: 'var(--font-sm)', color: 'var(--color-text-secondary)', marginBottom: 'var(--space-4)', lineHeight: 1.4 }}>
              {!isSelf
                ? 'Would you like to delete this entire conversation only for yourself, or for both participants?'
                : 'Are you sure you want to delete this entire conversation? All messages will be permanently removed from this device.'}
            </div>
            <div className="modal-footer">
              <button
                id="cancel-delete-conv-btn"
                type="button"
                className="modal-btn modal-btn--cancel"
                onClick={() => setShowDeleteConvDialog(false)}
              >
                Cancel
              </button>
              <button
                id="delete-conv-for-me-btn"
                data-testid="delete-conv-for-me-btn"
                type="button"
                className="modal-btn modal-btn--secondary"
                onClick={() => void handleConfirmDeleteConversation('me')}
              >
                Delete for me
              </button>
              {!isSelf && (
                <button
                  id="delete-conv-for-both-btn"
                  data-testid="delete-conv-for-both-btn"
                  type="button"
                  className="modal-btn modal-btn--danger"
                  onClick={() => void handleConfirmDeleteConversation('both')}
                >
                  {isGroupOrChannel ? 'Delete for everyone' : 'Delete for both'}
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Forward Modal */}
      <ForwardModal
        isOpen={!!forwardingMsg}
        onClose={() => setForwardingMsg(null)}
        message={forwardingMsg}
        conversations={conversations || []}
        contacts={contacts || []}
        onForward={async (targetId) => {
          if (forwardingMsg) {
            await forwardMessage(targetId, forwardingMsg);
          }
        }}
        createConversation={createConversation}
      />

      <PeerProfileModal
        userId={activeConv?.peerId || peerUserId || undefined}
        isOpen={showPeerProfileModal}
        onClose={() => setShowPeerProfileModal(false)}
      />
    </div>
  );
}

/**
 * Render plaintext with link detection.
 * Links: rel="noopener noreferrer" with click-confirm.
 * Plain JSX interpolation only — NO dangerouslySetInnerHTML.
 */
function renderPlaintext(text?: string | null): React.ReactNode {
  if (!text) return '';
  const parts = text.split(URL_REGEX);
  const urls = text.match(URL_REGEX);

  if (!urls) {
    return (
      <span dir="auto" style={{ unicodeBidi: 'plaintext' }}>
        {text}
      </span>
    );
  }

  const nodes: React.ReactNode[] = [];
  for (let i = 0; i < parts.length; i++) {
    if (parts[i]) {
      nodes.push(
        <span key={`text-${i}`} dir="auto" style={{ unicodeBidi: 'plaintext' }}>
          {parts[i]}
        </span>,
      );
    }
    if (i < (urls?.length ?? 0)) {
      const url = urls[i];
      nodes.push(
        <a
          key={`link-${i}`}
          href={url}
          rel="noopener noreferrer"
          target="_blank"
          className="msg-link"
          onClick={(e) => {
            if (!confirm(`Open external link?\n${url}`)) {
              e.preventDefault();
            }
          }}
        >
          {url}
        </a>,
      );
    }
  }
  return nodes;
}
