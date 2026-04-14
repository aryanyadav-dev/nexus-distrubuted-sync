/**
 * Demo Backend — A fully client-side mock of the DSync REST API.
 *
 * When the real backend is unreachable (e.g. Vercel-only deploy),
 * every API call is routed here instead. All state lives in localStorage
 * so it survives page refreshes within the same browser.
 *
 * Three demo users are pre-seeded: alice, bob, carol.
 * A shared "Demo Workspace" with a board + doc is bootstrapped on first run.
 */

// ── Deterministic UUIDs for demo fixtures ───────────────────────

const DEMO_USERS = {
  alice: {
    id: 'da000000-0000-0000-0000-000000000001',
    email: 'alice@demo.com',
    displayName: 'Alice',
    password: 'password123',
  },
  bob: {
    id: 'da000000-0000-0000-0000-000000000002',
    email: 'bob@demo.com',
    displayName: 'Bob',
    password: 'password123',
  },
  carol: {
    id: 'da000000-0000-0000-0000-000000000003',
    email: 'carol@demo.com',
    displayName: 'Carol',
    password: 'password123',
  },
} as const;

const DEMO_WORKSPACE_ID = 'da000000-0000-0000-0000-0000000000w1';
const DEMO_BOARD_ID = 'da000000-0000-0000-0000-0000000000d1';
const DEMO_DOC_ID = 'da000000-0000-0000-0000-0000000000d2';

// ── LocalStorage helpers ────────────────────────────────────────

const STORE_KEY = 'dsync_demo_store';

interface DemoUser {
  id: string;
  email: string;
  displayName: string;
  password: string;
  createdAt: string;
}

interface DemoWorkspace {
  id: string;
  name: string;
  ownerId: string;
  createdAt: string;
}

interface DemoMembership {
  workspaceId: string;
  userId: string;
  role: 'owner' | 'editor' | 'viewer';
  joinedAt: string;
}

interface DemoDocument {
  id: string;
  workspaceId: string;
  title: string;
  content: Record<string, unknown>;
  revision: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

interface DemoStore {
  users: Record<string, DemoUser>;
  workspaces: Record<string, DemoWorkspace>;
  memberships: DemoMembership[];
  documents: Record<string, DemoDocument>;
  seeded: boolean;
}

function loadStore(): DemoStore {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as DemoStore;
      if (parsed.seeded) return parsed;
    }
  } catch { /* fall through to seed */ }
  return seed();
}

function saveStore(store: DemoStore): void {
  localStorage.setItem(STORE_KEY, JSON.stringify(store));
}

function uuid(): string {
  return crypto.randomUUID();
}

const now = () => new Date().toISOString();

// ── Seed initial data ───────────────────────────────────────────

function seed(): DemoStore {
  const ts = now();

  const users: Record<string, DemoUser> = {};
  for (const u of Object.values(DEMO_USERS)) {
    users[u.id] = { ...u, createdAt: ts };
  }

  const workspaces: Record<string, DemoWorkspace> = {
    [DEMO_WORKSPACE_ID]: {
      id: DEMO_WORKSPACE_ID,
      name: 'Demo Workspace',
      ownerId: DEMO_USERS.alice.id,
      createdAt: ts,
    },
  };

  const memberships: DemoMembership[] = Object.values(DEMO_USERS).map((u) => ({
    workspaceId: DEMO_WORKSPACE_ID,
    userId: u.id,
    role: u.id === DEMO_USERS.alice.id ? 'owner' : 'editor',
    joinedAt: ts,
  }));

  const item1Id = uuid();
  const item2Id = uuid();
  const item3Id = uuid();

  const documents: Record<string, DemoDocument> = {
    [DEMO_BOARD_ID]: {
      id: DEMO_BOARD_ID,
      workspaceId: DEMO_WORKSPACE_ID,
      title: 'Sprint Board',
      content: {
        kind: 'board',
        title: 'Sprint Board',
        description: 'Track sprint tasks in real-time',
        items: {
          [item1Id]: {
            id: item1Id,
            text: 'Set up CI/CD pipeline',
            completed: false,
            createdBy: 'Alice',
            createdAt: ts,
            order: 0,
            priority: 'high',
          },
          [item2Id]: {
            id: item2Id,
            text: 'Design sync protocol v2',
            completed: false,
            createdBy: 'Bob',
            createdAt: ts,
            order: 1,
            priority: 'medium',
          },
          [item3Id]: {
            id: item3Id,
            text: 'Write unit tests for CRDT merge',
            completed: true,
            createdBy: 'Carol',
            createdAt: ts,
            order: 2,
            priority: 'low',
          },
        },
      },
      revision: 1,
      createdBy: DEMO_USERS.alice.id,
      createdAt: ts,
      updatedAt: ts,
    },
    [DEMO_DOC_ID]: {
      id: DEMO_DOC_ID,
      workspaceId: DEMO_WORKSPACE_ID,
      title: 'Architecture Notes',
      content: {
        kind: 'doc',
        title: 'Architecture Notes',
        body: `# Nexus Distributed Sync Engine\n\nThis document captures the architectural decisions behind the Nexus sync system.\n\n## Overview\nNexus uses an optimistic mutation protocol with server-side conflict resolution.\nEach document maintains a linear revision history. Clients submit patches\nagainst their known base revision and the server resolves any conflicts\nusing a deterministic last-write-wins strategy.\n\n## Key Components\n- **SyncClient SDK** — manages WebSocket lifecycle, heartbeats, and offline buffering\n- **Mutation Queue** — server-side FIFO queue per document for serialized apply\n- **Snapshot Store** — periodic full-state snapshots for fast client bootstrap\n- **Presence Engine** — real-time user awareness via heartbeat aggregation\n\n## Next Steps\n- Implement field-level OT for finer conflict granularity\n- Add Redis pub/sub for horizontal server scaling\n- Build admin dashboard for live system monitoring`,
        comments: {},
        tasks: {},
      },
      revision: 1,
      createdBy: DEMO_USERS.alice.id,
      createdAt: ts,
      updatedAt: ts,
    },
  };

  const store: DemoStore = { users, workspaces, memberships, documents, seeded: true };
  saveStore(store);
  return store;
}

// ── Fake JWT ────────────────────────────────────────────────────

function makeDemoToken(userId: string): string {
  // Not a real JWT — just a base64 marker the demo backend can recognise
  return `demo.${btoa(userId)}.fake`;
}

function parseDemoToken(token: string): string | null {
  if (!token.startsWith('demo.')) return null;
  try {
    return atob(token.split('.')[1]);
  } catch { return null; }
}

// ── Public API ──────────────────────────────────────────────────

export type DemoResult<T> = { ok: true; data: T } | { ok: false; error: string };

/** Check whether a given JWT is a demo-mode token */
export function isDemoToken(token: string | null): boolean {
  return !!token && token.startsWith('demo.');
}

/** Look up the user behind a demo token */
export function getDemoUser(token: string): { id: string; email: string; displayName: string } | null {
  const userId = parseDemoToken(token);
  if (!userId) return null;
  const store = loadStore();
  const u = store.users[userId];
  if (!u) return null;
  return { id: u.id, email: u.email, displayName: u.displayName };
}

// ── Auth ────────────────────────────────────────────────────────

export function demoSignIn(email: string, password: string): DemoResult<{ token: string; user: { id: string; email: string; displayName: string } }> {
  const store = loadStore();
  const user = Object.values(store.users).find((u) => u.email === email);
  if (!user || user.password !== password) {
    return { ok: false, error: 'Invalid email or password' };
  }
  return {
    ok: true,
    data: {
      token: makeDemoToken(user.id),
      user: { id: user.id, email: user.email, displayName: user.displayName },
    },
  };
}

export function demoSignUp(email: string, password: string, displayName: string): DemoResult<{ token: string; user: { id: string; email: string; displayName: string } }> {
  const store = loadStore();
  if (Object.values(store.users).some((u) => u.email === email)) {
    return { ok: false, error: 'Email already registered' };
  }
  const id = uuid();
  store.users[id] = { id, email, displayName, password, createdAt: now() };
  saveStore(store);
  return {
    ok: true,
    data: {
      token: makeDemoToken(id),
      user: { id, email, displayName },
    },
  };
}

// ── Workspaces ──────────────────────────────────────────────────

export function demoListWorkspaces(token: string): DemoResult<Array<{ id: string; name: string; ownerId: string; createdAt: string }>> {
  const userId = parseDemoToken(token);
  if (!userId) return { ok: false, error: 'Unauthorized' };
  const store = loadStore();
  const memberOf = store.memberships.filter((m) => m.userId === userId).map((m) => m.workspaceId);
  const workspaces = memberOf.map((wsId) => store.workspaces[wsId]).filter(Boolean);
  return { ok: true, data: workspaces };
}

export function demoCreateWorkspace(token: string, name: string): DemoResult<{ id: string; name: string; ownerId: string; createdAt: string }> {
  const userId = parseDemoToken(token);
  if (!userId) return { ok: false, error: 'Unauthorized' };
  const store = loadStore();
  const id = uuid();
  const ws = { id, name, ownerId: userId, createdAt: now() };
  store.workspaces[id] = ws;
  store.memberships.push({ workspaceId: id, userId, role: 'owner', joinedAt: now() });
  saveStore(store);
  return { ok: true, data: ws };
}

export function demoDeleteWorkspace(token: string, wsId: string): DemoResult<{ success: boolean }> {
  const userId = parseDemoToken(token);
  if (!userId) return { ok: false, error: 'Unauthorized' };
  const store = loadStore();
  delete store.workspaces[wsId];
  store.memberships = store.memberships.filter((m) => m.workspaceId !== wsId);
  for (const [docId, doc] of Object.entries(store.documents)) {
    if (doc.workspaceId === wsId) delete store.documents[docId];
  }
  saveStore(store);
  return { ok: true, data: { success: true } };
}

export function demoGetWorkspaceMembers(token: string, wsId: string): DemoResult<Array<{
  workspaceId: string;
  userId: string;
  role: string;
  joinedAt: string;
  user?: { id: string; email: string; displayName: string };
}>> {
  const userId = parseDemoToken(token);
  if (!userId) return { ok: false, error: 'Unauthorized' };
  const store = loadStore();
  const members = store.memberships
    .filter((m) => m.workspaceId === wsId)
    .map((m) => {
      const u = store.users[m.userId];
      return {
        workspaceId: m.workspaceId,
        userId: m.userId,
        role: m.role,
        joinedAt: m.joinedAt,
        user: u ? { id: u.id, email: u.email, displayName: u.displayName } : undefined,
      };
    });
  return { ok: true, data: members };
}

export function demoInviteMember(token: string, wsId: string, email: string, role: 'editor' | 'viewer'): DemoResult<{ message: string }> {
  const userId = parseDemoToken(token);
  if (!userId) return { ok: false, error: 'Unauthorized' };
  const store = loadStore();
  const target = Object.values(store.users).find((u) => u.email === email);
  if (!target) return { ok: false, error: 'User not found' };
  if (store.memberships.some((m) => m.workspaceId === wsId && m.userId === target.id)) {
    return { ok: false, error: 'Already a member' };
  }
  store.memberships.push({ workspaceId: wsId, userId: target.id, role, joinedAt: now() });
  saveStore(store);
  return { ok: true, data: { message: `${email} invited as ${role}` } };
}

// ── Documents ───────────────────────────────────────────────────

export function demoListDocuments(token: string, wsId: string): DemoResult<Array<{
  id: string; workspaceId: string; title: string; content: Record<string, unknown>; revision: number; createdAt: string; updatedAt: string;
}>> {
  const userId = parseDemoToken(token);
  if (!userId) return { ok: false, error: 'Unauthorized' };
  const store = loadStore();
  const docs = Object.values(store.documents)
    .filter((d) => d.workspaceId === wsId)
    .map((d) => ({ id: d.id, workspaceId: d.workspaceId, title: d.title, content: d.content, revision: d.revision, createdAt: d.createdAt, updatedAt: d.updatedAt }));
  return { ok: true, data: docs };
}

export function demoCreateDocument(token: string, wsId: string, title: string, initialContent?: Record<string, unknown>): DemoResult<{
  id: string; workspaceId: string; title: string; content: Record<string, unknown>; revision: number;
}> {
  const userId = parseDemoToken(token);
  if (!userId) return { ok: false, error: 'Unauthorized' };
  const store = loadStore();
  const id = uuid();
  const doc: DemoDocument = {
    id,
    workspaceId: wsId,
    title,
    content: initialContent || {},
    revision: 0,
    createdBy: userId,
    createdAt: now(),
    updatedAt: now(),
  };
  store.documents[id] = doc;
  saveStore(store);
  return { ok: true, data: { id: doc.id, workspaceId: doc.workspaceId, title: doc.title, content: doc.content, revision: doc.revision } };
}

export function demoDeleteDocument(token: string, wsId: string, docId: string): DemoResult<{ success: boolean }> {
  const userId = parseDemoToken(token);
  if (!userId) return { ok: false, error: 'Unauthorized' };
  const store = loadStore();
  delete store.documents[docId];
  saveStore(store);
  return { ok: true, data: { success: true } };
}

export function demoGetDocument(token: string, wsId: string, docId: string): DemoResult<{
  id: string; workspaceId: string; title: string; content: Record<string, unknown>; revision: number;
}> {
  const userId = parseDemoToken(token);
  if (!userId) return { ok: false, error: 'Unauthorized' };
  const store = loadStore();
  const doc = store.documents[docId];
  if (!doc) return { ok: false, error: 'Document not found' };
  return { ok: true, data: { id: doc.id, workspaceId: doc.workspaceId, title: doc.title, content: doc.content, revision: doc.revision } };
}

export function demoUpdateDocument(token: string, wsId: string, docId: string, patch: Record<string, unknown>): DemoResult<{
  id: string; workspaceId: string; title: string; content: Record<string, unknown>; revision: number; updatedAt: string;
}> {
  const userId = parseDemoToken(token);
  if (!userId) return { ok: false, error: 'Unauthorized' };
  const store = loadStore();
  const doc = store.documents[docId];
  if (!doc) return { ok: false, error: 'Document not found' };

  // Deep-merge items specially
  const merged = { ...doc.content };
  for (const [key, value] of Object.entries(patch)) {
    if (key === 'items' && typeof value === 'object' && value !== null && !Array.isArray(value)) {
      const items = { ...(merged.items as Record<string, unknown> || {}) };
      for (const [ik, iv] of Object.entries(value as Record<string, unknown>)) {
        if (iv === null) { delete items[ik]; } else { items[ik] = iv; }
      }
      merged.items = items;
    } else {
      merged[key] = value;
    }
  }

  doc.content = merged;
  doc.revision++;
  doc.updatedAt = now();
  saveStore(store);

  return { ok: true, data: { id: doc.id, workspaceId: doc.workspaceId, title: doc.title, content: doc.content, revision: doc.revision, updatedAt: doc.updatedAt } };
}

export function demoGetDocumentHistory(
  _token: string, _wsId: string, _docId: string, _limit: number
): DemoResult<Array<unknown>> {
  // Demo mode doesn't track history — return empty list
  return { ok: true, data: [] };
}

export function demoRestoreDocumentRevision(
  _token: string, _wsId: string, _docId: string, _revision: number
): DemoResult<unknown> {
  return { ok: false, error: 'Restore not supported in demo mode' };
}

// ── Admin ───────────────────────────────────────────────────────

export function demoAdminHealth(): DemoResult<{
  status: string; activeSessions: number; subscribedDocuments: number; uptime: number; memoryMb: number; ts: number;
}> {
  return {
    ok: true,
    data: {
      status: 'demo',
      activeSessions: 1,
      subscribedDocuments: 0,
      uptime: 0,
      memoryMb: 0,
      ts: Date.now(),
    },
  };
}

export function demoAdminSessions(): DemoResult<Array<unknown>> {
  return { ok: true, data: [] };
}
