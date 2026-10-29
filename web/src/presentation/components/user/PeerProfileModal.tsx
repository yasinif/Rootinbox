import React, { useState, useEffect } from 'react';
import { useAppContext } from '../../context';
import type { UserProfile } from '../../../domain';
import { Avatar } from '../common/Avatar';

import { formatLastSeen } from '../common/presence';

export interface PeerProfileModalProps {
  userId?: string | null;
  isOpen: boolean;
  onClose: () => void;
  onStartChat?: (userId: string) => void;
}

export const PeerProfileModal: React.FC<PeerProfileModalProps> = ({
  userId,
  isOpen,
  onClose,
  onStartChat,
}) => {
  const { userPort } = useAppContext();
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen || !userId) return;
    setLoading(true);
    setErrorMsg(null);

    userPort
      .getProfile(userId)
      .then((p) => setProfile(p))
      .catch((err: unknown) => {
        setErrorMsg(err instanceof Error ? err.message : 'Failed to load user profile');
      })
      .finally(() => setLoading(false));
  }, [isOpen, userId, userPort]);

  if (!isOpen) return null;

  const displayName = profile?.display_name || profile?.username || 'User Profile';
  const fullName = [profile?.display_name, profile?.last_name].filter(Boolean).join(' ') || displayName;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        id="peer-profile-modal"
        className="modal-card modal-card--narrow"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <h2 className="modal-title">User Info</h2>
          <button
            id="close-peer-profile-btn"
            type="button"
            onClick={onClose}
            className="modal-close-btn"
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        {loading ? (
          <div style={{ textAlign: 'center', padding: '30px 0', color: 'var(--color-text-tertiary)' }}>
            Loading profile...
          </div>
        ) : errorMsg ? (
          <div className="modal-error">
            {errorMsg}
          </div>
        ) : profile ? (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 'var(--space-4)' }}>
            <Avatar
              userId={profile.user_id}
              name={fullName}
              size="lg"
            />
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontSize: 'var(--font-xl)', fontWeight: 600, color: 'var(--color-text-primary)' }}>
                {fullName}
              </div>
              {profile.username && (
                <div style={{ fontSize: 'var(--font-sm)', color: 'var(--color-accent)', marginTop: '2px' }}>
                  @{profile.username}
                </div>
              )}
              <div
                id="peer-profile-last-seen"
                style={{
                  fontSize: 'var(--font-xs)',
                  color: profile.online ? 'var(--color-primary, #10b981)' : 'var(--color-text-tertiary)',
                  marginTop: '4px',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: '5px',
                }}
              >
                {profile.online && (
                  <span
                    style={{
                      width: '6px',
                      height: '6px',
                      borderRadius: '50%',
                      backgroundColor: '#10b981',
                      display: 'inline-block',
                    }}
                  />
                )}
                <span>{formatLastSeen(profile.online, profile.last_seen_at)}</span>
              </div>
            </div>

            {profile.bio && (
              <div
                style={{
                  width: '100%',
                  backgroundColor: 'var(--color-bg-secondary)',
                  padding: 'var(--space-3) var(--space-4)',
                  borderRadius: 'var(--radius-sm)',
                  fontSize: 'var(--font-sm)',
                  color: 'var(--color-text-primary)',
                  lineHeight: 1.5,
                  border: '1px solid var(--color-border-light)',
                }}
              >
                <div style={{ fontSize: 'var(--font-xs)', color: 'var(--color-text-tertiary)', marginBottom: '4px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                  Bio
                </div>
                {profile.bio}
              </div>
            )}

            <div style={{ width: '100%', marginTop: 'var(--space-3)', display: 'flex', gap: 'var(--space-2)' }}>
              {onStartChat && (
                <button
                  id="peer-profile-message-btn"
                  type="button"
                  onClick={() => {
                    onClose();
                    onStartChat(profile.user_id);
                  }}
                  className="modal-btn modal-btn--primary"
                  style={{ flex: 1 }}
                >
                  💬 Message
                </button>
              )}
              <button
                type="button"
                onClick={onClose}
                className="modal-btn modal-btn--cancel"
              >
                Close
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
};
