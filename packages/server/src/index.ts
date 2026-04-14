import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';

import { logger } from './utils/logger';
import { checkDbConnection } from './db/pool';
import { connectRedis } from './redis/client';
import { handleConnection } from './ws/handler';

import authRoutes from './routes/auth';
import workspaceRoutes from './routes/workspaces';
import documentRoutes from './routes/documents';
import adminRoutes from './routes/admin';

const PORT = parseInt(process.env.PORT || '4000', 10);

async function bootstrap() {
  // Verify infrastructure
  await checkDbConnection();
  await connectRedis();

  const app = express();

  // ── Security & middleware ──────────────────────────────────
  app.use(helmet());
  const allowedOrigins = (process.env.CORS_ORIGIN || '*').split(',').map(s => s.trim());
  app.use(cors({
    origin: (origin, callback) => {
      // Allow requests with no origin (mobile apps, curl, etc.)
      if (!origin) return callback(null, true);
      // Allow if wildcard or origin is in the list
      if (allowedOrigins.includes('*') || allowedOrigins.includes(origin)) {
        return callback(null, true);
      }
      // Also allow any *.vercel.app origin for preview deploys
      if (origin.endsWith('.vercel.app')) {
        return callback(null, true);
      }
      callback(null, true); // In production demo, allow all for now
    },
    credentials: true,
  }));
  app.use(express.json({ limit: '1mb' }));
  app.use(morgan('combined', { stream: { write: (msg) => logger.http(msg.trim()) } }));

  // Rate limiting on auth endpoints
  const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 20,
    message: { ok: false, error: 'Too many requests, please try again later.' },
  });
  const generalLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 200,
  });
  app.use(generalLimiter);

  // ── Routes ────────────────────────────────────────────────
  app.use('/api/auth', authLimiter, authRoutes);
  app.use('/api/workspaces', workspaceRoutes);
  app.use('/api/workspaces/:workspaceId/documents', documentRoutes);
  app.use('/api/admin', adminRoutes);

  // ── Health check (no auth) ────────────────────────────────
  app.get('/health', (_req, res) => res.json({ ok: true, ts: Date.now() }));

  // ── 404 handler ───────────────────────────────────────────
  app.use((_req, res) => {
    res.status(404).json({ ok: false, error: 'Not found' });
  });

  // ── Error handler ─────────────────────────────────────────
  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    logger.error('Unhandled error', { error: err.message, stack: err.stack });
    res.status(500).json({ ok: false, error: 'Internal server error' });
  });

  // ── HTTP + WebSocket servers ───────────────────────────────
  const httpServer = createServer(app);

  const wss = new WebSocketServer({
    server: httpServer,
    path: '/ws',
  });

  wss.on('connection', (ws, req) => {
    handleConnection(ws, req).catch((err) => {
      logger.error('Unhandled WS error', { error: err.message });
    });
  });

  wss.on('error', (err) => {
    logger.error('WebSocketServer error', { error: err.message });
  });

  httpServer.listen(PORT, () => {
    logger.info(`🚀 DSync server listening on port ${PORT}`);
    logger.info(`   REST:      http://localhost:${PORT}/api`);
    logger.info(`   WebSocket: ws://localhost:${PORT}/ws`);
    logger.info(`   Health:    http://localhost:${PORT}/health`);
  });
}

bootstrap().catch((err) => {
  logger.error('Bootstrap failed', { error: err.message });
  process.exit(1);
});
