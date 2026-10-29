/**
 * AdminIPBlocklist — IP Hash Blocking and Allowlist Management (RFC-0014 §5).
 * IP blocks are enforced at the network gate before authentication.
 * Uses SHA-256 IP hashes to protect end-user privacy while mitigating abuse.
 */

import React, { useState, useEffect } from 'react';
import { BanIcon, RefreshIcon } from '../common/Icons';
import { AdminConfirmModal } from './AdminConfirmModal';
import {
  banIP,
  unbanIP,
  listBlockedIPs,
  type IPBlockDTO,
} from './admin-api';

export interface AdminIPBlocklistProps {
  apiKey: string;
  initialIPHash?: string | null;
}

export const AdminIPBlocklist: React.FC<AdminIPBlocklistProps> = ({
  apiKey,
  initialIPHash,
}) => {
  const [ipInput, setIpInput] = useState(initialIPHash || '');
  const [blockedIPs, setBlockedIPs] = useState<IPBlockDTO[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  // Modal states
  const [confirmModal, setConfirmModal] = useState<{
    action: 'ban' | 'unban';
    targetIP: string;
  } | null>(null);
  const [modalLoading, setModalLoading] = useState(false);
  const [modalError, setModalError] = useState<string | null>(null);

  useEffect(() => {
    if (initialIPHash) {
      setIpInput(initialIPHash);
    }
  }, [initialIPHash]);

  const loadBlockedIPs = async (isManual = false) => {
    if (isManual) setRefreshing(true);
    else setLoading(true);

    try {
      const data = await listBlockedIPs(apiKey);
      setBlockedIPs(data);
    } catch (err: unknown) {
      setFeedback({
        type: 'error',
        message: err instanceof Error ? err.message : 'Failed to fetch blocked IP list',
      });
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    void loadBlockedIPs();
  }, [apiKey]);

  const handleOpenBan = (target = ipInput.trim()) => {
    if (!target) return;
    setModalError(null);
    setConfirmModal({ action: 'ban', targetIP: target });
  };

  const handleOpenUnban = (target = ipInput.trim()) => {
    if (!target) return;
    setModalError(null);
    setConfirmModal({ action: 'unban', targetIP: target });
  };

  const handleConfirmAction = async () => {
    if (!confirmModal) return;
    setModalLoading(true);
    setModalError(null);

    const { action, targetIP } = confirmModal;

    try {
      if (action === 'ban') {
        const res = await banIP(apiKey, targetIP);
        setFeedback({
          type: 'success',
          message: `IP hash ${targetIP.slice(0, 16)}... banned successfully (status: ${res.status}).`,
        });
        setIpInput('');
      } else {
        const res = await unbanIP(apiKey, targetIP);
        setFeedback({
          type: 'success',
          message: `IP hash ${targetIP.slice(0, 16)}... unbanned successfully (status: ${res.status}).`,
        });
        if (ipInput.trim() === targetIP) setIpInput('');
      }

      setConfirmModal(null);
      await loadBlockedIPs(true);
    } catch (err: unknown) {
      setModalError(err instanceof Error ? err.message : 'Operation failed');
    } finally {
      setModalLoading(false);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-6)' }}>
      {/* Header */}
      <div>
        <h2 style={{ margin: 0, fontSize: 'var(--font-xl)', fontWeight: 700, color: 'var(--color-text-primary)' }}>
          IP Blocklist Management
        </h2>
        <span style={{ fontSize: 'var(--font-sm)', color: 'var(--color-text-secondary)' }}>
          Enforce IP-level access restrictions via privacy-preserving SHA-256 IP hashes (RFC-0014 §5)
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

      {/* Action / Ban Input Card */}
      <div className="admin-card">
        <div className="admin-card-header">
          <h3 className="admin-card-title">
            <BanIcon size={18} />
            Block / Unblock IP Hash
          </h3>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
          <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
            <div style={{ flex: 1, minWidth: '260px' }}>
              <input
                type="text"
                data-testid="admin-ip-input"
                className="admin-input"
                placeholder="Enter 64-char IP hash from audit log..."
                value={ipInput}
                onChange={(e) => setIpInput(e.target.value)}
              />
            </div>
            <button
              type="button"
              className="admin-btn admin-btn--danger"
              disabled={!ipInput.trim()}
              data-testid="admin-ban-ip-btn"
              onClick={() => handleOpenBan()}
            >
              <BanIcon size={16} />
              Ban IP Hash
            </button>
            <button
              type="button"
              className="admin-btn admin-btn--secondary"
              disabled={!ipInput.trim()}
              data-testid="admin-unban-ip-btn"
              onClick={() => handleOpenUnban()}
            >
              Unban IP Hash
            </button>
          </div>

          <div
            className="admin-hint"
            style={{
              fontSize: 'var(--font-xs)',
              backgroundColor: 'var(--color-bg-hover)',
              padding: 'var(--space-3)',
              borderRadius: 'var(--radius-sm)',
            }}
          >
            <strong>Privacy Explanation:</strong> Under RootInbox zero-knowledge design, client IP addresses are immediately hashed with SHA-256 before storage or comparison. The raw client IP is never retained. Find suspicious IP hashes in the <strong>Audit Log</strong> viewer when inspecting auth failures or rate limit violations.
          </div>
        </div>
      </div>

      {/* Currently Blocked IPs Table */}
      <div className="admin-card">
        <div className="admin-card-header">
          <h3 className="admin-card-title">
            Active Blocked IP Hashes ({blockedIPs.filter((b) => b.status === 'BLOCKED').length})
          </h3>
          <button
            type="button"
            className="admin-btn admin-btn--secondary admin-btn--sm"
            onClick={() => void loadBlockedIPs(true)}
            disabled={loading || refreshing}
          >
            <RefreshIcon size={16} />
            {refreshing ? 'Refreshing...' : 'Refresh List'}
          </button>
        </div>

        {loading ? (
          <div style={{ textAlign: 'center', padding: 'var(--space-6)', color: 'var(--color-text-tertiary)' }}>
            Loading blocked IP list...
          </div>
        ) : blockedIPs.length === 0 ? (
          <div style={{ textAlign: 'center', padding: 'var(--space-6)', color: 'var(--color-text-tertiary)' }}>
            No blocked IP addresses on record.
          </div>
        ) : (
          <div className="admin-table-container">
            <table className="admin-table" aria-label="Blocked IP Addresses">
              <thead>
                <tr>
                  <th scope="col">IP Hash</th>
                  <th scope="col">Status</th>
                  <th scope="col">Blocked At</th>
                  <th scope="col">Last Updated</th>
                  <th scope="col" style={{ textAlign: 'right' }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {blockedIPs.map((block) => (
                  <tr key={block.ipHash}>
                    <td>
                      <code className="admin-code" title={block.ipHash}>
                        {block.ipHash}
                      </code>
                    </td>
                    <td>
                      <span
                        className={`admin-badge ${
                          block.status === 'BLOCKED' ? 'admin-badge--danger' : 'admin-badge--muted'
                        }`}
                      >
                        {block.status}
                      </span>
                    </td>
                    <td style={{ whiteSpace: 'nowrap', fontSize: 'var(--font-xs)' }}>
                      {block.createdAt ? new Date(block.createdAt * 1000).toLocaleString() : '—'}
                    </td>
                    <td style={{ whiteSpace: 'nowrap', fontSize: 'var(--font-xs)' }}>
                      {block.updatedAt ? new Date(block.updatedAt * 1000).toLocaleString() : '—'}
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      {block.status === 'BLOCKED' ? (
                        <button
                          type="button"
                          className="admin-btn admin-btn--secondary admin-btn--sm"
                          data-testid={`admin-unban-row-${block.ipHash.slice(0, 8)}`}
                          onClick={() => handleOpenUnban(block.ipHash)}
                        >
                          Unban
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="admin-btn admin-btn--outline-danger admin-btn--sm"
                          onClick={() => handleOpenBan(block.ipHash)}
                        >
                          Re-Ban
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Confirmation Modal */}
      <AdminConfirmModal
        isOpen={confirmModal !== null}
        title={confirmModal?.action === 'ban' ? 'Confirm IP Ban' : 'Confirm IP Unban'}
        message={
          confirmModal?.action === 'ban'
            ? `Are you sure you want to block all traffic originating from IP hash ${confirmModal?.targetIP}? All subsequent connections from this address will receive 403 Forbidden.`
            : `Restore network access for IP hash ${confirmModal?.targetIP}? Requests from this address will no longer be blocked.`
        }
        confirmLabel={confirmModal?.action === 'ban' ? 'Ban IP' : 'Unban IP'}
        isDestructive={confirmModal?.action === 'ban'}
        isLoading={modalLoading}
        error={modalError}
        onConfirm={() => void handleConfirmAction()}
        onCancel={() => {
          if (!modalLoading) {
            setConfirmModal(null);
            setModalError(null);
          }
        }}
      />
    </div>
  );
};
