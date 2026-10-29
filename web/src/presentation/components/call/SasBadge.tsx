/**
 * SasBadge — Short Authentication String component.
 * Phase 12B Task 12 (§14.4, §15.4, §23.4).
 *
 * Renders exactly 6 digits in monospace.
 * Preserves zero padding, shows verification status.
 */

import React from 'react';

export interface SasBadgeProps {
  sasDigits: string | null;
  verified: boolean;
  onVerify?: () => void;
}

export const SasBadge: React.FC<SasBadgeProps> = ({ sasDigits, verified, onVerify }) => {
  if (!sasDigits) return null;

  // Ensure 6 digits preserved with leading zeros
  const formattedDigits = sasDigits.padStart(6, '0').slice(0, 6);

  return (
    <div
      data-testid="sas-badge"
      className={`sas-badge ${verified ? 'sas-badge--verified' : 'sas-badge--unverified'}`}
      style={{
        backgroundColor: verified ? 'rgba(34, 197, 94, 0.15)' : 'rgba(234, 179, 8, 0.15)',
      }}
    >
      <span className="sas-label">SAS:</span>
      <span
        data-testid="sas-digits"
        className={`sas-digits ${verified ? 'sas-digits--verified' : 'sas-digits--unverified'}`}
      >
        {formattedDigits}
      </span>
      {onVerify && !verified && (
        <button
          id="call-verify-sas-btn"
          type="button"
          data-testid="sas-verify-btn"
          onClick={onVerify}
          className="sas-verify-btn"
        >
          Verify
        </button>
      )}
      {verified && (
        <span
          data-testid="sas-verified-icon"
          className="sas-verified-icon"
          title="Verified"
        >
          ✓
        </span>
      )}
    </div>
  );
};
