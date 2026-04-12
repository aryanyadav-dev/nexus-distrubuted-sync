import { pool } from './pool';
import type { User, Workspace, WorkspaceMember, Document, Snapshot, Mutation } from '@dsync/shared';

// ─────────────────────────────────────────────
// Type mappers (snake_case DB → camelCase TS)
// ─────────────────────────────────────────────

function mapUser(row: Record<string, unknown>): User {
  return {
    id: row.id as string,
    email: row.email as string,
    displayName: row.display_name as string,
    createdAt: (row.created_at as Date).toISOString(),
  };
}

function mapWorkspace(row: Record<string, unknown>): Workspace {
  return {
    id: row.id as string,
    name: row.name as string,
    ownerId: row.owner_id as string,
    createdAt: (row.created_at as Date).toISOString(),
  };
}

function mapDocument(row: Record<string, unknown>): Document {
  return {
    id: row.id as string,
    workspaceId: row.workspace_id as string,
    title: row.title as string,
    content: row.content as Record<string, unknown>,
    revision: row.revision as number,
    createdBy: row.created_by as string,
    createdAt: (row.created_at as Date).toISOString(),
    updatedAt: (row.updated_at as Date).toISOString(),
  };
}

function mapSnapshot(row: Record<string, unknown>): Snapshot {
  return {
    id: row.id as string,
    documentId: row.document_id as string,
    revision: row.revision as number,
    content: row.content as Record<string, unknown>,
    createdAt: (row.created_at as Date).toISOString(),
  };
}

function mapMutation(row: Record<string, unknown>): Mutation {
  return {
    id: row.id as string,
    documentId: row.document_id as string,
    userId: row.user_id as string,
    revision: row.revision as number,
    baseRevision: row.base_revision as number,
    patch: row.patch as Record<string, unknown>,
    conflictMeta: row.conflict_meta as Mutation['conflictMeta'],
    correlationId: row.correlation_id as string,
    appliedAt: (row.applied_at as Date).toISOString(),
  };
}

// ─────────────────────────────────────────────
// User queries
// ─────────────────────────────────────────────

export async function createUser(
  email: string,
  passwordHash: string,
  displayName: string
): Promise<User> {
  const res = await pool.query(
    `INSERT INTO users (email, password_hash, display_name) VALUES ($1, $2, $3) RETURNING *`,
    [email, passwordHash, displayName]
  );
  return mapUser(res.rows[0]);
}

export async function findUserByEmail(email: string): Promise<(User & { passwordHash: string }) | null> {
  const res = await pool.query(`SELECT * FROM users WHERE email = $1`, [email]);
  if (!res.rows[0]) return null;
  const row = res.rows[0];
  return { ...mapUser(row), passwordHash: row.password_hash as string };
}

export async function findUserById(id: string): Promise<User | null> {
  const res = await pool.query(`SELECT * FROM users WHERE id = $1`, [id]);
  if (!res.rows[0]) return null;
  return mapUser(res.rows[0]);
}

// ─────────────────────────────────────────────
// Workspace queries
// ─────────────────────────────────────────────

export async function createWorkspace(name: string, ownerId: string): Promise<Workspace> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const wsRes = await client.query(
      `INSERT INTO workspaces (name, owner_id) VALUES ($1, $2) RETURNING *`,
      [name, ownerId]
    );
    const workspace = mapWorkspace(wsRes.rows[0]);
    // Add owner as member
    await client.query(
      `INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'owner')`,
      [workspace.id, ownerId]
    );
    await client.query('COMMIT');
    return workspace;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export async function findWorkspaceById(id: string): Promise<Workspace | null> {
  const res = await pool.query(`SELECT * FROM workspaces WHERE id = $1`, [id]);
  if (!res.rows[0]) return null;
  return mapWorkspace(res.rows[0]);
}

export async function findWorkspacesByUser(userId: string): Promise<Workspace[]> {
  const res = await pool.query(
    `SELECT w.* FROM workspaces w
     JOIN workspace_members wm ON wm.workspace_id = w.id
     WHERE wm.user_id = $1
     ORDER BY w.created_at DESC`,
    [userId]
  );
  return res.rows.map(mapWorkspace);
}

export async function findWorkspaceMember(
  workspaceId: string,
  userId: string
): Promise<WorkspaceMember | null> {
  const res = await pool.query(
    `SELECT wm.*, u.email, u.display_name, u.created_at as user_created_at
     FROM workspace_members wm
     JOIN users u ON u.id = wm.user_id
     WHERE wm.workspace_id = $1 AND wm.user_id = $2`,
    [workspaceId, userId]
  );
  if (!res.rows[0]) return null;
  const row = res.rows[0];
  return {
    workspaceId: row.workspace_id,
    userId: row.user_id,
    role: row.role,
    joinedAt: row.joined_at.toISOString(),
    user: {
      id: row.user_id,
      email: row.email,
      displayName: row.display_name,
      createdAt: row.user_created_at.toISOString(),
    },
  };
}

export async function findWorkspaceMembers(workspaceId: string): Promise<WorkspaceMember[]> {
  const res = await pool.query(
    `SELECT wm.*, u.email, u.display_name, u.created_at as user_created_at
     FROM workspace_members wm
     JOIN users u ON u.id = wm.user_id
     WHERE wm.workspace_id = $1
     ORDER BY wm.joined_at ASC`,
    [workspaceId]
  );
  return res.rows.map((row) => ({
    workspaceId: row.workspace_id,
    userId: row.user_id,
    role: row.role,
    joinedAt: row.joined_at.toISOString(),
    user: {
      id: row.user_id,
      email: row.email,
      displayName: row.display_name,
      createdAt: row.user_created_at.toISOString(),
    },
  }));
}

export async function addWorkspaceMember(
  workspaceId: string,
  userId: string,
  role: 'editor' | 'viewer'
): Promise<void> {
  await pool.query(
    `INSERT INTO workspace_members (workspace_id, user_id, role) 
     VALUES ($1, $2, $3) 
     ON CONFLICT (workspace_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
    [workspaceId, userId, role]
  );
}

// ─────────────────────────────────────────────
// Document queries
// ─────────────────────────────────────────────

export async function createDocument(
  workspaceId: string,
  title: string,
  content: Record<string, unknown>,
  createdBy: string
): Promise<Document> {
  const res = await pool.query(
    `INSERT INTO documents (workspace_id, title, content, created_by) 
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [workspaceId, title, JSON.stringify(content), createdBy]
  );
  return mapDocument(res.rows[0]);
}

export async function findDocumentById(id: string): Promise<Document | null> {
  const res = await pool.query(`SELECT * FROM documents WHERE id = $1`, [id]);
  if (!res.rows[0]) return null;
  return mapDocument(res.rows[0]);
}

export async function findDocumentsByWorkspace(workspaceId: string): Promise<Document[]> {
  const res = await pool.query(
    `SELECT * FROM documents WHERE workspace_id = $1 ORDER BY created_at DESC`,
    [workspaceId]
  );
  return res.rows.map(mapDocument);
}

export async function deleteDocument(id: string): Promise<void> {
  await pool.query(`DELETE FROM documents WHERE id = $1`, [id]);
}

/**
 * Apply a patch atomically. Uses SELECT FOR UPDATE to prevent races.
 * Returns the updated document.
 */
export async function applyPatchToDocument(
  documentId: string,
  patch: Record<string, unknown>,
  expectedBaseRevision: number
): Promise<Document> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const lockRes = await client.query(
      `SELECT * FROM documents WHERE id = $1 FOR UPDATE`,
      [documentId]
    );
    if (!lockRes.rows[0]) throw new Error(`Document not found: ${documentId}`);
    const currentDoc = mapDocument(lockRes.rows[0]);

    // Merge patch into current content
    const newContent = { ...currentDoc.content };
    for (const [key, value] of Object.entries(patch)) {
      newContent[key] = value;
    }
    const newRevision = currentDoc.revision + 1;

    const updateRes = await client.query(
      `UPDATE documents SET content = $1, revision = $2, updated_at = now()
       WHERE id = $3 RETURNING *`,
      [JSON.stringify(newContent), newRevision, documentId]
    );
    await client.query('COMMIT');
    return mapDocument(updateRes.rows[0]);
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

// ─────────────────────────────────────────────
// Mutation log queries
// ─────────────────────────────────────────────

export async function storeMutation(params: {
  documentId: string;
  userId: string;
  revision: number;
  baseRevision: number;
  patch: Record<string, unknown>;
  conflictMeta: Mutation['conflictMeta'];
  correlationId: string;
}): Promise<Mutation> {
  const res = await pool.query(
    `INSERT INTO mutations 
     (document_id, user_id, revision, base_revision, patch, conflict_meta, correlation_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [
      params.documentId,
      params.userId,
      params.revision,
      params.baseRevision,
      JSON.stringify(params.patch),
      params.conflictMeta ? JSON.stringify(params.conflictMeta) : null,
      params.correlationId,
    ]
  );
  return mapMutation(res.rows[0]);
}

export async function findMutationByCorrelationId(correlationId: string): Promise<Mutation | null> {
  const res = await pool.query(
    `SELECT * FROM mutations WHERE correlation_id = $1`,
    [correlationId]
  );
  if (!res.rows[0]) return null;
  return mapMutation(res.rows[0]);
}

export async function findMutationsSince(
  documentId: string,
  sinceRevision: number
): Promise<Mutation[]> {
  const res = await pool.query(
    `SELECT m.*, u.display_name FROM mutations m
     JOIN users u ON u.id = m.user_id
     WHERE m.document_id = $1 AND m.revision > $2 
     ORDER BY m.revision ASC`,
    [documentId, sinceRevision]
  );
  return res.rows.map(mapMutation);
}

export async function findMutationsForDocument(
  documentId: string,
  limit = 50,
  offset = 0
): Promise<Mutation[]> {
  const res = await pool.query(
    `SELECT * FROM mutations WHERE document_id = $1 
     ORDER BY revision DESC LIMIT $2 OFFSET $3`,
    [documentId, limit, offset]
  );
  return res.rows.map(mapMutation);
}

// ─────────────────────────────────────────────
// Snapshot queries
// ─────────────────────────────────────────────

export async function createSnapshot(
  documentId: string,
  revision: number,
  content: Record<string, unknown>
): Promise<Snapshot> {
  const res = await pool.query(
    `INSERT INTO snapshots (document_id, revision, content) VALUES ($1, $2, $3) RETURNING *`,
    [documentId, revision, JSON.stringify(content)]
  );
  return mapSnapshot(res.rows[0]);
}

export async function findLatestSnapshot(documentId: string): Promise<Snapshot | null> {
  const res = await pool.query(
    `SELECT * FROM snapshots WHERE document_id = $1 ORDER BY revision DESC LIMIT 1`,
    [documentId]
  );
  if (!res.rows[0]) return null;
  return mapSnapshot(res.rows[0]);
}

export async function findSnapshotByRevision(
  documentId: string,
  revision: number
): Promise<Snapshot | null> {
  const res = await pool.query(
    `SELECT * FROM snapshots WHERE document_id = $1 AND revision = $2`,
    [documentId, revision]
  );
  if (!res.rows[0]) return null;
  return mapSnapshot(res.rows[0]);
}

/**
 * Binary search for the nearest snapshot at or below a target revision.
 * Used by the snapshot restore algorithm to find the closest recovery point,
 * then replay mutations forward from that point.
 *
 * Instead of loading all snapshots and filtering, this uses a bounded
 * binary search approach: find the MAX(revision) <= targetRevision.
 */
export async function findNearestSnapshotAtOrBelow(
  documentId: string,
  targetRevision: number
): Promise<Snapshot | null> {
  const res = await pool.query(
    `SELECT * FROM snapshots
     WHERE document_id = $1 AND revision <= $2
     ORDER BY revision DESC
     LIMIT 1`,
    [documentId, targetRevision]
  );
  if (!res.rows[0]) return null;
  return mapSnapshot(res.rows[0]);
}

/**
 * Fetch mutations in a revision range [fromRevision+1, toRevision].
 * Used to replay mutations on top of a snapshot to reach a target state.
 */
export async function findMutationsInRange(
  documentId: string,
  fromRevision: number,
  toRevision: number
): Promise<Mutation[]> {
  const res = await pool.query(
    `SELECT * FROM mutations
     WHERE document_id = $1 AND revision > $2 AND revision <= $3
     ORDER BY revision ASC`,
    [documentId, fromRevision, toRevision]
  );
  return res.rows.map(mapMutation);
}

/**
 * Get all snapshot revisions for a document (for binary search).
 * Returns revisions in ascending order.
 */
export async function getSnapshotRevisions(documentId: string): Promise<number[]> {
  const res = await pool.query(
    `SELECT revision FROM snapshots WHERE document_id = $1 ORDER BY revision ASC`,
    [documentId]
  );
  return res.rows.map((r) => r.revision as number);
}

// ─────────────────────────────────────────────
// Session queries
// ─────────────────────────────────────────────

export async function createSession(params: {
  id: string;
  userId: string;
  ipAddress?: string;
}): Promise<void> {
  await pool.query(
    `INSERT INTO sessions (id, user_id, ip_address) VALUES ($1, $2, $3)`,
    [params.id, params.userId, params.ipAddress ?? null]
  );
}

export async function updateSessionDocument(sessionId: string, documentId: string | null): Promise<void> {
  await pool.query(
    `UPDATE sessions SET document_id = $1, last_seen_at = now() WHERE id = $2`,
    [documentId, sessionId]
  );
}

export async function updateSessionLastSeen(sessionId: string): Promise<void> {
  await pool.query(
    `UPDATE sessions SET last_seen_at = now() WHERE id = $1`,
    [sessionId]
  );
}

export async function disconnectSession(sessionId: string): Promise<void> {
  await pool.query(
    `UPDATE sessions SET disconnected_at = now() WHERE id = $1`,
    [sessionId]
  );
}

export async function getActiveSessions(): Promise<unknown[]> {
  const res = await pool.query(
    `SELECT s.*, u.email, u.display_name FROM sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.disconnected_at IS NULL
     ORDER BY s.connected_at DESC`
  );
  return res.rows;
}

// ─────────────────────────────────────────────
// Audit log queries
// ─────────────────────────────────────────────

export async function writeAuditLog(params: {
  userId?: string;
  workspaceId?: string;
  action: string;
  meta?: Record<string, unknown>;
}): Promise<void> {
  await pool.query(
    `INSERT INTO audit_logs (user_id, workspace_id, action, meta) VALUES ($1, $2, $3, $4)`,
    [params.userId ?? null, params.workspaceId ?? null, params.action, JSON.stringify(params.meta ?? {})]
  );
}

export async function findAuditLogs(workspaceId: string, limit = 100): Promise<unknown[]> {
  const res = await pool.query(
    `SELECT al.*, u.display_name FROM audit_logs al
     LEFT JOIN users u ON u.id = al.user_id
     WHERE al.workspace_id = $1
     ORDER BY al.created_at DESC LIMIT $2`,
    [workspaceId, limit]
  );
  return res.rows;
}
