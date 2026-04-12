/**
 * WebSocket session registry.
 * Tracks all active WS connections and provides broadcast utilities.
 */
import type WebSocket from 'ws';
import type { JwtPayload } from '../auth/jwt';

export interface WsSession {
  ws: WebSocket;
  sessionId: string;
  user: JwtPayload;
  subscribedDocumentIds: Set<string>;
  lastHeartbeat: number;
}

// In-memory registry of live sessions
const sessions = new Map<string, WsSession>();

export function registerSession(session: WsSession): void {
  sessions.set(session.sessionId, session);
}

export function unregisterSession(sessionId: string): void {
  sessions.delete(sessionId);
}

export function getSession(sessionId: string): WsSession | undefined {
  return sessions.get(sessionId);
}

export function getAllSessions(): WsSession[] {
  return Array.from(sessions.values());
}

/** Get all sessions subscribed to a given document */
export function getSessionsForDocument(documentId: string): WsSession[] {
  return Array.from(sessions.values()).filter((s) => s.subscribedDocumentIds.has(documentId));
}

/** Broadcast a message to all sessions subscribed to a document, except optionally one */
export function broadcastToDocument(
  documentId: string,
  message: unknown,
  excludeSessionId?: string
): void {
  const payload = JSON.stringify(message);
  for (const session of getSessionsForDocument(documentId)) {
    if (session.sessionId === excludeSessionId) continue;
    if (session.ws.readyState === 1 /* OPEN */) {
      session.ws.send(payload);
    }
  }
}

/** Send a message to a specific session */
export function sendToSession(sessionId: string, message: unknown): void {
  const session = sessions.get(sessionId);
  if (session && session.ws.readyState === 1) {
    session.ws.send(JSON.stringify(message));
  }
}

// Heartbeat watchdog — evict stale sessions
const HEARTBEAT_TIMEOUT_MS = 60_000;
setInterval(() => {
  const now = Date.now();
  for (const [id, session] of sessions.entries()) {
    if (now - session.lastHeartbeat > HEARTBEAT_TIMEOUT_MS) {
      session.ws.terminate();
      sessions.delete(id);
    }
  }
}, 30_000);
