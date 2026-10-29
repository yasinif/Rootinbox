import React, { createContext, useContext, useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useAppContext } from './index';
import {
  loadPasscodeSettings,
  savePasscodeSettings,
  clearPasscodeSettings,
  hashPasscode,
  verifyPasscode,
} from '../../domain/passcode';
import type { AutoLockTimeout, PasscodeSettings } from '../../domain/passcode';

export interface PasscodeContextValue {
  isPasscodeEnabled: boolean;
  isLocked: boolean;
  autoLockTimeout: AutoLockTimeout;
  isLoading: boolean;
  lock: () => void;
  unlock: (pin: string) => Promise<boolean>;
  unlockWithMasterPassword: (password: string) => Promise<boolean>;
  setupPasscode: (pin: string) => Promise<void>;
  changePasscode: (oldPin: string, newPin: string) => Promise<boolean>;
  disablePasscode: (currentPin?: string) => Promise<boolean>;
  setAutoLockTimeout: (timeout: AutoLockTimeout) => Promise<void>;
}

export const PasscodeContext = createContext<PasscodeContextValue | null>(null);

const TIMEOUT_MS_MAP: Record<AutoLockTimeout, number> = {
  off: 0,
  '1m': 60 * 1000,
  '5m': 5 * 60 * 1000,
  '15m': 15 * 60 * 1000,
  '1h': 60 * 60 * 1000,
  blur: -1,
};

const SYNC_CHANNEL_NAME = 'rootinbox-passcode-sync';

function broadcastSync(msg: { type: string; settings?: PasscodeSettings }) {
  if (typeof BroadcastChannel !== 'undefined') {
    try {
      const ch = new BroadcastChannel(SYNC_CHANNEL_NAME);
      ch.postMessage(msg);
      ch.close();
    } catch {
      // BroadcastChannel best effort
    }
  }
}

export const PasscodeProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { metadataPort, authUC } = useAppContext();
  const [settings, setSettings] = useState<PasscodeSettings>({
    enabled: false,
    autoLockTimeout: '5m',
  });
  const [isLocked, setIsLocked] = useState(false);
  const [isLoading, setIsLoading] = useState(true);

  const lastActivityRef = useRef<number>(Date.now());
  const isLockedRef = useRef(isLocked);
  isLockedRef.current = isLocked;

  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  // Cross-tab broadcast synchronization
  useEffect(() => {
    if (typeof BroadcastChannel === 'undefined') return;

    let channel: BroadcastChannel | null = null;
    try {
      channel = new BroadcastChannel(SYNC_CHANNEL_NAME);
      channel.onmessage = (event) => {
        const data = event.data;
        if (!data || typeof data !== 'object') return;

        if (data.type === 'LOCK') {
          if (settingsRef.current.enabled && !isLockedRef.current) {
            setIsLocked(true);
          }
        } else if (data.type === 'UNLOCK') {
          if (isLockedRef.current) {
            setIsLocked(false);
            lastActivityRef.current = Date.now();
          }
        } else if (data.type === 'SETTINGS_CHANGED' && data.settings) {
          setSettings(data.settings);
        }
      };
    } catch {
      // Best effort
    }

    return () => {
      try {
        channel?.close();
      } catch {
        // ignore
      }
    };
  }, []);

  // Load initial settings on mount or user changes
  useEffect(() => {
    let mounted = true;
    const currentUserId = authUC.getSnapshot().userId;

    void (async () => {
      try {
        const loaded = await loadPasscodeSettings(metadataPort, currentUserId);
        if (mounted) {
          setSettings(loaded);
          if (loaded.enabled && authUC.getSnapshot().state === 'authenticated') {
            setIsLocked(true);
          }
        }
      } catch (err) {
        console.warn('[PasscodeContext] Failed to load settings:', err);
      } finally {
        if (mounted) setIsLoading(false);
      }
    })();

    return () => {
      mounted = false;
    };
  }, [metadataPort, authUC]);

  // Subscribe to auth state transitions
  useEffect(() => {
    return authUC.subscribe((snapshot) => {
      if (snapshot.state === 'idle') {
        setIsLocked(false);
        setSettings({ enabled: false, autoLockTimeout: '5m' });
        if (typeof sessionStorage !== 'undefined' && sessionStorage.getItem('is_session_only') === 'true') {
          void clearPasscodeSettings(metadataPort, snapshot.userId);
        }
      } else if (snapshot.state === 'authenticated') {
        void (async () => {
          try {
            const loaded = await loadPasscodeSettings(metadataPort, snapshot.userId);
            setSettings(loaded);
            if (loaded.enabled) {
              setIsLocked(true);
            }
          } catch (err) {
            console.warn('[PasscodeContext] Failed to load settings for user:', err);
          }
        })();
      }
    });
  }, [authUC, metadataPort]);

  // Lock action
  const lock = useCallback(() => {
    if (settingsRef.current.enabled) {
      setIsLocked(true);
      broadcastSync({ type: 'LOCK' });
    }
  }, []);

  // Unlock action via 4-digit PIN
  const unlock = useCallback(async (pin: string): Promise<boolean> => {
    const current = settingsRef.current;
    if (!current.enabled || !current.salt || !current.hash) {
      setIsLocked(false);
      broadcastSync({ type: 'UNLOCK' });
      return true;
    }
    const valid = await verifyPasscode(pin, current.salt, current.hash);
    if (valid) {
      setIsLocked(false);
      lastActivityRef.current = Date.now();
      broadcastSync({ type: 'UNLOCK' });
      return true;
    }
    return false;
  }, []);

  // Fallback unlock via account master password
  const unlockWithMasterPassword = useCallback(async (password: string): Promise<boolean> => {
    try {
      await authUC.unlock(password);
      const snap = authUC.getSnapshot();
      if (snap.state === 'authenticated') {
        setIsLocked(false);
        lastActivityRef.current = Date.now();
        broadcastSync({ type: 'UNLOCK' });
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }, [authUC]);

  // Setup initial passcode
  const setupPasscode = useCallback(async (pin: string): Promise<void> => {
    const currentUserId = authUC.getSnapshot().userId;
    const { salt, hash } = await hashPasscode(pin);
    const updated: PasscodeSettings = {
      ...settingsRef.current,
      enabled: true,
      salt,
      hash,
    };
    await savePasscodeSettings(metadataPort, updated, currentUserId);
    setSettings(updated);
    setIsLocked(false);
    lastActivityRef.current = Date.now();
    broadcastSync({ type: 'SETTINGS_CHANGED', settings: updated });
  }, [metadataPort, authUC]);

  // Change existing passcode
  const changePasscode = useCallback(async (oldPin: string, newPin: string): Promise<boolean> => {
    const current = settingsRef.current;
    if (current.enabled && current.salt && current.hash) {
      const valid = await verifyPasscode(oldPin, current.salt, current.hash);
      if (!valid) return false;
    }
    const currentUserId = authUC.getSnapshot().userId;
    const { salt, hash } = await hashPasscode(newPin);
    const updated: PasscodeSettings = {
      ...current,
      enabled: true,
      salt,
      hash,
    };
    await savePasscodeSettings(metadataPort, updated, currentUserId);
    setSettings(updated);
    broadcastSync({ type: 'SETTINGS_CHANGED', settings: updated });
    return true;
  }, [metadataPort, authUC]);

  // Disable passcode
  const disablePasscode = useCallback(async (currentPin?: string): Promise<boolean> => {
    const current = settingsRef.current;
    if (current.enabled && current.salt && current.hash && currentPin !== undefined) {
      const valid = await verifyPasscode(currentPin, current.salt, current.hash);
      if (!valid) return false;
    }
    const currentUserId = authUC.getSnapshot().userId;
    await clearPasscodeSettings(metadataPort, currentUserId);
    const updated: PasscodeSettings = {
      enabled: false,
      autoLockTimeout: '5m',
    };
    setSettings(updated);
    setIsLocked(false);
    broadcastSync({ type: 'SETTINGS_CHANGED', settings: updated });
    return true;
  }, [metadataPort, authUC]);

  // Update auto-lock timeout
  const setAutoLockTimeout = useCallback(async (timeout: AutoLockTimeout): Promise<void> => {
    const currentUserId = authUC.getSnapshot().userId;
    const updated: PasscodeSettings = {
      ...settingsRef.current,
      autoLockTimeout: timeout,
    };
    await savePasscodeSettings(metadataPort, updated, currentUserId);
    setSettings(updated);
    lastActivityRef.current = Date.now();
    broadcastSync({ type: 'SETTINGS_CHANGED', settings: updated });
  }, [metadataPort, authUC]);

  // User activity tracker & inactivity timer
  useEffect(() => {
    if (!settings.enabled || isLocked) return;

    const timeoutSetting = settings.autoLockTimeout;
    const timeoutMs = TIMEOUT_MS_MAP[timeoutSetting];

    const resetActivity = () => {
      lastActivityRef.current = Date.now();
    };

    const events = ['mousemove', 'mousedown', 'keydown', 'touchstart', 'scroll'];
    for (const evt of events) {
      window.addEventListener(evt, resetActivity, { passive: true });
    }

    // Inactivity interval
    let interval: ReturnType<typeof setInterval> | null = null;
    if (timeoutMs > 0) {
      interval = setInterval(() => {
        if (!isLockedRef.current && Date.now() - lastActivityRef.current >= timeoutMs) {
          setIsLocked(true);
          broadcastSync({ type: 'LOCK' });
        }
      }, 5000);
    }

    // Tab blur / background listener
    const handleVisibility = () => {
      if (document.hidden && settingsRef.current.autoLockTimeout === 'blur') {
        setIsLocked(true);
        broadcastSync({ type: 'LOCK' });
      }
    };
    const handleBlur = () => {
      if (settingsRef.current.autoLockTimeout === 'blur') {
        setIsLocked(true);
        broadcastSync({ type: 'LOCK' });
      }
    };

    document.addEventListener('visibilitychange', handleVisibility);
    window.addEventListener('blur', handleBlur);

    return () => {
      for (const evt of events) {
        window.removeEventListener(evt, resetActivity);
      }
      if (interval) clearInterval(interval);
      document.removeEventListener('visibilitychange', handleVisibility);
      window.removeEventListener('blur', handleBlur);
    };
  }, [settings.enabled, settings.autoLockTimeout, isLocked]);

  const value = useMemo<PasscodeContextValue>(() => ({
    isPasscodeEnabled: settings.enabled,
    isLocked,
    autoLockTimeout: settings.autoLockTimeout,
    isLoading,
    lock,
    unlock,
    unlockWithMasterPassword,
    setupPasscode,
    changePasscode,
    disablePasscode,
    setAutoLockTimeout,
  }), [
    settings.enabled,
    isLocked,
    settings.autoLockTimeout,
    isLoading,
    lock,
    unlock,
    unlockWithMasterPassword,
    setupPasscode,
    changePasscode,
    disablePasscode,
    setAutoLockTimeout,
  ]);

  return (
    <PasscodeContext.Provider value={value}>
      {children}
    </PasscodeContext.Provider>
  );
};

const defaultPasscodeContext: PasscodeContextValue = {
  isPasscodeEnabled: false,
  isLocked: false,
  isLoading: false,
  autoLockTimeout: 'off',
  lock: () => {},
  unlock: async () => false,
  unlockWithMasterPassword: async () => false,
  setupPasscode: async () => {},
  changePasscode: async () => false,
  disablePasscode: async () => false,
  setAutoLockTimeout: async () => {},
};

export function usePasscodeLock(): PasscodeContextValue {
  const context = useContext(PasscodeContext);
  if (!context) {
    return defaultPasscodeContext;
  }
  return context;
}
