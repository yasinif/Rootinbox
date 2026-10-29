/**
 * IncomingCallSheet component.
 * Phase 12B Task 12 (§15.1, §15.4).
 *
 * Appears when incoming_ringing.
 * Shows caller name, Accept and Decline buttons.
 */

import React from 'react';

export interface IncomingCallSheetProps {
  callerName: string;
  callType?: string;
  onAccept: () => void;
  onDecline: () => void;
}

export const IncomingCallSheet: React.FC<IncomingCallSheetProps> = ({
  callerName,
  callType,
  onAccept,
  onDecline,
}) => {
  return (
    <div
      id="incoming-call-sheet"
      data-testid="incoming-call-sheet"
      className="incoming-call-sheet"
    >
      <div style={{ textAlign: 'center' }}>
        <div id="incoming-call-type" className="incoming-call-type">
          Incoming {callType === 'video' ? 'Video' : 'Audio'} Call
        </div>
        <div
          id="incoming-caller-name"
          data-testid="caller-display-name"
          className="incoming-caller-name"
        >
          {callerName}
        </div>
      </div>

      <div className="incoming-call-actions">
        <button
          id="call-decline-btn"
          type="button"
          data-testid="decline-call-btn"
          aria-label="Decline call"
          onClick={onDecline}
          className="incoming-call-btn incoming-call-btn--decline"
        >
          Decline
        </button>
        <button
          id="call-answer-btn"
          type="button"
          data-testid="accept-call-btn"
          aria-label="Accept call"
          onClick={onAccept}
          className="incoming-call-btn incoming-call-btn--accept"
        >
          Accept
        </button>
      </div>
    </div>
  );
};
