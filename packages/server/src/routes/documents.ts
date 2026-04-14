import { Router, type Request } from 'express';
import { CreateDocumentRequestSchema, UpdateDocumentRequestSchema, type RemoteUpdate } from '@dsync/shared';
import { requireAuth } from '../auth/jwt';
import {
  createDocument,
  findDocumentsByWorkspace,
  findDocumentById,
  findWorkspaceMember,
  findMutationsForDocument,
  findLatestSnapshot,
  findSnapshotByRevision,
  writeAuditLog,
  deleteDocument,
  applyPatchToDocument,
  storeMutation,
} from '../db/queries';
import { restoreAtRevision, estimateReplayCost } from '../sync/snapshotRestore';
import { logger } from '../utils/logger';
import { broadcastToDocument } from '../ws/sessionRegistry';
import { publishToDocument } from '../redis/client';
import { syncResolvedBoardTasks } from '../sync/linkedBoardTasks';

interface DocParams {
  workspaceId: string;
  docId?: string;
  revision?: string;
}

const router = Router({ mergeParams: true });
router.use(requireAuth);

// Helper: verify user is a member of the workspace that owns this document
async function assertDocumentAccess(docId: string, userId: string) {
  const doc = await findDocumentById(docId);
  if (!doc) return null;
  const member = await findWorkspaceMember(doc.workspaceId, userId);
  if (!member) return null;
  return { doc, member };
}

// List documents in a workspace
router.get('/', async (req: Request<DocParams>, res) => {
  const { workspaceId } = req.params;
  const member = await findWorkspaceMember(workspaceId, req.user!.userId);
  if (!member) {
    res.status(403).json({ ok: false, error: 'Forbidden' });
    return;
  }
  const docs = await findDocumentsByWorkspace(workspaceId);
  res.json({ ok: true, data: docs });
});

// Create document
router.post('/', async (req: Request<DocParams>, res) => {
  const { workspaceId } = req.params;
  const member = await findWorkspaceMember(workspaceId, req.user!.userId);
  if (!member || member.role === 'viewer') {
    res.status(403).json({ ok: false, error: 'Forbidden' });
    return;
  }

  const parsed = CreateDocumentRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: 'Invalid request', details: parsed.error.flatten() });
    return;
  }

  try {
    const doc = await createDocument(
      workspaceId,
      parsed.data.title,
      parsed.data.initialContent ?? {},
      req.user!.userId
    );
    await writeAuditLog({
      userId: req.user!.userId,
      workspaceId,
      action: 'document_created',
      meta: { documentId: doc.id, title: doc.title },
    });
    res.status(201).json({ ok: true, data: doc });
  } catch (err) {
    logger.error('Create document error', { error: (err as Error).message });
    res.status(500).json({ ok: false, error: 'Internal server error' });
  }
});

// Get document
router.get('/:docId', async (req: Request<DocParams>, res) => {
  const access = await assertDocumentAccess(req.params.docId!, req.user!.userId);
  if (!access) {
    res.status(403).json({ ok: false, error: 'Forbidden or not found' });
    return;
  }
  res.json({ ok: true, data: access.doc });
});

router.patch('/:docId', async (req: Request<DocParams>, res) => {
  const access = await assertDocumentAccess(req.params.docId!, req.user!.userId);
  if (!access || access.member.role === 'viewer') {
    res.status(403).json({ ok: false, error: 'Forbidden' });
    return;
  }

  const parsed = UpdateDocumentRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: 'Invalid request', details: parsed.error.flatten() });
    return;
  }

  try {
    const updated = await applyPatchToDocument(req.params.docId!, parsed.data.patch, access.doc.revision);
    await storeMutation({
      documentId: updated.id,
      userId: req.user!.userId,
      revision: updated.revision,
      baseRevision: access.doc.revision,
      patch: parsed.data.patch,
      conflictMeta: null,
      correlationId: crypto.randomUUID(),
    });

    const remoteUpdate: RemoteUpdate = {
      type: 'remote_update',
      documentId: updated.id,
      revision: updated.revision,
      patch: parsed.data.patch,
      userId: req.user!.userId,
      displayName: req.user!.displayName,
      correlationId: crypto.randomUUID(),
      conflictMeta: null,
    };
    broadcastToDocument(updated.id, remoteUpdate);
    await publishToDocument(updated.id, remoteUpdate);
    await syncResolvedBoardTasks({
      workspaceId: updated.workspaceId,
      boardId: updated.id,
      patch: parsed.data.patch,
      userId: req.user!.userId,
      displayName: req.user!.displayName,
    });

    res.json({ ok: true, data: updated });
  } catch (err) {
    logger.error('Update document error', { error: (err as Error).message });
    res.status(500).json({ ok: false, error: 'Internal server error' });
  }
});

// Delete document
router.delete('/:docId', async (req: Request<DocParams>, res) => {
  const access = await assertDocumentAccess(req.params.docId!, req.user!.userId);
  if (!access || access.member.role === 'viewer') {
    res.status(403).json({ ok: false, error: 'Forbidden' });
    return;
  }
  try {
    await deleteDocument(req.params.docId!);
    await writeAuditLog({
      userId: req.user!.userId,
      workspaceId: req.params.workspaceId,
      action: 'document_deleted',
      meta: { documentId: req.params.docId! },
    });
    res.json({ ok: true, data: { success: true } });
  } catch (err) {
    logger.error('Delete document error', { error: (err as Error).message });
    res.status(500).json({ ok: false, error: 'Internal server error' });
  }
});

// Get mutation history
router.get('/:docId/history', async (req: Request<DocParams>, res) => {
  const access = await assertDocumentAccess(req.params.docId!, req.user!.userId);
  if (!access) {
    res.status(403).json({ ok: false, error: 'Forbidden or not found' });
    return;
  }
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const offset = Number(req.query.offset) || 0;
  const mutations = await findMutationsForDocument(req.params.docId!, limit, offset);
  res.json({ ok: true, data: mutations });
});

// Get latest snapshot
router.get('/:docId/snapshot', async (req: Request<DocParams>, res) => {
  const access = await assertDocumentAccess(req.params.docId!, req.user!.userId);
  if (!access) {
    res.status(403).json({ ok: false, error: 'Forbidden or not found' });
    return;
  }
  const snapshot = await findLatestSnapshot(req.params.docId!);
  res.json({ ok: true, data: snapshot });
});

// Get snapshot at specific revision
router.get('/:docId/snapshot/:revision', async (req: Request<DocParams>, res) => {
  const access = await assertDocumentAccess(req.params.docId!, req.user!.userId);
  if (!access) {
    res.status(403).json({ ok: false, error: 'Forbidden or not found' });
    return;
  }
  const revision = parseInt(req.params.revision!, 10);
  if (isNaN(revision)) {
    res.status(400).json({ ok: false, error: 'Invalid revision number' });
    return;
  }
  const snapshot = await findSnapshotByRevision(req.params.docId!, revision);
  if (!snapshot) {
    res.status(404).json({ ok: false, error: 'Snapshot not found for that revision' });
    return;
  }
  res.json({ ok: true, data: snapshot });
});

// Restore document state at a specific revision (binary search + replay)
router.get('/:docId/restore/:revision', async (req: Request<DocParams>, res) => {
  const access = await assertDocumentAccess(req.params.docId!, req.user!.userId);
  if (!access) {
    res.status(403).json({ ok: false, error: 'Forbidden or not found' });
    return;
  }
  const revision = parseInt(req.params.revision!, 10);
  if (isNaN(revision) || revision < 0) {
    res.status(400).json({ ok: false, error: 'Invalid revision number' });
    return;
  }
  try {
    const restored = await restoreAtRevision(req.params.docId!, revision);
    if (!restored) {
      res.status(404).json({ ok: false, error: 'Could not restore at that revision' });
      return;
    }
    res.json({ ok: true, data: restored });
  } catch (err) {
    logger.error('Restore error', { error: (err as Error).message });
    res.status(500).json({ ok: false, error: 'Internal server error' });
  }
});

// Estimate replay cost for restoring at a revision
router.get('/:docId/restore/:revision/cost', async (req: Request<DocParams>, res) => {
  const access = await assertDocumentAccess(req.params.docId!, req.user!.userId);
  if (!access) {
    res.status(403).json({ ok: false, error: 'Forbidden or not found' });
    return;
  }
  const revision = parseInt(req.params.revision!, 10);
  if (isNaN(revision) || revision < 0) {
    res.status(400).json({ ok: false, error: 'Invalid revision number' });
    return;
  }
  try {
    const cost = await estimateReplayCost(req.params.docId!, revision);
    res.json({ ok: true, data: cost });
  } catch (err) {
    logger.error('Cost estimate error', { error: (err as Error).message });
    res.status(500).json({ ok: false, error: 'Internal server error' });
  }
});

export default router;
