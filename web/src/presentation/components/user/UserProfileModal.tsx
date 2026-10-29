import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useAppContext } from '../../context';
import type { UserProfile } from '../../../domain';
import { Avatar } from '../common/Avatar';
import { usePwaInstall, usePasscodeLock } from '../../hooks';
import type { AutoLockTimeout } from '../../../domain/passcode';
import { InstallModal } from '../common/InstallModal';
import { SW_CACHE_VERSION } from '../../../domain/version';
import type { SWLogEvent } from '../../../domain';

export interface UserProfileModalProps {
  isOpen: boolean;
  onClose: () => void;
  onProfileUpdated?: (profile: UserProfile) => void;
}

export const UserProfileModal: React.FC<UserProfileModalProps> = ({
  isOpen,
  onClose,
  onProfileUpdated,
}) => {
  const { userPort, metadataPort, pushUC } = useAppContext();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(false);
  const [displayNameInput, setDisplayNameInput] = useState('');
  const [lastNameInput, setLastNameInput] = useState('');
  const [bioInput, setBioInput] = useState('');
  const [usernameInput, setUsernameInput] = useState('');
  const [saving, setSaving] = useState(false);
  const [uploadingAvatar, setUploadingAvatar] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [copiedField, setCopiedField] = useState<string | null>(null);
  const { isInstalled, hasNativePrompt, promptInstall } = usePwaInstall();
  const [showInstallSubModal, setShowInstallSubModal] = useState(false);

  // Push Notification State
  const [pushSupported, setPushSupported] = useState(false);
  const [pushPermission, setPushPermission] = useState<string>('default');
  const [pushSubscribed, setPushSubscribed] = useState(false);
  const [pushServerAvailable, setPushServerAvailable] = useState<boolean>(true);
  const [pushLoading, setPushLoading] = useState(false);
  const [pushEndpoint, setPushEndpoint] = useState('');
  const [pushVapidStatus, setPushVapidStatus] = useState('checking...');
  const [pushSwState, setPushSwState] = useState('none');
  const [pushSwController, setPushSwController] = useState('none');
  const [pushSecureContext, setPushSecureContext] = useState(false);
  const [swLogs, setSwLogs] = useState<SWLogEvent[]>([]);

  const isStandalone = typeof window !== 'undefined' && (
    Boolean(window.matchMedia?.('(display-mode: standalone)')?.matches) ||
    Boolean((window.navigator as unknown as { standalone?: boolean })?.standalone)
  );
  const displayMode = isStandalone ? 'standalone' : 'browser tab';

  const refreshPushState = useCallback(async () => {
    if (typeof window === 'undefined') return;
    setPushSecureContext(window.isSecureContext);
    const supported = Boolean(pushUC?.isSupported());
    setPushSupported(supported);
    const perm = pushUC?.getPermission() ?? 'default';
    setPushPermission(perm);

    if (pushUC && supported) {
      try {
        const sub = await pushUC.getCurrentSubscription();
        setPushSubscribed(Boolean(sub));
        setPushEndpoint(sub?.endpoint || '');
      } catch {
        setPushSubscribed(false);
        setPushEndpoint('');
      }

      if (typeof pushUC.isAvailable === 'function') {
        try {
          const avail = await pushUC.isAvailable();
          setPushServerAvailable(avail);
        } catch {
          setPushServerAvailable(false);
        }
      }

      try {
        const res = await fetch('/api/v1/push/vapid-public-key', { credentials: 'include' });
        const text = res.statusText || (res.status === 200 ? 'OK' : res.status === 404 ? 'Not Found' : '');
        setPushVapidStatus(`${res.status} ${text}`.trim());
        if (res.status === 404) {
          setPushServerAvailable(false);
        } else if (res.ok) {
          setPushServerAvailable(true);
        }
      } catch (err) {
        setPushVapidStatus(`Error: ${err instanceof Error ? err.message : String(err)}`);
      }
    } else {
      setPushVapidStatus(supported ? 'No pushUC' : 'Unsupported');
    }

    if ('serviceWorker' in navigator) {
      try {
        const reg = await navigator.serviceWorker.getRegistration();
        if (reg) {
          const state = reg.active ? 'active' : reg.waiting ? 'waiting' : reg.installing ? 'installing' : 'none';
          setPushSwState(state);
        } else {
          setPushSwState('none');
        }
        setPushSwController(navigator.serviceWorker.controller ? 'active' : 'none');
      } catch {
        setPushSwState('error');
        setPushSwController('none');
      }
    }

    try {
      const logs = (await pushUC?.getSWLogs?.()) ?? [];
      setSwLogs(logs);
    } catch {
      setSwLogs([]);
    }
  }, [pushUC]);

  const handleCopyDiagnostics = async () => {
    const host = pushEndpoint ? (() => {
      try {
        return new URL(pushEndpoint).host;
      } catch {
        return 'present';
      }
    })() : 'none';

    const text = [
      `RootInbox Notification Diagnostics`,
      `----------------------------------`,
      `Display Mode: ${displayMode}`,
      `User Agent: ${typeof navigator !== 'undefined' ? navigator.userAgent : 'unknown'}`,
      `Secure Context: ${pushSecureContext}`,
      `Notification Permission: ${pushPermission}`,
      `Subscription: ${pushSubscribed ? 'active' : 'none'}`,
      `Push Host: ${host}`,
      `Server VAPID: ${pushVapidStatus}`,
      `SW State: ${pushSwState}`,
      `SW Controller: ${pushSwController}`,
      `Cache Version: ${SW_CACHE_VERSION}`,
      `Build Timestamp: ${typeof __BUILD_TIMESTAMP__ !== 'undefined' ? __BUILD_TIMESTAMP__ : 'development'}`,
      `SW Event Log (${swLogs.length} events):`,
      ...swLogs.map((l) => `[${new Date(l.timestamp).toISOString()}] ${l.type}${l.detail ? ' ' + JSON.stringify(l.detail) : ''}`),
    ].join('\n');

    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
      }
      setCopiedField('diagnostics');
      setTimeout(() => setCopiedField(null), 2000);
    } catch {
      setCopiedField('diagnostics');
      setTimeout(() => setCopiedField(null), 2000);
    }
  };

  const handleTogglePush = async () => {
    if (!pushUC) return;
    setPushLoading(true);
    setErrorMsg(null);
    setSuccessMsg(null);
    try {
      if (pushSubscribed) {
        await pushUC.unsubscribe();
        setSuccessMsg('Push notifications turned off');
      } else {
        const ok = await pushUC.subscribe();
        if (ok) {
          setSuccessMsg('Push notifications enabled!');
        } else {
          setErrorMsg('Push notification permission was not granted');
        }
      }
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to update push notifications');
    } finally {
      setPushLoading(false);
      await refreshPushState();
    }
  };

  // Passcode Lock Hook & State
  const {
    isPasscodeEnabled,
    autoLockTimeout,
    setupPasscode,
    changePasscode,
    disablePasscode,
    setAutoLockTimeout,
  } = usePasscodeLock();

  const [showPasscodeForm, setShowPasscodeForm] = useState(false);
  const [passcodeMode, setPasscodeMode] = useState<'setup' | 'change' | 'disable'>('setup');
  const [currentPinInput, setCurrentPinInput] = useState('');
  const [newPinInput, setNewPinInput] = useState('');
  const [confirmPinInput, setConfirmPinInput] = useState('');
  const [passcodeError, setPasscodeError] = useState<string | null>(null);
  const [passcodeSuccess, setPasscodeSuccess] = useState<string | null>(null);
  const [passcodeProcessing, setPasscodeProcessing] = useState(false);

  const handleSavePasscode = async (e: React.FormEvent) => {
    e.preventDefault();
    setPasscodeError(null);
    setPasscodeSuccess(null);

    if (passcodeMode === 'disable') {
      if (!/^\d{4}$/.test(currentPinInput)) {
        setPasscodeError('Please enter your 4-digit passcode');
        return;
      }
      setPasscodeProcessing(true);
      try {
        const success = await disablePasscode(currentPinInput);
        if (!success) {
          setPasscodeError('Incorrect passcode');
          return;
        }
        setPasscodeSuccess('Passcode lock turned off');
        setShowPasscodeForm(false);
        setCurrentPinInput('');
      } catch {
        setPasscodeError('Failed to disable passcode');
      } finally {
        setPasscodeProcessing(false);
      }
      return;
    }

    if (!/^\d{4}$/.test(newPinInput)) {
      setPasscodeError('Passcode must be exactly 4 numeric digits');
      return;
    }
    if (newPinInput !== confirmPinInput) {
      setPasscodeError('Passcodes do not match');
      return;
    }

    setPasscodeProcessing(true);
    try {
      if (passcodeMode === 'change') {
        if (!/^\d{4}$/.test(currentPinInput)) {
          setPasscodeError('Current passcode must be 4 digits');
          return;
        }
        const success = await changePasscode(currentPinInput, newPinInput);
        if (!success) {
          setPasscodeError('Incorrect current passcode');
          return;
        }
        setPasscodeSuccess('Passcode changed successfully');
      } else {
        await setupPasscode(newPinInput);
        setPasscodeSuccess('Passcode lock enabled');
      }
      setShowPasscodeForm(false);
      setCurrentPinInput('');
      setNewPinInput('');
      setConfirmPinInput('');
    } catch {
      setPasscodeError('Failed to save passcode');
    } finally {
      setPasscodeProcessing(false);
    }
  };

  const handleStartDisablePasscode = () => {
    setPasscodeMode('disable');
    setShowPasscodeForm(true);
    setPasscodeError(null);
    setPasscodeSuccess(null);
    setCurrentPinInput('');
  };

  useEffect(() => {
    if (!isOpen) return;
    setErrorMsg(null);
    setSuccessMsg(null);
    setLoading(true);

    userPort
      .getMe()
      .then((p: UserProfile) => {
        setProfile(p);
        setDisplayNameInput(p.display_name || '');
        setLastNameInput(p.last_name || '');
        setBioInput(p.bio || '');
        setUsernameInput(p.username || '');
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : 'Failed to load profile';
        setErrorMsg(msg);
      })
      .finally(() => setLoading(false));

    void refreshPushState();
  }, [isOpen, userPort, refreshPushState]);

  if (!isOpen) return null;

  const handleCopy = (text: string, field: string) => {
    navigator.clipboard.writeText(text);
    setCopiedField(field);
    setTimeout(() => setCopiedField(null), 2000);
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setErrorMsg(null);
    setSuccessMsg(null);

    if (file.size > 2 * 1024 * 1024) {
      setErrorMsg('Avatar image must be smaller than 2MB');
      if (fileInputRef.current) fileInputRef.current.value = '';
      return;
    }

    const validTypes = ['image/jpeg', 'image/png', 'image/webp'];
    if (!validTypes.includes(file.type)) {
      setErrorMsg('Unsupported format. Please select JPEG, PNG, or WebP image');
      if (fileInputRef.current) fileInputRef.current.value = '';
      return;
    }

    setUploadingAvatar(true);
    try {
      const res = await userPort.uploadAvatar(file);
      const updated: UserProfile = {
        ...(profile as UserProfile),
        avatar_updated_at: res.avatar_updated_at,
      };
      setProfile(updated);
      setSuccessMsg('Avatar updated successfully');
      onProfileUpdated?.(updated);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to upload avatar';
      setErrorMsg(message);
    } finally {
      setUploadingAvatar(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleRemoveAvatar = async () => {
    setErrorMsg(null);
    setSuccessMsg(null);
    setUploadingAvatar(true);
    try {
      await userPort.deleteAvatar();
      const updated: UserProfile = {
        ...(profile as UserProfile),
        avatar_updated_at: 0,
      };
      setProfile(updated);
      setSuccessMsg('Avatar removed');
      onProfileUpdated?.(updated);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to remove avatar';
      setErrorMsg(message);
    } finally {
      setUploadingAvatar(false);
    }
  };

  const handleSaveProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);
    setSuccessMsg(null);

    const trimmedDisplay = displayNameInput.trim();
    if (!trimmedDisplay) {
      setErrorMsg('Display Name is required');
      return;
    }

    const trimmedUsername = usernameInput.trim().toLowerCase().replace(/^@/, '');
    if (!/^[a-z0-9_]{3,32}$/.test(trimmedUsername)) {
      setErrorMsg('Username must be 3-32 characters, lowercase alphanumeric or underscore');
      return;
    }

    if (bioInput.length > 200) {
      setErrorMsg('Bio cannot exceed 200 characters');
      return;
    }

    setSaving(true);
    try {
      // 1. Update profile (display_name, last_name, bio)
      const updatedProfile = await userPort.updateProfile({
        display_name: trimmedDisplay,
        last_name: lastNameInput.trim() || null,
        bio: bioInput.trim() || null,
      });

      // 2. Update username if changed
      let finalUsername = updatedProfile.username;
      if (trimmedUsername !== (profile?.username || '').toLowerCase()) {
        const resUser = await userPort.updateUsername(trimmedUsername);
        finalUsername = resUser.username ?? finalUsername;
        if (finalUsername) {
          await metadataPort.set('username', finalUsername);
        }
      }

      await metadataPort.set('display_name', trimmedDisplay);

      const merged: UserProfile = {
        ...updatedProfile,
        username: finalUsername,
      };

      setProfile(merged);
      setSuccessMsg('Profile updated successfully');
      onProfileUpdated?.(merged);
    } catch (err: unknown) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to save profile');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        id="user-profile-modal"
        className="modal-card"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <h2 className="modal-title">Edit Profile</h2>
          <button
            id="close-profile-modal-btn"
            type="button"
            onClick={onClose}
            className="modal-close-btn"
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        {errorMsg && (
          <div id="profile-error-banner" className="modal-error">
            {errorMsg}
          </div>
        )}

        {successMsg && (
          <div
            id="profile-success-banner"
            style={{
              padding: 'var(--space-2) var(--space-3)',
              backgroundColor: 'var(--color-success-bg)',
              border: '1px solid var(--color-success)',
              borderRadius: 'var(--radius-sm)',
              color: 'var(--color-success)',
              fontSize: 'var(--font-sm)',
              marginBottom: 'var(--space-3)',
            }}
          >
            {successMsg}
          </div>
        )}

        {loading ? (
          <div style={{ textAlign: 'center', padding: '30px 0', color: 'var(--color-text-tertiary)' }}>Loading profile...</div>
        ) : profile ? (
          <div>
            {/* Avatar Section */}
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: 'var(--space-3)',
                marginBottom: 'var(--space-4)',
                paddingBottom: 'var(--space-3)',
                borderBottom: '1px solid var(--color-border)',
              }}
            >
              <Avatar
                userId={profile.user_id}
                name={displayNameInput || profile.username || 'User'}
                size="lg"
              />

              <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
                <input
                  type="file"
                  ref={fileInputRef}
                  style={{ display: 'none' }}
                  accept="image/jpeg,image/png,image/webp"
                  onChange={handleFileChange}
                />
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={uploadingAvatar}
                  className="modal-btn modal-btn--primary"
                  data-testid="upload-avatar-btn"
                >
                  {uploadingAvatar ? 'Uploading...' : 'Set New Photo'}
                </button>

                {profile.avatar_updated_at && profile.avatar_updated_at > 0 && (
                  <button
                    type="button"
                    onClick={handleRemoveAvatar}
                    disabled={uploadingAvatar}
                    className="modal-btn modal-btn--danger"
                    data-testid="remove-avatar-btn"
                  >
                    Remove
                  </button>
                )}
              </div>
            </div>

            {/* Profile Form */}
            <form onSubmit={handleSaveProfile} className="modal-form">
              <div>
                <label
                  htmlFor="profile-display-name-input"
                  className="modal-label"
                >
                  Display Name <span style={{ color: 'var(--color-danger)' }}>*</span>
                </label>
                <input
                  id="profile-display-name-input"
                  type="text"
                  required
                  placeholder="e.g. Alice"
                  value={displayNameInput}
                  onChange={(e) => setDisplayNameInput(e.target.value)}
                  className="modal-input"
                />
              </div>

              <div>
                <label
                  htmlFor="profile-last-name-input"
                  className="modal-label"
                >
                  Last Name (optional)
                </label>
                <input
                  id="profile-last-name-input"
                  type="text"
                  placeholder="e.g. Wonder"
                  value={lastNameInput}
                  onChange={(e) => setLastNameInput(e.target.value)}
                  className="modal-input"
                />
              </div>

              <div>
                <label
                  htmlFor="profile-username-input"
                  className="modal-label"
                >
                  Username <span style={{ color: 'var(--color-danger)' }}>*</span>
                </label>
                <div style={{ position: 'relative' }}>
                  <span style={{ position: 'absolute', left: '10px', top: '9px', color: 'var(--color-text-tertiary)', pointerEvents: 'none' }}>@</span>
                  <input
                    id="profile-username-input"
                    type="text"
                    required
                    placeholder="alice"
                    value={usernameInput}
                    onChange={(e) => setUsernameInput(e.target.value)}
                    className="modal-input"
                    style={{ paddingLeft: '26px' }}
                  />
                </div>
              </div>

              <div>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
                  <label
                    htmlFor="profile-bio-input"
                    className="modal-label"
                  >
                    Bio
                  </label>
                  <span style={{ fontSize: 'var(--font-xs)', color: bioInput.length > 200 ? 'var(--color-danger)' : 'var(--color-text-tertiary)' }}>
                    {bioInput.length}/200
                  </span>
                </div>
                <textarea
                  id="profile-bio-input"
                  rows={3}
                  maxLength={200}
                  placeholder="A few words about yourself..."
                  value={bioInput}
                  onChange={(e) => setBioInput(e.target.value)}
                  className="modal-textarea"
                />
              </div>

              <button
                id="save-profile-btn"
                type="submit"
                disabled={saving}
                className="modal-btn modal-btn--primary"
                style={{ marginTop: 'var(--space-2)' }}
              >
                {saving ? 'Saving...' : 'Save Changes'}
              </button>
            </form>

            {/* Passcode Lock & Auto-Lock Section (Telegram Style) */}
            <div className="profile-passcode-section">
              <div className="passcode-section-header">
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <span style={{ fontSize: '18px' }}>🔒</span>
                  <div>
                    <h3 className="passcode-section-title">Passcode Lock</h3>
                    <p className="passcode-section-desc">
                      Protect RootInbox locally on this device with a 4-digit PIN.
                    </p>
                  </div>
                </div>
                <span className={`passcode-status-pill ${isPasscodeEnabled ? 'passcode-status-pill--active' : ''}`}>
                  {isPasscodeEnabled ? '✓ Enabled' : 'Off'}
                </span>
              </div>

              {passcodeError && (
                <div id="passcode-settings-error" className="modal-error" style={{ marginBottom: 'var(--space-2)' }}>
                  {passcodeError}
                </div>
              )}

              {passcodeSuccess && (
                <div id="passcode-settings-success" className="passcode-success-banner">
                  {passcodeSuccess}
                </div>
              )}

              {!isPasscodeEnabled ? (
                /* Not enabled yet */
                !showPasscodeForm ? (
                  <button
                    id="enable-passcode-btn"
                    type="button"
                    className="modal-btn modal-btn--secondary"
                    onClick={() => {
                      setPasscodeMode('setup');
                      setShowPasscodeForm(true);
                      setPasscodeError(null);
                      setPasscodeSuccess(null);
                      setNewPinInput('');
                      setConfirmPinInput('');
                    }}
                    style={{ width: '100%', marginTop: 'var(--space-2)' }}
                  >
                    + Turn On Passcode Lock
                  </button>
                ) : (
                  /* Setup Form */
                  <form onSubmit={(e) => void handleSavePasscode(e)} className="passcode-inline-form">
                    <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
                      <div style={{ flex: 1 }}>
                        <label htmlFor="new-passcode-input" className="passcode-field-label">
                          New 4-Digit Passcode
                        </label>
                        <input
                          id="new-passcode-input"
                          type="password"
                          inputMode="numeric"
                          pattern="[0-9]*"
                          maxLength={4}
                          value={newPinInput}
                          onChange={(e) => setNewPinInput(e.target.value.replace(/\D/g, '').slice(0, 4))}
                          placeholder="••••"
                          className="auth-input"
                          autoFocus
                          required
                        />
                      </div>
                      <div style={{ flex: 1 }}>
                        <label htmlFor="confirm-passcode-input" className="passcode-field-label">
                          Confirm Passcode
                        </label>
                        <input
                          id="confirm-passcode-input"
                          type="password"
                          inputMode="numeric"
                          pattern="[0-9]*"
                          maxLength={4}
                          value={confirmPinInput}
                          onChange={(e) => setConfirmPinInput(e.target.value.replace(/\D/g, '').slice(0, 4))}
                          placeholder="••••"
                          className="auth-input"
                          required
                        />
                      </div>
                    </div>
                    <div style={{ display: 'flex', gap: 'var(--space-2)', marginTop: 'var(--space-2)' }}>
                      <button
                        id="save-passcode-btn"
                        type="submit"
                        disabled={passcodeProcessing || newPinInput.length !== 4 || confirmPinInput.length !== 4}
                        className="modal-btn modal-btn--primary"
                        style={{ flex: 1 }}
                      >
                        {passcodeProcessing ? 'Saving...' : 'Set Passcode'}
                      </button>
                      <button
                        id="cancel-passcode-btn"
                        type="button"
                        className="modal-btn modal-btn--secondary"
                        onClick={() => {
                          setShowPasscodeForm(false);
                          setPasscodeError(null);
                        }}
                      >
                        Cancel
                      </button>
                    </div>
                  </form>
                )
              ) : (
                /* Enabled: show auto-lock selector and change/disable actions */
                <div className="passcode-active-controls">
                  <div className="passcode-control-row">
                    <label htmlFor="autolock-select" className="passcode-control-label">
                      Auto-Lock
                    </label>
                    <select
                      id="autolock-select"
                      value={autoLockTimeout}
                      onChange={(e) => void setAutoLockTimeout(e.target.value as AutoLockTimeout)}
                      className="passcode-select"
                    >
                      <option value="1m">If away for 1 minute</option>
                      <option value="5m">If away for 5 minutes</option>
                      <option value="15m">If away for 15 minutes</option>
                      <option value="1h">If away for 1 hour</option>
                      <option value="blur">On tab blur / background</option>
                      <option value="off">Disabled (manual lock only)</option>
                    </select>
                  </div>

                  {!showPasscodeForm ? (
                    <div style={{ display: 'flex', gap: 'var(--space-2)', marginTop: 'var(--space-2)' }}>
                      <button
                        id="change-passcode-btn"
                        type="button"
                        className="modal-btn modal-btn--secondary"
                        style={{ flex: 1 }}
                        onClick={() => {
                          setPasscodeMode('change');
                          setShowPasscodeForm(true);
                          setPasscodeError(null);
                          setPasscodeSuccess(null);
                          setCurrentPinInput('');
                          setNewPinInput('');
                          setConfirmPinInput('');
                        }}
                      >
                        Change Passcode
                      </button>
                      <button
                        id="disable-passcode-btn"
                        type="button"
                        className="modal-btn modal-btn--danger"
                        style={{ flex: 1 }}
                        onClick={handleStartDisablePasscode}
                      >
                        Turn Off Passcode
                      </button>
                    </div>
                  ) : passcodeMode === 'disable' ? (
                    /* Turn Off Passcode Verification Form */
                    <form onSubmit={(e) => void handleSavePasscode(e)} className="passcode-inline-form">
                      <div style={{ marginBottom: 'var(--space-2)' }}>
                        <label htmlFor="current-passcode-input" className="passcode-field-label">
                          Enter Current 4-Digit Passcode to Turn Off
                        </label>
                        <input
                          id="current-passcode-input"
                          type="password"
                          inputMode="numeric"
                          pattern="[0-9]*"
                          maxLength={4}
                          value={currentPinInput}
                          onChange={(e) => setCurrentPinInput(e.target.value.replace(/\D/g, '').slice(0, 4))}
                          placeholder="••••"
                          className="auth-input"
                          autoFocus
                          required
                        />
                      </div>
                      <div style={{ display: 'flex', gap: 'var(--space-2)', marginTop: 'var(--space-2)' }}>
                        <button
                          id="confirm-disable-passcode-btn"
                          type="submit"
                          disabled={passcodeProcessing || currentPinInput.length !== 4}
                          className="modal-btn modal-btn--danger"
                          style={{ flex: 1 }}
                        >
                          {passcodeProcessing ? 'Turning Off...' : 'Confirm Turn Off'}
                        </button>
                        <button
                          id="cancel-passcode-btn"
                          type="button"
                          className="modal-btn modal-btn--secondary"
                          onClick={() => {
                            setShowPasscodeForm(false);
                            setPasscodeError(null);
                          }}
                        >
                          Cancel
                        </button>
                      </div>
                    </form>
                  ) : (
                    /* Change Passcode Form */
                    <form onSubmit={(e) => void handleSavePasscode(e)} className="passcode-inline-form">
                      <div style={{ marginBottom: 'var(--space-2)' }}>
                        <label htmlFor="current-passcode-input" className="passcode-field-label">
                          Current 4-Digit Passcode
                        </label>
                        <input
                          id="current-passcode-input"
                          type="password"
                          inputMode="numeric"
                          pattern="[0-9]*"
                          maxLength={4}
                          value={currentPinInput}
                          onChange={(e) => setCurrentPinInput(e.target.value.replace(/\D/g, '').slice(0, 4))}
                          placeholder="••••"
                          className="auth-input"
                          autoFocus
                          required
                        />
                      </div>
                      <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
                        <div style={{ flex: 1 }}>
                          <label htmlFor="new-passcode-input" className="passcode-field-label">
                            New Passcode
                          </label>
                          <input
                            id="new-passcode-input"
                            type="password"
                            inputMode="numeric"
                            pattern="[0-9]*"
                            maxLength={4}
                            value={newPinInput}
                            onChange={(e) => setNewPinInput(e.target.value.replace(/\D/g, '').slice(0, 4))}
                            placeholder="••••"
                            className="auth-input"
                            required
                          />
                        </div>
                        <div style={{ flex: 1 }}>
                          <label htmlFor="confirm-passcode-input" className="passcode-field-label">
                            Confirm New
                          </label>
                          <input
                            id="confirm-passcode-input"
                            type="password"
                            inputMode="numeric"
                            pattern="[0-9]*"
                            maxLength={4}
                            value={confirmPinInput}
                            onChange={(e) => setConfirmPinInput(e.target.value.replace(/\D/g, '').slice(0, 4))}
                            placeholder="••••"
                            className="auth-input"
                            required
                          />
                        </div>
                      </div>
                      <div style={{ display: 'flex', gap: 'var(--space-2)', marginTop: 'var(--space-2)' }}>
                        <button
                          id="save-changed-passcode-btn"
                          type="submit"
                          disabled={passcodeProcessing || currentPinInput.length !== 4 || newPinInput.length !== 4 || confirmPinInput.length !== 4}
                          className="modal-btn modal-btn--primary"
                          style={{ flex: 1 }}
                        >
                          {passcodeProcessing ? 'Updating...' : 'Update Passcode'}
                        </button>
                        <button
                          id="cancel-passcode-btn"
                          type="button"
                          className="modal-btn modal-btn--secondary"
                          onClick={() => {
                            setShowPasscodeForm(false);
                            setPasscodeError(null);
                          }}
                        >
                          Cancel
                        </button>
                      </div>
                    </form>
                  )}
                  <p className="passcode-hint-text">
                    🔒 Quick-lock button is available in the header. Background calls will continue to be received securely.
                  </p>
                </div>
              )}
            </div>

            {/* Push Notifications Section */}
            <div className="passcode-section" style={{ marginTop: 'var(--space-3)' }}>
              <div className="passcode-header">
                <span className="passcode-title">🔔 Web Push Notifications</span>
                <span className={`passcode-badge ${pushSubscribed && pushServerAvailable ? 'passcode-badge--enabled' : 'passcode-badge--disabled'}`}>
                  {pushSubscribed && pushServerAvailable ? 'Subscribed' : 'Off'}
                </span>
              </div>
              <p className="passcode-desc">
                Receive alerts for incoming calls and new messages even when RootInbox is closed or in the background.
              </p>

              <div style={{ marginTop: 'var(--space-2)' }}>
                {!pushSupported ? (
                  <div style={{ color: 'var(--color-warning)', fontSize: 'var(--font-xs)', marginTop: '4px' }}>
                    ⚠️ Web Push is not supported in this browser or context.
                  </div>
                ) : !pushServerAvailable ? (
                  <div data-testid="push-disabled-server-msg" style={{ color: 'var(--color-text-secondary)', fontSize: 'var(--font-xs)', marginTop: '4px' }}>
                    Push is not enabled on the server
                  </div>
                ) : pushPermission === 'denied' ? (
                  <div style={{ color: 'var(--color-danger)', fontSize: 'var(--font-xs)', marginTop: '4px' }}>
                    🚫 Notification permission is blocked in your browser. Please reset permission in your browser site settings.
                  </div>
                ) : (
                  <button
                    id="toggle-push-btn"
                    data-testid="toggle-push-btn"
                    type="button"
                    className={`modal-btn ${pushSubscribed ? 'modal-btn--secondary' : 'modal-btn--primary'}`}
                    style={{ width: '100%', marginTop: 'var(--space-2)' }}
                    disabled={pushLoading}
                    onClick={() => void handleTogglePush()}
                  >
                    {pushLoading ? 'Updating...' : pushSubscribed ? 'Disable Notifications' : 'Enable Notifications'}
                  </button>
                )}
              </div>

              {/* Collapsible Notification Diagnostics */}
              <details style={{ marginTop: 'var(--space-2)', borderTop: '1px solid var(--color-border-light)', paddingTop: 'var(--space-2)' }}>
                <summary style={{ cursor: 'pointer', color: 'var(--color-text-tertiary)', fontSize: 'var(--font-xs)', userSelect: 'none' }}>
                  Notification Diagnostics
                </summary>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-1)', marginTop: 'var(--space-2)', fontSize: 'var(--font-xs)', fontFamily: 'var(--font-mono)' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span style={{ color: 'var(--color-text-secondary)' }}>Display Mode:</span>
                    <span>{displayMode}</span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span style={{ color: 'var(--color-text-secondary)' }}>User Agent:</span>
                    <span style={{ maxWidth: '200px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={typeof navigator !== 'undefined' ? navigator.userAgent : ''}>
                      {typeof navigator !== 'undefined' ? navigator.userAgent : 'unknown'}
                    </span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span style={{ color: 'var(--color-text-secondary)' }}>Secure Context:</span>
                    <span>{pushSecureContext ? 'true (HTTPS/localhost)' : 'false (Insecure)'}</span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span style={{ color: 'var(--color-text-secondary)' }}>Permission:</span>
                    <span>{pushPermission}</span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span style={{ color: 'var(--color-text-secondary)' }}>Subscription:</span>
                    <span>{pushSubscribed ? 'active' : 'none'}</span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span style={{ color: 'var(--color-text-secondary)' }}>Push Host:</span>
                    <span style={{ maxWidth: '200px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {pushEndpoint ? (() => {
                        try {
                          return new URL(pushEndpoint).host;
                        } catch {
                          return 'present';
                        }
                      })() : 'none'}
                    </span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span style={{ color: 'var(--color-text-secondary)' }}>Server VAPID:</span>
                    <span>{pushVapidStatus}</span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span style={{ color: 'var(--color-text-secondary)' }}>SW Registration:</span>
                    <span>{pushSwState}</span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span style={{ color: 'var(--color-text-secondary)' }}>SW Controller:</span>
                    <span>{pushSwController}</span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span style={{ color: 'var(--color-text-secondary)' }}>Cache Version:</span>
                    <span>{SW_CACHE_VERSION}</span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span style={{ color: 'var(--color-text-secondary)' }}>Build Timestamp:</span>
                    <span style={{ fontSize: '10px' }}>{typeof __BUILD_TIMESTAMP__ !== 'undefined' ? __BUILD_TIMESTAMP__ : 'development'}</span>
                  </div>

                  {swLogs.length > 0 && (
                    <div style={{ marginTop: 'var(--space-2)' }}>
                      <span style={{ color: 'var(--color-text-secondary)', display: 'block', marginBottom: '4px' }}>
                        Recent SW Events ({swLogs.length}):
                      </span>
                      <div style={{ maxHeight: '120px', overflowY: 'auto', backgroundColor: 'var(--color-bg-secondary)', padding: '6px', borderRadius: 'var(--radius-sm)', fontSize: '10px' }}>
                        {swLogs.slice(-15).reverse().map((ev, i) => (
                          <div key={ev.id ?? i} style={{ marginBottom: '2px', borderBottom: '1px solid var(--color-border-light)' }}>
                            <span style={{ color: 'var(--color-accent)' }}>{new Date(ev.timestamp).toLocaleTimeString()}</span>{' '}
                            <strong>{ev.type}</strong>{' '}
                            {ev.detail ? JSON.stringify(ev.detail) : ''}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  <button
                    id="copy-diagnostics-btn"
                    data-testid="copy-diagnostics-btn"
                    type="button"
                    onClick={() => void handleCopyDiagnostics()}
                    className="modal-btn modal-btn--secondary"
                    style={{ marginTop: 'var(--space-2)', width: '100%', fontSize: 'var(--font-xs)' }}
                  >
                    {copiedField === 'diagnostics' ? '✓ Diagnostics Copied' : '📋 Copy diagnostics'}
                  </button>
                </div>
              </details>
            </div>

            {!isInstalled && (
              <div style={{ marginTop: 'var(--space-3)' }}>
                <button
                  id="profile-install-btn"
                  type="button"
                  onClick={async () => {
                    if (hasNativePrompt) {
                      await promptInstall();
                    } else {
                      setShowInstallSubModal(true);
                    }
                  }}
                  className="modal-btn modal-btn--secondary"
                  style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px' }}
                >
                  <span>📥</span>
                  <span>Install RootInbox App</span>
                </button>
              </div>
            )}

            {/* Collapsed Technical Details */}
            <details style={{ marginTop: 'var(--space-4)', borderTop: '1px solid var(--color-border)', paddingTop: 'var(--space-3)' }}>
              <summary style={{ cursor: 'pointer', color: 'var(--color-text-tertiary)', fontSize: 'var(--font-xs)', userSelect: 'none' }}>
                Technical Details
              </summary>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)', marginTop: 'var(--space-2)' }}>
                <div>
                  <span style={{ fontSize: '11px', color: 'var(--color-text-tertiary)', display: 'block', marginBottom: '2px' }}>
                    Identity Hash
                  </span>
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      backgroundColor: 'var(--color-bg-secondary)',
                      padding: 'var(--space-1) var(--space-2)',
                      borderRadius: 'var(--radius-sm)',
                      fontSize: 'var(--font-xs)',
                      fontFamily: 'var(--font-mono)',
                      color: 'var(--color-text-primary)',
                      border: '1px solid var(--color-border-light)',
                    }}
                  >
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '280px' }}>
                      {profile.identity_hash}
                    </span>
                    <button
                      type="button"
                      onClick={() => handleCopy(profile.identity_hash || '', 'hash')}
                      style={{
                        background: 'none',
                        border: 'none',
                        color: copiedField === 'hash' ? 'var(--color-success)' : 'var(--color-accent)',
                        cursor: 'pointer',
                        fontSize: 'var(--font-xs)',
                        marginLeft: 'var(--space-2)',
                        fontWeight: 600,
                      }}
                    >
                      {copiedField === 'hash' ? 'Copied!' : 'Copy'}
                    </button>
                  </div>
                </div>

                <div>
                  <span style={{ fontSize: '11px', color: 'var(--color-text-tertiary)', display: 'block', marginBottom: '2px' }}>
                    User ID
                  </span>
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      backgroundColor: 'var(--color-bg-secondary)',
                      padding: 'var(--space-1) var(--space-2)',
                      borderRadius: 'var(--radius-sm)',
                      fontSize: 'var(--font-xs)',
                      fontFamily: 'var(--font-mono)',
                      color: 'var(--color-text-primary)',
                      border: '1px solid var(--color-border-light)',
                    }}
                  >
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '280px' }}>
                      {profile.user_id}
                    </span>
                    <button
                      type="button"
                      onClick={() => handleCopy(profile.user_id, 'id')}
                      style={{
                        background: 'none',
                        border: 'none',
                        color: copiedField === 'id' ? 'var(--color-success)' : 'var(--color-accent)',
                        cursor: 'pointer',
                        fontSize: 'var(--font-xs)',
                        marginLeft: 'var(--space-2)',
                        fontWeight: 600,
                      }}
                    >
                      {copiedField === 'id' ? 'Copied!' : 'Copy'}
                    </button>
                  </div>
                </div>
              </div>
            </details>

            <InstallModal
              isOpen={showInstallSubModal}
              onClose={() => setShowInstallSubModal(false)}
            />
          </div>
        ) : null}
      </div>
    </div>
  );
};
