/**
 * AdminUserManagement — Account controls for administrative users.
 * Supports Suspend, Resume, and Tombstone operations via identity_hash (RFC-0014).
 * Destructive operations require explicit confirmation modals.
 */

import React, { useState, useEffect } from 'react';
import {
  UsersIcon,
  AlertTriangleIcon,
  SearchIcon,
  CheckIcon,
} from '../common/Icons';
import { AdminConfirmModal } from './AdminConfirmModal';
import {
  suspendUser,
  resumeUser,
  generateConfirmationToken,
  tombstoneUser,
  queryAuditLogs,
  type SecurityEventDTO,
} from './admin-api';

export interface AdminUserManagementProps {
  apiKey: string;
  initialIdentityHash?: string | null;
}

export const AdminUserManagement: React.FC<AdminUserManagementProps> = ({
  apiKey,
  initialIdentityHash,
}) => {
  const [identityHash, setIdentityHash] = useState(initialIdentityHash || '');
  const [activeTarget, setActiveTarget] = useState(initialIdentityHash || '');
  const [userEvents, setUserEvents] = useState<SecurityEventDTO[]>([]);
  const [loadingEvents, setLoadingEvents] = useState(false);

  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  // Modal states
  const [modalType, setModalType] = useState<'suspend' | 'resume' | 'tombstone' | null>(null);
  const [modalLoading, setModalLoading] = useState(false);
  const [modalError, setModalError] = useState<string | null>(null);
  const [tombstoneToken, setTombstoneToken] = useState<string | null>(null);

  useEffect(() => {
    if (initialIdentityHash) {
      setIdentityHash(initialIdentityHash);
      setActiveTarget(initialIdentityHash);
    }
  }, [initialIdentityHash]);

  useEffect(() => {
    if (!activeTarget.trim()) {
      setUserEvents([]);
      return;
    }

    setLoadingEvents(true);
    queryAuditLogs(apiKey, { identityHash: activeTarget.trim(), limit: 20 })
      .then((res) => setUserEvents(res.events))
      .catch(() => setUserEvents([]))
      .finally(() => setLoadingEvents(false));
  }, [apiKey, activeTarget]);

  const handleLookup = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = identityHash.trim();
    if (!trimmed) return;
    setActiveTarget(trimmed);
    setFeedback(null);
  };

  const handleOpenSuspend = () => {
    setModalError(null);
    setModalType('suspend');
  };

  const handleOpenResume = () => {
    setModalError(null);
    setModalType('resume');
  };

  const handleOpenTombstone = async () => {
    setModalError(null);
    setModalLoading(true);
    setModalType('tombstone');

    try {
      // Step 1: generate confirmation token
      const token = await generateConfirmationToken(apiKey, 'tombstone', activeTarget);
      setTombstoneToken(token);
    } catch (err: unknown) {
      setModalError(err instanceof Error ? err.message : 'Failed to request confirmation token');
    } finally {
      setModalLoading(false);
    }
  };

  const handleConfirmAction = async () => {
    if (!activeTarget) return;
    setModalLoading(true);
    setModalError(null);

    try {
      if (modalType === 'suspend') {
        const res = await suspendUser(apiKey, activeTarget);
        setFeedback({
          type: 'success',
          message: `User ${activeTarget.slice(0, 16)}... suspended successfully (status: ${res.status}). All sessions revoked.`,
        });
        setModalType(null);
      } else if (modalType === 'resume') {
        const res = await resumeUser(apiKey, activeTarget);
        setFeedback({
          type: 'success',
          message: `User ${activeTarget.slice(0, 16)}... resumed successfully (status: ${res.status}).`,
        });
        setModalType(null);
      } else if (modalType === 'tombstone') {
        if (!tombstoneToken) throw new Error('Missing confirmation token');
        const res = await tombstoneUser(apiKey, activeTarget, tombstoneToken);
        setFeedback({
          type: 'success',
          message: `User ${activeTarget.slice(0, 16)}... permanently tombstoned (status: ${res.status}).`,
        });
        setModalType(null);
        setTombstoneToken(null);
      }

      // Refresh events
      queryAuditLogs(apiKey, { identityHash: activeTarget, limit: 20 })
        .then((r) => setUserEvents(r.events))
        .catch(() => {});
    } catch (err: unknown) {
      setModalError(err instanceof Error ? err.message : 'Operation failed');
    } finally {
      setModalLoading(false);
    }
  };

  const handleCloseModal = () => {
    if (!modalLoading) {
      setModalType(null);
      setModalError(null);
      setTombstoneToken(null);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-6)' }}>
      {/* Header */}
      <div>
        <h2 style={{ margin: 0, fontSize: 'var(--font-xl)', fontWeight: 700, color: 'var(--color-text-primary)' }}>
          User Management
        </h2>
        <span style={{ fontSize: 'var(--font-sm)', color: 'var(--color-text-secondary)' }}>
          Target accounts by zero-knowledge identity hash (RFC-0014 §4)
        </span>
      </div>

      {feedback && (
        <div
          className={`admin-banner ${feedback.type === 'success' ? 'admin-banner--success' : 'admin-banner--error'}`}
          role="alert"
        >
          {feedback.message}
        </div>
      )}

      {/* Lookup Card */}
      <div className="admin-card">
        <div className="admin-card-header">
          <h3 className="admin-card-title">
            <SearchIcon size={18} />
            User Lookup
          </h3>
        </div>

        <form onSubmit={handleLookup} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
          <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
            <div style={{ flex: 1, minWidth: '260px' }}>
              <input
                type="text"
                data-testid="admin-search-input"
                className="admin-input"
                placeholder="Enter identity hash (e.g. 64-char hex or audit log user_id)..."
                value={identityHash}
                onChange={(e) => setIdentityHash(e.target.value)}
              />
            </div>
            <button
              type="submit"
              className="admin-btn admin-btn--primary"
              disabled={!identityHash.trim()}
              data-testid="admin-lookup-btn"
            >
              <SearchIcon size={16} />
              Inspect User
            </button>
          </div>

          <div className="admin-hint" style={{ fontSize: 'var(--font-xs)', backgroundColor: 'var(--color-bg-hover)', padding: 'var(--space-3)', borderRadius: 'var(--radius-sm)' }}>
            <strong>Where to find Identity Hash:</strong> Under the Audit Log tab (User ID / Identity Hash column), or ask the user to share the hash found under Settings &rarr; Technical Details. Admin Bearer authentication operates directly on privacy-preserving identity hashes.
          </div>
        </form>
      </div>

      {/* Target User Actions Card */}
      {activeTarget && (
        <div className="admin-card" data-testid="admin-user-details-card">
          <div className="admin-card-header">
            <h3 className="admin-card-title">
              <UsersIcon size={18} />
              Target Account Actions
            </h3>
            <span className="admin-badge admin-badge--accent">
              Active Selection
            </span>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
            <div>
              <span className="admin-hint" style={{ display: 'block', marginBottom: 'var(--space-1)' }}>
                Target Identity Hash:
              </span>
              <code className="admin-code" style={{ fontSize: 'var(--font-sm)', padding: 'var(--space-2) var(--space-3)', width: '100%', boxSizing: 'border-box' }}>
                {activeTarget}
              </code>
            </div>

            <div
              style={{
                display: 'flex',
                flexWrap: 'wrap',
                gap: 'var(--space-3)',
                paddingTop: 'var(--space-3)',
                borderTop: '1px solid var(--color-border-light)',
              }}
            >
              <button
                type="button"
                className="admin-btn admin-btn--outline-danger"
                data-testid="admin-suspend-btn"
                onClick={handleOpenSuspend}
              >
                <AlertTriangleIcon size={16} />
                Suspend Account
              </button>

              <button
                type="button"
                className="admin-btn admin-btn--primary"
                data-testid="admin-resume-btn"
                onClick={handleOpenResume}
              >
                <CheckIcon size={16} />
                Resume Account
              </button>

              <button
                type="button"
                className="admin-btn admin-btn--danger"
                data-testid="admin-tombstone-btn"
                onClick={handleOpenTombstone}
              >
                Tombstone Account (Permanent)
              </button>
            </div>
          </div>
        </div>
      )}

      {/* User Specific Audit Events */}
      {activeTarget && (
        <div className="admin-card">
          <div className="admin-card-header">
            <h3 className="admin-card-title">
              Audit Events for Selected Identity
            </h3>
            <span className="admin-hint" style={{ fontSize: 'var(--font-xs)' }}>
              {userEvents.length} events found
            </span>
          </div>

          {loadingEvents ? (
            <div style={{ textAlign: 'center', padding: 'var(--space-5)', color: 'var(--color-text-tertiary)' }}>
              Loading user audit logs...
            </div>
          ) : userEvents.length === 0 ? (
            <div style={{ textAlign: 'center', padding: 'var(--space-5)', color: 'var(--color-text-tertiary)' }}>
              No audit logs recorded for this identity hash.
            </div>
          ) : (
            <div className="admin-table-container">
              <table className="admin-table" aria-label="User Specific Audit Events">
                <thead>
                  <tr>
                    <th scope="col">Timestamp</th>
                    <th scope="col">Event Type</th>
                    <th scope="col">IP Hash</th>
                    <th scope="col">Action / Trace</th>
                  </tr>
                </thead>
                <tbody>
                  {userEvents.map((evt) => (
                    <tr key={evt.id}>
                      <td style={{ whiteSpace: 'nowrap' }}>
                        {new Date(evt.createdAt * 1000).toLocaleString()}
                      </td>
                      <td>
                        <span className="admin-badge admin-badge--accent">{evt.eventType}</span>
                      </td>
                      <td>
                        {evt.ipHash ? (
                          <code className="admin-code">{evt.ipHash.slice(0, 14)}...</code>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td style={{ fontSize: 'var(--font-xs)' }}>
                        {evt.adminAction || evt.traceId || '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Confirmation Modals */}
      <AdminConfirmModal
        isOpen={modalType === 'suspend'}
        title="Confirm Account Suspension"
        message={`Are you sure you want to suspend account ${activeTarget}? All active user sessions will be invalidated and future authentications will be rejected.`}
        confirmLabel="Suspend Account"
        isDestructive={true}
        isLoading={modalLoading}
        error={modalError}
        onConfirm={() => void handleConfirmAction()}
        onCancel={handleCloseModal}
      />

      <AdminConfirmModal
        isOpen={modalType === 'resume'}
        title="Confirm Account Resumption"
        message={`Restore active status for account ${activeTarget}? The user will be permitted to authenticate normally.`}
        confirmLabel="Resume Account"
        isDestructive={false}
        isLoading={modalLoading}
        error={modalError}
        onConfirm={() => void handleConfirmAction()}
        onCancel={handleCloseModal}
      />

      <AdminConfirmModal
        isOpen={modalType === 'tombstone'}
        title="CRITICAL: Tombstone User Account"
        message={`WARNING: Tombstoning permanently marks account ${activeTarget} as DELETED and deletes all server session credentials. This action is irreversible.`}
        confirmLabel="Permanently Tombstone User"
        isDestructive={true}
        isLoading={modalLoading}
        error={modalError}
        token={tombstoneToken}
        requireInputMatch="TOMBSTONE"
        onConfirm={() => void handleConfirmAction()}
        onCancel={handleCloseModal}
      />
    </div>
  );
};
