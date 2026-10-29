/**
 * AdminScreen — Root component for the dedicated /admin route.
 * RFC-0014: Single Administrative Principal.
 * Auth is stored in volatile memory only — clearing on page refresh or logout.
 */

import React, { useState, useEffect } from 'react';
import {
  ShieldIcon,
  ActivityIcon,
  BanIcon,
  UsersIcon,
  ServerIcon,
  LogoutIcon,
  SunIcon,
  MoonIcon,
} from '../common/Icons';
import { AdminLogin } from './AdminLogin';
import { AdminDashboard } from './AdminDashboard';
import { AdminUserManagement } from './AdminUserManagement';
import { AdminIPBlocklist } from './AdminIPBlocklist';
import { AdminAuditLog } from './AdminAuditLog';
import { AdminWorkerTriggers } from './AdminWorkerTriggers';

export type AdminTab = 'dashboard' | 'users' | 'ip-blocks' | 'audit' | 'workers';

export const AdminScreen: React.FC = () => {
  const [apiKey, setApiKey] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<AdminTab>('dashboard');

  // Shared context for drill-down navigation (e.g. from audit log to user/ip tabs)
  const [selectedUser, setSelectedUser] = useState<string | null>(null);
  const [selectedIP, setSelectedIP] = useState<string | null>(null);

  // Theme support
  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    return (document.documentElement.getAttribute('data-theme') as 'light' | 'dark') || 'light';
  });

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  const toggleTheme = () => {
    const next = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
  };

  const handleLogout = () => {
    setApiKey(null);
    setSelectedUser(null);
    setSelectedIP(null);
    setActiveTab('dashboard');
  };

  const handleSelectUser = (hash: string) => {
    setSelectedUser(hash);
    setActiveTab('users');
  };

  const handleSelectIP = (hash: string) => {
    setSelectedIP(hash);
    setActiveTab('ip-blocks');
  };

  if (!apiKey) {
    return <AdminLogin onLoginSuccess={(key) => setApiKey(key)} />;
  }

  return (
    <div className="admin-shell" data-testid="admin-panel-shell">
      {/* Header */}
      <header className="admin-header">
        <div className="admin-brand">
          <ShieldIcon size={24} />
          <span>RootInbox Admin</span>
          <span className="admin-brand-badge">RFC-0014</span>
        </div>

        <div className="admin-header-actions">
          <button
            type="button"
            className="admin-btn admin-btn--secondary admin-btn--sm"
            onClick={toggleTheme}
            data-testid="admin-theme-toggle-btn"
            title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
          >
            {theme === 'dark' ? <SunIcon size={16} /> : <MoonIcon size={16} />}
            <span>{theme === 'dark' ? 'Light' : 'Dark'}</span>
          </button>

          <button
            type="button"
            className="admin-btn admin-btn--secondary admin-btn--sm"
            onClick={handleLogout}
            data-testid="admin-logout-btn"
            title="Clear API key from memory and log out"
          >
            <LogoutIcon size={16} />
            <span>Sign Out</span>
          </button>
        </div>
      </header>

      {/* Tabs Bar */}
      <nav className="admin-nav" role="tablist" aria-label="Admin Navigation">
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'dashboard'}
          className={`admin-nav-item ${activeTab === 'dashboard' ? 'admin-nav-item--active' : ''}`}
          data-testid="admin-tab-dashboard"
          onClick={() => setActiveTab('dashboard')}
        >
          <ActivityIcon size={18} />
          Dashboard
        </button>

        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'users'}
          className={`admin-nav-item ${activeTab === 'users' ? 'admin-nav-item--active' : ''}`}
          data-testid="admin-tab-users"
          onClick={() => setActiveTab('users')}
        >
          <UsersIcon size={18} />
          User Management
        </button>

        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'ip-blocks'}
          className={`admin-nav-item ${activeTab === 'ip-blocks' ? 'admin-nav-item--active' : ''}`}
          data-testid="admin-tab-ip-blocks"
          onClick={() => setActiveTab('ip-blocks')}
        >
          <BanIcon size={18} />
          IP Blocklist
        </button>

        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'audit'}
          className={`admin-nav-item ${activeTab === 'audit' ? 'admin-nav-item--active' : ''}`}
          data-testid="admin-tab-audit"
          onClick={() => setActiveTab('audit')}
        >
          <ActivityIcon size={18} />
          Audit Log
        </button>

        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'workers'}
          className={`admin-nav-item ${activeTab === 'workers' ? 'admin-nav-item--active' : ''}`}
          data-testid="admin-tab-workers"
          onClick={() => setActiveTab('workers')}
        >
          <ServerIcon size={18} />
          Worker Triggers
        </button>
      </nav>

      {/* Main Content Area */}
      <main className="admin-main" role="tabpanel">
        {activeTab === 'dashboard' && (
          <AdminDashboard
            apiKey={apiKey}
            onNavigateTab={(tab) => setActiveTab(tab)}
          />
        )}

        {activeTab === 'users' && (
          <AdminUserManagement
            apiKey={apiKey}
            initialIdentityHash={selectedUser}
          />
        )}

        {activeTab === 'ip-blocks' && (
          <AdminIPBlocklist
            apiKey={apiKey}
            initialIPHash={selectedIP}
          />
        )}

        {activeTab === 'audit' && (
          <AdminAuditLog
            apiKey={apiKey}
            onSelectUser={handleSelectUser}
            onSelectIP={handleSelectIP}
          />
        )}

        {activeTab === 'workers' && (
          <AdminWorkerTriggers apiKey={apiKey} />
        )}
      </main>
    </div>
  );
};
