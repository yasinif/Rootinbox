/**
 * GroupMembersModal — view and manage group/channel members.
 * RFC-0010 §4.2: Presentation layer, uses domain types & usecases only.
 * Clean Architecture strictly enforced: zero infrastructure imports.
 */

import { useState, useEffect, useCallback } from 'react';
import { useAppContext } from '../../context';
import { useAuth } from '../../hooks';
import type { ConversationMemberDTO } from '../../../domain';
import { Avatar } from '../common/Avatar';

interface GroupMembersModalProps {
  isOpen: boolean;
  onClose: () => void;
  conversationId: string;
  conversationName?: string;
  conversationType?: string;
  createdBy?: string;
}

export function GroupMembersModal({
  isOpen,
  onClose,
  conversationId,
  conversationName,
  conversationType = 'GROUP',
}: GroupMembersModalProps) {
  const { chatUC } = useAppContext();
  const { identityHash } = useAuth();

  const [members, setMembers] = useState<ConversationMemberDTO[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Add member state
  const [newUsername, setNewUsername] = useState('');
  const [newRole, setNewRole] = useState<'MEMBER' | 'SUBSCRIBER' | 'ADMIN'>(
    conversationType === 'CHANNEL' ? 'SUBSCRIBER' : 'MEMBER',
  );
  const [adding, setAdding] = useState(false);

  const loadMembers = useCallback(async () => {
    if (!conversationId) return;
    setLoading(true);
    setError(null);
    try {
      const data = await chatUC.getGroupMembers(conversationId);
      setMembers(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load members');
    } finally {
      setLoading(false);
    }
  }, [chatUC, conversationId]);

  useEffect(() => {
    if (isOpen) {
      void loadMembers();
    }
  }, [isOpen, loadMembers]);

  if (!isOpen) return null;

  // Identify current user's role in this conversation
  const myMember = members.find((m) => m.identity_hash === identityHash);
  const isOwner = myMember?.role === 'OWNER';
  const isAdmin = myMember?.role === 'ADMIN' || isOwner;

  const handleAddMember = async (e: React.FormEvent) => {
    e.preventDefault();
    const clean = newUsername.trim().replace(/^@/, '');
    if (!clean) return;

    setAdding(true);
    setError(null);
    try {
      await chatUC.addGroupMember(conversationId, {
        username: clean,
        role: newRole,
      });
      setNewUsername('');
      await loadMembers();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add member');
    } finally {
      setAdding(false);
    }
  };

  const handleRemoveMember = async (userId: string, username?: string) => {
    const confirmName = username ? `@${username}` : 'this member';
    if (!confirm(`Remove ${confirmName} from this conversation?`)) return;

    setError(null);
    try {
      await chatUC.removeGroupMember(conversationId, userId);
      await loadMembers();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to remove member');
    }
  };

  const handleUpdateRole = async (userId: string, currentRole: string) => {
    const nextRole = currentRole === 'ADMIN'
      ? (conversationType === 'CHANNEL' ? 'SUBSCRIBER' : 'MEMBER')
      : 'ADMIN';

    setError(null);
    try {
      await chatUC.updateGroupMemberRole(conversationId, userId, nextRole);
      await loadMembers();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to change role');
    }
  };

  const handleLeave = async () => {
    if (!myMember) return;
    if (!confirm('Are you sure you want to leave this conversation?')) return;

    setError(null);
    try {
      await chatUC.removeGroupMember(conversationId, myMember.user_id);
      await chatUC.loadConversations();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to leave conversation');
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div>
            <h2 className="modal-title">
              {conversationType === 'GROUP' ? '👥' : '📢'} {conversationName || 'Conversation'}
            </h2>
            <div style={{ fontSize: 'var(--font-xs)', color: 'var(--color-text-secondary)', marginTop: '2px' }}>
              {members.length} {members.length === 1 ? 'member' : 'members'} • {conversationType}
            </div>
          </div>
          <button id="close-group-members-btn" type="button" className="modal-close-btn" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        {error && <div className="modal-error">{error}</div>}

        {/* Add Member Form (Admins/Owners only) */}
        {isAdmin && (
          <form onSubmit={(e) => void handleAddMember(e)} style={{ display: 'flex', gap: 'var(--space-2)', marginBottom: 'var(--space-3)' }}>
            <input
              id="add-member-username-input"
              type="text"
              placeholder="Add member by @username..."
              value={newUsername}
              onChange={(e) => setNewUsername(e.target.value)}
              className="modal-input"
              style={{ flex: 1 }}
              disabled={adding}
            />
            {conversationType === 'CHANNEL' && (
              <select
                value={newRole}
                onChange={(e) => setNewRole(e.target.value as 'SUBSCRIBER' | 'ADMIN')}
                className="modal-select"
                style={{ width: 'auto' }}
              >
                <option value="SUBSCRIBER">Subscriber (Read-only)</option>
                <option value="ADMIN">Admin (Can post)</option>
              </select>
            )}
            <button
              id="add-member-submit-btn"
              type="submit"
              className="modal-btn modal-btn--primary"
              disabled={adding || !newUsername.trim()}
            >
              {adding ? '...' : '+ Add'}
            </button>
          </form>
        )}

        {/* Members List */}
        <div className="members-list">
          {loading ? (
            <div style={{ padding: 'var(--space-4)', textAlign: 'center', color: 'var(--color-text-tertiary)' }}>Loading members...</div>
          ) : (
            members.map((m) => {
              const isMe = m.identity_hash === identityHash;
              const canModify = (isOwner || (isAdmin && m.role !== 'OWNER' && m.role !== 'ADMIN')) && !isMe;

              const memberName = ([m.display_name, m.last_name].filter(Boolean).join(' ') || m.display_name) || (m.username ? `@${m.username}` : 'Member');

              return (
                <div key={m.user_id} className="member-item">
                  <div style={{ marginRight: '10px' }}>
                    <Avatar
                      userId={m.user_id}
                      avatarUpdatedAt={m.avatar_updated_at}
                      name={memberName}
                      size="sm"
                    />
                  </div>
                  <div className="member-info">
                    <div className="member-name-row">
                      <span className="member-name">
                        {memberName}
                      </span>
                      {isMe && <span className="member-badge">You</span>}
                    </div>
                    {([m.display_name, m.last_name].filter(Boolean).join(' ') || m.display_name) && m.username && (
                      <span style={{ fontSize: '11px', color: 'var(--color-text-tertiary)' }}>
                        @{m.username}
                      </span>
                    )}
                  </div>

                  <div style={{ display: 'flex', alignItems: 'center' }}>
                    <span
                      className="role-badge"
                      style={{
                        backgroundColor:
                          m.role === 'OWNER'
                            ? '#7c3aed'
                            : m.role === 'ADMIN'
                              ? '#2563eb'
                              : 'var(--color-bg-hover)',
                        color: m.role === 'OWNER' || m.role === 'ADMIN' ? '#fff' : 'var(--color-text-secondary)',
                      }}
                    >
                      {m.role}
                    </span>
                  </div>

                  {canModify && (
                    <div className="member-actions">
                      <button
                        type="button"
                        className="role-toggle-btn"
                        onClick={() => void handleUpdateRole(m.user_id, m.role)}
                        title={m.role === 'ADMIN' ? 'Demote to Member' : 'Promote to Admin'}
                      >
                        {m.role === 'ADMIN' ? 'Demote' : 'Promote'}
                      </button>
                      <button
                        type="button"
                        className="remove-btn"
                        onClick={() => void handleRemoveMember(m.user_id, m.username)}
                        title="Remove member"
                      >
                        🗑️
                      </button>
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>

        {/* Footer with Leave Button */}
        <div className="modal-footer">
          {!isOwner && myMember && (
            <button
              id="leave-group-btn"
              type="button"
              className="modal-btn modal-btn--danger"
              onClick={() => void handleLeave()}
            >
              🚪 Leave {conversationType === 'GROUP' ? 'Group' : 'Channel'}
            </button>
          )}
          <button type="button" className="modal-btn modal-btn--primary" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
