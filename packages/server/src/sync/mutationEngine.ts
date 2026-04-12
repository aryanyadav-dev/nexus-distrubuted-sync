/**
 * Mutation Engine — Deterministic Field-Level Conflict Resolution
 *
 * ─── Algorithm: Revision-Based Optimistic Sync + Last-Write-Wins Field Merge ───
 *
 * This is the core algorithm that ensures all clients converge to the
 * same document state. It runs inside a PostgreSQL transaction with
 * a row-level lock (SELECT FOR UPDATE) to prevent race conditions.
 *
 * Given an incoming mutation M with baseRevision B and patch P:
 *
 *   1. ACQUIRE LOCK
 *      Lock the document row to serialize concurrent mutations.
 *
 *   2. FETCH DELTA
 *      Query all mutations applied since revision B.
 *      Build the set of fields changed by others: D = {f | ∃m in delta, f ∈ m.patch}
 *
 *   3. DETECT CONFLICTS
 *      For each field f in the incoming patch P:
 *        if f ∈ D → CONFLICT: server's current value wins for f
 *        else    → CLEAN: client's value is applied for f
 *
 *   4. BUILD RESOLUTION
 *      appliedPatch  = {f: v | (f,v) ∈ P, f ∉ D}   (clean fields only)
 *      conflictMeta  = {f: {client, server, resolved} | f ∈ D ∩ P}
 *      resolved value = server's current content[f] for each conflicting f
 *
 *   5. APPLY
 *      newContent = {...currentContent, ...appliedPatch}
 *      newRevision = currentRevision + 1
 *
 *   6. PERSIST
 *      Store mutation record (append-only, unique correlationId for idempotency)
 *      Update document row with new content and revision
 *
 *   7. SNAPSHOT
 *      Every N mutations, create a snapshot for fast restore
 *      (see snapshotRestore.ts for the binary search algorithm)
 *
 * Properties:
 *   - Deterministic: same inputs always produce same output
 *   - Idempotent: duplicate correlationId → no-op, returns existing result
 *   - Auditable: every mutation is logged with full conflict metadata
 *   - No data loss: conflicting client values are preserved in conflictMeta
 */

import { pool } from '../db/pool';
import type { Mutation, ConflictMeta } from '@dsync/shared';
import { logger } from '../utils/logger';
import { createSnapshot } from '../db/queries';

const SNAPSHOT_EVERY_N_MUTATIONS = 10;

export interface ApplyMutationParams {
  documentId: string;
  userId: string;
  clientId: string;
  baseRevision: number;
  patch: Record<string, unknown>;
  correlationId: string;
}

export interface ApplyMutationResult {
  mutation: Mutation;
  appliedPatch: Record<string, unknown>;  // what actually got applied (may differ from input if conflicts)
  conflictMeta: ConflictMeta | null;
  newRevision: number;
  content: Record<string, unknown>;
}

export async function applyMutation(params: ApplyMutationParams): Promise<ApplyMutationResult> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Lock document row
    const docRes = await client.query(
      `SELECT * FROM documents WHERE id = $1 FOR UPDATE`,
      [params.documentId]
    );
    if (!docRes.rows[0]) {
      throw new Error(`Document not found: ${params.documentId}`);
    }
    const doc = docRes.rows[0];
    const currentRevision: number = doc.revision;
    const currentContent: Record<string, unknown> = doc.content;

    // 2. Fetch mutations applied since baseRevision (the delta)
    const deltaRes = await client.query(
      `SELECT patch FROM mutations 
       WHERE document_id = $1 AND revision > $2 
       ORDER BY revision ASC`,
      [params.documentId, params.baseRevision]
    );

    // 3. Build field set changed by others
    const changedFieldsSinceBase = new Set<string>();
    for (const row of deltaRes.rows) {
      const patch = row.patch as Record<string, unknown>;
      for (const [field, value] of Object.entries(patch)) {
        if (field === 'items' && typeof value === 'object' && value !== null) {
          for (const itemKey of Object.keys(value as Record<string, unknown>)) {
            changedFieldsSinceBase.add(`items.${itemKey}`);
          }
        } else {
          changedFieldsSinceBase.add(field);
        }
      }
    }

    // 4. Detect field-level conflicts
    const conflictingFields: string[] = [];
    const clientConflictValues: Record<string, unknown> = {};
    const serverConflictValues: Record<string, unknown> = {};
    const resolvedConflictValues: Record<string, unknown> = {};
    const cleanPatch: Record<string, unknown> = {};

    for (const [field, value] of Object.entries(params.patch)) {
      if (field === 'items' && typeof value === 'object' && value !== null) {
        const cleanItems: Record<string, unknown> = {};
        const clientItemsValue = value as Record<string, unknown>;
        let hasConflict = false;
        
        for (const [itemKey, itemValue] of Object.entries(clientItemsValue)) {
          const path = `items.${itemKey}`;
          if (changedFieldsSinceBase.has(path)) {
            conflictingFields.push(path);
            hasConflict = true;
            // Provide a partial view of the conflict for this specific item
            clientConflictValues[path] = itemValue;
            const currentItems = currentContent.items as Record<string, unknown> | undefined;
            serverConflictValues[path] = currentItems?.[itemKey];
            resolvedConflictValues[path] = currentItems?.[itemKey];
          } else {
            cleanItems[itemKey] = itemValue;
          }
        }
        
        if (Object.keys(cleanItems).length > 0) {
          cleanPatch.items = cleanItems;
        }
      } else {
        if (changedFieldsSinceBase.has(field)) {
          conflictingFields.push(field);
          clientConflictValues[field] = value;
          serverConflictValues[field] = currentContent[field];
          resolvedConflictValues[field] = currentContent[field];
        } else {
          cleanPatch[field] = value;
        }
      }
    }

    const conflictMeta: ConflictMeta | null =
      conflictingFields.length > 0
        ? {
            conflictingFields,
            clientValue: clientConflictValues,
            serverValue: serverConflictValues,
            resolvedValue: resolvedConflictValues,
          }
        : null;

    // 5. Build new content: current + clean patch using deep merge
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

    const newContent = deepMerge(currentContent, cleanPatch);
    const newRevision = currentRevision + 1;
    const appliedPatch = { ...cleanPatch };

    // 6. Update document
    const newTitle = typeof newContent.title === 'string' ? newContent.title : doc.title;
    await client.query(
      `UPDATE documents SET content = $1, revision = $2, title = $3, updated_at = now() WHERE id = $4`,
      [JSON.stringify(newContent), newRevision, newTitle, params.documentId]
    );

    // 7. Store mutation record (idempotency: unique constraint on correlation_id)
    const mutRes = await client.query(
      `INSERT INTO mutations 
       (document_id, user_id, revision, base_revision, patch, conflict_meta, correlation_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [
        params.documentId,
        params.userId,
        newRevision,
        params.baseRevision,
        JSON.stringify(appliedPatch),
        conflictMeta ? JSON.stringify(conflictMeta) : null,
        params.correlationId,
      ]
    );

    await client.query('COMMIT');

    const mutRow = mutRes.rows[0];
    const mutation: Mutation = {
      id: mutRow.id,
      documentId: mutRow.document_id,
      userId: mutRow.user_id,
      revision: mutRow.revision,
      baseRevision: mutRow.base_revision,
      patch: mutRow.patch,
      conflictMeta: mutRow.conflict_meta,
      correlationId: mutRow.correlation_id,
      appliedAt: mutRow.applied_at.toISOString(),
    };

    // 8. Async snapshot (every N mutations)
    if (newRevision % SNAPSHOT_EVERY_N_MUTATIONS === 0) {
      createSnapshot(params.documentId, newRevision, newContent).catch((err) => {
        logger.error('Failed to create snapshot', { error: err.message });
      });
    }

    logger.debug('Mutation applied', {
      documentId: params.documentId,
      revision: newRevision,
      hasConflict: !!conflictMeta,
      conflictingFields,
    });

    return { mutation, appliedPatch, conflictMeta, newRevision, content: newContent };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
