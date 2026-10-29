/**
 * ChatScreen — sidebar + message view + local profile + contacts + user search.
 * RFC-0010 §4.2: Presentation layer, uses hooks & domain ports only.
 * dangerouslySetInnerHTML FORBIDDEN.
 *
 * Features (Bundle 1):
 * - 1.1 Username search bar with instant results, message initiation & add-contact.
 * - 1.2 Local contacts management (Dexie-backed, Zero-Knowledge from server).
 * - 1.3 Pinned "My Notes" (SELF conversation, full E2EE pipeline).
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { useAuth, useChat, useSync, useContacts, usePwaInstall, usePasscodeLock } from '../hooks';
import { useAppContext } from '../context';
import type { UserSearchResult, ContactDTO, UserProfile, ConversationDTO } from '../../domain';
import { toMillis } from '../../domain';
import { MessageList } from './MessageList';
import { ErrorBoundary } from './ErrorBoundary';
import { CreateGroupModal } from './group/CreateGroupModal';
import { Avatar } from './common/Avatar';
import { UserProfileModal } from './user/UserProfileModal';
import { ThemeToggle } from './common/ThemeToggle';
import { SessionsPanel } from './SessionsPanel';
import { InstallModal } from './common/InstallModal';

function formatConvTime(timestamp?: number): string {
  if (!timestamp) return '';
  const date = new Date(toMillis(timestamp));
  const now = new Date();
  const isToday =
    date.getDate() === now.getDate() &&
    date.getMonth() === now.getMonth() &&
    date.getFullYear() === now.getFullYear();

  if (isToday) {
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const isYesterday =
    date.getDate() === yesterday.getDate() &&
    date.getMonth() === yesterday.getMonth() &&
    date.getFullYear() === yesterday.getFullYear();

  if (isYesterday) {
    return 'Yesterday';
  }

  return date.toLocaleDateString([], { month: 'numeric', day: 'numeric' });
}

export function ChatScreen() {
  const { logout } = useAuth();
  const { isPasscodeEnabled, lock: lockApp } = usePasscodeLock();
  const { conversations, activeConversationId, selectConversation, loadConversations } = useChat();
  const { phase } = useSync();
  const { metadataPort, userPort, chatUC, pushUC } = useAppContext();
  const { contacts, saveContact, deleteContact, loadContacts } = useContacts();

  // Web Push Notification Banner state (Bug 2.7)
  const [showPushBanner, setShowPushBanner] = useState<boolean>(false);
  const [isEnablingPush, setIsEnablingPush] = useState<boolean>(false);

  useEffect(() => {
    let cancelled = false;
    if (typeof window === 'undefined') return;
    try {
      if (typeof localStorage === 'undefined' || !localStorage) return;
      const dismissed = localStorage.getItem('rootinbox_dismiss_push_banner') === 'true';
      if (dismissed) return;
      if (!pushUC || !pushUC.isSupported() || pushUC.getPermission() !== 'default') return;
      if (!window.isSecureContext) return;
      if (typeof pushUC.isAvailable === 'function') {
        void pushUC.isAvailable().then((available) => {
          if (!cancelled && available) {
            setShowPushBanner(true);
          }
        }).catch(() => {});
      } else {
        setShowPushBanner(true);
      }
    } catch {
      // ignore in environments without localStorage
    }
    return () => {
      cancelled = true;
    };
  }, [pushUC]);

  const handleEnablePush = async () => {
    if (!pushUC) return;
    setIsEnablingPush(true);
    try {
      await pushUC.subscribe();
      setShowPushBanner(false);
    } catch (err) {
      console.warn('[Push] Enable from banner failed:', err);
      setShowPushBanner(false);
    } finally {
      setIsEnablingPush(false);
    }
  };

  const handleDismissPushBanner = () => {
    try {
      if (typeof localStorage !== 'undefined' && localStorage) {
        localStorage.setItem('rootinbox_dismiss_push_banner', 'true');
      }
    } catch {
      // ignore
    }
    setShowPushBanner(false);
  };

  useEffect(() => {
    const handleVisibilityChange = () => {
      if (!document.hidden && chatUC) {
        void chatUC.loadConversations();
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, [chatUC]);

  // Navigation tab: 'chats' or 'contacts'
  const [activeTab, setActiveTab] = useState<'chats' | 'contacts'>('chats');

  // Username and public channel/group search state
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<UserSearchResult[]>([]);
  const [publicConvResults, setPublicConvResults] = useState<ConversationDTO[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const searchTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Auto-join via invite code or @username in URL hash (e.g. #/join/xyz or #@my_channel)
  useEffect(() => {
    const checkHash = async () => {
      const hash = window.location.hash;
      if (hash.startsWith('#/join/') || hash.startsWith('#join/')) {
        const code = hash.replace(/^#\/?join\//, '');
        if (code) {
          window.location.hash = '';
          try {
            await chatUC.joinByInvite(code);
          } catch (err) {
            console.error('Failed to join by invite link:', err);
          }
        }
      } else if (hash.startsWith('#@')) {
        const uName = hash.slice(2);
        if (uName) {
          window.location.hash = '';
          try {
            await chatUC.joinPublic(uName);
          } catch (err) {
            console.error('Failed to join public conversation:', err);
          }
        }
      }
    };
    void checkHash();
    window.addEventListener('hashchange', checkHash);
    return () => window.removeEventListener('hashchange', checkHash);
  }, [chatUC]);

  // Local user profile state
  const [displayName, setDisplayName] = useState<string>('');
  const [peerNicknames, setPeerNicknames] = useState<Record<string, string>>({});

  // Manual Add Contact Form
  const [showAddContact, setShowAddContact] = useState(false);
  const [newContactHash, setNewContactHash] = useState('');
  const [newContactNick, setNewContactNick] = useState('');
  const [addContactError, setAddContactError] = useState<string | null>(null);

  // Group & Channel Creation
  const [showCreateGroup, setShowCreateGroup] = useState(false);

  // User Profile & Settings Modal (Bundle 4)
  const [myProfile, setMyProfile] = useState<UserProfile | null>(null);
  const [showProfileModal, setShowProfileModal] = useState(false);
  const [showSessionsModal, setShowSessionsModal] = useState(false);
  const [showInstallModal, setShowInstallModal] = useState(false);
  const { isInstalled, hasNativePrompt, promptInstall } = usePwaInstall();

  useEffect(() => {
    userPort.getMe().then(async (profile) => {
      setMyProfile(profile);
      if (profile.user_id) await metadataPort.set('user_id', profile.user_id);
      if (profile.username) await metadataPort.set('username', profile.username);
      if (profile.identity_hash) await metadataPort.set('identity_hash', profile.identity_hash);
    }).catch(() => {});
  }, [userPort, metadataPort]);

  // Auto-clear search when active conversation changes
  useEffect(() => {
    if (activeConversationId) {
      handleClearSearch();
    }
  }, [activeConversationId]);

  useEffect(() => {
    void loadConversations();
    const interval = setInterval(() => {
      void loadConversations();
    }, 3000);
    return () => clearInterval(interval);
  }, [loadConversations]);

  useEffect(() => {
    if (activeTab === 'contacts') {
      void loadContacts();
    }
  }, [activeTab, loadContacts]);

  // Load device-local profile
  useEffect(() => {
    void metadataPort.get('local_display_name').then((name) => {
      if (name) setDisplayName(name);
    });
  }, [metadataPort]);

  // Load device-local peer nicknames & contact nicknames
  useEffect(() => {
    const loadNicknames = async () => {
      const map: Record<string, string> = {};
      // Prioritize saved contacts
      for (const c of contacts) {
        if (c.identity_hash && c.nickname) {
          map[c.identity_hash] = c.nickname;
        }
      }
      // Fill from conversation peer profile & metadata store for remaining
      for (const c of conversations) {
        if (c.peerIdentityHash && !map[c.peerIdentityHash]) {
          const peerFull = [c.peer_display_name, c.peer_last_name].filter(Boolean).join(' ') || c.peer_display_name;
          if (peerFull) {
            map[c.peerIdentityHash] = peerFull;
          } else {
            const nick = await metadataPort.get(`peer_name_${c.peerIdentityHash}`);
            if (nick) {
              map[c.peerIdentityHash] = nick;
            } else if (c.peer_username) {
              map[c.peerIdentityHash] = `@${c.peer_username}`;
            }
          }
        }
      }
      setPeerNicknames(map);
    };
    void loadNicknames();
  }, [conversations, contacts, metadataPort]);

  // Debounced directory & public conversations search handler
  const handleSearchChange = (val: string) => {
    setSearchQuery(val);
    if (searchTimeoutRef.current) clearTimeout(searchTimeoutRef.current);
    const trimmed = val.trim().replace(/^@/, '');
    if (!trimmed) {
      setSearchResults([]);
      setPublicConvResults([]);
      setSearchError(null);
      setIsSearching(false);
      return;
    }
    setIsSearching(true);
    setSearchError(null);
    searchTimeoutRef.current = setTimeout(async () => {
      try {
        const [results, convs] = await Promise.all([
          userPort.search(trimmed, 10).catch(() => []),
          chatUC.searchPublicConversations(trimmed).catch(() => []),
        ]);
        setSearchResults(results);
        setPublicConvResults(convs);
      } catch (err) {
        setSearchError(err instanceof Error ? err.message : 'Search failed');
        setSearchResults([]);
        setPublicConvResults([]);
      } finally {
        setIsSearching(false);
      }
    }, 250);
  };

  const handleClearSearch = () => {
    setSearchQuery('');
    setSearchResults([]);
    setPublicConvResults([]);
    setSearchError(null);
    setIsSearching(false);
    if (searchTimeoutRef.current) clearTimeout(searchTimeoutRef.current);
  };

  const handleEditNickname = async (peerHash: string) => {
    const current = peerNicknames[peerHash] || '';
    const newNick = window.prompt('Set friendly local nickname for peer:', current);
    if (newNick === null) return;
    const trimmed = newNick.trim();
    if (trimmed) {
      await metadataPort.set(`peer_name_${peerHash}`, trimmed);
      setPeerNicknames((prev) => ({ ...prev, [peerHash]: trimmed }));
    } else {
      await metadataPort.delete(`peer_name_${peerHash}`);
      setPeerNicknames((prev) => {
        const next = { ...prev };
        delete next[peerHash];
        return next;
      });
    }
  };

  const handleSelectConversation = useCallback(
    async (id: string) => {
      handleClearSearch();
      await selectConversation(id);
    },
    [selectConversation],
  );

  useEffect(() => {
    if (import.meta.env.VITE_E2E === 'true') {
      (window as unknown as Record<string, unknown>).__selectConv = (id: string) => void handleSelectConversation(id);
    }
  }, [handleSelectConversation]);

  // Auto-transition from draft if a real conversation matching this peer exists
  useEffect(() => {
    if (activeConversationId?.startsWith('draft:')) {
      const draftHash = activeConversationId.slice(6);
      const matched = (conversations || []).find((c) => c.peerIdentityHash === draftHash);
      if (matched) {
        void handleSelectConversation(matched.id);
      }
    }
  }, [activeConversationId, conversations, handleSelectConversation]);

  const handleMessageUser = useCallback(async (peerHash: string, defaultNickname?: string, username?: string, peerUserId?: string) => {
    try {
      handleClearSearch();
      const existing = (conversations || []).find((c) =>
        (peerHash && c.peerIdentityHash === peerHash) ||
        (peerUserId && c.peerId === peerUserId) ||
        (username && c.peer_username === username)
      );
      if (existing) {
        await handleSelectConversation(existing.id);
        setActiveTab('chats');
        return;
      }

      if (defaultNickname) {
        await metadataPort.set(`peer_name_${peerHash}`, defaultNickname);
        setPeerNicknames((prev) => ({ ...prev, [peerHash]: defaultNickname }));
      }
      if (username) {
        await metadataPort.set(`peer_user_${peerHash}`, username);
      }
      if (peerUserId) {
        await metadataPort.set(`peer_id_${peerHash}`, peerUserId);
      }
      await handleSelectConversation('draft:' + peerHash);
      setActiveTab('chats');
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Could not open conversation');
    }
  }, [conversations, handleClearSearch, handleSelectConversation, metadataPort]);

  const handleAddContactFromSearch = async (user: UserSearchResult) => {
    try {
      const contact: ContactDTO = {
        peer_user_id: user.user_id,
        identity_hash: user.identity_hash,
        nickname: user.username,
        added_at: Date.now(),
      };
      await saveContact(contact);
      await metadataPort.set(`peer_name_${user.identity_hash}`, user.username);
      setPeerNicknames((prev) => ({ ...prev, [user.identity_hash]: user.username }));
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to add contact');
    }
  };

  const handleSaveManualContact = async (e: React.FormEvent) => {
    e.preventDefault();
    const input = newContactHash.trim();
    const nick = newContactNick.trim();
    if (!input) {
      setAddContactError('Username or Identity Hash is required');
      return;
    }
    setAddContactError(null);
    try {
      let targetHash = input;
      let peerUserId = input;
      let finalNick = nick;
      if (!/^[a-fA-F0-9]{64}$/.test(input)) {
        const cleanName = input.replace(/^@/, '');
        const results = await userPort.search(cleanName, 5);
        const match = results.find((u) => u.username?.toLowerCase() === cleanName.toLowerCase()) || results[0];
        if (!match || !match.identity_hash) {
          throw new Error(`User @${cleanName} not found`);
        }
        targetHash = match.identity_hash;
        peerUserId = match.user_id;
        if (!finalNick) {
          finalNick = match.display_name || match.username || cleanName;
        }
      }
      const contact: ContactDTO = {
        peer_user_id: peerUserId,
        identity_hash: targetHash,
        nickname: finalNick || targetHash.substring(0, 8),
        added_at: Date.now(),
      };
      await saveContact(contact);
      await metadataPort.set(`peer_name_${targetHash}`, contact.nickname);
      setPeerNicknames((prev) => ({ ...prev, [targetHash]: contact.nickname }));
      setNewContactHash('');
      setNewContactNick('');
      setShowAddContact(false);
    } catch (err) {
      setAddContactError(err instanceof Error ? err.message : 'Failed to save contact');
    }
  };

  return (
    <div id="chat-screen" className="chat-layout">
      {/* Sidebar */}
        <aside id="chat-sidebar" className={`sidebar ${activeConversationId ? 'sidebar--hidden' : ''}`}>
          {/* Header */}
          <div className="sidebar-header">
            <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
              <h2 className="sidebar-title">RootInbox</h2>
              {isPasscodeEnabled && (
                <button
                  id="quick-lock-btn"
                  data-testid="quick-lock-btn"
                  type="button"
                  className="quick-lock-btn"
                  onClick={lockApp}
                  title="Lock RootInbox instantly"
                  aria-label="Lock app"
                >
                  🔒
                </button>
              )}
            </div>
          <div className="sync-badge" title={`Sync: ${phase}`}>
             {phase === 'ready' ? '🟢 Synced' : phase === 'error' ? '🔴 Offline' : '🟡 Syncing'}
          </div>
        </div>

        {/* Push Notification Prompt Banner (Bug 2.7) */}
        {showPushBanner && (
          <div id="push-notification-banner" className="push-banner" role="alert">
            <div className="push-banner-content">
              <span className="push-banner-icon">🔔</span>
              <span className="push-banner-text">Enable notifications for incoming calls and messages.</span>
            </div>
            <div className="push-banner-actions">
              <button
                id="push-banner-enable-btn"
                type="button"
                className="push-banner-btn-enable"
                disabled={isEnablingPush}
                onClick={() => void handleEnablePush()}
              >
                {isEnablingPush ? '...' : 'Enable'}
              </button>
              <button
                id="push-banner-dismiss-btn"
                type="button"
                className="push-banner-btn-close"
                aria-label="Dismiss"
                onClick={handleDismissPushBanner}
              >
                ✕
              </button>
            </div>
          </div>
        )}

        {/* User Profile Card (Bundle 4: Avatar + Settings) */}
        {(() => {
          const myFullName = [myProfile?.display_name, myProfile?.last_name].filter(Boolean).join(' ') || myProfile?.display_name;
          const myPrimaryName = myFullName || (myProfile?.username ? `@${myProfile.username}` : (displayName || 'Anonymous User'));
          const mySecondaryText = myProfile?.bio || (!myFullName && myProfile?.username ? `@${myProfile.username}` : '');
          return (
            <div id="sidebar-user-card" className="profile-section">
              <div className="avatar-row">
                <div
                  style={{ cursor: 'pointer' }}
                  onClick={() => setShowProfileModal(true)}
                  title="Click to edit profile & avatar"
                  data-testid="user-profile-avatar-trigger"
                >
                  <Avatar
                    userId={myProfile?.user_id}
                    avatarUpdatedAt={myProfile?.avatar_updated_at}
                    name={myPrimaryName}
                    size="md"
                  />
                </div>
                <div className="profile-info">
                  <div className="profile-display-row">
                    <span
                      id="user-profile-name"
                      className="profile-name"
                      onClick={() => setShowProfileModal(true)}
                      title="Click to edit profile & avatar"
                    >
                      {myPrimaryName}
                    </span>
                    <button
                      id="edit-profile-btn"
                      type="button"
                      className="edit-profile-btn"
                      onClick={() => setShowProfileModal(true)}
                      title="Edit profile & avatar"
                    >
                      ⚙️
                    </button>
                  </div>
                  {mySecondaryText && (
                    <span id="user-profile-username" className="profile-badge">
                      {mySecondaryText}
                    </span>
                  )}
                </div>
              </div>
            </div>
          );
        })()}

        {/* Username Search Bar (Bundle 1.1) */}
        <div className="search-section">
          <div className="search-row">
            <input
              id="user-search-input"
              type="text"
              placeholder="🔍 Search users, groups, channels..."
              value={searchQuery}
              onChange={(e) => handleSearchChange(e.target.value)}
              className="search-input"
            />
            {searchQuery && (
              <button
                id="user-search-clear"
                type="button"
                onClick={handleClearSearch}
                className="clear-search-btn"
                title="Clear search"
              >
                ✕
              </button>
            )}
          </div>
          {isSearching && <div className="search-feedback">Searching directory...</div>}
          {searchError && <div className="error-text" style={{ paddingLeft: 'var(--space-1)' }}>{searchError}</div>}
          {searchQuery.trim() && !isSearching && searchResults.length === 0 && publicConvResults.length === 0 && !searchError && (
            <div className="search-feedback">No users, groups, or channels found for "@{searchQuery.trim()}"</div>
          )}

          {/* Search Results Dropdown */}
          {(searchResults.length > 0 || publicConvResults.length > 0) && (
            <div id="user-search-results" className="search-results-box">
              {publicConvResults.length > 0 && (
                <div>
                  <div className="search-result-header">
                    <span>Public Groups & Channels ({publicConvResults.length})</span>
                    <span style={{ fontSize: '10px', opacity: 0.6 }}>Public directory</span>
                  </div>
                  {publicConvResults.map((conv) => {
                    const isMember = (conversations || []).some((c) => c.id === conv.id);
                    return (
                      <div key={conv.id} className="search-result-item">
                        <div style={{ marginRight: '10px' }}>
                          <Avatar name={conv.name} icon={conv.type === 'CHANNEL' ? '📢' : '👥'} size="sm" />
                        </div>
                        <div className="search-result-info">
                          <div className="search-result-name">
                            {conv.name}
                          </div>
                          <div style={{ fontSize: '11px', color: 'var(--color-text-secondary)' }}>
                            {conv.type === 'CHANNEL' ? '📢 Channel' : '👥 Group'} • @{conv.username}
                          </div>
                        </div>
                        <div className="search-result-actions">
                          {isMember ? (
                            <button
                              id={`open-conv-${conv.username}`}
                              type="button"
                              className="search-action-msg-btn"
                              onClick={() => void handleSelectConversation(conv.id)}
                            >
                              Open
                            </button>
                          ) : (
                            <button
                              id={`join-conv-${conv.username}`}
                              type="button"
                              className="search-action-add-btn"
                              onClick={async () => {
                                if (conv.username) {
                                  await chatUC.joinPublic(conv.username);
                                  handleClearSearch();
                                }
                              }}
                            >
                              + Join
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              {searchResults.length > 0 && (
                <div>
                  <div className="search-result-header">
                    <span>Users ({searchResults.length})</span>
                    <span style={{ fontSize: '10px', opacity: 0.6 }}>Rate-limited discovery</span>
                  </div>
                  {searchResults.map((user) => {
                    const isSaved = contacts.some((c) => c.identity_hash === user.identity_hash || c.peer_user_id === user.user_id);
                    const userFullName = [user.display_name, user.last_name].filter(Boolean).join(' ') || user.display_name;
                    const userPrimaryName = userFullName || user.username;
                    return (
                      <div key={user.user_id} className="search-result-item">
                        <div style={{ marginRight: '10px' }}>
                          <Avatar
                            userId={user.user_id}
                            avatarUpdatedAt={user.avatar_updated_at}
                            name={userPrimaryName}
                            size="sm"
                          />
                        </div>
                        <div className="search-result-info">
                          <div className="search-result-name">
                            {userPrimaryName}
                          </div>
                          <div style={{ fontSize: '11px', color: 'var(--color-text-secondary)' }}>
                            @{user.username}
                          </div>
                        </div>
                        <div className="search-result-actions">
                          <button
                            id={`search-msg-${user.username}`}
                            type="button"
                            className="search-action-msg-btn"
                            onClick={() => void handleMessageUser(user.identity_hash, userPrimaryName, user.username, user.user_id)}
                            title="Start encrypted chat"
                          >
                            💬 Message
                          </button>
                          <button
                            id={`search-add-${user.username}`}
                            type="button"
                            className={isSaved ? 'search-action-added-btn' : 'search-action-add-btn'}
                            disabled={isSaved}
                            onClick={() => void handleAddContactFromSearch(user)}
                            title={isSaved ? 'Already in contacts' : 'Add to contacts'}
                          >
                            {isSaved ? '✓ Added' : '+ Contact'}
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Tab Switcher: Chats vs Contacts */}
        <div className="tabs-container">
          <button
            id="tab-chats"
            type="button"
            className={activeTab === 'chats' ? 'tab--active' : 'tab'}
            onClick={() => {
              handleClearSearch();
              setActiveTab('chats');
              void loadConversations();
            }}
          >
            💬 Chats ({conversations.length})
          </button>
          <button
            id="tab-contacts"
            type="button"
            className={activeTab === 'contacts' ? 'tab--active' : 'tab'}
            onClick={() => {
              handleClearSearch();
              setActiveTab('contacts');
              void loadContacts();
            }}
          >
            👥 Contacts ({contacts.length})
          </button>
        </div>

        {/* Tab Content: Chats */}
        {activeTab === 'chats' && (
          <div className="tab-content-area">
            {/* Start New Direct Conversation or Group */}
            <div className="new-conv-section">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span className="section-label">Chats</span>
                <button
                  id="open-create-group-btn"
                  type="button"
                  className="new-group-btn"
                  disabled
                  aria-disabled="true"
                  title="Coming Soon"
                >
                  👥 + Group / Channel (Coming Soon)
                </button>
              </div>
            </div>

            {/* Conversations List */}
            <div className="conv-list">
              {conversations.length === 0 && (
                <p className="empty-text">No conversations yet. Search a username above to start!</p>
              )}
              {conversations.map((conv) => {
                if (!conv) return null;
                const isSelf = conv.type === 'SELF';
                const isGroup = conv.type === 'GROUP';
                const isChannel = conv.type === 'CHANNEL';

                const peerFullName = [conv.peer_display_name, conv.peer_last_name].filter(Boolean).join(' ') || conv.peer_display_name;
                const peerNick = conv.peerIdentityHash ? peerNicknames[conv.peerIdentityHash] : undefined;
                const isTechnical = (str?: string) => Boolean(str && /^[0-9a-fA-F-]{32,64}$/.test(str));
                const cleanName = isTechnical(conv.name) ? undefined : conv.name;

                const label = isSelf
                  ? '📝 My Notes'
                  : isGroup
                    ? conv.name || 'Group Chat'
                    : isChannel
                      ? conv.name || 'Channel'
                      : peerFullName || peerNick || (cleanName ? (cleanName.startsWith('@') ? cleanName : `@${cleanName}`) : (conv.peer_username ? `@${conv.peer_username}` : 'Direct Message'));

                const subtext = isSelf
                  ? (conv.lastMessage || 'Saved messages & notes')
                  : (conv.unreadCount && conv.unreadCount > 0)
                    ? (conv.lastUnreadMessage || conv.lastMessage || 'New message')
                    : (conv.lastMessage || ((isGroup || isChannel) ? (conv.description || (isGroup ? 'Group discussion' : 'Channel broadcast')) : ''));

                const icon = isSelf ? '📝' : isGroup ? '👥' : isChannel ? '📢' : '💬';
                const badge = isSelf ? 'You' : isGroup ? 'Group' : isChannel ? 'Channel' : null;

                const isActive = conv.id === activeConversationId;
                const rowClass = isSelf
                  ? (isActive ? 'self-conv-row--active' : 'self-conv-row')
                  : (isActive ? 'conv-item-row--active' : 'conv-item-row');

                return (
                  <div key={conv.id} className={rowClass}>
                    <button
                      id={`conv-${conv.id}`}
                      data-conv-type={conv.type}
                      data-conv-name={conv.name || label || undefined}
                      type="button"
                      className="conv-item-btn"
                      onClick={() => void handleSelectConversation(conv.id)}
                    >
                      <div style={{ marginRight: '10px' }}>
                        <Avatar
                          userId={!isSelf && !isGroup && !isChannel ? conv.peerId : undefined}
                          name={label}
                          icon={icon}
                          size="sm"
                        />
                      </div>
                      <div className="conv-text-container">
                        <div className="conv-title-row">
                          <span className="conv-id" title={conv.name ?? conv.peerIdentityHash ?? conv.id}>
                            {label}
                          </span>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                            {conv.lastMessageTime ? (
                              <span className="conv-time">{formatConvTime(conv.lastMessageTime)}</span>
                            ) : null}
                            {badge && (
                              <span className={`type-badge ${isSelf ? 'type-badge--self' : isGroup ? 'type-badge--group' : 'type-badge--channel'}`}>
                                {badge}
                              </span>
                            )}
                          </div>
                        </div>
                        <div className="conv-subtitle-row">
                          <span
                            className={`conv-subtext ${conv.unreadCount && conv.unreadCount > 0 ? 'conv-subtext--unread' : ''}`}
                            title={subtext || undefined}
                          >
                            {subtext || '\u00A0'}
                          </span>
                          {Boolean(conv.unreadCount && conv.unreadCount > 0) && (
                            <span
                              id={`unread-badge-${conv.id}`}
                              className="unread-badge"
                            >
                              {conv.unreadCount}
                            </span>
                          )}
                        </div>
                      </div>
                    </button>
                    {!isSelf && !isGroup && !isChannel && conv.peerIdentityHash && (
                      <button
                        type="button"
                        className="edit-nick-btn"
                        onClick={() => void handleEditNickname(conv.peerIdentityHash!)}
                        title="Set friendly nickname"
                      >
                        ✏️
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Tab Content: Contacts (Bundle 1.2) */}
        {activeTab === 'contacts' && (
          <div className="tab-content-area">
            <div className="contacts-header-section">
              <span className="section-label">Saved Contacts</span>
              <button
                id="show-add-contact-btn"
                type="button"
                className="add-contact-toggle-btn"
                onClick={() => setShowAddContact((prev) => !prev)}
              >
                {showAddContact ? '✕ Cancel' : '+ Add Contact'}
              </button>
            </div>

            {/* Manual Add Contact Form */}
            {showAddContact && (
              <form id="add-contact-form" onSubmit={(e) => void handleSaveManualContact(e)} className="add-contact-form">
                <input
                  id="new-contact-hash-input"
                  type="text"
                  placeholder="Peer @username..."
                  value={newContactHash}
                  onChange={(e) => setNewContactHash(e.target.value)}
                  className="peer-input"
                />
                <input
                  id="new-contact-nick-input"
                  type="text"
                  placeholder="Friendly Nickname..."
                  value={newContactNick}
                  onChange={(e) => setNewContactNick(e.target.value)}
                  className="peer-input"
                />
                {addContactError && <p className="error-text">{addContactError}</p>}
                <div className="add-contact-btn-row">
                  <button id="save-new-contact-btn" type="submit" className="save-contact-btn">
                    Save Contact
                  </button>
                  <button
                    id="cancel-new-contact-btn"
                    type="button"
                    className="cancel-contact-btn"
                    onClick={() => {
                      setShowAddContact(false);
                      setAddContactError(null);
                    }}
                  >
                    Cancel
                  </button>
                </div>
              </form>
            )}

            {/* Contacts List */}
            <div id="contacts-list" className="conv-list">
              {contacts.length === 0 ? (
                <div className="empty-contacts">
                  <p className="empty-text">No saved contacts yet.</p>
                  <p className="empty-text" style={{ fontSize: '11px', marginTop: '4px' }}>
                    Search usernames above or add by Identity Hash.
                  </p>
                </div>
              ) : (
                contacts.map((contact) => (
                  <div key={contact.peer_user_id} className="contact-item-row">
                    <div className="contact-info">
                      <div style={{ marginRight: '10px' }}>
                        <Avatar
                          userId={contact.peer_user_id}
                          name={contact.nickname}
                          size="sm"
                        />
                      </div>
                      <div className="contact-details">
                        <span className="contact-nickname">{contact.nickname}</span>
                        <span className="contact-hash" title={contact.identity_hash}>
                          {contact.identity_hash.substring(0, 14)}...
                        </span>
                      </div>
                    </div>
                    <div className="contact-actions">
                      <button
                        id={`contact-msg-${contact.peer_user_id}`}
                        type="button"
                        className="contact-action-btn contact-action-btn--msg"
                        onClick={() => void handleMessageUser(contact.identity_hash, contact.nickname)}
                        title="Chat with contact"
                      >
                        💬
                      </button>
                      <button
                        id={`contact-edit-${contact.peer_user_id}`}
                        type="button"
                        className="contact-action-btn"
                        onClick={() => void handleEditNickname(contact.identity_hash)}
                        title="Edit nickname"
                      >
                        ✏️
                      </button>
                      <button
                        id={`contact-del-${contact.peer_user_id}`}
                        type="button"
                        className="contact-action-btn"
                        onClick={() => {
                          if (window.confirm(`Delete contact "${contact.nickname}"?`)) {
                            void deleteContact(contact.peer_user_id);
                          }
                        }}
                        title="Delete contact"
                      >
                        🗑️
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        )}

        {/* Footer */}
        <div className="sidebar-footer">
          <button
            id="open-sessions-btn"
            type="button"
            className="sessions-btn"
            title="Active Sessions"
            onClick={() => setShowSessionsModal(true)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '4px',
              padding: 'var(--space-1) var(--space-2)',
              fontSize: 'var(--font-xs)',
              fontWeight: 600,
              color: 'var(--color-text-secondary)',
              background: 'var(--color-bg-secondary)',
              border: '1px solid var(--color-border)',
              borderRadius: 'var(--radius-sm)',
              cursor: 'pointer',
              transition: 'color 0.15s ease, background 0.15s ease',
            }}
          >
            <span>🔒</span>
            <span>Sessions</span>
          </button>
          {!isInstalled && (
            <button
              id="pwa-install-btn"
              type="button"
              className="install-app-btn"
              onClick={async () => {
                if (hasNativePrompt) {
                  await promptInstall();
                } else {
                  setShowInstallModal(true);
                }
              }}
              title="Install RootInbox App"
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '4px',
                padding: 'var(--space-1) var(--space-2)',
                fontSize: 'var(--font-xs)',
                fontWeight: 600,
                color: 'var(--color-accent)',
                background: 'var(--color-bg-secondary)',
                border: '1px solid var(--color-accent)',
                borderRadius: 'var(--radius-sm)',
                cursor: 'pointer',
                transition: 'color 0.15s ease, background 0.15s ease',
              }}
            >
              <span>📥</span>
              <span>Install</span>
            </button>
          )}
          <button
            id="chat-logout"
            type="button"
            className="logout-btn"
            onClick={() => void logout()}
          >
            Sign Out
          </button>
          <ThemeToggle />
        </div>
      </aside>

      {/* Main Area */}
      <main id="chat-main" className={`chat-main ${!activeConversationId ? 'chat-main--hidden' : ''}`}>
        {activeConversationId ? (
          <ErrorBoundary fallbackTitle="Conversation Error">
            <MessageList key={activeConversationId} conversationId={activeConversationId} />
          </ErrorBoundary>
        ) : (
          <div className="empty-state">
            <div className="empty-icon">💬</div>
            <h3 className="empty-title">Select or start a conversation</h3>
            <p className="empty-subtext">Search users by @username or select My Notes to get started</p>
          </div>
        )}
      </main>

      <CreateGroupModal
        isOpen={showCreateGroup}
        onClose={() => setShowCreateGroup(false)}
      />

      <UserProfileModal
        isOpen={showProfileModal}
        onClose={() => setShowProfileModal(false)}
        onProfileUpdated={(p) => setMyProfile(p)}
      />

      <SessionsPanel
        isOpen={showSessionsModal}
        onClose={() => setShowSessionsModal(false)}
      />

      <InstallModal
        isOpen={showInstallModal}
        onClose={() => setShowInstallModal(false)}
      />
    </div>
  );
}
