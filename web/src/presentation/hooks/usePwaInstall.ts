/**
 * Hook for PWA installation state and trigger.
 * Captures `beforeinstallprompt` globally at module evaluation time so
 * that late-mounting components (e.g. ChatScreen, UserProfileModal, InstallModal, AuthScreen)
 * do not miss the one-time browser event.
 * RFC-0010 §4.1: Presentation hooks import domain + usecase only (no infra imports).
 */

import { useState, useEffect, useCallback } from 'react';

export interface BeforeInstallPromptEvent extends Event {
  readonly platforms: string[];
  readonly userChoice: Promise<{
    outcome: 'accepted' | 'dismissed';
    platform: string;
  }>;
  prompt(): Promise<void>;
}

// Module-level singletons to capture one-time window events
let deferredPrompt: BeforeInstallPromptEvent | null = null;
const promptSubscribers = new Set<(p: BeforeInstallPromptEvent | null) => void>();
const installSubscribers = new Set<(installed: boolean) => void>();

function detectIsInstalled(): boolean {
  if (typeof window === 'undefined') return false;
  const isStandaloneMedia = typeof window.matchMedia === 'function' && window.matchMedia('(display-mode: standalone)').matches;
  const isNavigatorStandalone = (window.navigator as unknown as { standalone?: boolean }).standalone === true;
  return Boolean(isStandaloneMedia || isNavigatorStandalone);
}

if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (e: Event) => {
    e.preventDefault();
    deferredPrompt = e as BeforeInstallPromptEvent;
    promptSubscribers.forEach((cb) => cb(deferredPrompt));
  });

  window.addEventListener('appinstalled', () => {
    deferredPrompt = null;
    promptSubscribers.forEach((cb) => cb(null));
    installSubscribers.forEach((cb) => cb(true));
  });
}

/** Testing helper to inject synthetic prompt or reset */
export function _resetPwaPromptForTesting(mock?: BeforeInstallPromptEvent | null) {
  deferredPrompt = mock ?? null;
  promptSubscribers.forEach((cb) => cb(deferredPrompt));
}

export function usePwaInstall() {
  const [installPrompt, setInstallPrompt] = useState<BeforeInstallPromptEvent | null>(() => deferredPrompt);
  const [isInstalled, setIsInstalled] = useState<boolean>(() => detectIsInstalled());

  useEffect(() => {
    if (typeof window === 'undefined') return;

    // Check navigator.getInstalledRelatedApps if supported
    if (typeof navigator !== 'undefined' && 'getInstalledRelatedApps' in navigator) {
      (navigator as unknown as { getInstalledRelatedApps: () => Promise<unknown[]> })
        .getInstalledRelatedApps()
        .then((apps) => {
          if (Array.isArray(apps) && apps.length > 0) {
            setIsInstalled(true);
            installSubscribers.forEach((cb) => cb(true));
          }
        })
        .catch(() => {});
    }

    // Subscribe to module-level prompt updates
    const onPromptChange = (p: BeforeInstallPromptEvent | null) => {
      setInstallPrompt(p);
    };
    promptSubscribers.add(onPromptChange);

    // Subscribe to install completion updates
    const onInstallChange = (installed: boolean) => {
      setIsInstalled(installed);
    };
    installSubscribers.add(onInstallChange);

    // Check standalone mode changes
    let mediaQuery: MediaQueryList | null = null;
    let handleDisplayModeChange: ((e: MediaQueryListEvent) => void) | null = null;

    if (typeof window.matchMedia === 'function') {
      mediaQuery = window.matchMedia('(display-mode: standalone)');
      handleDisplayModeChange = (e: MediaQueryListEvent) => {
        setIsInstalled(e.matches);
        if (e.matches) {
          installSubscribers.forEach((cb) => cb(true));
        }
      };
      mediaQuery.addEventListener('change', handleDisplayModeChange);
    }

    return () => {
      promptSubscribers.delete(onPromptChange);
      installSubscribers.delete(onInstallChange);
      if (mediaQuery && handleDisplayModeChange) {
        mediaQuery.removeEventListener('change', handleDisplayModeChange);
      }
    };
  }, []);

  const promptInstall = useCallback(async (): Promise<boolean> => {
    const promptToUse = installPrompt || deferredPrompt;
    if (!promptToUse) {
      return false;
    }
    try {
      await promptToUse.prompt();
      const choice = await promptToUse.userChoice;
      if (choice.outcome === 'accepted') {
        deferredPrompt = null;
        promptSubscribers.forEach((cb) => cb(null));
        installSubscribers.forEach((cb) => cb(true));
        setIsInstalled(true);
        setInstallPrompt(null);
        return true;
      }
    } catch (err: unknown) {
      console.error('[PWA] Prompt error:', err);
    }
    return false;
  }, [installPrompt]);

  const hasNativePrompt = installPrompt !== null || deferredPrompt !== null;

  return {
    isInstallable: hasNativePrompt && !isInstalled,
    isInstalled,
    hasNativePrompt,
    promptInstall,
  };
}
