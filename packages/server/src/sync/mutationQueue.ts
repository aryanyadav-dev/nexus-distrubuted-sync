/**
 * Deterministic Mutation Reconciliation Queue
 *
 * This module implements the core synchronization algorithm that ensures
 * all server instances and clients converge to the same document state
 * regardless of message arrival order.
 *
 * ─── Algorithm: Deterministic Mutation Reconciliation ───
 *
 * When multiple clients edit concurrently or a reconnecting client
 * replays buffered mutations, the server must apply them in a
 * deterministic total order. This queue provides that guarantee.
 *
 * Ordering rule (applied when flushing the queue):
 *   1. baseRevision ASC  — mutations rooted on earlier state go first
 *   2. receivedAt ASC     — earlier server arrivals go first
 *   3. userId ASC         — stable lexicographic tie-break by author
 *   4. correlationId ASC  — final deterministic tie-break
 *
 * This ordering ensures:
 *   - Offline replay: a client that reconnects with mutations based on
 *     revision N will have them applied before mutations based on N+1,
 *     preserving causal intent.
 *   - Concurrent edits: two mutations arriving "simultaneously" are
 *     always resolved in the same order on every server instance.
 *   - Idempotency: duplicate correlationIds are rejected before enqueue.
 *
 * Queue lifecycle per document:
 *   - enqueue() adds a mutation to the per-document buffer
 *   - flush() sorts the buffer by the deterministic rule, then applies
 *     each mutation sequentially through the mutation engine
 *   - Results are delivered to callers via Promise resolution
 *
 * The queue is flushed immediately after each enqueue, but if a flush
 * is already in progress for that document, new mutations wait for
 * the next flush cycle (preventing concurrent application).
 */

import type { QueuedMutation } from '@dsync/shared';
import { applyMutation, type ApplyMutationResult } from './mutationEngine';
import { findMutationByCorrelationId } from '../db/queries';
import { logger } from '../utils/logger';

// ─────────────────────────────────────────────
// Per-document queue state
// ─────────────────────────────────────────────

interface QueueEntry {
  mutation: QueuedMutation;
  resolve: (result: ApplyMutationResult | null) => void;
  reject: (error: Error) => void;
}

interface DocumentQueue {
  entries: QueueEntry[];
  flushing: boolean;
}

const queues = new Map<string, DocumentQueue>();

function getQueue(documentId: string): DocumentQueue {
  let q = queues.get(documentId);
  if (!q) {
    q = { entries: [], flushing: false };
    queues.set(documentId, q);
  }
  return q;
}

// ─────────────────────────────────────────────
// Deterministic comparator
// ─────────────────────────────────────────────

/**
 * Compare two queued mutations to establish a deterministic total order.
 *
 * Priority:
 *   1. baseRevision ascending  (earlier base → applied first)
 *   2. receivedAt ascending    (earlier arrival → applied first)
 *   3. userId ascending        (lexicographic tie-break)
 *   4. correlationId ascending (final tie-break, always unique)
 */
export function compareMutations(a: QueuedMutation, b: QueuedMutation): number {
  // 1. baseRevision ascending
  if (a.baseRevision !== b.baseRevision) return a.baseRevision - b.baseRevision;
  // 2. receivedAt ascending
  if (a.receivedAt !== b.receivedAt) return a.receivedAt - b.receivedAt;
  // 3. userId lexicographic ascending
  if (a.userId < b.userId) return -1;
  if (a.userId > b.userId) return 1;
  // 4. correlationId lexicographic ascending (guaranteed unique)
  if (a.correlationId < b.correlationId) return -1;
  if (a.correlationId > b.correlationId) return 1;
  return 0;
}

// ─────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────

/**
 * Enqueue a mutation for deterministic processing.
 *
 * Returns a Promise that resolves with the ApplyMutationResult once
 * the mutation has been processed through the queue.
 *
 * Idempotency: if the correlationId was already applied (exists in DB),
 * the promise resolves immediately with a sentinel indicating it was
 * a duplicate — the caller should re-ack the existing result.
 */
export async function enqueueMutation(
  mutation: QueuedMutation
): Promise<ApplyMutationResult | null> {
  // Idempotency check: already applied?
  const existing = await findMutationByCorrelationId(mutation.correlationId);
  if (existing) {
    logger.debug('Idempotent mutation skipped', { correlationId: mutation.correlationId });
    // Return null signals "already applied" — caller should re-ack from existing
    return null;
  }

  const queue = getQueue(mutation.documentId);

  return new Promise<ApplyMutationResult | null>((resolve, reject) => {
    queue.entries.push({ mutation, resolve, reject });
    logger.debug('Mutation enqueued', {
      documentId: mutation.documentId,
      correlationId: mutation.correlationId,
      queueSize: queue.entries.length,
      baseRevision: mutation.baseRevision,
    });

    // Trigger flush if not already running
    if (!queue.flushing) {
      flushQueue(mutation.documentId).catch((err) => {
        logger.error('Queue flush error', { documentId: mutation.documentId, error: err.message });
      });
    }
  });
}

/**
 * Flush the queue for a given document: sort deterministically, then
 * apply each mutation sequentially through the mutation engine.
 */
async function flushQueue(documentId: string): Promise<void> {
  const queue = getQueue(documentId);
  if (queue.flushing) return;
  queue.flushing = true;

  try {
    // Drain loop: keep flushing while entries arrive
    while (queue.entries.length > 0) {
      // Sort by deterministic rule
      queue.entries.sort((a, b) => compareMutations(a.mutation, b.mutation));

      // Take the first entry (highest priority by our ordering)
      const entry = queue.entries.shift()!;

      try {
        // Check idempotency again (may have been applied by a concurrent flush)
        const existing = await findMutationByCorrelationId(entry.mutation.correlationId);
        if (existing) {
          entry.resolve(null); // signal "already applied"
          continue;
        }

        const result = await applyMutation({
          documentId: entry.mutation.documentId,
          userId: entry.mutation.userId,
          clientId: entry.mutation.clientId,
          baseRevision: entry.mutation.baseRevision,
          patch: entry.mutation.patch,
          correlationId: entry.mutation.correlationId,
        });

        entry.resolve(result);
      } catch (err) {
        entry.reject(err as Error);
      }
    }
  } finally {
    queue.flushing = false;
  }
}

/**
 * Get current queue size for a document (for monitoring/debugging).
 */
export function getQueueSize(documentId: string): number {
  return queues.get(documentId)?.entries.length ?? 0;
}

/**
 * Check if a document queue is currently being flushed.
 */
export function isFlushing(documentId: string): boolean {
  return queues.get(documentId)?.flushing ?? false;
}

/**
 * Clear all queues (for testing / shutdown).
 */
export function clearQueues(): void {
  queues.clear();
}
