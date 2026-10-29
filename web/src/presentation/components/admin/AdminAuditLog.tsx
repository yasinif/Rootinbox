/**
 * AdminAuditLog — Security Audit Events Viewer (RFC-0014 §6).
 * Provides read-only query interface with filters (the 8 frozen types + Admin Action),
 * identity_hash, ip_hash, time ranges, and cursor-based pagination.
 */

import React, { useState, useEffect } from 'react';
import {
  ActivityIcon,
  RefreshIcon,
  SearchIcon,
  CopyIcon,
  CheckIcon,
} from '../common/Icons';
import {
  queryAuditLogs,
  FROZEN_SECURITY_EVENT_TYPES,
  type SecurityEventDTO,
  type AuditLogFilter,
} from './admin-api';

export interface AdminAuditLogProps {
  apiKey: string;
  onSelectUser?: (identityHash: string) => void;
  onSelectIP?: (ipHash: string) => void;
}

export const AdminAuditLog: React.FC<AdminAuditLogProps> = ({
  apiKey,
  onSelectUser,
  onSelectIP,
}) => {
  const [events, setEvents] = useState<SecurityEventDTO[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Filter state
  const [eventType, setEventType] = useState<string>('');
  const [identityHash, setIdentityHash] = useState<string>('');
  const [ipHash, setIpHash] = useState<string>('');
  const [timePreset, setTimePreset] = useState<string>('90d');

  // Pagination state
  const [nextCursor, setNextCursor] = useState<string | undefined>(undefined);
  const [cursorHistory, setCursorHistory] = useState<string[]>([]);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const calculateStartTime = (preset: string): number | undefined => {
    const now = Math.floor(Date.now() / 1000);
    switch (preset) {
      case '24h':
        return now - 24 * 3600;
      case '7d':
        return now - 7 * 24 * 3600;
      case '30d':
        return now - 30 * 24 * 3600;
      case '90d':
        return now - 90 * 24 * 3600;
      default:
        return undefined;
    }
  };

  const fetchEvents = async (cursor?: string) => {
    setLoading(true);
    setError(null);

    const filter: AuditLogFilter = {
      limit: 50,
      cursor,
    };
    if (eventType) filter.eventType = eventType;
    if (identityHash.trim()) filter.identityHash = identityHash.trim();
    if (ipHash.trim()) filter.ipHash = ipHash.trim();
    const st = calculateStartTime(timePreset);
    if (st) filter.startTime = st;

    try {
      const res = await queryAuditLogs(apiKey, filter);
      setEvents(res.events);
      setNextCursor(res.nextCursor);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to query audit events');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void fetchEvents();
  }, [apiKey]);

  const handleApplyFilter = (e: React.FormEvent) => {
    e.preventDefault();
    setCursorHistory([]);
    void fetchEvents();
  };

  const handleResetFilter = () => {
    setEventType('');
    setIdentityHash('');
    setIpHash('');
    setTimePreset('90d');
    setCursorHistory([]);
    setLoading(true);
    queryAuditLogs(apiKey, { limit: 50 })
      .then((res) => {
        setEvents(res.events);
        setNextCursor(res.nextCursor);
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  };

  const handleNextPage = () => {
    if (!nextCursor) return;
    setCursorHistory((prev) => [...prev, nextCursor]);
    void fetchEvents(nextCursor);
  };

  const handleCopy = (text: string, id: string) => {
    navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 1500);
  };

  const getEventBadgeClass = (et: string) => {
    if (et === 'AUTH_SUCCESS') return 'admin-badge--success';
    if (et === 'AUTH_FAILURE' || et === 'RATE_LIMIT_TRIPPED' || et === 'WS_ORIGIN_REJECTED')
      return 'admin-badge--danger';
    if (et === 'SESSION_REVOKED' || et === 'QUOTA_EXCEEDED') return 'admin-badge--warning';
    if (et === 'ADMIN_ACTION') return 'admin-badge--accent';
    return 'admin-badge--muted';
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-6)' }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 'var(--space-3)' }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 'var(--font-xl)', fontWeight: 700, color: 'var(--color-text-primary)' }}>
            Audit Log Viewer
          </h2>
          <span style={{ fontSize: 'var(--font-sm)', color: 'var(--color-text-secondary)' }}>
            Append-only record of security events and administrative actions (RFC-0014 §6)
          </span>
        </div>
        <button
          type="button"
          className="admin-btn admin-btn--secondary admin-btn--sm"
          onClick={() => void fetchEvents()}
          disabled={loading}
          data-testid="admin-audit-refresh-btn"
        >
          <RefreshIcon size={16} />
          Refresh
        </button>
      </div>

      {error && (
        <div className="admin-banner admin-banner--error" role="alert">
          {error}
        </div>
      )}

      {/* Filter Card */}
      <div className="admin-card">
        <form onSubmit={handleApplyFilter} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
              gap: 'var(--space-3)',
            }}
          >
            {/* Event Type Filter */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-1)' }}>
              <label
                htmlFor="filter-event-type"
                style={{ fontSize: 'var(--font-xs)', fontWeight: 600, color: 'var(--color-text-secondary)' }}
              >
                Event Type
              </label>
              <select
                id="filter-event-type"
                data-testid="admin-filter-event-type"
                className="admin-input"
                value={eventType}
                onChange={(e) => setEventType(e.target.value)}
              >
                <option value="">All Event Types</option>
                {FROZEN_SECURITY_EVENT_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {type}
                  </option>
                ))}
              </select>
            </div>

            {/* Time Preset */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-1)' }}>
              <label
                htmlFor="filter-time-preset"
                style={{ fontSize: 'var(--font-xs)', fontWeight: 600, color: 'var(--color-text-secondary)' }}
              >
                Time Window
              </label>
              <select
                id="filter-time-preset"
                data-testid="admin-filter-time-preset"
                className="admin-input"
                value={timePreset}
                onChange={(e) => setTimePreset(e.target.value)}
              >
                <option value="24h">Last 24 Hours</option>
                <option value="7d">Last 7 Days</option>
                <option value="30d">Last 30 Days</option>
                <option value="90d">Last 90 Days</option>
                <option value="all">All Time</option>
              </select>
            </div>

            {/* Identity Hash Filter */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-1)' }}>
              <label
                htmlFor="filter-user"
                style={{ fontSize: 'var(--font-xs)', fontWeight: 600, color: 'var(--color-text-secondary)' }}
              >
                Identity Hash
              </label>
              <input
                id="filter-user"
                data-testid="admin-filter-user-input"
                type="text"
                className="admin-input"
                placeholder="Filter by user identity..."
                value={identityHash}
                onChange={(e) => setIdentityHash(e.target.value)}
              />
            </div>

            {/* IP Hash Filter */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-1)' }}>
              <label
                htmlFor="filter-ip"
                style={{ fontSize: 'var(--font-xs)', fontWeight: 600, color: 'var(--color-text-secondary)' }}
              >
                IP Hash
              </label>
              <input
                id="filter-ip"
                data-testid="admin-filter-ip-input"
                type="text"
                className="admin-input"
                placeholder="Filter by IP hash..."
                value={ipHash}
                onChange={(e) => setIpHash(e.target.value)}
              />
            </div>
          </div>

          <div style={{ display: 'flex', gap: 'var(--space-2)', justifyContent: 'flex-end', flexWrap: 'wrap' }}>
            <button
              type="button"
              className="admin-btn admin-btn--secondary admin-btn--sm"
              data-testid="admin-filter-reset-btn"
              onClick={handleResetFilter}
            >
              Reset Filters
            </button>
            <button
              type="submit"
              className="admin-btn admin-btn--primary admin-btn--sm"
              data-testid="admin-filter-apply-btn"
              disabled={loading}
            >
              <SearchIcon size={14} />
              Apply Filters
            </button>
          </div>
        </form>
      </div>

      {/* Events Table */}
      <div className="admin-card">
        <div className="admin-card-header">
          <h3 className="admin-card-title">
            <ActivityIcon size={18} />
            Events ({events.length})
          </h3>
          {nextCursor && (
            <span className="admin-hint" style={{ fontSize: 'var(--font-xs)' }}>
              More records available
            </span>
          )}
        </div>

        {loading ? (
          <div style={{ textAlign: 'center', padding: 'var(--space-7)', color: 'var(--color-text-tertiary)' }}>
            Loading audit records...
          </div>
        ) : events.length === 0 ? (
          <div style={{ textAlign: 'center', padding: 'var(--space-7)', color: 'var(--color-text-tertiary)' }}>
            No security audit events match the selected criteria.
          </div>
        ) : (
          <div className="admin-table-container">
            <table className="admin-table" data-testid="admin-audit-table" aria-label="Security Audit Log">
              <thead>
                <tr>
                  <th scope="col">Timestamp</th>
                  <th scope="col">Event Type</th>
                  <th scope="col">Identity Hash</th>
                  <th scope="col">IP Hash</th>
                  <th scope="col">Details / Action</th>
                </tr>
              </thead>
              <tbody>
                {events.map((evt) => (
                  <tr key={evt.id}>
                    <td style={{ whiteSpace: 'nowrap', fontSize: 'var(--font-xs)' }}>
                      {new Date(evt.createdAt * 1000).toLocaleString()}
                    </td>
                    <td>
                      <span className={`admin-badge ${getEventBadgeClass(evt.eventType)}`}>
                        {evt.eventType}
                      </span>
                    </td>
                    <td>
                      {evt.identityHash ? (
                        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--space-1)' }}>
                          <code className="admin-code" title={evt.identityHash}>
                            {evt.identityHash.slice(0, 14)}...
                          </code>
                          <button
                            type="button"
                            onClick={() => handleCopy(evt.identityHash!, `user-${evt.id}`)}
                            title="Copy full identity hash"
                            style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 2, color: 'var(--color-text-tertiary)' }}
                          >
                            {copiedId === `user-${evt.id}` ? <CheckIcon size={12} /> : <CopyIcon size={12} />}
                          </button>
                          {onSelectUser && (
                            <button
                              type="button"
                              onClick={() => onSelectUser(evt.identityHash!)}
                              title="Inspect in User Management"
                              className="admin-btn admin-btn--secondary admin-btn--sm"
                              style={{ padding: '0 6px', height: '22px', fontSize: '11px', minHeight: 'unset' }}
                            >
                              Manage
                            </button>
                          )}
                        </div>
                      ) : (
                        <span style={{ color: 'var(--color-text-tertiary)' }}>—</span>
                      )}
                    </td>
                    <td>
                      {evt.ipHash ? (
                        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--space-1)' }}>
                          <code className="admin-code" title={evt.ipHash}>
                            {evt.ipHash.slice(0, 12)}...
                          </code>
                          <button
                            type="button"
                            onClick={() => handleCopy(evt.ipHash!, `ip-${evt.id}`)}
                            title="Copy full IP hash"
                            style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 2, color: 'var(--color-text-tertiary)' }}
                          >
                            {copiedId === `ip-${evt.id}` ? <CheckIcon size={12} /> : <CopyIcon size={12} />}
                          </button>
                          {onSelectIP && (
                            <button
                              type="button"
                              onClick={() => onSelectIP(evt.ipHash!)}
                              title="Manage in IP Blocklist"
                              className="admin-btn admin-btn--secondary admin-btn--sm"
                              style={{ padding: '0 6px', height: '22px', fontSize: '11px', minHeight: 'unset' }}
                            >
                              Ban
                            </button>
                          )}
                        </div>
                      ) : (
                        <span style={{ color: 'var(--color-text-tertiary)' }}>—</span>
                      )}
                    </td>
                    <td style={{ fontSize: 'var(--font-xs)', color: 'var(--color-text-secondary)' }}>
                      {evt.adminAction ? (
                        <span style={{ fontWeight: 600, color: 'var(--color-accent)' }}>
                          Action: {evt.adminAction}
                        </span>
                      ) : evt.traceId ? (
                        <span>Trace: {evt.traceId.slice(0, 8)}</span>
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

        {/* Pagination Controls */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 'var(--space-3)' }}>
          <span className="admin-hint" style={{ fontSize: 'var(--font-xs)' }}>
            Showing {events.length} records {cursorHistory.length > 0 ? `(Page ${cursorHistory.length + 1})` : ''}
          </span>
          <button
            type="button"
            className="admin-btn admin-btn--secondary admin-btn--sm"
            data-testid="admin-audit-next-page-btn"
            onClick={handleNextPage}
            disabled={!nextCursor || loading}
          >
            Next Page &rarr;
          </button>
        </div>
      </div>
    </div>
  );
};
