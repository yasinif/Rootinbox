/**
 * AuthUseCase — register, login, reactive auth state.
 * RFC-0010 §4.1: UseCase layer may import domain only (NOT infrastructure).
 * Uses domain ports for DI.
 *
 * Auth failures: single uniform message (no detail leak).
 */

import type {
  AuthPort,
  CryptoPort,
  MetadataPort,
  SessionDTO,
  ZKVaultPort,
  ZeroKnowledgeVaultPayload,
} from '../domain';

export type AuthState = 'idle' | 'loading' | 'authenticated' | 'locked' | 'error';

export interface AuthStateSnapshot {
  state: AuthState;
  identityHash: string | null;
  publicKey: string | null;
  username?: string | null;
  displayName?: string | null;
  userId?: string | null;
  error: string | null;
}

type AuthStateListener = (snapshot: AuthStateSnapshot) => void;

export class AuthUseCase {
  private authPort: AuthPort;
  private cryptoPort: CryptoPort;
  private metadataPort: MetadataPort;
  private zkVaultPort?: ZKVaultPort;
  private onBeforeLogout?: () => Promise<void>;
  private listeners = new Set<AuthStateListener>();
  private snapshot: AuthStateSnapshot = {
    state: 'idle',
    identityHash: null,
    publicKey: null,
    error: null,
  };

  constructor(
    authPort: AuthPort,
    cryptoPort: CryptoPort,
    metadataPort: MetadataPort,
    zkVaultPort?: ZKVaultPort,
  ) {
    this.authPort = authPort;
    this.cryptoPort = cryptoPort;
    this.metadataPort = metadataPort;
    this.zkVaultPort = zkVaultPort;
  }

  setBeforeLogoutHook(hook: () => Promise<void>): void {
    this.onBeforeLogout = hook;
  }

  subscribe(listener: AuthStateListener): () => void {
    this.listeners.add(listener);
    listener(this.snapshot);
    return () => this.listeners.delete(listener);
  }

  getSnapshot(): AuthStateSnapshot {
    return this.snapshot;
  }

  private emit(patch: Partial<AuthStateSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener(this.snapshot);
  }

  private async persistSessionKeypair(keypair: { publicKey: string; privateKey: string; sessionId?: string; expiresAt?: number }): Promise<void> {
    try {
      await this.metadataPort.set('active_session_keypair', JSON.stringify(keypair));
      const savedKeyring = await this.metadataPort.get('session_keyring');
      let keyring: Array<{ publicKey: string; privateKey: string; sessionId?: string; expiresAt?: number }> = [];
      if (savedKeyring) {
        try {
          const parsed = JSON.parse(savedKeyring);
          if (Array.isArray(parsed)) keyring = parsed;
        } catch {
          // ignore malformed keyring
        }
      }
      keyring = [keypair, ...keyring.filter((k) => k.publicKey !== keypair.publicKey)].slice(0, 10);
      await this.metadataPort.set('session_keyring', JSON.stringify(keyring));
      if (this.cryptoPort.importSessionKeyring) {
        await this.cryptoPort.importSessionKeyring(keyring);
      }
    } catch (err) {
      console.warn('[AuthUseCase] persistSessionKeypair failed:', err);
    }
  }

  private async restoreSessionKeyring(): Promise<boolean> {
    let restoredAny = false;
    try {
      const savedActive = await this.metadataPort.get('active_session_keypair');
      if (savedActive && this.cryptoPort.importSessionKeys) {
        const parsed = JSON.parse(savedActive);
        if (parsed.publicKey && parsed.privateKey) {
          await this.cryptoPort.importSessionKeys(parsed);
          restoredAny = true;
        }
      }
      const savedKeyring = await this.metadataPort.get('session_keyring');
      if (savedKeyring && this.cryptoPort.importSessionKeyring) {
        const parsedKeyring = JSON.parse(savedKeyring);
        if (Array.isArray(parsedKeyring) && parsedKeyring.length > 0) {
          await this.cryptoPort.importSessionKeyring(parsedKeyring);
          restoredAny = true;
        }
      }

      const savedSeq = await this.metadataPort.get('outgoing_sequence');
      if (savedSeq && this.cryptoPort.setOutgoingSequence) {
        await this.cryptoPort.setOutgoingSequence(savedSeq);
      }
    } catch (err) {
      console.warn('[AuthUseCase] restoreSessionKeyring failed:', err);
    }
    return restoredAny;
  }

  setLocked(user: { username?: string | null; displayName?: string | null; userId?: string | null; identityHash?: string | null }): void {
    this.emit({
      state: 'locked',
      username: user.username,
      displayName: user.displayName,
      userId: user.userId,
      identityHash: user.identityHash ?? null,
      error: null,
    });
  }

  async register(username: string, password: string, displayName?: string, rememberMe = true): Promise<void> {
    this.emit({ state: 'loading', error: null });
    try {
      await this.metadataPort.delete('session_keyring');
      await this.metadataPort.delete('active_session_keypair');

      // 1. Init crypto worker (derive identity key).
      const identity = await this.cryptoPort.init(username, password);

      // 1b. Derive Vault Key (Argon2id with username || 'VAULT').
      await this.cryptoPort.deriveVaultKey(username, password);

      // Stage 1a: Derive KDF master seed, auth keypair, vault key, recovery key
      let authPubkey: string | undefined;
      let kdfSalt: string | undefined;
      let recoveryKeyHex: string | undefined;
      if (this.cryptoPort.deriveStage1aKeys) {
        try {
          const keys = await this.cryptoPort.deriveStage1aKeys(password);
          authPubkey = keys.authPubkey;
          kdfSalt = keys.salt;
          recoveryKeyHex = keys.recoveryKeyHex;
        } catch (err) {
          console.warn('[AuthUseCase] deriveStage1aKeys failed:', err);
        }
      }

      // 1c. Remember Keys (RFC-0003 §8.3): Persist keys wrapped with non-extractable AES-GCM wrapping key
      // If rememberMe is true, persist keys in IndexedDB keyring; if false, ensure keyring is cleared.
      if (rememberMe) {
        if (this.cryptoPort.persistKeys) {
          try {
            await this.cryptoPort.persistKeys();
          } catch (err) {
            console.warn('[AuthUseCase] persistKeys best-effort failed:', err);
          }
        }
      } else {
        if (this.cryptoPort.clearKeys) {
          try {
            await this.cryptoPort.clearKeys();
          } catch {
            // Best effort
          }
        }
      }

      // 2. Generate session keys.
      const session = await this.cryptoPort.generateSessionKeys();
      const expiresAt = Math.floor(Date.now() / 1000) + 86400; // 24h

      // 3. Build registration wire (137 bytes raw binary).
      // The wire already contains: identityPK + sessionPK + signature + version + expiresAt.
      const { wireBytes } = await this.cryptoPort.buildRegistrationWire(session.publicKey, expiresAt);

      // 4. Register with server (raw binary POST, application/octet-stream).
      const result = authPubkey && kdfSalt
        ? await this.authPort.register(wireBytes, username, displayName, rememberMe, authPubkey, kdfSalt)
        : await this.authPort.register(wireBytes, username, displayName, rememberMe);

      // 5. Persist session info.
      if (rememberMe) {
        await this.metadataPort.set('session_token', result.session_token);
        await this.metadataPort.set('identity_hash', identity.identityHash);
        if (result.user_id) {
          await this.metadataPort.set('user_id', result.user_id);
        }
        if (username) {
          await this.metadataPort.set('auth_username', username);
          await this.metadataPort.set('username', username);
        }
        if (displayName) {
          await this.metadataPort.set('display_name', displayName);
        }
        if (typeof sessionStorage !== 'undefined') {
          sessionStorage.removeItem('is_session_only');
          sessionStorage.removeItem('session_token');
        }
        if (this.cryptoPort.exportSessionKeys) {
          try {
            const exported = await this.cryptoPort.exportSessionKeys();
            await this.persistSessionKeypair({ ...exported, expiresAt });
          } catch {
            // Export session keys best effort
          }
        }
      } else {
        // Session-only mode for public/shared computers: store only in sessionStorage.
        if (typeof sessionStorage !== 'undefined') {
          sessionStorage.setItem('is_session_only', 'true');
          sessionStorage.setItem('session_token', result.session_token);
          sessionStorage.setItem('auth_username', username);
          sessionStorage.setItem('identity_hash', identity.identityHash);
          if (result.user_id) sessionStorage.setItem('user_id', result.user_id);
          if (displayName) sessionStorage.setItem('display_name', displayName);
        }
        // Remove from persistent Dexie metadata so closing browser clears session.
        await this.metadataPort.delete('session_token');
        await this.metadataPort.delete('active_session_keypair');
        await this.metadataPort.delete('session_keyring');
      }

      // Stage 1a: Initialize and save initial Zero-Knowledge Vault (version 1)
      if (result.user_id && this.zkVaultPort && this.cryptoPort.sealZKVault) {
        try {
          const initialPayload: ZeroKnowledgeVaultPayload = {
            schema_version: 1,
            user_id: result.user_id,
            username,
            identity_keys: {
              id_sign_pk: identity.publicKey,
              id_sign_sk: '',
              id_dh_pk: '',
              id_dh_sk: '',
            },
            devices: [
              {
                device_id: 'default',
                label: 'Web Device',
                created_at: Date.now(),
                last_seen_at: Date.now(),
              },
            ],
            conversation_epochs: {},
            pinned_identities: {},
            recovery_skipped: false,
          };
          const sealed = await this.cryptoPort.sealZKVault(initialPayload, 1);
          await this.zkVaultPort.saveVault(0, sealed.ciphertextHex, sealed.signatureHex);
          await this.metadataPort.set('last_seen_vault_version', '1');
          if (recoveryKeyHex) {
            await this.metadataPort.set('pending_recovery_key', recoveryKeyHex);
          }
        } catch (err) {
          console.warn('[AuthUseCase] initial zkVault upload best-effort failed:', err);
        }
      }

      this.emit({
        state: 'authenticated',
        identityHash: identity.identityHash,
        publicKey: identity.publicKey,
        username,
        displayName: displayName || username,
        userId: result.user_id,
      });
    } catch (err: unknown) {
      if (err && typeof err === 'object' && 'code' in err) {
        const apiErr = err as { code: string; message?: string };
        if (apiErr.code === 'USR_003' || apiErr.code === 'USR_002') {
          this.emit({ state: 'error', error: 'Username is already taken' });
          return;
        }
        if (apiErr.code === 'USR_004') {
          this.emit({ state: 'error', error: apiErr.message || 'Invalid username format' });
          return;
        }
      }
      // Single uniform error message — no detail leak.
      this.emit({ state: 'error', error: 'Authentication failed' });
    }
  }

  async login(username: string, password: string, rememberMe = true): Promise<void> {
    this.emit({ state: 'loading', error: null });
    try {
      // Stage 1a: Pre-Auth KDF parameters
      if (this.authPort.getKdfParams && this.cryptoPort.deriveStage1aKeys) {
        try {
          const kdfParams = await this.authPort.getKdfParams(username);
          if (kdfParams && kdfParams.salt) {
            await this.cryptoPort.deriveStage1aKeys(password, kdfParams.salt);
          }
        } catch (err) {
          console.warn('[AuthUseCase] getKdfParams best-effort failed:', err);
        }
      }

      // 1. Init crypto worker (derive identity key).
      const identity = await this.cryptoPort.init(username, password);

      // 1b. Derive Vault Key (Argon2id with username || 'VAULT').
      await this.cryptoPort.deriveVaultKey(username, password);

      // 1c. Remember Keys (RFC-0003 §8.3): Persist keys wrapped with non-extractable AES-GCM wrapping key
      if (rememberMe) {
        if (this.cryptoPort.persistKeys) {
          try {
            await this.cryptoPort.persistKeys();
          } catch (err) {
            console.warn('[AuthUseCase] persistKeys best-effort failed in login:', err);
          }
        }
      } else {
        if (this.cryptoPort.clearKeys) {
          try {
            await this.cryptoPort.clearKeys();
          } catch {
            // Best effort
          }
        }
      }

      // 2. Request challenge.
      const challenge = await this.authPort.requestChallenge(identity.identityHash);

      // If switching accounts on this device, clear old user's keyring
      const previousHash = await this.metadataPort.get('identity_hash');
      if (previousHash && previousHash.toLowerCase() !== identity.identityHash.toLowerCase()) {
        await this.metadataPort.delete('session_keyring');
        await this.metadataPort.delete('active_session_keypair');
      }

      // 3. Restore or generate session keys.
      let session: { publicKey: string; sessionId: string } | null = null;
      let expiresAt = Math.floor(Date.now() / 1000) + 86400;
      const nowSec = Math.floor(Date.now() / 1000);

      // Restore all existing keyring entries into worker so past messages decrypt
      await this.restoreSessionKeyring();

      const saved = await this.metadataPort.get('active_session_keypair');
      if (saved && this.cryptoPort.importSessionKeys) {
        try {
          const parsed = JSON.parse(saved);
          if (parsed.publicKey && parsed.privateKey && parsed.expiresAt > nowSec + 60) {
            await this.cryptoPort.importSessionKeys({
              publicKey: parsed.publicKey,
              privateKey: parsed.privateKey,
              sessionId: parsed.sessionId,
            });
            session = { publicKey: parsed.publicKey, sessionId: parsed.sessionId };
            expiresAt = parsed.expiresAt;
          }
        } catch {
          // Session key restore best effort
        }
      }

      if (!session) {
        session = await this.cryptoPort.generateSessionKeys();
        if (this.cryptoPort.exportSessionKeys) {
          try {
            const exported = await this.cryptoPort.exportSessionKeys();
            await this.persistSessionKeypair({ ...exported, expiresAt });
          } catch {
            // Export session keys best effort
          }
        }
      }

      // 4. Sign login payload.
      const { signature } = await this.cryptoPort.signLoginPayload(
        challenge.nonce,
        session.publicKey,
        challenge.challengeId,
      );

      // 5. Sign session key for server-side verification.
      const sessionSig = await this.cryptoPort.signSessionKey(session.publicKey, expiresAt);

      // 6. Verify with server.
      const result = await this.authPort.verify(
        identity.identityHash,
        challenge.challengeId,
        signature,
        session.publicKey,
        sessionSig.signature,
        expiresAt,
        rememberMe,
      );

      // 7. Persist session.
      let displayName = username;
      if (rememberMe) {
        await this.metadataPort.set('session_token', result.session_token);
        await this.metadataPort.set('identity_hash', identity.identityHash);
        if (result.user_id) {
          await this.metadataPort.set('user_id', result.user_id);
        }
        if (username) {
          await this.metadataPort.set('auth_username', username);
          await this.metadataPort.set('username', username);
        }
        if (typeof sessionStorage !== 'undefined') {
          sessionStorage.removeItem('is_session_only');
          sessionStorage.removeItem('session_token');
        }
        displayName = (await this.metadataPort.get('display_name')) || username;
      } else {
        // Session-only mode for public/shared computers: store in sessionStorage.
        if (typeof sessionStorage !== 'undefined') {
          sessionStorage.setItem('is_session_only', 'true');
          sessionStorage.setItem('session_token', result.session_token);
          sessionStorage.setItem('auth_username', username);
          sessionStorage.setItem('identity_hash', identity.identityHash);
          if (result.user_id) sessionStorage.setItem('user_id', result.user_id);
          displayName = sessionStorage.getItem('display_name') || username;
        }
        // Remove from persistent Dexie metadata so closing browser clears session.
        await this.metadataPort.delete('session_token');
        await this.metadataPort.delete('active_session_keypair');
        await this.metadataPort.delete('session_keyring');
      }

      // Stage 1a: Download, verify, and decrypt Zero-Knowledge Vault
      if (result.user_id && this.zkVaultPort && this.cryptoPort.openZKVault) {
        try {
          const vault = await this.zkVaultPort.getVault();
          if (vault) {
            const lastSeen = await this.metadataPort.get('last_seen_vault_version');
            if (lastSeen) {
              const lastVer = parseInt(lastSeen, 10);
              if (!isNaN(lastVer) && vault.version < lastVer) {
                console.error('[AuthUseCase] Vault rollback detected! Server version:', vault.version, 'Local version:', lastVer);
                throw new Error('Server rollback detected: vault version is older than local version');
              }
            }
            await this.cryptoPort.openZKVault(vault.ciphertext, vault.signature, vault.version, vault.user_id);
            await this.metadataPort.set('last_seen_vault_version', String(vault.version));
          }
        } catch (err) {
          console.warn('[AuthUseCase] vault sync best-effort failed:', err);
        }
      }

      this.emit({
        state: 'authenticated',
        identityHash: identity.identityHash,
        publicKey: identity.publicKey,
        username,
        displayName,
        userId: result.user_id,
      });
    } catch {
      this.emit({ state: 'error', error: 'Authentication failed' });
    }
  }

  /**
   * Unlock after page refresh.
   * Derives BOTH Identity Key and Vault Key so all history (including vault_ciphertext)
   * can be decrypted seamlessly without requiring full re-authentication.
   */
  async unlock(password: string): Promise<void> {
    this.emit({ state: 'loading', error: null });
    try {
      const isSessionOnly = typeof sessionStorage !== 'undefined' && sessionStorage.getItem('is_session_only') === 'true';
      const storedAuthUser = (isSessionOnly && typeof sessionStorage !== 'undefined' && sessionStorage.getItem('auth_username')) || (await this.metadataPort.get('auth_username'));
      const rawUsername = storedAuthUser || this.snapshot.username || (await this.metadataPort.get('username'));
      if (!rawUsername) {
        throw new Error('No username available to unlock');
      }
      const username = rawUsername.trim().toLowerCase().replace(/^@/, '');

      // 1. Re-derive Identity Key.
      const identity = await this.cryptoPort.init(username, password);

      // Verify identity hash matches if present (case-insensitive and trimmed).
      const savedHash = this.snapshot.identityHash || (isSessionOnly && typeof sessionStorage !== 'undefined' && sessionStorage.getItem('identity_hash')) || (await this.metadataPort.get('identity_hash'));
      if (savedHash && identity.identityHash.toLowerCase() !== savedHash.trim().toLowerCase()) {
        console.error('[authUC.unlock] Identity hash mismatch:', {
          derived: identity.identityHash,
          saved: savedHash,
          username,
        });
        throw new Error('Identity hash mismatch');
      }

      // 2. Re-derive Vault Key (Argon2id with username || 'VAULT').
      await this.cryptoPort.deriveVaultKey(username, password);
      if (!isSessionOnly && this.cryptoPort.persistKeys) {
        try {
          await this.cryptoPort.persistKeys();
        } catch (err) {
          console.warn('[AuthUseCase] persistKeys best-effort failed in unlock:', err);
        }
      }
      if (!isSessionOnly) {
        await this.metadataPort.set('auth_username', username);
      } else if (typeof sessionStorage !== 'undefined') {
        sessionStorage.setItem('auth_username', username);
      }

      // 3. Restore session keys from storage.
      const restored = await this.restoreSessionKeyring();

      if (!restored && this.cryptoPort.generateSessionKeys) {
        try {
          await this.cryptoPort.generateSessionKeys();
          if (this.cryptoPort.exportSessionKeys && !isSessionOnly) {
            const exported = await this.cryptoPort.exportSessionKeys();
            await this.persistSessionKeypair({ ...exported, expiresAt: Math.floor(Date.now() / 1000) + 86400 });
          }
        } catch {
          // Best effort
        }
      }

      const userId = this.snapshot.userId || (isSessionOnly && typeof sessionStorage !== 'undefined' && sessionStorage.getItem('user_id')) || (await this.metadataPort.get('user_id'));
      const displayName = this.snapshot.displayName || (isSessionOnly && typeof sessionStorage !== 'undefined' && sessionStorage.getItem('display_name')) || (await this.metadataPort.get('display_name')) || username;

      this.emit({
        state: 'authenticated',
        identityHash: identity.identityHash,
        publicKey: identity.publicKey,
        username,
        displayName,
        userId,
        error: null,
      });
    } catch {
      this.emit({ state: 'locked', error: 'Invalid password. Please try again.' });
    }
  }

  /**
   * Attempt zero-password session restoration (RFC-0003 §8.3 Remember Keys).
   * Called on page boot/refresh if a valid session exists.
   * Unwraps keys via dedicated IndexedDB keyring without prompting user.
   */
  async tryRestoreSession(userInfo?: { username?: string | null; displayName?: string | null; userId?: string | null }): Promise<boolean> {
    if (!this.cryptoPort.restoreKeys) return false;
    try {
      let sessionToken = await this.metadataPort.get('session_token');
      if (!sessionToken && typeof sessionStorage !== 'undefined' && sessionStorage.getItem('is_session_only') === 'true') {
        sessionToken = sessionStorage.getItem('session_token') || undefined;
      }
      if (!sessionToken) {
        return false;
      }

      const restored = await this.cryptoPort.restoreKeys();
      if (!restored || !restored.identityHash || !restored.publicKey) {
        return false;
      }

      const storedAuthUser = (typeof sessionStorage !== 'undefined' && sessionStorage.getItem('auth_username')) || (await this.metadataPort.get('auth_username'));
      const username = userInfo?.username || storedAuthUser || (await this.metadataPort.get('username')) || null;
      const userId = userInfo?.userId || (typeof sessionStorage !== 'undefined' && sessionStorage.getItem('user_id')) || (await this.metadataPort.get('user_id')) || null;
      const displayName = userInfo?.displayName || (typeof sessionStorage !== 'undefined' && sessionStorage.getItem('display_name')) || (await this.metadataPort.get('display_name')) || username || null;

      // Restore registered session keys for this tab/connection (X25519)
      const sessionRestored = await this.restoreSessionKeyring();

      if (!sessionRestored && this.cryptoPort.generateSessionKeys) {
        try {
          await this.cryptoPort.generateSessionKeys();
          const expiresAt = Math.floor(Date.now() / 1000) + 86400;
          if (this.cryptoPort.exportSessionKeys) {
            const exported = await this.cryptoPort.exportSessionKeys();
            await this.persistSessionKeypair({ ...exported, expiresAt });
          }
        } catch {
          // Best effort session key generation
        }
      }

      this.emit({
        state: 'authenticated',
        identityHash: restored.identityHash,
        publicKey: restored.publicKey,
        username,
        displayName,
        userId,
        error: null,
      });
      return true;
    } catch (err) {
      console.warn('[AuthUseCase] tryRestoreSession failed:', err);
      return false;
    }
  }

  async logout(): Promise<void> {
    if (this.onBeforeLogout) {
      try {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeoutPromise = new Promise<void>((_, reject) => {
          timer = setTimeout(() => reject(new Error('onBeforeLogout timed out')), 3000);
        });
        const hookPromise = Promise.resolve(this.onBeforeLogout()).catch((err) => {
          console.warn('[AuthUseCase] onBeforeLogout hook late rejection suppressed:', err);
        });
        await Promise.race([
          hookPromise,
          timeoutPromise,
        ]).finally(() => {
          if (timer) clearTimeout(timer);
        });
      } catch (err) {
        console.warn('[AuthUseCase] onBeforeLogout hook failed:', err);
      }
    }

    try {
      const savedActive = await this.metadataPort.get('active_session_keypair');
      if (savedActive) {
        try {
          const parsed = JSON.parse(savedActive);
          if (parsed.sessionId) {
            await this.authPort.terminateSession(parsed.sessionId).catch(() => {});
          }
        } catch {
          // ignore
        }
      }
    } catch {
      // ignore
    }

    if (this.cryptoPort.clearKeys) {
      try {
        await this.cryptoPort.clearKeys();
      } catch {
        // Best effort
      }
    }
    await this.cryptoPort.destroy();
    await this.metadataPort.delete('session_token');
    await this.metadataPort.delete('identity_hash');
    await this.metadataPort.delete('user_id');
    await this.metadataPort.delete('auth_username');
    await this.metadataPort.delete('username');
    await this.metadataPort.delete('display_name');
    await this.metadataPort.delete('active_session_keypair');
    if (typeof sessionStorage !== 'undefined') {
      sessionStorage.removeItem('is_session_only');
      sessionStorage.removeItem('session_token');
      sessionStorage.removeItem('auth_username');
      sessionStorage.removeItem('identity_hash');
      sessionStorage.removeItem('user_id');
      sessionStorage.removeItem('display_name');
    }
    // Note: session_keyring is preserved so offline messages sent to this device can still be decrypted upon re-login!
    this.emit({ state: 'idle', identityHash: null, publicKey: null, username: null, displayName: null, userId: null, error: null });
  }

  invalidateSession(): void {
    if (typeof sessionStorage !== 'undefined') {
      sessionStorage.removeItem('is_session_only');
      sessionStorage.removeItem('session_token');
    }
    void this.metadataPort.delete('session_token');
    void this.metadataPort.delete('active_session_keypair');
    this.emit({ state: 'idle', identityHash: null, publicKey: null, error: null });
  }

  async listSessions(): Promise<SessionDTO[]> {
    return this.authPort.listSessions();
  }

  async terminateSession(sessionId: string): Promise<void> {
    return this.authPort.terminateSession(sessionId);
  }

  async terminateOtherSessions(): Promise<void> {
    return this.authPort.terminateOtherSessions();
  }
}
