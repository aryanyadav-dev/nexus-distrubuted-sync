import { Router } from 'express';
import { CreateWorkspaceRequestSchema, InviteMemberRequestSchema } from '@dsync/shared';
import { requireAuth } from '../auth/jwt';
import {
  createWorkspace,
  findWorkspacesByUser,
  findWorkspaceById,
  findWorkspaceMembers,
  findWorkspaceMember,
  addWorkspaceMember,
  findUserByEmail,
  writeAuditLog,
  findAuditLogs,
  deleteWorkspace,
} from '../db/queries';
import { logger } from '../utils/logger';

const router = Router();
router.use(requireAuth);

// List my workspaces
router.get('/', async (req, res) => {
  try {
    const workspaces = await findWorkspacesByUser(req.user!.userId);
    res.json({ ok: true, data: workspaces });
  } catch (err) {
    res.status(500).json({ ok: false, error: 'Internal server error' });
  }
});

// Create workspace
router.post('/', async (req, res) => {
  const parsed = CreateWorkspaceRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: 'Invalid request', details: parsed.error.flatten() });
    return;
  }
  try {
    const workspace = await createWorkspace(parsed.data.name, req.user!.userId);
    await writeAuditLog({
      userId: req.user!.userId,
      workspaceId: workspace.id,
      action: 'workspace_created',
      meta: { name: workspace.name },
    });
    res.status(201).json({ ok: true, data: workspace });
  } catch (err) {
    logger.error('Create workspace error', { error: (err as Error).message });
    res.status(500).json({ ok: false, error: 'Internal server error' });
  }
});

// Get workspace
router.get('/:workspaceId', async (req, res) => {
  const { workspaceId } = req.params;
  const member = await findWorkspaceMember(workspaceId, req.user!.userId);
  if (!member) {
    res.status(403).json({ ok: false, error: 'Forbidden' });
    return;
  }
  const workspace = await findWorkspaceById(workspaceId);
  if (!workspace) {
    res.status(404).json({ ok: false, error: 'Not found' });
    return;
  }
  res.json({ ok: true, data: workspace });
});

// Delete workspace
router.delete('/:workspaceId', async (req, res) => {
  const { workspaceId } = req.params;
  const member = await findWorkspaceMember(workspaceId, req.user!.userId);
  if (!member || member.role !== 'owner') {
    res.status(403).json({ ok: false, error: 'Only owners can delete workspaces' });
    return;
  }
  try {
    await deleteWorkspace(workspaceId);
    res.json({ ok: true, data: { success: true } });
  } catch (err) {
    logger.error('Delete workspace error', { error: (err as Error).message });
    res.status(500).json({ ok: false, error: 'Internal server error' });
  }
});

// List members
router.get('/:workspaceId/members', async (req, res) => {
  const { workspaceId } = req.params;
  const member = await findWorkspaceMember(workspaceId, req.user!.userId);
  if (!member) {
    res.status(403).json({ ok: false, error: 'Forbidden' });
    return;
  }
  const members = await findWorkspaceMembers(workspaceId);
  res.json({ ok: true, data: members });
});

// Invite member
router.post('/:workspaceId/members', async (req, res) => {
  const { workspaceId } = req.params;

  const myMembership = await findWorkspaceMember(workspaceId, req.user!.userId);
  if (!myMembership || !['owner', 'editor'].includes(myMembership.role)) {
    res.status(403).json({ ok: false, error: 'Only owners or editors can invite members' });
    return;
  }

  const parsed = InviteMemberRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: 'Invalid request', details: parsed.error.flatten() });
    return;
  }

  const invitee = await findUserByEmail(parsed.data.email);
  if (!invitee) {
    res.status(404).json({ ok: false, error: 'User not found with that email' });
    return;
  }

  await addWorkspaceMember(workspaceId, invitee.id, parsed.data.role);
  await writeAuditLog({
    userId: req.user!.userId,
    workspaceId,
    action: 'member_invited',
    meta: { inviteeId: invitee.id, role: parsed.data.role },
  });

  res.json({ ok: true, data: { message: 'Member added' } });
});

// Audit logs
router.get('/:workspaceId/audit', async (req, res) => {
  const { workspaceId } = req.params;
  const member = await findWorkspaceMember(workspaceId, req.user!.userId);
  if (!member || member.role !== 'owner') {
    res.status(403).json({ ok: false, error: 'Only owners can view audit logs' });
    return;
  }
  const logs = await findAuditLogs(workspaceId);
  res.json({ ok: true, data: logs });
});

export default router;
