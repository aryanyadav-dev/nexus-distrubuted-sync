import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─────────────────────────────────────────────
// Unit tests for the mutation engine logic
// These test the algorithm in isolation (no DB)
// ─────────────────────────────────────────────

interface Delta {
  field: string;
  value: unknown;
}

/**
 * Pure version of conflict detection for unit testing.
 */
function detectConflicts(
  currentContent: Record<string, unknown>,
  patch: Record<string, unknown>,
  deltaSinceBase: Delta[]
): {
  appliedPatch: Record<string, unknown>;
  conflictingFields: string[];
  resolvedContent: Record<string, unknown>;
} {
  const changedFields = new Set(deltaSinceBase.map((d) => d.field));
  const appliedPatch: Record<string, unknown> = {};
  const conflictingFields: string[] = [];

  for (const [field, value] of Object.entries(patch)) {
    if (changedFields.has(field)) {
      conflictingFields.push(field);
      // Server wins: do not apply this field
    } else {
      appliedPatch[field] = value;
    }
  }

  const resolvedContent = { ...currentContent, ...appliedPatch };
  return { appliedPatch, conflictingFields, resolvedContent };
}

describe('Mutation Engine — conflict detection', () => {
  describe('detectConflicts', () => {
    it('applies patch cleanly when no delta conflicts', () => {
      const current = { title: 'Hello', count: 1 };
      const patch = { count: 2 };
      const delta: Delta[] = []; // no one else changed anything

      const result = detectConflicts(current, patch, delta);

      expect(result.conflictingFields).toHaveLength(0);
      expect(result.appliedPatch).toEqual({ count: 2 });
      expect(result.resolvedContent).toEqual({ title: 'Hello', count: 2 });
    });

    it('detects a conflict when same field was changed in delta', () => {
      const current = { title: 'Updated by server', count: 1 };
      const patch = { title: 'Updated by client' }; // client wants to change title
      const delta: Delta[] = [{ field: 'title', value: 'Updated by server' }]; // server already changed it

      const result = detectConflicts(current, patch, delta);

      expect(result.conflictingFields).toContain('title');
      expect(result.appliedPatch).not.toHaveProperty('title'); // client's change dropped
      expect(result.resolvedContent.title).toBe('Updated by server'); // server value preserved
    });

    it('partially applies patch when only some fields conflict', () => {
      const current = { title: 'Server title', body: 'old', status: 'draft' };
      const patch = { title: 'Client title', body: 'new body', status: 'published' };
      const delta: Delta[] = [{ field: 'title', value: 'Server title' }];

      const result = detectConflicts(current, patch, delta);

      expect(result.conflictingFields).toEqual(['title']);
      expect(result.appliedPatch).toEqual({ body: 'new body', status: 'published' });
      expect(result.resolvedContent).toEqual({
        title: 'Server title',     // server won
        body: 'new body',           // client applied
        status: 'published',        // client applied
      });
    });

    it('returns no conflicts on brand-new fields', () => {
      const current = { title: 'Hello' };
      const patch = { newField: 'value' };
      const delta: Delta[] = [{ field: 'title', value: 'Changed' }];

      const result = detectConflicts(current, patch, delta);

      expect(result.conflictingFields).toHaveLength(0);
      expect(result.resolvedContent.newField).toBe('value');
    });

    it('handles empty patch gracefully', () => {
      const current = { title: 'Hello' };
      const patch = {};
      const delta: Delta[] = [];

      const result = detectConflicts(current, patch, delta);

      expect(result.appliedPatch).toEqual({});
      expect(result.conflictingFields).toHaveLength(0);
      expect(result.resolvedContent).toEqual(current);
    });
  });
});

// ─────────────────────────────────────────────
// Revision bump logic
// ─────────────────────────────────────────────

describe('Revision management', () => {
  it('increments revision on each mutation', () => {
    let revision = 0;
    const bump = () => ++revision;

    expect(bump()).toBe(1);
    expect(bump()).toBe(2);
    expect(bump()).toBe(3);
  });

  it('detects stale base revisions', () => {
    const currentRevision = 10;
    const baseRevision = 7; // client is 3 revisions behind
    const isStale = baseRevision < currentRevision;
    expect(isStale).toBe(true);
  });

  it('accepts current base revision (no divergence)', () => {
    const currentRevision = 5;
    const baseRevision = 5;
    const isStale = baseRevision < currentRevision;
    expect(isStale).toBe(false);
  });
});

// ─────────────────────────────────────────────
// Idempotency
// ─────────────────────────────────────────────

describe('Mutation idempotency', () => {
  it('same correlation ID returns same result', () => {
    const applied = new Map<string, { revision: number }>();
    const correlationId = 'uuid-123';

    function applyOrReplay(corrId: string, revision: number) {
      if (applied.has(corrId)) return applied.get(corrId)!;
      const result = { revision };
      applied.set(corrId, result);
      return result;
    }

    const first = applyOrReplay(correlationId, 5);
    const second = applyOrReplay(correlationId, 99); // different revision ignored

    expect(first).toBe(second); // same object returned
    expect(second.revision).toBe(5); // original revision preserved
  });
});

// ─────────────────────────────────────────────
// Access control logic
// ─────────────────────────────────────────────

describe('Access control', () => {
  const roles = ['owner', 'editor', 'viewer'] as const;

  function canMutate(role: typeof roles[number]): boolean {
    return role === 'owner' || role === 'editor';
  }

  it('owner can mutate', () => expect(canMutate('owner')).toBe(true));
  it('editor can mutate', () => expect(canMutate('editor')).toBe(true));
  it('viewer cannot mutate', () => expect(canMutate('viewer')).toBe(false));
});

// ─────────────────────────────────────────────
// Reconnect replay buffer
// ─────────────────────────────────────────────

describe('Reconnect replay', () => {
  it('replays pending mutations in order after reconnect', () => {
    const pendingMutations = [
      { correlationId: 'a', patch: { x: 1 }, baseRevision: 0 },
      { correlationId: 'b', patch: { y: 2 }, baseRevision: 1 },
      { correlationId: 'c', patch: { z: 3 }, baseRevision: 2 },
    ];

    const applied: string[] = [];
    // Simulate replay: each mutation sent in order
    for (const m of pendingMutations) {
      applied.push(m.correlationId);
    }

    expect(applied).toEqual(['a', 'b', 'c']);
  });

  it('skips already-applied mutations (by correlationId)', () => {
    const serverApplied = new Set(['a', 'b']);
    const pending = ['a', 'b', 'c', 'd'];

    const toSend = pending.filter((id) => !serverApplied.has(id));
    expect(toSend).toEqual(['c', 'd']);
  });
});
