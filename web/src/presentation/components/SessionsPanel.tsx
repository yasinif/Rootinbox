import React, { useState, useEffect, useCallback } from 'react';
import { useAppContext } from '../context';
import type { SessionDTO } from '../../domain';

export interface SessionsPanelProps {
  isOpen: boolean;
  onClose: () => void;
}

function formatRelativeTime(timestampSeconds: number): string {
  if (!timestampSeconds) return 'Unknown';
  const now = Math.floor(Date.now() / 1000);
  const diff = Math.max(0, now - timestampSeconds);
  if (diff < 45) return 'Active just now';
  if (diff < 3600) return `Active ${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `Active ${Math.floor(diff / 3600)}h ago`;
  return `Active ${Math.floor(diff / 86400)}d ago`;
}

function getDeviceIcon(label: string): string {
  const lower = (label || '').toLowerCase();
  if (lower.includes('iphone') || lower.includes('android') || lower.includes('mobile')) {
    return '📱';
  }
  if (lower.includes('ipad') || lower.includes('tablet')) {
    return '📟';
  }
  if (lower.includes('mac') || lower.includes('windows') || lower.includes('linux')) {
    return '💻';
  }
  return '🌐';
}

export const SessionsPanel: React.FC<SessionsPanelProps> = ({ isOpen, onClose }) => {
  const { authUC } = useAppContext();
  const [sessions, setSessions] = useState<SessionDTO[]>([]);
  const [loading, setLoading] = useState(false);
  const [terminatingId, setTerminatingId] = useState<string | null>(null);
  const [terminatingOthers, setTerminatingOthers] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  const fetchSessions = useCallback(async () => {
    try {
      setLoading(true);
      setErrorMsg(null);
      const data = await authUC.listSessions();
      setSessions(data || []);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to load sessions';
      setErrorMsg(msg);
    } finally {
      setLoading(false);
    }
  }, [authUC]);

  useEffect(() => {
    if (isOpen) {
      fetchSessions();
      setSuccessMsg(null);
      setErrorMsg(null);
    }
  }, [isOpen, fetchSessions]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const handleTerminateSession = async (sessionId: string) => {
    try {
      setTerminatingId(sessionId);
      setErrorMsg(null);
      await authUC.terminateSession(sessionId);
      setSessions((prev) => prev.filter((s) => s.id !== sessionId));
      setSuccessMsg('Session terminated successfully');
      setTimeout(() => setSuccessMsg(null), 3000);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to terminate session';
      setErrorMsg(msg);
    } finally {
      setTerminatingId(null);
    }
  };

  const handleTerminateOthers = async () => {
    try {
      setTerminatingOthers(true);
      setErrorMsg(null);
      await authUC.terminateOtherSessions();
      setSessions((prev) => prev.filter((s) => s.is_current));
      setSuccessMsg('All other sessions terminated successfully');
      setTimeout(() => setSuccessMsg(null), 3000);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to terminate other sessions';
      setErrorMsg(msg);
    } finally {
      setTerminatingOthers(false);
    }
  };

  const otherSessionsCount = sessions.filter((s) => !s.is_current).length;

  return (
    <div className="modal-backdrop" onClick={onClose} role="dialog" aria-modal="true">
      <div
        id="sessions-modal"
        className="modal-card"
        style={{ maxWidth: '540px', width: '92%' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
            <span style={{ fontSize: '1.25rem' }}>🔒</span>
            <h2 className="modal-title" style={{ margin: 0 }}>Active Sessions</h2>
          </div>
          <button
            id="close-sessions-modal-btn"
            type="button"
            onClick={onClose}
            className="modal-close-btn"
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        <p style={{
          fontSize: 'var(--font-sm)',
          color: 'var(--color-text-secondary)',
          margin: '0 0 var(--space-4) 0',
          lineHeight: '1.4',
        }}>
          Manage devices currently signed into your account. Terminating a session immediately revokes access and disconnects real-time messaging on that device.
        </p>

        {errorMsg && (
          <div id="sessions-error-banner" className="modal-error" style={{ marginBottom: 'var(--space-3)' }}>
            {errorMsg}
          </div>
        )}

        {successMsg && (
          <div
            id="sessions-success-banner"
            style={{
              padding: 'var(--space-2) var(--space-3)',
              backgroundColor: 'var(--color-success-bg, rgba(46, 213, 115, 0.15))',
              border: '1px solid var(--color-success, #2ed573)',
              borderRadius: 'var(--radius-sm)',
              color: 'var(--color-success, #2ed573)',
              fontSize: 'var(--font-sm)',
              marginBottom: 'var(--space-3)',
              display: 'flex',
              alignItems: 'center',
              gap: 'var(--space-2)',
            }}
          >
            <span>✓</span> {successMsg}
          </div>
        )}

        {loading ? (
          <div style={{ textAlign: 'center', padding: 'var(--space-6) 0', color: 'var(--color-text-tertiary)' }}>
            Loading active sessions...
          </div>
        ) : (
          <div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)', maxHeight: '360px', overflowY: 'auto', paddingRight: '4px' }}>
              {sessions.map((session) => (
                <div
                  key={session.id}
                  id={`session-item-${session.id}`}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    padding: 'var(--space-3)',
                    backgroundColor: session.is_current ? 'var(--color-bg-secondary)' : 'var(--color-bg-primary)',
                    border: session.is_current ? '1.5px solid var(--color-accent)' : '1px solid var(--color-border)',
                    borderRadius: 'var(--radius-md)',
                    transition: 'border-color 0.2s ease',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)', minWidth: 0 }}>
                    <div
                      style={{
                        width: '40px',
                        height: '40px',
                        borderRadius: 'var(--radius-md)',
                        backgroundColor: session.is_current ? 'rgba(var(--color-accent-rgb, 108, 92, 231), 0.15)' : 'var(--color-bg-secondary)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        fontSize: '1.25rem',
                        flexShrink: 0,
                      }}
                    >
                      {getDeviceIcon(session.device_label)}
                    </div>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
                        <span style={{
                          fontWeight: 600,
                          fontSize: 'var(--font-sm)',
                          color: 'var(--color-text-primary)',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}>
                          {session.device_label || 'Unknown Device'}
                        </span>
                        {session.is_current && (
                          <span
                            id="current-device-badge"
                            style={{
                              fontSize: '10px',
                              fontWeight: 700,
                              textTransform: 'uppercase',
                              letterSpacing: '0.04em',
                              padding: '2px 6px',
                              borderRadius: 'var(--radius-sm)',
                              backgroundColor: 'rgba(46, 213, 115, 0.15)',
                              color: 'var(--color-success, #2ed573)',
                              border: '1px solid rgba(46, 213, 115, 0.3)',
                              display: 'inline-flex',
                              alignItems: 'center',
                              gap: '4px',
                            }}
                          >
                            <span style={{ width: '5px', height: '5px', borderRadius: '50%', backgroundColor: '#2ed573' }} />
                            Current Device
                          </span>
                        )}
                      </div>
                      <div style={{
                        fontSize: 'var(--font-xs)',
                        color: 'var(--color-text-tertiary)',
                        marginTop: '2px',
                        display: 'flex',
                        gap: 'var(--space-2)',
                        alignItems: 'center',
                      }}>
                        <span>{formatRelativeTime(session.last_active_at)}</span>
                        {session.ip_hash && (
                          <>
                            <span>•</span>
                            <span style={{ fontFamily: 'var(--font-mono)' }}>
                              IP: {session.ip_hash.slice(0, 8)}…
                            </span>
                          </>
                        )}
                      </div>
                    </div>
                  </div>

                  {!session.is_current && (
                    <button
                      id={`terminate-session-btn-${session.id}`}
                      type="button"
                      disabled={terminatingId === session.id}
                      onClick={() => handleTerminateSession(session.id)}
                      style={{
                        padding: 'var(--space-1) var(--space-3)',
                        fontSize: 'var(--font-xs)',
                        fontWeight: 600,
                        color: 'var(--color-danger, #ff4757)',
                        backgroundColor: 'rgba(255, 71, 87, 0.08)',
                        border: '1px solid rgba(255, 71, 87, 0.25)',
                        borderRadius: 'var(--radius-sm)',
                        cursor: terminatingId === session.id ? 'not-allowed' : 'pointer',
                        opacity: terminatingId === session.id ? 0.6 : 1,
                        whiteSpace: 'nowrap',
                        transition: 'background-color 0.15s ease',
                      }}
                    >
                      {terminatingId === session.id ? 'Terminating…' : 'Terminate'}
                    </button>
                  )}
                </div>
              ))}
            </div>

            {otherSessionsCount > 0 && (
              <div style={{ marginTop: 'var(--space-4)', paddingTop: 'var(--space-3)', borderTop: '1px solid var(--color-border)' }}>
                <button
                  id="terminate-all-others-btn"
                  type="button"
                  disabled={terminatingOthers}
                  onClick={handleTerminateOthers}
                  style={{
                    width: '100%',
                    padding: 'var(--space-2) var(--space-4)',
                    fontSize: 'var(--font-sm)',
                    fontWeight: 600,
                    color: '#ffffff',
                    backgroundColor: 'var(--color-danger, #ff4757)',
                    border: 'none',
                    borderRadius: 'var(--radius-md)',
                    cursor: terminatingOthers ? 'not-allowed' : 'pointer',
                    opacity: terminatingOthers ? 0.7 : 1,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 'var(--space-2)',
                    transition: 'filter 0.2s ease',
                  }}
                >
                  <span>⚠️</span>
                  {terminatingOthers ? 'Terminating other sessions…' : `Terminate All Other Sessions (${otherSessionsCount})`}
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
