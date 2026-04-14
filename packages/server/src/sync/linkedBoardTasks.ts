import type { RemoteUpdate } from '@dsync/shared';
import { applyPatchToDocument, findDocumentsByWorkspace, storeMutation } from '../db/queries';
import { broadcastToDocument } from '../ws/sessionRegistry';
import { publishToDocument } from '../redis/client';

interface LinkedDocTask {
  id: string;
  boardId?: string;
  boardItemId?: string;
  [key: string]: unknown;
}

function getResolvedBoardItemIds(patch: Record<string, unknown>): string[] {
  const itemsPatch = patch.items;
  if (!itemsPatch || typeof itemsPatch !== 'object') return [];

  return Object.entries(itemsPatch as Record<string, unknown>).flatMap(([itemId, itemValue]) => {
    if (itemValue === null) return [itemId];
    if (typeof itemValue === 'object' && itemValue !== null && (itemValue as Record<string, unknown>).completed === true) {
      return [itemId];
    }
    return [];
  });
}

export async function syncResolvedBoardTasks(params: {
  workspaceId: string;
  boardId: string;
  patch: Record<string, unknown>;
  userId: string;
  displayName: string;
}): Promise<void> {
  const resolvedBoardItemIds = getResolvedBoardItemIds(params.patch);
  if (resolvedBoardItemIds.length === 0) return;

  const documents = await findDocumentsByWorkspace(params.workspaceId);
  const docsWithTasks = documents.filter((doc) => {
    const tasks = doc.content.tasks;
    return tasks && typeof tasks === 'object' && doc.id !== params.boardId;
  });

  for (const doc of docsWithTasks) {
    const currentTasks = (doc.content.tasks as Record<string, LinkedDocTask>) || {};
    const nextTasks = Object.fromEntries(
      Object.entries(currentTasks).filter(([, task]) => {
        if (!task || typeof task !== 'object') return true;
        return !(task.boardId === params.boardId && task.boardItemId && resolvedBoardItemIds.includes(task.boardItemId));
      })
    );

    if (Object.keys(nextTasks).length === Object.keys(currentTasks).length) continue;

    const updatedDoc = await applyPatchToDocument(doc.id, { tasks: nextTasks }, doc.revision);
    await storeMutation({
      documentId: updatedDoc.id,
      userId: params.userId,
      revision: updatedDoc.revision,
      baseRevision: doc.revision,
      patch: { tasks: nextTasks },
      conflictMeta: null,
      correlationId: crypto.randomUUID(),
    });

    const remoteUpdate: RemoteUpdate = {
      type: 'remote_update',
      documentId: updatedDoc.id,
      revision: updatedDoc.revision,
      patch: { tasks: nextTasks },
      userId: params.userId,
      displayName: params.displayName,
      correlationId: crypto.randomUUID(),
      conflictMeta: null,
    };

    broadcastToDocument(updatedDoc.id, remoteUpdate);
    await publishToDocument(updatedDoc.id, remoteUpdate);
  }
}
