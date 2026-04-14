/**
 * REST API client for DSync server.
 * Handles auth, workspaces, documents, and history endpoints.
 *
 * When the real backend is unreachable (e.g. static Vercel deploy),
 * all calls are transparently routed through the in-memory demo backend.
 */

import { getApiBaseUrl } from './runtimeConfig';
import {
  isDemoToken,
  demoSignIn,
  demoSignUp,
  demoListWorkspaces,
  demoCreateWorkspace,
  demoDeleteWorkspace,
  demoGetWorkspaceMembers,
  demoInviteMember,
  demoListDocuments,
  demoCreateDocument,
  demoDeleteDocument,
  demoGetDocument,
  demoUpdateDocument,
  demoGetDocumentHistory,
  demoRestoreDocumentRevision,
  demoAdminHealth,
  demoAdminSessions,
} from './demoBackend';

const BASE_URL = getApiBaseUrl();

function getToken(): string | null {
  return localStorage.getItem('dsync_token');
}

/**
 * Returns true if we should use the demo backend for all API calls.
 * This is true when:
 * - current token is a demo token, OR
 * - we're running on a non-localhost host without an explicit VITE_API_URL
 *   (i.e. deployed frontend with no backend)
 */
function shouldUseDemoMode(): boolean {
  const token = getToken();
  if (isDemoToken(token)) return true;
  // Also detect "first visit on deployed frontend with no backend configured"
  // — checked lazily on auth calls below
  return false;
}

/** Flag set once we confirm the real backend is unreachable — all subsequent calls go demo */
let forceDemoMode = false;

export function isInDemoMode(): boolean {
  return forceDemoMode || shouldUseDemoMode();
}

export function setForceDemoMode(v: boolean): void {
  forceDemoMode = v;
}

// ── Generic fetch helper (for real backend) ─────────────────────

type ApiOk<T> = { ok: true; data: T };
type ApiErr = { ok: false; error: string };
type ApiResult<T> = ApiOk<T> | ApiErr;

async function request<T>(
  path: string,
  options: RequestInit = {}
): Promise<ApiResult<T>> {
  const token = getToken();
  const url = `${BASE_URL}${path}`;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string> || {}),
  };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  try {
    const res = await fetch(url, {
      ...options,
      headers,
    });

    const contentType = res.headers.get('content-type') || '';
    const rawBody = await res.text();

    if (!contentType.includes('application/json')) {
      return {
        ok: false,
        error: `API returned non-JSON response (${res.status}) from ${url}`,
      };
    }

    let body: { ok?: boolean; error?: string; data?: T };
    try {
      body = JSON.parse(rawBody) as { ok?: boolean; error?: string; data?: T };
    } catch {
      return {
        ok: false,
        error: `API returned invalid JSON (${res.status}) from ${url}`,
      };
    }

    if (!res.ok || body.ok === false) {
      return { ok: false, error: body.error || `HTTP ${res.status}` };
    }
    if (body.data === undefined) {
      return { ok: false, error: `API response missing data from ${url}` };
    }
    return { ok: true, data: body.data };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

/**
 * Try a real backend request. If it fails with a non-JSON / network error
 * AND we seem to be on a deployed host, flip to demo mode permanently.
 */
async function requestWithFallback<T>(
  path: string,
  options: RequestInit = {},
  demoFn: () => ApiResult<T>
): Promise<ApiResult<T>> {
  if (isInDemoMode()) return demoFn();

  const result = await request<T>(path, options);

  // If the real backend returned a valid API error (like "wrong password"), that's fine — return it.
  if (result.ok) return result;

  // Check if this is a routing / infrastructure error (Vercel 404, CORS, network fail)
  const infraError =
    result.error.includes('non-JSON') ||
    result.error.includes('Failed to fetch') ||
    result.error.includes('NetworkError') ||
    result.error.includes('Load failed');

  if (infraError) {
    console.warn('[DSync] Real backend unreachable — switching to demo mode.', result.error);
    forceDemoMode = true;
    return demoFn();
  }

  return result;
}

// ── Auth ────────────────────────────────────────────────────────

export async function signUp(email: string, password: string, displayName: string) {
  return requestWithFallback<{ token: string; user: { id: string; email: string; displayName: string } }>(
    '/auth/signup',
    { method: 'POST', body: JSON.stringify({ email, password, displayName }) },
    () => demoSignUp(email, password, displayName),
  );
}

export async function signIn(email: string, password: string) {
  return requestWithFallback<{ token: string; user: { id: string; email: string; displayName: string } }>(
    '/auth/signin',
    { method: 'POST', body: JSON.stringify({ email, password }) },
    () => demoSignIn(email, password),
  );
}

// ── Workspaces ──────────────────────────────────────────────────

export async function listWorkspaces() {
  const token = getToken();
  return requestWithFallback<Array<{ id: string; name: string; ownerId: string; createdAt: string }>>(
    '/workspaces',
    {},
    () => demoListWorkspaces(token!),
  );
}

export async function createWorkspace(name: string) {
  const token = getToken();
  return requestWithFallback<{ id: string; name: string; ownerId: string; createdAt: string }>(
    '/workspaces',
    { method: 'POST', body: JSON.stringify({ name }) },
    () => demoCreateWorkspace(token!, name),
  );
}

export async function deleteWorkspace(workspaceId: string) {
  const token = getToken();
  return requestWithFallback<{ success: boolean }>(
    `/workspaces/${workspaceId}`,
    { method: 'DELETE' },
    () => demoDeleteWorkspace(token!, workspaceId),
  );
}

export async function getWorkspaceMembers(workspaceId: string) {
  const token = getToken();
  return requestWithFallback<Array<{
    workspaceId: string;
    userId: string;
    role: string;
    joinedAt: string;
    user?: { id: string; email: string; displayName: string };
  }>>(
    `/workspaces/${workspaceId}/members`,
    {},
    () => demoGetWorkspaceMembers(token!, workspaceId),
  );
}

export async function inviteMember(workspaceId: string, email: string, role: 'editor' | 'viewer') {
  const token = getToken();
  return requestWithFallback<{ message: string }>(
    `/workspaces/${workspaceId}/members`,
    { method: 'POST', body: JSON.stringify({ email, role }) },
    () => demoInviteMember(token!, workspaceId, email, role),
  );
}

// ── Documents ───────────────────────────────────────────────────

export async function listDocuments(workspaceId: string) {
  const token = getToken();
  return requestWithFallback<Array<{
    id: string;
    workspaceId: string;
    title: string;
    content: Record<string, unknown>;
    revision: number;
    createdAt: string;
    updatedAt: string;
  }>>(
    `/workspaces/${workspaceId}/documents`,
    {},
    () => demoListDocuments(token!, workspaceId),
  );
}

export async function createDocument(workspaceId: string, title: string, initialContent?: Record<string, unknown>) {
  const token = getToken();
  return requestWithFallback<{
    id: string;
    workspaceId: string;
    title: string;
    content: Record<string, unknown>;
    revision: number;
  }>(
    `/workspaces/${workspaceId}/documents`,
    { method: 'POST', body: JSON.stringify({ title, initialContent }) },
    () => demoCreateDocument(token!, workspaceId, title, initialContent),
  );
}

export async function deleteDocument(workspaceId: string, docId: string) {
  const token = getToken();
  return requestWithFallback<{ success: boolean }>(
    `/workspaces/${workspaceId}/documents/${docId}`,
    { method: 'DELETE' },
    () => demoDeleteDocument(token!, workspaceId, docId),
  );
}

export async function getDocument(workspaceId: string, docId: string) {
  const token = getToken();
  return requestWithFallback<{
    id: string;
    workspaceId: string;
    title: string;
    content: Record<string, unknown>;
    revision: number;
  }>(
    `/workspaces/${workspaceId}/documents/${docId}`,
    {},
    () => demoGetDocument(token!, workspaceId, docId),
  );
}

export async function updateDocument(workspaceId: string, docId: string, patch: Record<string, unknown>) {
  const token = getToken();
  return requestWithFallback<{
    id: string;
    workspaceId: string;
    title: string;
    content: Record<string, unknown>;
    revision: number;
    updatedAt: string;
  }>(
    `/workspaces/${workspaceId}/documents/${docId}`,
    { method: 'PATCH', body: JSON.stringify({ patch }) },
    () => demoUpdateDocument(token!, workspaceId, docId, patch),
  );
}

export async function getDocumentHistory(workspaceId: string, docId: string, limit = 50) {
  const token = getToken();
  return requestWithFallback<Array<{
    id: string;
    documentId: string;
    userId: string;
    revision: number;
    baseRevision: number;
    patch: Record<string, unknown>;
    conflictMeta: unknown;
    correlationId: string;
    appliedAt: string;
  }>>(
    `/workspaces/${workspaceId}/documents/${docId}/history?limit=${limit}`,
    {},
    () => demoGetDocumentHistory(token!, workspaceId, docId, limit) as ApiResult<Array<{
      id: string; documentId: string; userId: string; revision: number; baseRevision: number;
      patch: Record<string, unknown>; conflictMeta: unknown; correlationId: string; appliedAt: string;
    }>>,
  );
}

export async function restoreDocumentRevision(workspaceId: string, docId: string, revision: number) {
  const token = getToken();
  return requestWithFallback<{
    id: string;
    workspaceId: string;
    title: string;
    content: Record<string, unknown>;
    revision: number;
  }>(
    `/workspaces/${workspaceId}/documents/${docId}/restore/${revision}`,
    {},
    () => demoRestoreDocumentRevision(token!, workspaceId, docId, revision) as ApiResult<{
      id: string; workspaceId: string; title: string; content: Record<string, unknown>; revision: number;
    }>,
  );
}

// ── Admin ───────────────────────────────────────────────────────

export async function getAdminHealth() {
  return requestWithFallback<{
    status: string;
    activeSessions: number;
    subscribedDocuments: number;
    uptime: number;
    memoryMb: number;
    ts: number;
  }>(
    '/admin/health',
    {},
    () => demoAdminHealth(),
  );
}

export async function getAdminSessions() {
  return requestWithFallback<Array<{
    sessionId: string;
    userId: string;
    displayName: string;
    subscribedDocuments: string[];
    lastHeartbeat: string;
  }>>(
    '/admin/sessions',
    {},
    () => demoAdminSessions() as ApiResult<Array<{
      sessionId: string; userId: string; displayName: string; subscribedDocuments: string[]; lastHeartbeat: string;
    }>>,
  );
}
