/**
 * CreateGroupModal — dialog to create a Group Chat or Channel.
 * RFC-0010 §4.2: Presentation layer, uses domain types & usecases only.
 * Clean Architecture strictly enforced: zero infrastructure imports.
 */

import { useState, useMemo } from 'react';
import { useChat, useContacts } from '../../hooks';
import { useAppContext } from '../../context';
import { Avatar } from '../common/Avatar';

interface CreateGroupModalProps {
  isOpen: boolean;
  onClose: () => void;
  defaultType?: 'GROUP' | 'CHANNEL';
}

export function CreateGroupModal({ isOpen, onClose, defaultType = 'GROUP' }: CreateGroupModalProps) {
  const { chatUC } = useAppContext();
  const { loadConversations, selectConversation, conversations } = useChat();
  const { contacts } = useContacts();

  const [type, setType] = useState<'GROUP' | 'CHANNEL'>(defaultType);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [isPublic, setIsPublic] = useState(false);
  const [publicUsername, setPublicUsername] = useState('');
  const [manualUsernames, setManualUsernames] = useState('');
  const [selectedUsernames, setSelectedUsernames] = useState<Set<string>>(new Set());
  const [showManualInput, setShowManualInput] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Build selectable contact candidates from saved contacts + direct chats
  const contactOptions = useMemo(() => {
    const list: Array<{ id: string; username: string; displayName: string; userId?: string }> = [];
    const seen = new Set<string>();

    for (const c of contacts) {
      const uName = (c.nickname || '').replace(/^@/, '').trim();
      if (uName && !seen.has(uName.toLowerCase())) {
        seen.add(uName.toLowerCase());
        list.push({
          id: c.peer_user_id || uName,
          username: uName,
          displayName: c.nickname,
          userId: c.peer_user_id,
        });
      }
    }

    for (const conv of conversations || []) {
      if (conv.type === 'DIRECT' && conv.peer_username) {
        const uName = conv.peer_username.replace(/^@/, '').trim();
        if (uName && !seen.has(uName.toLowerCase())) {
          seen.add(uName.toLowerCase());
          const fullName = [conv.peer_display_name, conv.peer_last_name].filter(Boolean).join(' ') || conv.peer_display_name;
          list.push({
            id: conv.peerId || uName,
            username: uName,
            displayName: fullName || `@${uName}`,
            userId: conv.peerId,
          });
        }
      }
    }
    return list;
  }, [contacts, conversations]);

  if (!isOpen) return null;

  const toggleContact = (username: string) => {
    setSelectedUsernames((prev) => {
      const next = new Set(prev);
      if (next.has(username)) {
        next.delete(username);
      } else {
        next.add(username);
      }
      return next;
    });
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmedName = name.trim();
    if (!trimmedName) {
      setError('Name is required');
      return;
    }

    // Collect usernames from selected contacts & manual input
    const usernames = new Set<string>(selectedUsernames);
    if (manualUsernames.trim()) {
      const parts = manualUsernames.split(/[,\s]+/);
      for (const p of parts) {
        const clean = p.replace(/^@/, '').trim();
        if (clean) usernames.add(clean);
      }
    }

    const memberList = Array.from(usernames);

    if (isPublic) {
      const cleanHandle = publicUsername.trim().replace(/^@/, '');
      if (cleanHandle.length < 3) {
        setError('Public username must be at least 3 characters long.');
        return;
      }
    }

    setLoading(true);
    setError(null);
    try {
      let convId: string;
      const cleanUsername = isPublic ? publicUsername.trim().replace(/^@/, '') : undefined;
      if (type === 'GROUP') {
        convId = await chatUC.createGroup(trimmedName, description.trim() || undefined, memberList, isPublic, cleanUsername);
      } else {
        convId = await chatUC.createChannel(trimmedName, description.trim() || undefined, memberList, isPublic, cleanUsername);
      }
      await loadConversations();
      await selectConversation(convId);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create group');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div id="create-group-modal" className="modal-card" style={{ maxWidth: '480px' }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2 className="modal-title">
            {type === 'GROUP' ? '👥 New Group Chat' : '📢 New Channel'}
          </h2>
          <button id="close-create-group-btn" type="button" className="modal-close-btn" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        <form onSubmit={(e) => void handleCreate(e)} className="modal-form">
          {/* Type Selector */}
          <div className="type-selector">
            <button
              id="type-group-btn"
              type="button"
              className={type === 'GROUP' ? 'type-btn--active' : 'type-btn'}
              onClick={() => setType('GROUP')}
            >
              👥 Group (All members talk)
            </button>
            <button
              id="type-channel-btn"
              type="button"
              className={type === 'CHANNEL' ? 'type-btn--active' : 'type-btn'}
              onClick={() => setType('CHANNEL')}
            >
              📢 Channel (Admin broadcast)
            </button>
          </div>

          {/* Name Field */}
          <div>
            <label className="modal-label" htmlFor="group-name-input">
              {type === 'GROUP' ? 'Group Name' : 'Channel Name'} *
            </label>
            <input
              id="group-name-input"
              type="text"
              placeholder={type === 'GROUP' ? 'e.g. Core Engineering' : 'e.g. Product Announcements'}
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="modal-input"
              maxLength={100}
              required
            />
          </div>

          {/* Description Field */}
          <div>
            <label className="modal-label" htmlFor="group-desc-input">
              Description (optional)
            </label>
            <textarea
              id="group-desc-input"
              placeholder="What is this conversation about?"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="modal-textarea"
              rows={2}
              maxLength={255}
            />
          </div>

          {/* Privacy Toggle: Private vs Public */}
          <div>
            <span className="modal-label">Privacy Type</span>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', marginTop: '6px' }}>
              <button
                id="privacy-private-btn"
                type="button"
                className={!isPublic ? 'type-btn--active' : 'type-btn'}
                onClick={() => setIsPublic(false)}
                style={{ textAlign: 'left', padding: '10px 12px' }}
              >
                <div style={{ fontWeight: 600, fontSize: '13px' }}>🔒 Private</div>
                <div style={{ fontSize: '11px', color: 'var(--color-text-secondary)', marginTop: '2px' }}>
                  Join via invite link only. Never in search.
                </div>
              </button>
              <button
                id="privacy-public-btn"
                type="button"
                className={isPublic ? 'type-btn--active' : 'type-btn'}
                onClick={() => setIsPublic(true)}
                style={{ textAlign: 'left', padding: '10px 12px' }}
              >
                <div style={{ fontWeight: 600, fontSize: '13px' }}>🌐 Public</div>
                <div style={{ fontSize: '11px', color: 'var(--color-text-secondary)', marginTop: '2px' }}>
                  Has unique username. Searchable by anyone.
                </div>
              </button>
            </div>
          </div>

          {/* Public Username input when Public is selected */}
          {isPublic && (
            <div>
              <label className="modal-label" htmlFor="public-username-input">
                Public Username *
              </label>
              <div style={{ display: 'flex', alignItems: 'center' }}>
                <span style={{
                  padding: '8px 12px',
                  background: 'var(--color-bg-secondary)',
                  border: '1px solid var(--color-border)',
                  borderRight: 'none',
                  borderRadius: '8px 0 0 8px',
                  color: 'var(--color-text-secondary)',
                  fontWeight: 600,
                }}>
                  @
                </span>
                <input
                  id="public-username-input"
                  type="text"
                  placeholder="group_or_channel_name"
                  value={publicUsername}
                  onChange={(e) => setPublicUsername(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, ''))}
                  className="modal-input"
                  style={{ borderRadius: '0 8px 8px 0' }}
                  maxLength={32}
                  required
                />
              </div>
              <div style={{ fontSize: '11px', color: 'var(--color-text-tertiary)', marginTop: '4px' }}>
                Lowercase letters (a-z), numbers (0-9), and underscores. Min 3 characters.
              </div>
            </div>
          )}

          {/* Member Selection from Contacts & Direct Chats (Optional) */}
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' }}>
              <span className="modal-label" style={{ margin: 0 }}>
                Add Members (optional):
              </span>
              <button
                type="button"
                style={{ background: 'none', border: 'none', color: 'var(--color-primary)', fontSize: '12px', cursor: 'pointer', padding: 0 }}
                onClick={() => setShowManualInput((prev) => !prev)}
              >
                {showManualInput ? 'Hide manual input' : '+ Add by username'}
              </button>
            </div>

            {contactOptions.length > 0 ? (
              <div style={{
                maxHeight: '160px',
                overflowY: 'auto',
                border: '1px solid var(--color-border)',
                borderRadius: '8px',
                padding: '6px',
                display: 'flex',
                flexDirection: 'column',
                gap: '4px',
              }}>
                {contactOptions.map((c) => {
                  const isChecked = selectedUsernames.has(c.username);
                  return (
                    <label
                      key={c.username}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '8px',
                        padding: '6px 8px',
                        borderRadius: '6px',
                        cursor: 'pointer',
                        background: isChecked ? 'var(--color-primary-bg)' : 'transparent',
                        transition: 'background 0.15s',
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={isChecked}
                        onChange={() => toggleContact(c.username)}
                        style={{ cursor: 'pointer' }}
                      />
                      <Avatar userId={c.userId} name={c.displayName} size="sm" />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: '13px', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {c.displayName}
                        </div>
                        <div style={{ fontSize: '11px', color: 'var(--color-text-tertiary)' }}>
                          @{c.username}
                        </div>
                      </div>
                    </label>
                  );
                })}
              </div>
            ) : (
              <div style={{ fontSize: '12px', color: 'var(--color-text-tertiary)', fontStyle: 'italic', padding: '6px 0' }}>
                No saved contacts or direct chats yet.
              </div>
            )}
          </div>

          {/* Manual Member Usernames input */}
          {showManualInput && (
            <div>
              <label className="modal-label" htmlFor="group-members-input">
                Add other usernames (comma or space separated):
              </label>
              <input
                id="group-members-input"
                type="text"
                placeholder="e.g. alice, bob"
                value={manualUsernames}
                onChange={(e) => setManualUsernames(e.target.value)}
                className="modal-input"
              />
            </div>
          )}

          {error && <div className="modal-error">{error}</div>}

          <div className="modal-footer">
            <button
              id="cancel-group-btn"
              type="button"
              className="modal-btn modal-btn--cancel"
              onClick={onClose}
              disabled={loading}
            >
              Cancel
            </button>
            <button
              id="submit-group-btn"
              type="submit"
              className="modal-btn modal-btn--primary"
              disabled={loading || !name.trim()}
            >
              {loading ? 'Creating...' : type === 'GROUP' ? 'Create Group' : 'Create Channel'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
