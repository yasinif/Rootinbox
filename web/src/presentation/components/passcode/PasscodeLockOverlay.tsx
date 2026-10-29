import React from 'react';
import { usePasscodeLock, useAuth } from '../../hooks';
import { PasscodeLockScreen } from './PasscodeLockScreen';

export const PasscodeLockOverlay: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { isPasscodeEnabled, isLocked, isLoading } = usePasscodeLock();
  const { state } = useAuth();

  // Show lock screen if user is authenticated and passcode is enabled and locked
  const shouldLock = !isLoading && state === 'authenticated' && isPasscodeEnabled && isLocked;

  return (
    <>
      <div
        id="app-content-wrapper"
        style={shouldLock ? { display: 'none' } : { display: 'contents' }}
        aria-hidden={shouldLock ? 'true' : undefined}
      >
        {children}
      </div>
      {shouldLock && <PasscodeLockScreen />}
    </>
  );
};
