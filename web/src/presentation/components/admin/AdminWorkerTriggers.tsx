/**
 * AdminWorkerTriggers — Background Task and Maintenance Worker Dispatcher.
 * Dispatches on-demand worker execution via POST /api/v1/admin/workers/{name}/trigger (RFC-0014 §7).
 * Displays immediate HTTP 202 Accepted feedback with returned operation IDs.
 */

import React, { useState } from 'react';
import { ServerIcon, RefreshIcon, CheckIcon } from '../common/Icons';
import { triggerWorker } from './admin-api';

export interface AdminWorkerTriggersProps {
  apiKey: string;
}

interface TriggerResult {
  workerName: string;
  operationId: string;
  timestamp: string;
}

export const AdminWorkerTriggers: React.FC<AdminWorkerTriggersProps> = ({ apiKey }) => {
  const [loadingWorker, setLoadingWorker] = useState<string | null>(null);
  const [recentTriggers, setRecentTriggers] = useState<TriggerResult[]>([]);
  const [error, setError] = useState<string | null>(null);

  const handleTrigger = async (workerName: string, displayName: string) => {
    setLoadingWorker(workerName);
    setError(null);

    try {
      const res = await triggerWorker(apiKey, workerName);
      const newResult: TriggerResult = {
        workerName: displayName,
        operationId: res.operation_id,
        timestamp: new Date().toLocaleTimeString(),
      };
      setRecentTriggers((prev) => [newResult, ...prev]);
    } catch (err: unknown) {
      setError(
        err instanceof Error
          ? err.message
          : `Failed to trigger worker ${displayName}`,
      );
    } finally {
      setLoadingWorker(null);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-6)' }}>
      {/* Header */}
      <div>
        <h2 style={{ margin: 0, fontSize: 'var(--font-xl)', fontWeight: 700, color: 'var(--color-text-primary)' }}>
          Worker Triggers
        </h2>
        <span style={{ fontSize: 'var(--font-sm)', color: 'var(--color-text-secondary)' }}>
          Dispatch asynchronous server maintenance jobs and cache refreshes (RFC-0014 §7)
        </span>
      </div>

      {error && (
        <div className="admin-banner admin-banner--error" role="alert">
          {error}
        </div>
      )}

      {recentTriggers.length > 0 && (
        <div
          data-testid="admin-worker-feedback"
          className="admin-banner admin-banner--success"
          role="status"
        >
          <CheckIcon size={18} />
          <span>
            <strong>HTTP 202 Accepted:</strong> Worker &ldquo;{recentTriggers[0].workerName}&rdquo; triggered. Operation ID:{' '}
            <code className="admin-code">{recentTriggers[0].operationId}</code> at {recentTriggers[0].timestamp}.
          </span>
        </div>
      )}

      {/* Worker Action Cards Grid */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 'var(--space-4)' }}>
        {/* Media GC */}
        <div className="admin-card">
          <div className="admin-card-header">
            <h3 className="admin-card-title">
              <ServerIcon size={18} />
              Media Garbage Collector
            </h3>
            <span className="admin-badge admin-badge--accent">
              Storage Maintenance
            </span>
          </div>

          <p style={{ margin: 0, fontSize: 'var(--font-sm)', color: 'var(--color-text-secondary)', lineHeight: 1.5 }}>
            Scans filesystem chunk stores and removes expired or unreferenced encrypted attachments, orphaned media segments, and stale staging manifests.
          </p>

          <div style={{ marginTop: 'auto', paddingTop: 'var(--space-3)' }}>
            <button
              type="button"
              className="admin-btn admin-btn--primary"
              style={{ width: '100%' }}
              data-testid="admin-trigger-media-gc-btn"
              disabled={loadingWorker !== null}
              onClick={() => void handleTrigger('media_gc', 'Media GC')}
            >
              <RefreshIcon size={16} />
              {loadingWorker === 'media_gc' ? 'Dispatching...' : 'Trigger Media GC'}
            </button>
          </div>
        </div>

        {/* Audit Retention */}
        <div className="admin-card">
          <div className="admin-card-header">
            <h3 className="admin-card-title">
              <ServerIcon size={18} />
              Audit Log Retention
            </h3>
            <span className="admin-badge admin-badge--warning">
              Compliance Job
            </span>
          </div>

          <p style={{ margin: 0, fontSize: 'var(--font-sm)', color: 'var(--color-text-secondary)', lineHeight: 1.5 }}>
            Applies security audit retention windows (90-day default), prunes aged security events, and vacuums the immutable security event append log.
          </p>

          <div style={{ marginTop: 'auto', paddingTop: 'var(--space-3)' }}>
            <button
              type="button"
              className="admin-btn admin-btn--primary"
              style={{ width: '100%' }}
              data-testid="admin-trigger-audit-retention-btn"
              disabled={loadingWorker !== null}
              onClick={() => void handleTrigger('audit_retention', 'Audit Retention')}
            >
              <RefreshIcon size={16} />
              {loadingWorker === 'audit_retention' ? 'Dispatching...' : 'Trigger Audit Retention'}
            </button>
          </div>
        </div>

        {/* Metrics Cache */}
        <div className="admin-card">
          <div className="admin-card-header">
            <h3 className="admin-card-title">
              <ServerIcon size={18} />
              Metrics Cache Refresh
            </h3>
            <span className="admin-badge admin-badge--accent">
              Telemetry Cache
            </span>
          </div>

          <p style={{ margin: 0, fontSize: 'var(--font-sm)', color: 'var(--color-text-secondary)', lineHeight: 1.5 }}>
            Forces recomputation of Prometheus telemetry counters, token rate limit buckets, active session quotas, and database storage utilization stats.
          </p>

          <div style={{ marginTop: 'auto', paddingTop: 'var(--space-3)' }}>
            <button
              type="button"
              className="admin-btn admin-btn--primary"
              style={{ width: '100%' }}
              data-testid="admin-trigger-metrics-cache-btn"
              disabled={loadingWorker !== null}
              onClick={() => void handleTrigger('metrics_cache', 'Metrics Cache')}
            >
              <RefreshIcon size={16} />
              {loadingWorker === 'metrics_cache' ? 'Dispatching...' : 'Trigger Metrics Cache'}
            </button>
          </div>
        </div>
      </div>

      {/* Execution History */}
      {recentTriggers.length > 0 && (
        <div className="admin-card">
          <div className="admin-card-header">
            <h3 className="admin-card-title">
              Recent Dispatches (Current Session)
            </h3>
          </div>

          <div className="admin-table-container">
            <table className="admin-table" aria-label="Recent Worker Triggers">
              <thead>
                <tr>
                  <th scope="col">Time</th>
                  <th scope="col">Worker</th>
                  <th scope="col">Operation ID</th>
                  <th scope="col">Status</th>
                </tr>
              </thead>
              <tbody>
                {recentTriggers.map((t, i) => (
                  <tr key={`${t.operationId}-${i}`}>
                    <td style={{ whiteSpace: 'nowrap' }}>{t.timestamp}</td>
                    <td style={{ fontWeight: 600 }}>{t.workerName}</td>
                    <td>
                      <code className="admin-code">{t.operationId}</code>
                    </td>
                    <td>
                      <span className="admin-badge admin-badge--success">202 Accepted</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
};
