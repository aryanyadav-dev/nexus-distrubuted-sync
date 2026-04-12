/**
 * DSync Client SDK
 *
 * Responsibilities:
 * - Manages WebSocket connection lifecycle
 * - Sends hello/heartbeat/subscribe/mutation messages
 * - Buffers mutations while offline and replays on reconnect
 * - Emits typed events for callers to react to
 * - Handles exponential backoff for reconnection
 */

import { v4 as uuidv4 } from 'uuid';
import type {
  InboundMessage,
  OutboundMessage,
  MutationMessage,
  SnapshotMessage,
  MutationAck,
  RemoteUpdate,
  PresenceUpdate,
  ConflictMessage,
  ErrorMessage,
  HeartbeatAck,
  Authenticated,
} from '@dsync/shared';

// ─────────────────────────────────────────────
// Event types
// ─────────────────────────────────────────────

export type SyncEvent =
  | { type: 'connected' }
  | { type: 'authenticated'; userId: string; displayName: string }
  | { type: 'disconnected'; reason?: string }
  | { type: 'reconnecting'; attempt: number; delayMs: number }
  | { type: 'snapshot'; message: SnapshotMessage }
  | { type: 'mutation_ack'; message: MutationAck }
  | { type: 'remote_update'; message: RemoteUpdate }
  | { type: 'presence_update'; message: PresenceUpdate }
  | { type: 'conflict'; message: ConflictMessage }
  | { type: 'error'; message: ErrorMessage }
  | { type: 'heartbeat_ack'; message: HeartbeatAck }
  | { type: 'offline' }
  | { type: 'online' };

export type SyncEventHandler = (event: SyncEvent) => void;

// Pending mutation buffered during offline
interface PendingMutation {
  correlationId: string;
  documentId: string;
  baseRevision: number;
  patch: Record<string, unknown>;
  attempts: number;
}

// ─────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────

export interface SyncClientConfig {
  url: string;          // WebSocket URL e.g. ws://localhost:4000/ws
  token: string;        // JWT from auth
  clientId?: string;
  heartbeatIntervalMs?: number;   // default: 15000
  reconnectBaseDelayMs?: number;  // default: 1000
  maxReconnectDelayMs?: number;   // default: 30000
  maxReconnectAttempts?: number;  // default: Infinity
}

// ─────────────────────────────────────────────
// SyncClient
// ─────────────────────────────────────────────

export class SyncClient {
  private config: Required<SyncClientConfig>;
  private ws: WebSocket | null = null;
  private handlers: SyncEventHandler[] = [];
  private pendingMutations: PendingMutation[] = [];
  private subscribedDocuments = new Set<string>();
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private isAuthenticated = false;
  private isManuallyClosed = false;
  private isSimulatingOffline = false;

  // Track current revision per document for optimistic updates
  private documentRevisions = new Map<string, number>();

  constructor(config: SyncClientConfig) {
    this.config = {
      clientId: uuidv4(),
      heartbeatIntervalMs: 15_000,
      reconnectBaseDelayMs: 1_000,
      maxReconnectDelayMs: 30_000,
      maxReconnectAttempts: Infinity,
      ...config,
    };
  }

  // ── Public API ──────────────────────────────────────────────

  /** Connect to the sync server */
  connect(): void {
    this.isManuallyClosed = false;
    this.openSocket();
  }

  /** Gracefully disconnect */
  disconnect(): void {
    this.isManuallyClosed = true;
    this.clearTimers();
    this.ws?.close(1000, 'Client disconnect');
    this.ws = null;
    this.isAuthenticated = false;
  }

  /** Subscribe to a document channel */
  subscribe(documentId: string): void {
    this.subscribedDocuments.add(documentId);
    if (this.isAuthenticated) {
      this.rawSend({ type: 'subscribe', documentId });
    }
    // If not yet connected, subscriptions will be replayed after auth
  }

  /** Unsubscribe from a document channel */
  unsubscribe(documentId: string): void {
    this.subscribedDocuments.delete(documentId);
    this.documentRevisions.delete(documentId);
    if (this.isAuthenticated) {
      this.rawSend({ type: 'unsubscribe', documentId });
    }
  }

  /**
   * Send a mutation. Returns its correlationId.
   * If offline, buffers it for replay after reconnect.
   */
  mutate(
    documentId: string,
    patch: Record<string, unknown>
  ): string {
    const correlationId = uuidv4();
    const baseRevision = this.documentRevisions.get(documentId) ?? 0;

    const msg: MutationMessage = {
      type: 'mutation',
      correlationId,
      documentId,
      baseRevision,
      patch,
    };

    if (this.isAuthenticated && !this.isSimulatingOffline) {
      this.rawSend(msg);
      // Optimistically bump local revision
      this.documentRevisions.set(documentId, baseRevision + 1);
    } else {
      // Buffer for replay
      this.pendingMutations.push({ correlationId, documentId, baseRevision, patch, attempts: 0 });
      this.emit({ type: 'offline' });
    }

    return correlationId;
  }

  /** Get current known revision for a document */
  getRevision(documentId: string): number {
    return this.documentRevisions.get(documentId) ?? 0;
  }

  /** Register an event handler */
  on(handler: SyncEventHandler): () => void {
    this.handlers.push(handler);
    return () => {
      this.handlers = this.handlers.filter((h) => h !== handler);
    };
  }

  /**
   * Simulate going offline (drops WS, buffers mutations).
   * For demo/testing purposes.
   */
  simulateOffline(): void {
    this.isSimulatingOffline = true;
    this.ws?.close(4000, 'Simulated offline');
    this.emit({ type: 'offline' });
  }

  /** Resume from simulated offline */
  simulateOnline(): void {
    this.isSimulatingOffline = false;
    this.emit({ type: 'online' });
    this.openSocket();
  }

  // ── Internal ────────────────────────────────────────────────

  private openSocket(): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return;

    const ws = new WebSocket(this.config.url);
    this.ws = ws;

    ws.onopen = () => {
      this.reconnectAttempts = 0;
      this.emit({ type: 'connected' });
      // Authenticate immediately
      this.rawSend({
        type: 'hello',
        token: this.config.token,
        clientId: this.config.clientId,
      });
    };

    ws.onmessage = (ev) => {
      let data: OutboundMessage;
      try {
        data = JSON.parse(ev.data as string) as OutboundMessage;
      } catch {
        return;
      }
      this.handleServerMessage(data);
    };

    ws.onclose = (ev) => {
      this.isAuthenticated = false;
      this.clearTimers();
      this.emit({ type: 'disconnected', reason: ev.reason });

      if (!this.isManuallyClosed && !this.isSimulatingOffline) {
        this.scheduleReconnect();
      }
    };

    ws.onerror = () => {
      // onclose will follow
    };
  }

  private handleServerMessage(msg: OutboundMessage): void {
    switch (msg.type) {
      case 'authenticated': {
        this.isAuthenticated = true;
        this.emit({ type: 'authenticated', userId: msg.userId, displayName: msg.displayName });
        this.startHeartbeat();
        // Replay subscriptions
        for (const docId of this.subscribedDocuments) {
          this.rawSend({ type: 'subscribe', documentId: docId });
        }
        break;
      }

      case 'snapshot': {
        this.documentRevisions.set(msg.documentId, msg.revision);
        this.emit({ type: 'snapshot', message: msg });
        // Replay pending mutations for this document
        this.replayPending(msg.documentId, msg.revision);
        break;
      }

      case 'mutation_ack': {
        this.documentRevisions.set(msg.documentId, msg.revision);
        // Remove from pending buffer
        this.pendingMutations = this.pendingMutations.filter(
          (m) => m.correlationId !== msg.correlationId
        );
        this.emit({ type: 'mutation_ack', message: msg });
        break;
      }

      case 'remote_update': {
        this.documentRevisions.set(msg.documentId, msg.revision);
        this.emit({ type: 'remote_update', message: msg });
        break;
      }

      case 'presence_update': {
        this.emit({ type: 'presence_update', message: msg });
        break;
      }

      case 'heartbeat_ack': {
        this.emit({ type: 'heartbeat_ack', message: msg });
        break;
      }

      case 'conflict': {
        this.emit({ type: 'conflict', message: msg });
        break;
      }

      case 'error': {
        this.emit({ type: 'error', message: msg });
        break;
      }
    }
  }

  /**
   * After receiving a snapshot (on reconnect), replay any buffered mutations
   * that weren't ack'd yet, updating their baseRevision to current server state.
   */
  private replayPending(documentId: string, currentRevision: number): void {
    const toReplay = this.pendingMutations.filter((m) => m.documentId === documentId);
    if (!toReplay.length) return;

    let revision = currentRevision;
    for (const pending of toReplay) {
      pending.baseRevision = revision;
      const msg: MutationMessage = {
        type: 'mutation',
        correlationId: pending.correlationId,
        documentId: pending.documentId,
        baseRevision: pending.baseRevision,
        patch: pending.patch,
      };
      this.rawSend(msg);
      revision++;
    }
  }

  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.rawSend({ type: 'heartbeat', ts: Date.now() });
      }
    }, this.config.heartbeatIntervalMs);
  }

  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= this.config.maxReconnectAttempts) return;

    const delay = Math.min(
      this.config.reconnectBaseDelayMs * Math.pow(2, this.reconnectAttempts),
      this.config.maxReconnectDelayMs
    );
    this.reconnectAttempts++;

    this.emit({ type: 'reconnecting', attempt: this.reconnectAttempts, delayMs: delay });

    this.reconnectTimer = setTimeout(() => {
      this.openSocket();
    }, delay);
  }

  private clearTimers(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.heartbeatTimer = null;
    this.reconnectTimer = null;
  }

  private rawSend(msg: InboundMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  private emit(event: SyncEvent): void {
    for (const handler of this.handlers) {
      try {
        handler(event);
      } catch (err) {
        console.error('[SyncClient] Handler error:', err);
      }
    }
  }
}
