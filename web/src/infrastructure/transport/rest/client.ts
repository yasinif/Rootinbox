/**
 * REST API client.
 * RFC-0010 §4.2: Infrastructure layer — fetch wrapper.
 *
 * RULES:
 * - credentials: 'same-origin' (NEVER 'include')
 * - Relative URLs only (proxied via Vite dev, same-origin in prod)
 * - Unwrap {data, meta} envelope
 * - 401 → session-invalidated event
 * - 429 → honor Retry-After header
 */

export interface ApiResponse<T> {
  data: T;
  meta?: Record<string, unknown>;
}

export interface ApiError {
  code: string;
  message: string;
  status: number;
}

type SessionInvalidatedCallback = () => void;

let _onSessionInvalidated: SessionInvalidatedCallback | null = null;
let _authToken: string | null = null;

export function setSessionInvalidatedCallback(cb: SessionInvalidatedCallback): void {
  _onSessionInvalidated = cb;
}

export function setAuthToken(token: string | null): void {
  _authToken = token;
}

export function getAuthToken(): string | null {
  return _authToken;
}

function getAuthHeaders(): Record<string, string> {
  return _authToken ? { 'Authorization': `Bearer ${_authToken}` } : {};
}

async function handleResponse<T>(response: Response): Promise<ApiResponse<T>> {
  if (response.status === 401) {
    _authToken = null;
    _onSessionInvalidated?.();
    throw createApiError('AUTH_001', 'Authentication required', 401);
  }

  if (response.status === 429) {
    const retryAfter = response.headers.get('Retry-After');
    const err = createApiError('RATE_LIMITED', `Rate limited. Retry after: ${retryAfter ?? 'unknown'}s`, 429);
    (err as ApiError & { retryAfter?: number }).retryAfter = retryAfter ? parseInt(retryAfter, 10) : undefined;
    throw err;
  }

  if (!response.ok) {
    let body: { error?: { code?: string; message?: string } } = {};
    try {
      body = await response.json() as typeof body;
    } catch {
      // Non-JSON error response
    }
    throw createApiError(
      body.error?.code ?? 'UNKNOWN',
      body.error?.message ?? response.statusText,
      response.status,
    );
  }

  const json = await response.json() as { data: T; meta?: Record<string, unknown> };
  return { data: json.data, meta: json.meta };
}

function createApiError(code: string, message: string, status: number): ApiError {
  return { code, message, status };
}

export function isApiError(err: unknown): err is ApiError {
  return typeof err === 'object' && err !== null && 'code' in err && 'status' in err;
}

export async function apiGet<T>(path: string): Promise<ApiResponse<T>> {
  const response = await fetch(path, {
    method: 'GET',
    credentials: 'same-origin',
    headers: {
      'Accept': 'application/json',
      ...getAuthHeaders(),
    },
  });
  return handleResponse<T>(response);
}

export async function apiPost<T>(path: string, body?: unknown): Promise<ApiResponse<T>> {
  const response = await fetch(path, {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      ...getAuthHeaders(),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return handleResponse<T>(response);
}

export async function apiPut<T>(path: string, body?: unknown): Promise<ApiResponse<T>> {
  const response = await fetch(path, {
    method: 'PUT',
    credentials: 'same-origin',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      ...getAuthHeaders(),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return handleResponse<T>(response);
}

export async function apiPostBinary<T>(path: string, body: Uint8Array): Promise<ApiResponse<T>> {
  // Copy into a fresh ArrayBuffer to satisfy TypeScript 6.0 strict BodyInit type.
  const buf = new ArrayBuffer(body.byteLength);
  new Uint8Array(buf).set(body);
  const response = await fetch(path, {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      'Content-Type': 'application/octet-stream',
      'Accept': 'application/json',
      ...getAuthHeaders(),
    },
    body: buf,
  });
  return handleResponse<T>(response);
}

export async function apiDelete<T>(path: string): Promise<ApiResponse<T>> {
  const response = await fetch(path, {
    method: 'DELETE',
    credentials: 'same-origin',
    headers: {
      'Accept': 'application/json',
      ...getAuthHeaders(),
    },
  });
  return handleResponse<T>(response);
}

export async function apiPatch<T>(path: string, body?: unknown): Promise<ApiResponse<T>> {
  const response = await fetch(path, {
    method: 'PATCH',
    credentials: 'same-origin',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      ...getAuthHeaders(),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return handleResponse<T>(response);
}

export async function apiPostBlob<T>(path: string, blob: Blob | File): Promise<ApiResponse<T>> {
  const response = await fetch(path, {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      'Content-Type': blob.type || 'application/octet-stream',
      'Accept': 'application/json',
      ...getAuthHeaders(),
    },
    body: blob,
  });
  return handleResponse<T>(response);
}

export async function apiPutBinary<T>(path: string, data: Uint8Array | ArrayBuffer, extraHeaders?: Record<string, string>): Promise<ApiResponse<T>> {
  const response = await fetch(path, {
    method: 'PUT',
    credentials: 'same-origin',
    headers: {
      'Content-Type': 'application/octet-stream',
      'Accept': 'application/json',
      ...getAuthHeaders(),
      ...(extraHeaders || {}),
    },
    body: new Blob([data as unknown as BlobPart]),
  });
  return handleResponse<T>(response);
}

export async function apiGetBinary(path: string): Promise<ArrayBuffer> {
  const response = await fetch(path, {
    method: 'GET',
    credentials: 'same-origin',
    headers: {
      ...getAuthHeaders(),
    },
  });
  if (response.status === 401) {
    _authToken = null;
    _onSessionInvalidated?.();
    throw createApiError('AUTH_001', 'Authentication required', 401);
  }
  if (!response.ok) {
    throw createApiError('DOWNLOAD_FAILED', response.statusText, response.status);
  }
  return response.arrayBuffer();
}


