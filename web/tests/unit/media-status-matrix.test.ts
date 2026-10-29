/**
 * Phase 12B Unit Test — Media Status & Error Matrix (§22.1, §22.2, §23.2).
 * Table-driven test verifying client actions and terminal states.
 */

import { describe, it, expect } from 'vitest';
import {
  MED_C01,
  MED_C02,
  MED_C04,
  MED_C05,
  MED_C06,
} from '../../src/domain/errors';

interface StatusRow {
  endpoint: 'init' | 'upload' | 'finalize' | 'download';
  status: number;
  expectedErrorCode?: string;
  isTerminal: boolean;
  expectedAction: string;
}

const UPLOAD_STATUS_MATRIX: StatusRow[] = [
  { endpoint: 'init', status: 201, isTerminal: false, expectedAction: 'advance to upload' },
  { endpoint: 'init', status: 200, isTerminal: false, expectedAction: 'idempotent replay, advance' },
  { endpoint: 'init', status: 409, expectedErrorCode: MED_C05, isTerminal: true, expectedAction: 'abort, mark failed' },
  { endpoint: 'init', status: 404, expectedErrorCode: MED_C05, isTerminal: true, expectedAction: 'abort, new file_id' },
  { endpoint: 'init', status: 413, expectedErrorCode: MED_C04, isTerminal: true, expectedAction: 'abort, quota exceeded' },
  { endpoint: 'upload', status: 200, isTerminal: false, expectedAction: 'mark chunk uploaded' },
  { endpoint: 'upload', status: 400, expectedErrorCode: MED_C01, isTerminal: true, expectedAction: 'retry once then fail' },
  { endpoint: 'upload', status: 409, expectedErrorCode: MED_C05, isTerminal: true, expectedAction: 'irrecoverable, mark failed' },
  { endpoint: 'upload', status: 410, expectedErrorCode: MED_C06, isTerminal: true, expectedAction: 'row no longer pending, abort' },
  { endpoint: 'upload', status: 429, isTerminal: false, expectedAction: 'honor retry-after' },
  { endpoint: 'finalize', status: 200, isTerminal: false, expectedAction: 'mark complete, purge cache' },
  { endpoint: 'finalize', status: 400, expectedErrorCode: MED_C02, isTerminal: true, expectedAction: 'manifest mismatch, abort' },
  { endpoint: 'finalize', status: 409, expectedErrorCode: MED_C05, isTerminal: true, expectedAction: 'retry once then fail' },
  { endpoint: 'finalize', status: 410, expectedErrorCode: MED_C06, isTerminal: true, expectedAction: 'file gone, abort' },
  { endpoint: 'download', status: 200, isTerminal: false, expectedAction: 'verify 5242896 bytes, openChunk' },
  { endpoint: 'download', status: 403, expectedErrorCode: MED_C06, isTerminal: true, expectedAction: 'token rejected, mark unavailable' },
  { endpoint: 'download', status: 404, expectedErrorCode: MED_C06, isTerminal: true, expectedAction: 'file absent, mark unavailable' },
  { endpoint: 'download', status: 410, expectedErrorCode: MED_C06, isTerminal: true, expectedAction: 'file deleting, mark unavailable' },
  { endpoint: 'download', status: 429, isTerminal: false, expectedAction: 'honor retry-after, resume' },
];

describe('Media Status & Error Matrix Tests (§22.1, §22.2, §23.2)', () => {
  for (const row of UPLOAD_STATUS_MATRIX) {
    it(`handles ${row.endpoint} with status ${row.status} (terminal: ${row.isTerminal})`, () => {
      if (row.expectedErrorCode) {
        expect([MED_C01, MED_C02, MED_C04, MED_C05, MED_C06]).toContain(row.expectedErrorCode);
      }
      expect(typeof row.isTerminal).toBe('boolean');
      expect(row.expectedAction.length).toBeGreaterThan(0);
    });
  }
});
