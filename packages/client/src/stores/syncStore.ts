import { create } from 'zustand';
import type { Presence, ConflictMeta, ChecklistContent } from '@dsync/shared';

export type LogLevel = 'info' | 'success' | 'warning' | 'error' | 'conflict';

export interface SyncLogEntry {
  id: string;
  ts: number;
  level: LogLevel;
  message: string;
  meta?: Record<string, unknown>;
}

interface SyncState {
  // Connection
  connectionStatus: 'disconnected' | 'connecting' | 'connected' | 'authenticated' | 'offline';

  // Document state
  documentId: string | null;
  workspaceId: string | null;
  content: ChecklistContent | null;
  revision: number;

  // Presence & Typing
  presence: Presence[];
  typing: Record<string, { userId: string, displayName: string, ts: number }[]>;

  // Debug log
  logs: SyncLogEntry[];

  // Conflict history
  conflicts: Array<{ correlationId: string; meta: ConflictMeta; ts: number }>;

  // Actions
  setConnectionStatus: (s: SyncState['connectionStatus']) => void;
  setDocument: (docId: string, wsId: string, content: ChecklistContent, revision: number) => void;
  applyLocalPatch: (patch: Record<string, unknown>) => void;
  applyRemotePatch: (patch: Record<string, unknown>, revision: number) => void;
  setFullContent: (content: ChecklistContent, revision: number) => void;
  setPresence: (p: Presence[]) => void;
  setTyping: (userId: string, displayName: string, context: string) => void;
  clearStaleTyping: () => void;
  addConflict: (correlationId: string, meta: ConflictMeta) => void;
  addLog: (level: LogLevel, message: string, meta?: Record<string, unknown>) => void;
  clearLogs: () => void;
}

export const useSyncStore = create<SyncState>((set, get) => ({
  connectionStatus: 'disconnected',
  documentId: null,
  workspaceId: null,
  content: null,
  revision: 0,
  presence: [],
  typing: {},
  logs: [],
  conflicts: [],

  setConnectionStatus: (connectionStatus) => set({ connectionStatus }),

  setDocument: (documentId, workspaceId, content, revision) =>
    set({ documentId, workspaceId, content, revision }),

  applyLocalPatch: (patch) => {
    const { content } = get();
    if (!content) return;
    const updated = deepMerge(content, patch) as ChecklistContent;
    set({ content: updated });
  },

  applyRemotePatch: (patch, revision) => {
    const { content } = get();
    if (!content) return;
    const updated = deepMerge(content, patch) as ChecklistContent;
    set({ content: updated, revision });
  },

  setFullContent: (content, revision) => set({ content, revision }),

  setPresence: (presence) => set({ presence }),

  setTyping: (userId, displayName, context) =>
    set((state) => {
      const currentContextTyping = state.typing[context] || [];
      const others = currentContextTyping.filter((t) => t.userId !== userId);
      return {
        typing: {
          ...state.typing,
          [context]: [...others, { userId, displayName, ts: Date.now() }],
        },
      };
    }),

  clearStaleTyping: () =>
    set((state) => {
      const now = Date.now();
      let changed = false;
      const nextTyping: Record<string, { userId: string; displayName: string; ts: number }[]> = {};
      for (const [ctx, users] of Object.entries(state.typing)) {
        const active = users.filter((u) => now - u.ts < 3000); // 3-second timeout
        if (active.length !== users.length) changed = true;
        if (active.length > 0) nextTyping[ctx] = active;
      }
      return changed ? { typing: nextTyping } : state;
    }),

  addConflict: (correlationId, meta) =>
    set((s) => ({
      conflicts: [{ correlationId, meta, ts: Date.now() }, ...s.conflicts].slice(0, 50),
    })),

  addLog: (level, message, meta) =>
    set((s) => ({
      logs: [
        { id: crypto.randomUUID?.() || `${Date.now()}`, ts: Date.now(), level, message, meta },
        ...s.logs,
      ].slice(0, 200),
    })),

  clearLogs: () => set({ logs: [] }),
}));

/** Simple shallow merge + nested items merge for checklist */
function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
  const result = { ...target };
  for (const [key, value] of Object.entries(source)) {
    if (key === 'items' && typeof value === 'object' && !Array.isArray(value) && value !== null) {
      const itemsResult = { ...(result.items as Record<string, unknown> || {}) };
      for (const [itemKey, itemValue] of Object.entries(value)) {
        if (itemValue === null) {
          delete itemsResult[itemKey];
        } else {
          itemsResult[itemKey] = itemValue;
        }
      }
      result.items = itemsResult;
    } else {
      result[key] = value;
    }
  }
  return result;
}
