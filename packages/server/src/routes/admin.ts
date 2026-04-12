import { Router } from 'express';
import { requireAuth } from '../auth/jwt';
import { getAllSessions } from '../ws/sessionRegistry';
import { getActiveSessions } from '../db/queries';

const router = Router();
router.use(requireAuth);

// Live active WS sessions (in-memory, this instance only)
router.get('/sessions', (_req, res) => {
  const sessions = getAllSessions().map((s) => ({
    sessionId: s.sessionId,
    userId: s.user.userId,
    displayName: s.user.displayName,
    subscribedDocuments: Array.from(s.subscribedDocumentIds),
    lastHeartbeat: new Date(s.lastHeartbeat).toISOString(),
  }));
  res.json({ ok: true, data: sessions });
});

// DB-persisted sessions (all time, this server instance)
router.get('/sessions/history', async (_req, res) => {
  try {
    const sessions = await getActiveSessions();
    res.json({ ok: true, data: sessions });
  } catch (err) {
    res.status(500).json({ ok: false, error: 'Internal server error' });
  }
});

// Health / metrics
router.get('/health', (_req, res) => {
  const live = getAllSessions();
  res.json({
    ok: true,
    data: {
      status: 'healthy',
      activeSessions: live.length,
      subscribedDocuments: new Set(live.flatMap((s) => Array.from(s.subscribedDocumentIds))).size,
      uptime: process.uptime(),
      memoryMb: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
      ts: Date.now(),
    },
  });
});

export default router;
