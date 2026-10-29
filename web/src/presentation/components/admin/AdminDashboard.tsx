/**
 * AdminDashboard — Overview metrics, summary cards, and quick navigation.
 * Queries available admin and health endpoints to render real-time telemetry.
 */

import React, { useEffect, useState } from 'react';
import {
  ActivityIcon,
  BanIcon,
  ServerIcon,
  UsersIcon,
  RefreshIcon,
} from '../common/Icons';
import {
  queryAuditLogs,
  listBlockedIPs,
  getHealthReady,
  getServerVersion,
  type SecurityEventDTO,
} from './admin-api';

export interface AdminDashboardProps {
  apiKey: string;
  onNavigateTab: (tab: 'users' | 'ip-blocks' | 'audit' | 'workers') => void;
}

export const AdminDashboard: React.FC<AdminDashboardProps> = ({ apiKey, onNavigateTab }) => {
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [recentEvents, setRecentEvents] = useState<SecurityEventDTO[]>([]);
  const [eventCount, setEventCount] = useState<number>(0);
  const [blockedIPCount, setBlockedIPCount] = useState<number>(0);
  const [healthStatus, setHealthStatus] = useState<string>('checking...');
  const [serverVersion, setServerVersion] = useState<string>('...');

  const loadData = async (isManual = false) => {
    if (isManual) setRefreshing(true);
    else setLoading(true);
    setError(null);

    try {
      const [auditRes, ipBlocks, health, version] = await Promise.all([
        queryAuditLogs(apiKey, { limit: 50 }),
        listBlockedIPs(apiKey).catch(() => []),
        getHealthReady(),
        getServerVersion(),
      ]);

      setRecentEvents(auditRes.events.slice(0, 5));
      setEventCount(auditRes.events.length);
      setBlockedIPCount(ipBlocks.filter((b) => b.status === 'BLOCKED').length);
      setHealthStatus(health.status || 'unknown');
      setServerVersion(version.version || 'Phase 10/13');
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to fetch dashboard telemetry');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    void loadData();
  }, [apiKey]);

  const formatTimestamp = (ts: number): string => {
    if (!ts) return '—';
    const date = new Date(ts * 1000);
    return date.toLocaleDateString() + ' ' + date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  };

  const getEventBadgeClass = (eventType: string) => {
    if (eventType === 'AUTH_SUCCESS') return 'admin-badge--success';
    if (
      eventType === 'AUTH_FAILURE' ||
      eventType === 'RATE_LIMIT_TRIPPED' ||
      eventType === 'WS_ORIGIN_REJECTED'
    )
      return 'admin-badge--danger';
    if (eventType === 'SESSION_REVOKED' || eventType === 'QUOTA_EXCEEDED')
      return 'admin-badge--warning';
    if (eventType === 'ADMIN_ACTION') return 'admin-badge--accent';
    return 'admin-badge--muted';
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-6)' }}>
      {/* Top Banner / Actions */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 'var(--space-3)' }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 'var(--font-xl)', fontWeight: 700, color: 'var(--color-text-primary)' }}>
            System Overview
          </h2>
          <span style={{ fontSize: 'var(--font-sm)', color: 'var(--color-text-secondary)' }}>
            Real-time security telemetry and administration controls
          </span>
        </div>
        <button
          type="button"
          onClick={() => void loadData(true)}
          disabled={loading || refreshing}
          className="admin-btn admin-btn--secondary admin-btn--sm"
          data-testid="admin-dashboard-refresh-btn"
        >
          <RefreshIcon size={16} />
          {refreshing ? 'Refreshing...' : 'Refresh'}
        </button>
      </div>

      {error && (
        <div className="admin-banner admin-banner--error" role="alert">
          {error}
        </div>
      )}

      {/* Summary Cards */}
      <div className="admin-grid-stats">
        <div className="admin-stat-card">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span className="admin-stat-label">Security Events (Recent)</span>
            <ActivityIcon size={20} className="admin-stat-label" />
          </div>
          <span className="admin-stat-value" data-testid="stat-security-events">
            {loading ? '...' : eventCount}
          </span>
          <button
            type="button"
            className="admin-btn admin-btn--secondary admin-btn--sm"
            style={{ marginTop: 'var(--space-2)', alignSelf: 'flex-start' }}
            onClick={() => onNavigateTab('audit')}
          >
            View Audit Log →
          </button>
        </div>

        <div className="admin-stat-card">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span className="admin-stat-label">Active Blocked IPs</span>
            <BanIcon size={20} className="admin-stat-label" />
          </div>
          <span className="admin-stat-value" data-testid="stat-blocked-ips">
            {loading ? '...' : blockedIPCount}
          </span>
          <button
            type="button"
            className="admin-btn admin-btn--secondary admin-btn--sm"
            style={{ marginTop: 'var(--space-2)', alignSelf: 'flex-start' }}
            onClick={() => onNavigateTab('ip-blocks')}
          >
            Manage IP Blocks →
          </button>
        </div>

        <div className="admin-stat-card">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span className="admin-stat-label">User Management</span>
            <UsersIcon size={20} className="admin-stat-label" />
          </div>
          <span
            className="admin-stat-value"
            style={{ fontSize: 'var(--font-lg)', fontWeight: 600, color: 'var(--color-text-primary)' }}
          >
            SHA-256 Lookup
          </span>
          <button
            type="button"
            className="admin-btn admin-btn--secondary admin-btn--sm"
            style={{ marginTop: 'var(--space-2)', alignSelf: 'flex-start' }}
            onClick={() => onNavigateTab('users')}
          >
            Manage Accounts →
          </button>
        </div>

        <div className="admin-stat-card">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span className="admin-stat-label">Server Health / Version</span>
            <ServerIcon size={20} className="admin-stat-label" />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', marginTop: 'var(--space-1)' }}>
            <span
              className={`admin-badge ${
                healthStatus === 'pass' || healthStatus === 'ok'
                  ? 'admin-badge--success'
                  : 'admin-badge--warning'
              }`}
            >
              {healthStatus}
            </span>
            <span style={{ fontSize: 'var(--font-xs)', color: 'var(--color-text-secondary)', fontFamily: 'var(--font-mono)' }}>
              v{serverVersion}
            </span>
          </div>
          <button
            type="button"
            className="admin-btn admin-btn--secondary admin-btn--sm"
            style={{ marginTop: 'var(--space-2)', alignSelf: 'flex-start' }}
            onClick={() => onNavigateTab('workers')}
          >
            Worker Triggers →
          </button>
        </div>
      </div>

      {/* Recent Security Activity */}
      <div className="admin-card">
        <div className="admin-card-header">
          <h3 className="admin-card-title">
            <ActivityIcon size={18} />
            Latest Security Activity
          </h3>
          <button
            type="button"
            className="admin-btn admin-btn--secondary admin-btn--sm"
            onClick={() => onNavigateTab('audit')}
          >
            Full Log
          </button>
        </div>

        {loading ? (
          <div style={{ textAlign: 'center', padding: 'var(--space-6)', color: 'var(--color-text-tertiary)' }}>
            Loading audit activity...
          </div>
        ) : recentEvents.length === 0 ? (
          <div style={{ textAlign: 'center', padding: 'var(--space-6)', color: 'var(--color-text-tertiary)' }}>
            No security events recorded yet.
          </div>
        ) : (
          <div className="admin-table-container">
            <table className="admin-table" aria-label="Latest Security Events">
              <thead>
                <tr>
                  <th scope="col">Timestamp</th>
                  <th scope="col">Event Type</th>
                  <th scope="col">Identity Hash</th>
                  <th scope="col">IP Hash</th>
                  <th scope="col">Details</th>
                </tr>
              </thead>
              <tbody>
                {recentEvents.map((evt) => (
                  <tr key={evt.id}>
                    <td style={{ whiteSpace: 'nowrap' }}>{formatTimestamp(evt.createdAt)}</td>
                    <td>
                      <span className={`admin-badge ${getEventBadgeClass(evt.eventType)}`}>
                        {evt.eventType}
                      </span>
                    </td>
                    <td>
                      {evt.identityHash ? (
                        <code className="admin-code" title={evt.identityHash}>
                          {evt.identityHash.slice(0, 16)}...
                        </code>
                      ) : (
                        <span style={{ color: 'var(--color-text-tertiary)' }}>—</span>
                      )}
                    </td>
                    <td>
                      {evt.ipHash ? (
                        <code className="admin-code" title={evt.ipHash}>
                          {evt.ipHash.slice(0, 14)}...
                        </code>
                      ) : (
                        <span style={{ color: 'var(--color-text-tertiary)' }}>—</span>
                      )}
                    </td>
                    <td style={{ fontSize: 'var(--font-xs)', color: 'var(--color-text-secondary)' }}>
                      {evt.adminAction || evt.traceId ? (
                        <span>{evt.adminAction || `Trace: ${evt.traceId?.slice(0, 8)}`}</span>
                      ) : (
                        '—'
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
};
