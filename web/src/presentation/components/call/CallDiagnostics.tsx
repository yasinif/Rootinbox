/**
 * CallDiagnostics component.
 * Phase 12B Task 12 (§14.7, §15.6).
 *
 * Displays high-level ICE quality and relay indicator.
 * Strictly avoids exposing candidate strings or IP addresses.
 */

import React from 'react';
import type { IceQuality } from '../../../domain/call/types';

export interface CallDiagnosticsProps {
  iceQuality: IceQuality;
  isRelayed?: boolean;
}

export const CallDiagnostics: React.FC<CallDiagnosticsProps> = ({ iceQuality, isRelayed }) => {
  const getQualityColor = () => {
    switch (iceQuality) {
      case 'excellent':
        return '#22c55e';
      case 'good':
        return '#3b82f6';
      case 'poor':
        return '#eab308';
      case 'failed':
      case 'disconnected':
        return '#ef4444';
      default:
        return '#888888';
    }
  };

  return (
    <div
      data-testid="call-diagnostics"
      className="call-diagnostics"
    >
      <span
        className="quality-dot"
        style={{ backgroundColor: getQualityColor() }}
      />
      <span style={{ textTransform: 'capitalize' }}>{iceQuality}</span>
      {isRelayed && (
        <span
          data-testid="relayed-indicator"
          className="relayed-indicator"
        >
          Relayed
        </span>
      )}
    </div>
  );
};
