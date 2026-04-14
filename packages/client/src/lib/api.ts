/**
 * REST API client for DSync server.
 * Handles auth, workspaces, documents, and history endpoints.
 */

import { getApiBaseUrl } from './runtimeConfig';

const BASE_URL = getApiBaseUrl();

function getToken(): string | null {
  return localStorage.getItem('dsync_token');
}

async function request<T>(
  path: string,
  options: RequestInit = {}
): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
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
      const preview = rawBody.trim().slice(0, 140) || `HTTP ${res.status}`;
      const deploymentHint =
        BASE_URL === '/api' && typeof window !== 'undefined' && window.location.hostname !== 'localhost'
          ? ' Check your production API routing or set VITE_API_URL to your deployed backend /api base.'
          : '';
      return {
        ok: false,
        error: `API returned non-JSON response (${res.status}) from ${url}: ${preview}${deploymentHint}`,
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

// ── Auth ────────────────────────────────────────────────

export async function signUp(email: string, password: string, displayName: string) {
  return request<{ token: string; user: { id: string; email: string; displayName: string } }>(
    '/auth/signup',
    { method: 'POST', body: JSON.stringify({ email, password, displayName }) }
  );
}

export async function signIn(email: string, password: string) {
  return request<{ token: string; user: { id: string; email: string; displayName: string } }>(
    '/auth/signin',
    { method: 'POST', body: JSON.stringify({ email, password }) }
  );
}

// ── Workspaces ──────────────────────────────────────────

export async function listWorkspaces() {
  return request<Array<{ id: string; name: string; ownerId: string; createdAt: string }>>(
    '/workspaces'
  );
}

export async function createWorkspace(name: string) {
  return request<{ id: string; name: string; ownerId: string; createdAt: string }>(
    '/workspaces',
    { method: 'POST', body: JSON.stringify({ name }) }
  );
}

export async function deleteWorkspace(workspaceId: string) {
  return request<{ success: boolean }>(`/workspaces/${workspaceId}`, {
    method: 'DELETE',
  });
}

export async function getWorkspaceMembers(workspaceId: string) {
  return request<Array<{
    workspaceId: string;
    userId: string;
    role: string;
    joinedAt: string;
    user?: { id: string; email: string; displayName: string };
  }>>(`/workspaces/${workspaceId}/members`);
}

export async function inviteMember(workspaceId: string, email: string, role: 'editor' | 'viewer') {
  return request<{ message: string }>(
    `/workspaces/${workspaceId}/members`,
    { method: 'POST', body: JSON.stringify({ email, role }) }
  );
}

// ── Documents ───────────────────────────────────────────

export async function listDocuments(workspaceId: string) {
  return request<Array<{
    id: string;
    workspaceId: string;
    title: string;
    content: Record<string, unknown>;
    revision: number;
    createdAt: string;
    updatedAt: string;
  }>>(`/workspaces/${workspaceId}/documents`);
}

export async function createDocument(workspaceId: string, title: string, initialContent?: Record<string, unknown>) {
  return request<{
    id: string;
    workspaceId: string;
    title: string;
    content: Record<string, unknown>;
    revision: number;
  }>(`/workspaces/${workspaceId}/documents`, {
    method: 'POST',
    body: JSON.stringify({ title, initialContent }),
  });
}

export async function deleteDocument(workspaceId: string, docId: string) {
  return request<{ success: boolean }>(`/workspaces/${workspaceId}/documents/${docId}`, {
    method: 'DELETE',
  });
}

export async function getDocument(workspaceId: string, docId: string) {
  return request<{
    id: string;
    workspaceId: string;
    title: string;
    content: Record<string, unknown>;
    revision: number;
  }>(`/workspaces/${workspaceId}/documents/${docId}`);
}

export async function updateDocument(workspaceId: string, docId: string, patch: Record<string, unknown>) {
  return request<{
    id: string;
    workspaceId: string;
    title: string;
    content: Record<string, unknown>;
    revision: number;
    updatedAt: string;
  }>(`/workspaces/${workspaceId}/documents/${docId}`, {
    method: 'PATCH',
    body: JSON.stringify({ patch }),
  });
}

export async function getDocumentHistory(workspaceId: string, docId: string, limit = 50) {
  return request<Array<{
    id: string;
    documentId: string;
    userId: string;
    revision: number;
    baseRevision: number;
    patch: Record<string, unknown>;
    conflictMeta: unknown;
    correlationId: string;
    appliedAt: string;
  }>>(`/workspaces/${workspaceId}/documents/${docId}/history?limit=${limit}`);
}

export async function restoreDocumentRevision(workspaceId: string, docId: string, revision: number) {
  return request<{
    id: string;
    workspaceId: string;
    title: string;
    content: Record<string, unknown>;
    revision: number;
  }>(`/workspaces/${workspaceId}/documents/${docId}/restore/${revision}`);
}

// ── Admin ───────────────────────────────────────────────

export async function getAdminHealth() {
  return request<{
    status: string;
    activeSessions: number;
    subscribedDocuments: number;
    uptime: number;
    memoryMb: number;
    ts: number;
  }>('/admin/health');
}

export async function getAdminSessions() {
  return request<Array<{
    sessionId: string;
    userId: string;
    displayName: string;
    subscribedDocuments: string[];
    lastHeartbeat: string;
  }>>('/admin/sessions');
}
