/**
 * useSas hook.
 * Phase 12B Task 12 (§15.1, §14.4).
 *
 * Exposes SAS digits and verification action.
 */

import { useCallback } from 'react';
import { useAppContext } from '../context';
import { useCallSession } from './useCallSession';

export function useSas() {
  const { callMachine } = useAppContext();
  const session = useCallSession();

  const verifySas = useCallback(() => {
    callMachine.verifySas();
  }, [callMachine]);

  return {
    sasDigits: session.sasDigits,
    sasVerified: session.sasVerified,
    fingerprintVerified: session.fingerprintVerified,
    verifySas,
  };
}
