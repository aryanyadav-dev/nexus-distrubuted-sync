/**
 * DemoSyncClient — Drop-in replacement for SyncClient in demo mode.
 *
 * Instead of opening a real WebSocket, it emits synthetic events
 * and persists mutations through demoUpdateDocument.
 */

import type { SyncEvent, SyncEventHandler, SyncClientConfig } from './SyncClient';
import {
  isDemoToken,
  getDemoUser,
  demoGetDocument,
  demoUpdateDocument,
} from './demoBackend';

export class DemoSyncClient {
  private token: string;
  private handlers: SyncEventHandler[] = [];
  private subscribedDocId: string | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private isConnected = false;
  private revisionMap = new Map<string, number>();

  constructor(config: Pick<SyncClientConfig, 'token' | 'url'>) {
    this.token = config.token;
  }

  // ── Public API (mirrors SyncClient) ──────────────────────────

  connect(): void {
    if (this.isConnected) return;
    this.isConnected = true;
    // Simulate async connection
    setTimeout(() => {
      this.emit({ type: 'connected' });
      const user = getDemoUser(this.token);
      if (user) {
        this.emit({
          type: 'authenticated',
          userId: user.id,
          displayName: user.displayName,
        });
      }

      // Start heartbeat (just ack loop for presence feel)
      this.heartbeatTimer = setInterval(() => {
        this.emit({
          type: 'heartbeat_ack',
          message: { type: 'heartbeat_ack' as const, ts: Date.now(), serverTs: Date.now() },
        });
      }, 15_000);

      // If already subscribed, send snapshot
      if (this.subscribedDocId) {
        this.sendSnapshot(this.subscribedDocId);
      }
    }, 80);
  }

  disconnect(): void {
    this.isConnected = false;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    this.emit({ type: 'disconnected', reason: 'Demo client disconnected' });
  }

  subscribe(documentId: string): void {
    this.subscribedDocId = documentId;
    if (this.isConnected) {
      this.sendSnapshot(documentId);
    }
  }

  unsubscribe(_documentId: string): void {
    this.subscribedDocId = null;
  }

  mutate(documentId: string, patch: Record<string, unknown>): string {
    const correlationId = crypto.randomUUID();
    const user = getDemoUser(this.token);

    // Derive workspaceId from the stored document
    // We need to try to find the doc across known workspaces
    const res = this.findAndUpdateDocument(documentId, patch);

    if (res) {
      this.revisionMap.set(documentId, res.revision);

      // Emit ack
      setTimeout(() => {
        this.emit({
          type: 'mutation_ack',
          message: {
            type: 'mutation_ack' as const,
            correlationId,
            documentId,
            revision: res.revision,
            appliedPatch: patch,
            conflictMeta: null,
          },
        });

        // Emit presence (self)
        if (user) {
          this.emit({
            type: 'presence_update',
            message: {
              type: 'presence_update' as const,
              documentId,
              presence: [
                {
                  userId: user.id,
                  displayName: user.displayName,
                  documentId,
                  lastSeen: new Date().toISOString(),
                  isActive: true,
                },
              ],
            },
          });
        }
      }, 20);
    }

    return correlationId;
  }

  sendTyping(_documentId: string, _context: string): void {
    // No-op in demo — no other real-time users
  }

  getRevision(documentId: string): number {
    return this.revisionMap.get(documentId) ?? 0;
  }

  on(handler: SyncEventHandler): () => void {
    this.handlers.push(handler);
    return () => {
      this.handlers = this.handlers.filter((h) => h !== handler);
    };
  }

  simulateOffline(): void {
    this.emit({ type: 'offline' });
  }

  simulateOnline(): void {
    this.emit({ type: 'online' });
    this.connect();
  }

  // ── Internal ─────────────────────────────────────────────────

  private sendSnapshot(documentId: string): void {
    // We need to find the workspace that this document belongs to
    const storeRaw = localStorage.getItem('dsync_demo_store');
    if (!storeRaw) return;
    const store = JSON.parse(storeRaw) as { documents: Record<string, { workspaceId: string }> };
    const docEntry = store.documents[documentId];
    if (!docEntry) return;

    const res = demoGetDocument(this.token, docEntry.workspaceId, documentId);
    if (!res.ok) return;

    this.revisionMap.set(documentId, res.data.revision);

    const user = getDemoUser(this.token);

    setTimeout(() => {
      this.emit({
        type: 'snapshot',
        message: {
          type: 'snapshot' as const,
          documentId,
          content: res.data.content,
          revision: res.data.revision,
        },
      });

      // Emit presence (self)
      if (user) {
        this.emit({
          type: 'presence_update',
          message: {
            type: 'presence_update' as const,
            documentId,
            presence: [
              {
                userId: user.id,
                displayName: user.displayName,
                documentId,
                lastSeen: new Date().toISOString(),
                isActive: true,
              },
            ],
          },
        });
      }
    }, 30);
  }

  private findAndUpdateDocument(docId: string, patch: Record<string, unknown>) {
    const storeRaw = localStorage.getItem('dsync_demo_store');
    if (!storeRaw) return null;
    const store = JSON.parse(storeRaw) as { documents: Record<string, { workspaceId: string }> };
    const docEntry = store.documents[docId];
    if (!docEntry) return null;

    const res = demoUpdateDocument(this.token, docEntry.workspaceId, docId, patch);
    if (!res.ok) return null;
    return res.data;
  }

  private emit(event: SyncEvent): void {
    for (const handler of this.handlers) {
      try {
        handler(event);
      } catch (err) {
        console.error('[DemoSyncClient] Handler error:', err);
      }
    }
  }
}

/**
 * Factory: returns a DemoSyncClient if the token is a demo token,
 * or null if it's a real token (caller should use the real SyncClient).
 */
export function createDemoSyncClientIfNeeded(
  config: Pick<SyncClientConfig, 'token' | 'url'>
): DemoSyncClient | null {
  if (isDemoToken(config.token)) {
    return new DemoSyncClient(config);
  }
  return null;
}
