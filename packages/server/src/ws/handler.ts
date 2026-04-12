/**
 * WebSocket message handler.
 * One instance is created per WS connection.
 *
 * Message flow:
 *   hello → subscribe → [mutation* | heartbeat* | unsubscribe]* → disconnect
 */

import type WebSocket from 'ws';
import type { IncomingMessage } from 'http';
import { v4 as uuidv4 } from 'uuid';

import {
  InboundMessageSchema,
  type OutboundMessage,
  type MutationAck,
  type RemoteUpdate,
  type PresenceUpdate,
  type SnapshotMessage,
} from '@dsync/shared';

import { verifyToken, type JwtPayload } from '../auth/jwt';
import { logger } from '../utils/logger';
import {
  registerSession,
  unregisterSession,
  broadcastToDocument,
  type WsSession,
} from './sessionRegistry';
import {
  setPresence,
  refreshPresence,
  removePresence,
  getPresence,
  publishToDocument,
  redisSub,
  documentChannel,
} from '../redis/client';
import { enqueueMutation } from '../sync/mutationQueue';
import {
  findDocumentById,
  findWorkspaceMember,
  createSession,
  updateSessionDocument,
  updateSessionLastSeen,
  disconnectSession,
  storeMutation,
  writeAuditLog,
  findMutationByCorrelationId,
} from '../db/queries';

function send(ws: WebSocket, msg: OutboundMessage): void {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

function sendError(ws: WebSocket, code: string, message: string, correlationId?: string): void {
  send(ws, { type: 'error', code, message, correlationId });
}

export async function handleConnection(ws: WebSocket, req: IncomingMessage): Promise<void> {
  const sessionId = uuidv4();
  const ip = req.socket.remoteAddress;
  let user: JwtPayload | null = null;
  let session: WsSession | null = null;
  let clientId: string = '';

  logger.info('WebSocket connection established', { sessionId, ip });

  ws.on('message', async (raw) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString());
    } catch {
      sendError(ws, 'PARSE_ERROR', 'Invalid JSON');
      return;
    }

    const result = InboundMessageSchema.safeParse(parsed);
    if (!result.success) {
      sendError(ws, 'INVALID_MESSAGE', 'Unknown or malformed message type');
      return;
    }

    const msg = result.data;

    // ── hello ──────────────────────────────────────────────────────────────
    if (msg.type === 'hello') {
      try {
        user = verifyToken(msg.token);
      } catch {
        sendError(ws, 'AUTH_FAILED', 'Invalid JWT token');
        ws.close(4001, 'Unauthorized');
        return;
      }

      clientId = msg.clientId;
      session = {
        ws,
        sessionId,
        user,
        subscribedDocumentIds: new Set(),
        lastHeartbeat: Date.now(),
      };
      registerSession(session);

      // Persist session record
      await createSession({ id: sessionId, userId: user.userId, ipAddress: ip });

      send(ws, {
        type: 'authenticated',
        userId: user.userId,
        displayName: user.displayName,
      });

      logger.info('Client authenticated', { sessionId, userId: user.userId });
      return;
    }

    // All subsequent messages require authentication
    if (!user || !session) {
      sendError(ws, 'NOT_AUTHENTICATED', 'Send hello message first');
      return;
    }

    // ── heartbeat ──────────────────────────────────────────────────────────
    if (msg.type === 'heartbeat') {
      session.lastHeartbeat = Date.now();
      await updateSessionLastSeen(sessionId);

      // Refresh presence for all subscribed documents
      for (const docId of session.subscribedDocumentIds) {
        await refreshPresence(docId, user.userId);
      }

      send(ws, { type: 'heartbeat_ack', ts: msg.ts, serverTs: Date.now() });
      return;
    }

    // ── subscribe ──────────────────────────────────────────────────────────
    if (msg.type === 'subscribe') {
      const { documentId } = msg;

      // Fetch doc and verify membership
      const doc = await findDocumentById(documentId);
      if (!doc) {
        sendError(ws, 'NOT_FOUND', `Document not found: ${documentId}`);
        return;
      }

      const member = await findWorkspaceMember(doc.workspaceId, user.userId);
      if (!member) {
        sendError(ws, 'FORBIDDEN', 'You do not have access to this document');
        return;
      }

      session.subscribedDocumentIds.add(documentId);
      await updateSessionDocument(sessionId, documentId);
      await setPresence(documentId, user.userId, user.displayName);

      // Subscribe to Redis pub/sub for cross-instance broadcasts
      await redisSub.subscribe(documentChannel(documentId));

      // Send current snapshot
      const snapshot: SnapshotMessage = {
        type: 'snapshot',
        documentId: doc.id,
        content: doc.content,
        revision: doc.revision,
        requestedBy: user.userId,
      };
      send(ws, snapshot);

      // Broadcast updated presence to all subscribers
      await broadcastPresence(documentId);

      logger.info('Client subscribed to document', { sessionId, documentId, userId: user.userId });
      return;
    }

    // ── unsubscribe ────────────────────────────────────────────────────────
    if (msg.type === 'unsubscribe') {
      const { documentId } = msg;
      session.subscribedDocumentIds.delete(documentId);
      await removePresence(documentId, user.userId);
      await broadcastPresence(documentId);
      return;
    }

    // ── typing ─────────────────────────────────────────────────────────────
    if (msg.type === 'typing') {
      const { documentId, context } = msg;
      const update: import('@dsync/shared').TypingUpdate = {
        type: 'typing_update',
        documentId,
        userId: user.userId,
        displayName: user.displayName,
        context,
      };
      
      // Broadcast to local sessions
      broadcastToDocument(documentId, update, sessionId);
      // Broadcast via Redis
      await publishToDocument(documentId, { ...update, _sourceSessionId: sessionId });
      return;
    }

    // ── mutation ───────────────────────────────────────────────────────────
    if (msg.type === 'mutation') {
      const { correlationId, documentId, baseRevision, patch } = msg;

      // Verify access and write permission
      const doc = await findDocumentById(documentId);
      if (!doc) {
        sendError(ws, 'NOT_FOUND', `Document not found: ${documentId}`, correlationId);
        return;
      }

      const member = await findWorkspaceMember(doc.workspaceId, user.userId);
      if (!member || member.role === 'viewer') {
        sendError(ws, 'FORBIDDEN', 'You do not have write access', correlationId);
        return;
      }

      try {
        // Enqueue into deterministic mutation queue
        const result = await enqueueMutation({
          correlationId,
          documentId,
          userId: user.userId,
          clientId: msg.clientId || clientId,
          baseRevision,
          patch,
          receivedAt: Date.now(),
        });

        // Idempotent duplicate — re-ack existing
        if (!result) {
          const existing = await findMutationByCorrelationId(correlationId);
          if (existing) {
            const ack: MutationAck = {
              type: 'mutation_ack',
              correlationId,
              documentId,
              revision: existing.revision,
              appliedPatch: existing.patch,
              conflictMeta: existing.conflictMeta,
            };
            send(ws, ack);
          }
          return;
        }

        // Ack to sender
        const ack: MutationAck = {
          type: 'mutation_ack',
          correlationId,
          documentId,
          revision: result.newRevision,
          appliedPatch: result.appliedPatch,
          conflictMeta: result.conflictMeta,
        };
        send(ws, ack);

        // Build remote_update for other subscribers
        const remoteUpdate: RemoteUpdate = {
          type: 'remote_update',
          documentId,
          revision: result.newRevision,
          patch: result.appliedPatch,
          userId: user.userId,
          displayName: user.displayName,
          correlationId,
          conflictMeta: result.conflictMeta,
        };

        // Broadcast locally to sessions on this instance
        broadcastToDocument(documentId, remoteUpdate, sessionId);

        // Broadcast via Redis for other server instances
        await publishToDocument(documentId, { ...remoteUpdate, _sourceSessionId: sessionId });

        // Log audit
        await writeAuditLog({
          userId: user.userId,
          workspaceId: doc.workspaceId,
          action: 'mutation_applied',
          meta: { documentId, revision: result.newRevision, correlationId, hadConflict: !!result.conflictMeta },
        });

        logger.info('Mutation applied', {
          userId: user.userId,
          documentId,
          revision: result.newRevision,
          hadConflict: !!result.conflictMeta,
        });
      } catch (err) {
        logger.error('Mutation failed', { error: (err as Error).message, correlationId });
        sendError(ws, 'MUTATION_FAILED', (err as Error).message, correlationId);
      }
    }
  });

  ws.on('close', async () => {
    if (session && user) {
      for (const docId of session.subscribedDocumentIds) {
        await removePresence(docId, user.userId);
        await broadcastPresence(docId);
        await redisSub.unsubscribe(documentChannel(docId)).catch(() => null);
      }
      unregisterSession(sessionId);
    }
    await disconnectSession(sessionId).catch(() => null);
    logger.info('WebSocket disconnected', { sessionId });
  });

  ws.on('error', (err) => {
    logger.error('WebSocket error', { sessionId, error: err.message });
  });
}

async function broadcastPresence(documentId: string): Promise<void> {
  const presenceData = await getPresence(documentId);
  const now = Date.now();
  const update: PresenceUpdate = {
    type: 'presence_update',
    documentId,
    presence: presenceData.map((p) => ({
      userId: p.userId,
      displayName: p.displayName,
      documentId,
      lastSeen: new Date(p.ts).toISOString(),
      isActive: now - p.ts < 35_000,
    })),
  };
  broadcastToDocument(documentId, update);
}

// ─────────────────────────────────────────────
// Redis pub/sub relay for cross-instance
// ─────────────────────────────────────────────
redisSub.on('message', (channel: string, payload: string) => {
  try {
    const msg = JSON.parse(payload) as (import('@dsync/shared').RemoteUpdate | import('@dsync/shared').TypingUpdate) & { _sourceSessionId?: string };
    const { _sourceSessionId, ...update } = msg;

    if (update.type === 'remote_update' || update.type === 'typing_update') {
      broadcastToDocument(update.documentId, update, _sourceSessionId);
    }
  } catch (err) {
    logger.error('Redis message parse error', { error: (err as Error).message });
  }
});
