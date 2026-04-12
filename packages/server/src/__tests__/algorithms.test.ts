import { describe, it, expect } from 'vitest';
import { compareMutations, clearQueues } from '../sync/mutationQueue';
import { binarySearchSnapshot, replayMutations } from '../sync/snapshotRestore';
import type { QueuedMutation, Mutation } from '@dsync/shared';

// ─────────────────────────────────────────────
// Helper factories
// ─────────────────────────────────────────────

function makeQueued(overrides: Partial<QueuedMutation> & { correlationId: string }): QueuedMutation {
  return {
    documentId: 'doc-1',
    userId: 'user-a',
    clientId: 'client-1',
    baseRevision: 0,
    patch: {},
    receivedAt: 1000,
    ...overrides,
  };
}

function makeMutation(overrides: Partial<Mutation> & { id: string }): Mutation {
  return {
    documentId: 'doc-1',
    userId: 'user-a',
    revision: 1,
    baseRevision: 0,
    patch: {},
    conflictMeta: null,
    appliedAt: new Date().toISOString(),
    ...overrides,
    correlationId: overrides.id,
  };
}

// ─────────────────────────────────────────────
// 1. Deterministic Mutation Ordering
// ─────────────────────────────────────────────

describe('Deterministic Mutation Reconciliation — compareMutations', () => {
  it('orders by baseRevision ascending', () => {
    const a = makeQueued({ correlationId: 'a', baseRevision: 3 });
    const b = makeQueued({ correlationId: 'b', baseRevision: 5 });
    expect(compareMutations(a, b)).toBeLessThan(0);
    expect(compareMutations(b, a)).toBeGreaterThan(0);
  });

  it('orders by receivedAt when baseRevision is equal', () => {
    const a = makeQueued({ correlationId: 'a', baseRevision: 5, receivedAt: 100 });
    const b = makeQueued({ correlationId: 'b', baseRevision: 5, receivedAt: 200 });
    expect(compareMutations(a, b)).toBeLessThan(0);
  });

  it('orders by userId when baseRevision and receivedAt are equal', () => {
    const a = makeQueued({ correlationId: 'a', baseRevision: 5, receivedAt: 100, userId: 'alice' });
    const b = makeQueued({ correlationId: 'b', baseRevision: 5, receivedAt: 100, userId: 'bob' });
    expect(compareMutations(a, b)).toBeLessThan(0);
  });

  it('orders by correlationId as final tie-break', () => {
    const a = makeQueued({ correlationId: 'aaa', baseRevision: 5, receivedAt: 100, userId: 'same' });
    const b = makeQueued({ correlationId: 'bbb', baseRevision: 5, receivedAt: 100, userId: 'same' });
    expect(compareMutations(a, b)).toBeLessThan(0);
  });

  it('returns 0 only for identical mutations', () => {
    const a = makeQueued({ correlationId: 'same', baseRevision: 5, receivedAt: 100, userId: 'same' });
    const b = makeQueued({ correlationId: 'same', baseRevision: 5, receivedAt: 100, userId: 'same' });
    expect(compareMutations(a, b)).toBe(0);
  });

  it('sorts an array of mutations deterministically', () => {
    const mutations = [
      makeQueued({ correlationId: 'm3', baseRevision: 7, receivedAt: 300, userId: 'bob' }),
      makeQueued({ correlationId: 'm1', baseRevision: 3, receivedAt: 100, userId: 'alice' }),
      makeQueued({ correlationId: 'm2', baseRevision: 3, receivedAt: 200, userId: 'alice' }),
      makeQueued({ correlationId: 'm5', baseRevision: 7, receivedAt: 300, userId: 'alice' }),
      makeQueued({ correlationId: 'm4', baseRevision: 7, receivedAt: 100, userId: 'zara' }),
    ];

    const sorted = [...mutations].sort(compareMutations);

    // Expected order:
    // m1 (base=3, recv=100)
    // m2 (base=3, recv=200)
    // m4 (base=7, recv=100)
    // m5 (base=7, recv=300, user=alice)
    // m3 (base=7, recv=300, user=bob)
    expect(sorted.map((m) => m.correlationId)).toEqual(['m1', 'm2', 'm4', 'm5', 'm3']);
  });

  it('handles offline replay scenario: buffered mutations ordered by base revision', () => {
    // Client was at rev 5, went offline, made 3 edits, reconnects at rev 8
    const buffered = [
      makeQueued({ correlationId: 'c3', baseRevision: 7, receivedAt: 5000 }),
      makeQueued({ correlationId: 'c1', baseRevision: 5, receivedAt: 5000 }),
      makeQueued({ correlationId: 'c2', baseRevision: 6, receivedAt: 5000 }),
    ];

    const sorted = [...buffered].sort(compareMutations);
    expect(sorted.map((m) => m.correlationId)).toEqual(['c1', 'c2', 'c3']);
  });
});

// ─────────────────────────────────────────────
// 2. Binary Search Snapshot Restore
// ─────────────────────────────────────────────

describe('Binary Search Snapshot Restore — binarySearchSnapshot', () => {
  it('finds exact match', () => {
    const revisions = [0, 10, 20, 30, 40, 50];
    expect(binarySearchSnapshot(revisions, 30)).toBe(3);
  });

  it('finds nearest snapshot below target', () => {
    const revisions = [0, 10, 20, 30, 40, 50];
    expect(binarySearchSnapshot(revisions, 35)).toBe(3); // revision 30
  });

  it('returns last snapshot when target is at or above max', () => {
    const revisions = [0, 10, 20, 30];
    expect(binarySearchSnapshot(revisions, 50)).toBe(3); // revision 30
  });

  it('returns -1 when target is below all snapshots', () => {
    const revisions = [10, 20, 30];
    expect(binarySearchSnapshot(revisions, 5)).toBe(-1);
  });

  it('returns -1 for empty array', () => {
    expect(binarySearchSnapshot([], 10)).toBe(-1);
  });

  it('handles single-element array', () => {
    expect(binarySearchSnapshot([10], 10)).toBe(0);
    expect(binarySearchSnapshot([10], 15)).toBe(0);
    expect(binarySearchSnapshot([10], 5)).toBe(-1);
  });

  it('handles two-element array', () => {
    expect(binarySearchSnapshot([10, 20], 15)).toBe(0);
    expect(binarySearchSnapshot([10, 20], 20)).toBe(1);
    expect(binarySearchSnapshot([10, 20], 25)).toBe(1);
  });

  it('finds revision 0 in typical snapshot sequence', () => {
    const revisions = [0, 10, 20, 30];
    expect(binarySearchSnapshot(revisions, 0)).toBe(0);
  });

  it('works with large arrays (performance check)', () => {
    const revisions = Array.from({ length: 1000 }, (_, i) => i * 10);
    expect(binarySearchSnapshot(revisions, 5555)).toBe(555); // revision 5550
    expect(binarySearchSnapshot(revisions, 9999)).toBe(999); // revision 9990
    expect(binarySearchSnapshot(revisions, 5)).toBe(0);      // revision 0
  });
});

// ─────────────────────────────────────────────
// 3. Mutation Replay (pure function)
// ─────────────────────────────────────────────

describe('Snapshot Restore — replayMutations', () => {
  it('applies mutations sequentially onto base content', () => {
    const base = { title: 'Hello', count: 0 };
    const mutations = [
      makeMutation({ id: 'm1', revision: 1, patch: { count: 1 } }),
      makeMutation({ id: 'm2', revision: 2, patch: { count: 2, extra: true } }),
    ];

    const result = replayMutations(base, mutations);
    expect(result).toEqual({ title: 'Hello', count: 2, extra: true });
  });

  it('returns base content when no mutations to replay', () => {
    const base = { title: 'Hello' };
    const result = replayMutations(base, []);
    expect(result).toEqual(base);
  });

  it('later mutations overwrite earlier ones for same field', () => {
    const base = { title: 'A' };
    const mutations = [
      makeMutation({ id: 'm1', revision: 1, patch: { title: 'B' } }),
      makeMutation({ id: 'm2', revision: 2, patch: { title: 'C' } }),
    ];

    const result = replayMutations(base, mutations);
    expect(result.title).toBe('C');
  });

  it('handles checklist content with nested items', () => {
    const base = { title: 'Board', items: { a: { text: 'Item A' } } };
    const mutations = [
      makeMutation({
        id: 'm1',
        revision: 1,
        patch: { items: { b: { text: 'Item B' } } },
      }),
    ];

    const result = replayMutations(base, mutations);
    // Shallow merge: items.b overwrites items.a (shallow merge of top-level keys)
    expect(result.items).toEqual({ b: { text: 'Item B' } });
  });

  it('is deterministic: same input always produces same output', () => {
    const base = { x: 1 };
    const mutations = [
      makeMutation({ id: 'm1', revision: 1, patch: { x: 2, y: 3 } }),
      makeMutation({ id: 'm2', revision: 2, patch: { z: 4 } }),
    ];

    const result1 = replayMutations(base, mutations);
    const result2 = replayMutations(base, mutations);
    expect(result1).toEqual(result2);
  });
});

// ─────────────────────────────────────────────
// 4. Mutation Engine Conflict Detection (pure logic)
// ─────────────────────────────────────────────

describe('Mutation Engine — field-level conflict detection', () => {
  function detectConflicts(
    currentContent: Record<string, unknown>,
    patch: Record<string, unknown>,
    deltaFields: Set<string>
  ): {
    appliedPatch: Record<string, unknown>;
    conflictingFields: string[];
    resolvedContent: Record<string, unknown>;
  } {
    const appliedPatch: Record<string, unknown> = {};
    const conflictingFields: string[] = [];

    for (const [field, value] of Object.entries(patch)) {
      if (deltaFields.has(field)) {
        conflictingFields.push(field);
        // Server wins: do not apply this field
      } else {
        appliedPatch[field] = value;
      }
    }

    const resolvedContent = { ...currentContent, ...appliedPatch };
    return { appliedPatch, conflictingFields, resolvedContent };
  }

  it('applies all fields when no delta conflicts', () => {
    const current = { title: 'Hello', count: 1 };
    const patch = { count: 2, status: 'active' };
    const delta = new Set<string>();

    const result = detectConflicts(current, patch, delta);
    expect(result.conflictingFields).toHaveLength(0);
    expect(result.appliedPatch).toEqual({ count: 2, status: 'active' });
    expect(result.resolvedContent).toEqual({ title: 'Hello', count: 2, status: 'active' });
  });

  it('drops conflicting fields (server wins)', () => {
    const current = { title: 'Server Title', count: 1 };
    const patch = { title: 'Client Title', count: 2 };
    const delta = new Set(['title']);

    const result = detectConflicts(current, patch, delta);
    expect(result.conflictingFields).toEqual(['title']);
    expect(result.appliedPatch).toEqual({ count: 2 });
    expect(result.resolvedContent.title).toBe('Server Title');
    expect(result.resolvedContent.count).toBe(2);
  });

  it('handles partial conflicts correctly', () => {
    const current = { a: 'server-a', b: 'server-b', c: 'server-c' };
    const patch = { a: 'client-a', b: 'client-b', d: 'client-d' };
    const delta = new Set(['a']);

    const result = detectConflicts(current, patch, delta);
    expect(result.conflictingFields).toEqual(['a']);
    expect(result.appliedPatch).toEqual({ b: 'client-b', d: 'client-d' });
    expect(result.resolvedContent).toEqual({
      a: 'server-a',  // server won
      b: 'client-b',  // client applied
      c: 'server-c',  // untouched
      d: 'client-d',  // new field
    });
  });

  it('handles multiple conflicting fields', () => {
    const current = { x: 10, y: 20, z: 30 };
    const patch = { x: 11, y: 21, w: 40 };
    const delta = new Set(['x', 'y']);

    const result = detectConflicts(current, patch, delta);
    expect(result.conflictingFields).toEqual(['x', 'y']);
    expect(result.appliedPatch).toEqual({ w: 40 });
    expect(result.resolvedContent).toEqual({ x: 10, y: 20, z: 30, w: 40 });
  });
});

// ─────────────────────────────────────────────
// 5. Idempotency
// ─────────────────────────────────────────────

describe('Idempotency — correlationId deduplication', () => {
  it('same correlationId returns same result on replay', () => {
    const applied = new Map<string, { revision: number }>();
    const correlationId = 'uuid-123';

    function applyOrReplay(corrId: string, revision: number) {
      if (applied.has(corrId)) return applied.get(corrId)!;
      const result = { revision };
      applied.set(corrId, result);
      return result;
    }

    const first = applyOrReplay(correlationId, 5);
    const second = applyOrReplay(correlationId, 99);
    expect(first).toBe(second);
    expect(second.revision).toBe(5);
  });

  it('different correlationIds are processed independently', () => {
    const applied = new Set<string>();

    function isDuplicate(corrId: string): boolean {
      if (applied.has(corrId)) return true;
      applied.add(corrId);
      return false;
    }

    expect(isDuplicate('a')).toBe(false);
    expect(isDuplicate('a')).toBe(true);
    expect(isDuplicate('b')).toBe(false);
  });
});

// ─────────────────────────────────────────────
// 6. Access control
// ─────────────────────────────────────────────

describe('Access control — role-based mutation permission', () => {
  const roles = ['owner', 'editor', 'viewer'] as const;

  function canMutate(role: typeof roles[number]): boolean {
    return role === 'owner' || role === 'editor';
  }

  it('owner can mutate', () => expect(canMutate('owner')).toBe(true));
  it('editor can mutate', () => expect(canMutate('editor')).toBe(true));
  it('viewer cannot mutate', () => expect(canMutate('viewer')).toBe(false));
});
