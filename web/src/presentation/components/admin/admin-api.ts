/**
 * Admin API Client — Direct HTTP client for RFC-0014 Admin Endpoints.
 * Uses Bearer authentication with an in-memory key (never persisted).
 * Normalized DTOs handling Go PascalCase JSON serialization seamlessly.
 */

export type SecurityEventType =
  | 'AUTH_SUCCESS'
  | 'AUTH_FAILURE'
  | 'SESSION_REVOKED'
  | 'IDENTITY_MIGRATION'
  | 'RATE_LIMIT_TRIPPED'
  | 'WS_ORIGIN_REJECTED'
  | 'QUOTA_EXCEEDED'
  | 'MEDIA_TOKEN_ISSUED'
  | 'ADMIN_ACTION';

export const FROZEN_SECURITY_EVENT_TYPES: SecurityEventType[] = [
  'AUTH_SUCCESS',
  'AUTH_FAILURE',
  'SESSION_REVOKED',
  'IDENTITY_MIGRATION',
  'RATE_LIMIT_TRIPPED',
  'WS_ORIGIN_REJECTED',
  'QUOTA_EXCEEDED',
  'MEDIA_TOKEN_ISSUED',
  'ADMIN_ACTION',
];

export interface SecurityEventDTO {
  id: string;
  eventType: SecurityEventType | string;
  identityHash?: string | null;
  ipHash?: string | null;
  traceId?: string | null;
  adminAction?: string | null;
  createdAt: number;
}

export interface IPBlockDTO {
  ipHash: string;
  status: 'BLOCKED' | 'UNBLOCKED' | string;
  createdAt: number;
  updatedAt: number;
}

export interface AuditLogFilter {
  eventType?: string;
  identityHash?: string;
  ipHash?: string;
  startTime?: number;
  endTime?: number;
  cursor?: string;
  limit?: number;
}

interface ApiResponse<T> {
  data?: T;
  meta?: {
    next_cursor?: string;
    [key: string]: unknown;
  };
  error?: {
    code: string;
    message: string;
  };
}

async function request<T>(
  endpoint: string,
  key: string,
  options: RequestInit = {},
): Promise<{ data: T; meta?: Record<string, unknown> }> {
  const headers = new Headers(options.headers || {});
  headers.set('Authorization', `Bearer ${key.trim()}`);
  if (options.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  const res = await fetch(endpoint, {
    ...options,
    headers,
  });

  const text = await res.text();
  let json: ApiResponse<T> = {};
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      // Non-JSON response
    }
  }

  if (!res.ok) {
    const errorMsg = json.error?.message || `Request failed with status ${res.status}`;
    const err = new Error(errorMsg);
    (err as unknown as { status: number }).status = res.status;
    (err as unknown as { code?: string }).code = json.error?.code;
    throw err;
  }

  return { data: json.data as T, meta: json.meta };
}

/**
 * Validates the admin API key against the server by querying 1 audit log event.
 * Returns true if valid, throws if 401 or invalid.
 */
export async function validateAdminKey(key: string): Promise<boolean> {
  await request<unknown>('/api/v1/admin/audit-events?limit=1', key, { method: 'GET' });
  return true;
}

/**
 * Suspend user by identity_hash (POST /api/v1/admin/users/{identity_hash}/suspend).
 */
export async function suspendUser(
  key: string,
  identityHash: string,
): Promise<{ status: string }> {
  const res = await request<{ status: string }>(
    `/api/v1/admin/users/${encodeURIComponent(identityHash)}/suspend`,
    key,
    { method: 'POST' },
  );
  return res.data;
}

/**
 * Resume user by identity_hash (POST /api/v1/admin/users/{identity_hash}/resume).
 */
export async function resumeUser(
  key: string,
  identityHash: string,
): Promise<{ status: string }> {
  const res = await request<{ status: string }>(
    `/api/v1/admin/users/${encodeURIComponent(identityHash)}/resume`,
    key,
    { method: 'POST' },
  );
  return res.data;
}

/**
 * Generates confirmation token for destructive action (POST /api/v1/admin/confirmations).
 * Note: Action is passed as lowercase "tombstone" to match backend expectation.
 */
export async function generateConfirmationToken(
  key: string,
  action: string,
  target: string,
): Promise<string> {
  const res = await request<{ token: string }>(
    '/api/v1/admin/confirmations',
    key,
    {
      method: 'POST',
      body: JSON.stringify({ action: action.toLowerCase(), target }),
    },
  );
  return res.data.token;
}

/**
 * Tombstone user with confirmation token (POST /api/v1/admin/users/{identity_hash}/tombstone).
 */
export async function tombstoneUser(
  key: string,
  identityHash: string,
  token: string,
): Promise<{ status: string }> {
  const res = await request<{ status: string }>(
    `/api/v1/admin/users/${encodeURIComponent(identityHash)}/tombstone`,
    key,
    {
      method: 'POST',
      body: JSON.stringify({ token }),
    },
  );
  return res.data;
}

/**
 * Ban IP hash (POST /api/v1/admin/ip-blocks/{ip_hash}/ban).
 */
export async function banIP(key: string, ipHash: string): Promise<{ status: string }> {
  const res = await request<{ status: string }>(
    `/api/v1/admin/ip-blocks/${encodeURIComponent(ipHash)}/ban`,
    key,
    { method: 'POST' },
  );
  return res.data;
}

/**
 * Unban IP hash (POST /api/v1/admin/ip-blocks/{ip_hash}/unban).
 */
export async function unbanIP(key: string, ipHash: string): Promise<{ status: string }> {
  const res = await request<{ status: string }>(
    `/api/v1/admin/ip-blocks/${encodeURIComponent(ipHash)}/unban`,
    key,
    { method: 'POST' },
  );
  return res.data;
}

interface RawIPBlock {
  IPHash?: string;
  ip_hash?: string;
  Status?: string;
  status?: string;
  CreatedAt?: number;
  created_at?: number;
  UpdatedAt?: number;
  updated_at?: number;
}

/**
 * List all blocked IPs (GET /api/v1/admin/ip/blocks).
 */
export async function listBlockedIPs(key: string): Promise<IPBlockDTO[]> {
  const res = await request<RawIPBlock[]>('/api/v1/admin/ip/blocks', key, { method: 'GET' });
  const rawList = Array.isArray(res.data) ? res.data : [];
  return rawList.map((item) => ({
    ipHash: item.IPHash || item.ip_hash || '',
    status: (item.Status || item.status || 'BLOCKED') as 'BLOCKED' | 'UNBLOCKED',
    createdAt: item.CreatedAt || item.created_at || 0,
    updatedAt: item.UpdatedAt || item.updated_at || 0,
  }));
}

interface RawSecurityEvent {
  ID?: string;
  id?: string;
  EventType?: string;
  event_type?: string;
  IdentityHash?: string | null;
  identity_hash?: string | null;
  IPHash?: string | null;
  ip_hash?: string | null;
  TraceID?: string | null;
  trace_id?: string | null;
  AdminAction?: string | null;
  admin_action?: string | null;
  CreatedAt?: number;
  created_at?: number;
}

/**
 * Query audit events (GET /api/v1/admin/audit-events).
 */
export async function queryAuditLogs(
  key: string,
  filter: AuditLogFilter = {},
): Promise<{ events: SecurityEventDTO[]; nextCursor?: string }> {
  const params = new URLSearchParams();
  if (filter.eventType) params.set('event_type', filter.eventType);
  if (filter.identityHash) params.set('user_id', filter.identityHash);
  if (filter.ipHash) params.set('ip_hash', filter.ipHash);
  if (filter.startTime) params.set('start_time', String(filter.startTime));
  if (filter.endTime) params.set('end_time', String(filter.endTime));
  if (filter.cursor) params.set('cursor', filter.cursor);
  if (filter.limit) params.set('limit', String(filter.limit));

  const url = `/api/v1/admin/audit-events${params.toString() ? `?${params.toString()}` : ''}`;
  const res = await request<RawSecurityEvent[]>(url, key, { method: 'GET' });
  const rawList = Array.isArray(res.data) ? res.data : [];

  const events: SecurityEventDTO[] = rawList.map((item) => ({
    id: item.ID || item.id || '',
    eventType: (item.EventType || item.event_type || '') as SecurityEventType,
    identityHash: item.IdentityHash || item.identity_hash || null,
    ipHash: item.IPHash || item.ip_hash || null,
    traceId: item.TraceID || item.trace_id || null,
    adminAction: item.AdminAction || item.admin_action || null,
    createdAt: item.CreatedAt || item.created_at || 0,
  }));

  const nextCursor = typeof res.meta?.next_cursor === 'string' ? res.meta.next_cursor : undefined;
  return { events, nextCursor };
}

/**
 * Trigger background worker (POST /api/v1/admin/workers/{name}/trigger).
 */
export async function triggerWorker(
  key: string,
  workerName: string,
): Promise<{ operation_id: string }> {
  const res = await request<{ operation_id: string }>(
    `/api/v1/admin/workers/${encodeURIComponent(workerName)}/trigger`,
    key,
    { method: 'POST' },
  );
  return res.data;
}

/**
 * Public health check (GET /health/ready).
 */
export async function getHealthReady(): Promise<{
  status: string;
  checks: Array<{ name: string; status: string; message?: string }>;
}> {
  try {
    const res = await fetch('/health/ready');
    if (!res.ok) return { status: 'fail', checks: [] };
    return await res.json();
  } catch {
    return { status: 'offline', checks: [] };
  }
}

/**
 * Public version check (GET /api/v1/version).
 */
export async function getServerVersion(): Promise<{
  version: string;
  commit: string;
  build_time: string;
}> {
  try {
    const res = await fetch('/api/v1/version');
    if (!res.ok) return { version: 'unknown', commit: '', build_time: '' };
    return await res.json();
  } catch {
    return { version: 'unknown', commit: '', build_time: '' };
  }
}
