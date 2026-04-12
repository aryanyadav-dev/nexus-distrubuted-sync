/**
 * Snapshot Restore Algorithm — Binary Search + Forward Replay
 *
 * This module implements an efficient algorithm to reconstruct the
 * document state at any historical revision.
 *
 * ─── Algorithm: Binary Search Snapshot Restore ───
 *
 * Problem: Given a target revision R, reconstruct the document content
 * as it existed at revision R, without storing a full snapshot at
 * every revision.
 *
 * Solution:
 *   1. Find the nearest snapshot at revision ≤ R (SQL index lookup)
 *   2. If snapshot.revision == R → return snapshot content directly
 *   3. Otherwise, fetch all mutations in range (snapshot.revision, R]
 *   4. Apply mutations sequentially onto the snapshot content
 *   5. Return the reconstructed content
 *
 * Complexity:
 *   - Snapshot lookup: O(1) via SQL index on (document_id, revision)
 *   - Mutation replay: O(k) where k = R - snapshot.revision
 *   - With snapshots every N mutations, k ≤ N, so worst case is O(N)
 *   - Without snapshots, falls back to replaying from revision 0
 *
 * This is significantly faster than replaying from revision 0 when
 * the document has many revisions. For a document with 10,000 revisions
 * and snapshots every 10 mutations, at most 10 mutations need replay.
 *
 * ─── Pure function for testing ───
 *
 * The `replayMutations` function is a pure function that applies a
 * sequence of mutation patches onto a base content object. This can
 * be unit-tested without any database dependency.
 */

import type { Mutation } from '@dsync/shared';
import {
  findNearestSnapshotAtOrBelow,
  findMutationsInRange,
  findDocumentById,
  getSnapshotRevisions,
} from '../db/queries';
import { logger } from '../utils/logger';

export interface RestoredState {
  content: Record<string, unknown>;
  revision: number;
  snapshotRevision: number;  // the snapshot we started from
  mutationsReplayed: number;  // how many mutations were replayed
}

/**
 * Reconstruct document state at a specific revision using
 * binary search snapshot lookup + forward mutation replay.
 */
export async function restoreAtRevision(
  documentId: string,
  targetRevision: number
): Promise<RestoredState | null> {
  // 1. Find nearest snapshot at or below target revision
  const snapshot = await findNearestSnapshotAtOrBelow(documentId, targetRevision);

  let baseContent: Record<string, unknown>;
  let baseRevision: number;

  if (snapshot) {
    // Best case: exact match
    if (snapshot.revision === targetRevision) {
      return {
        content: snapshot.content,
        revision: targetRevision,
        snapshotRevision: targetRevision,
        mutationsReplayed: 0,
      };
    }
    baseContent = snapshot.content;
    baseRevision = snapshot.revision;
  } else {
    // No snapshot exists — fall back to document creation state
    const doc = await findDocumentById(documentId);
    if (!doc) return null;
    baseContent = {};
    baseRevision = 0;
  }

  // 2. Fetch mutations in range (baseRevision, targetRevision]
  const mutations = await findMutationsInRange(documentId, baseRevision, targetRevision);

  // 3. Replay mutations sequentially
  const content = replayMutations(baseContent, mutations);

  logger.debug('Snapshot restore complete', {
    documentId,
    targetRevision,
    snapshotRevision: baseRevision,
    mutationsReplayed: mutations.length,
  });

  return {
    content,
    revision: targetRevision,
    snapshotRevision: baseRevision,
    mutationsReplayed: mutations.length,
  };
}

/**
 * Pure function: replay a sequence of mutations onto a base content.
 *
 * Each mutation's patch is merged field-by-field (shallow merge).
 * This is the same merge strategy used by the mutation engine.
 *
 * This function is deterministic: given the same base content and
 * mutation sequence, it always produces the same result.
 */
export function replayMutations(
  baseContent: Record<string, unknown>,
  mutations: Mutation[]
): Record<string, unknown> {
  let content = { ...baseContent };
  for (const mutation of mutations) {
    const patch = mutation.patch as Record<string, unknown>;
    content = { ...content, ...patch };
  }
  return content;
}

/**
 * Binary search over snapshot revisions array to find the index of
 * the nearest revision at or below the target.
 *
 * This is a pure function for testing the binary search logic
 * independently of the database. The actual DB query uses SQL
 * indexing for O(1) lookup, but this function demonstrates the
 * algorithm and is used in unit tests.
 *
 * Returns the index into `revisions`, or -1 if no suitable snapshot.
 */
export function binarySearchSnapshot(
  revisions: number[],
  targetRevision: number
): number {
  if (revisions.length === 0) return -1;

  let lo = 0;
  let hi = revisions.length - 1;
  let result = -1;

  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if (revisions[mid] <= targetRevision) {
      result = mid;
      lo = mid + 1; // look right for a closer match
    } else {
      hi = mid - 1;
    }
  }

  return result;
}

/**
 * Get the number of mutations that would need to be replayed
 * to reach a target revision from the nearest snapshot.
 * Useful for estimating restore cost.
 */
export async function estimateReplayCost(
  documentId: string,
  targetRevision: number
): Promise<{ snapshotRevision: number; mutationsToReplay: number } | null> {
  const snapshot = await findNearestSnapshotAtOrBelow(documentId, targetRevision);
  if (!snapshot) {
    return { snapshotRevision: 0, mutationsToReplay: targetRevision };
  }
  return {
    snapshotRevision: snapshot.revision,
    mutationsToReplay: targetRevision - snapshot.revision,
  };
}
