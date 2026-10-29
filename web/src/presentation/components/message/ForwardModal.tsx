import { useState } from 'react';
import { Avatar } from '../common/Avatar';
import type { ChatMessage, ConversationItem } from '../../../usecase/chat';
import type { ContactDTO } from '../../../domain';

interface ForwardModalProps {
  isOpen: boolean;
  onClose: () => void;
  message: ChatMessage | null;
  conversations: ConversationItem[];
  contacts: ContactDTO[];
  onForward: (targetConversationId: string) => Promise<void>;
  createConversation?: (peerIdentityHash: string) => Promise<string>;
}

export function ForwardModal({
  isOpen,
  onClose,
  message,
  conversations,
  contacts,
  onForward,
  createConversation,
}: ForwardModalProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedConvId, setSelectedConvId] = useState<string | null>(null);
  const [forwarding, setForwarding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!isOpen || !message) return null;

  // Filter conversations
  const q = searchQuery.trim().toLowerCase();
  const filteredConversations = conversations.filter((c) => {
    if (!q) return true;
    if (c.name && c.name.toLowerCase().includes(q)) return true;
    if (c.peerIdentityHash && c.peerIdentityHash.toLowerCase().includes(q)) return true;
    if (c.type === 'SELF' && 'my notes'.includes(q)) return true;
    return false;
  });

  // Also include contacts that don't have an existing active conversation in the list
  const existingPeerHashes = new Set(conversations.map((c) => c.peerIdentityHash).filter(Boolean));
  const additionalContacts = contacts.filter((ct) => {
    if (existingPeerHashes.has(ct.identity_hash)) return false;
    if (!q) return true;
    return (
      ct.nickname.toLowerCase().includes(q) ||
      ct.identity_hash.toLowerCase().includes(q)
    );
  });

  const handleSelect = (convId: string) => {
    setSelectedConvId(convId);
    setError(null);
  };

  const handleSelectContact = async (contact: ContactDTO) => {
    if (!createConversation) return;
    try {
      setForwarding(true);
      const convId = await createConversation(contact.identity_hash);
      setSelectedConvId(convId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create chat with contact');
    } finally {
      setForwarding(false);
    }
  };

  const handleConfirmForward = async () => {
    if (!selectedConvId || forwarding) return;
    try {
      setForwarding(true);
      setError(null);
      await onForward(selectedConvId);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to forward message');
    } finally {
      setForwarding(false);
    }
  };

  const previewSnippet = message.messageType === 'media'
    ? '📎 [Media attachment]'
    : message.plaintext || 'Message';

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-card modal-card--narrow" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3 className="modal-title">Forward Message</h3>
          <button
            id="close-forward-modal-btn"
            type="button"
            className="modal-close-btn"
            onClick={onClose}
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        {/* Message Preview */}
        <div className="forward-preview-box">
          <div className="forward-preview-label">Preview:</div>
          <div className="forward-preview-content">"{previewSnippet.substring(0, 80)}{previewSnippet.length > 80 ? '...' : ''}"</div>
        </div>

        {/* Search */}
        <div style={{ padding: 'var(--space-2) var(--space-4)' }}>
          <input
            id="forward-search-input"
            type="text"
            placeholder="Search chats or contacts..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="modal-input"
            autoFocus
          />
        </div>

        {error && <div className="modal-error" style={{ margin: '0 var(--space-4)' }}>{error}</div>}

        {/* Target List */}
        <div className="forward-target-list">
          {filteredConversations.map((conv) => {
            const isSelected = selectedConvId === conv.id;
            const isSelf = conv.type === 'SELF';
            const isGroup = conv.type === 'GROUP';
            const isChannel = conv.type === 'CHANNEL';
            const label = isSelf
              ? '📝 My Notes'
              : isGroup
                ? `👥 ${conv.name || 'Group Chat'}`
                : isChannel
                  ? `📢 ${conv.name || 'Channel'}`
                  : conv.name || (conv.peerIdentityHash ? `Peer: ${conv.peerIdentityHash.substring(0, 12)}...` : 'Direct Chat');

            return (
              <div
                key={conv.id}
                id={`forward-target-${conv.id}`}
                onClick={() => handleSelect(conv.id)}
                className="forward-target-item"
                style={{
                  backgroundColor: isSelected ? 'var(--color-bg-active)' : undefined,
                  borderColor: isSelected ? 'var(--color-accent)' : undefined,
                }}
              >
                <Avatar
                  userId={!isSelf && !isGroup && !isChannel ? conv.peerId : undefined}
                  name={label}
                  icon={isSelf ? '📝' : isGroup ? '👥' : isChannel ? '📢' : undefined}
                  size="sm"
                />
                <div className="forward-target-info">
                  <div className="forward-target-name">{label}</div>
                  <div className="forward-target-sub">
                    {isSelf
                      ? 'Encrypted Personal Storage'
                      : isGroup
                        ? 'Group Chat'
                        : isChannel
                          ? 'Broadcast Channel'
                          : 'End-to-End Encrypted'}
                  </div>
                </div>
                {isSelected && <span className="forward-selected-check">✓</span>}
              </div>
            );
          })}

          {additionalContacts.length > 0 && (
            <>
              <div className="forward-section-header">Contacts</div>
              {additionalContacts.map((ct) => (
                <div
                  key={ct.peer_user_id}
                  id={`forward-contact-${ct.peer_user_id}`}
                  onClick={() => void handleSelectContact(ct)}
                  className="forward-target-item"
                >
                  <Avatar userId={ct.peer_user_id} name={ct.nickname} size="sm" />
                  <div className="forward-target-info">
                    <div className="forward-target-name">{ct.nickname}</div>
                    <div className="forward-target-sub">
                      {ct.identity_hash.substring(0, 12)}...
                    </div>
                  </div>
                </div>
              ))}
            </>
          )}

          {filteredConversations.length === 0 && additionalContacts.length === 0 && (
            <div style={{ textAlign: 'center', color: 'var(--color-text-tertiary)', padding: 'var(--space-4)' }}>
              No chats or contacts found
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="modal-footer">
          <button
            id="cancel-forward-btn"
            type="button"
            className="modal-btn modal-btn--cancel"
            onClick={onClose}
            disabled={forwarding}
          >
            Cancel
          </button>
          <button
            id="confirm-forward-btn"
            type="button"
            className="modal-btn modal-btn--primary"
            style={{
              opacity: selectedConvId && !forwarding ? 1 : 0.5,
              cursor: selectedConvId && !forwarding ? 'pointer' : 'not-allowed',
            }}
            disabled={!selectedConvId || forwarding}
            onClick={() => void handleConfirmForward()}
          >
            {forwarding ? 'Forwarding...' : 'Forward'}
          </button>
        </div>
      </div>
    </div>
  );
}
