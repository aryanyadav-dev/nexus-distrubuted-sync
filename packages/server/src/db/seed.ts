/**
 * Seed script — creates demo users, workspace, and documents.
 * Run: npm run seed -w packages/server
 *
 * Uses UPSERT so it can be re-run safely to fix existing data.
 */
import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { pool } from './pool';
import { v4 as uuidv4 } from 'uuid';

async function seed() {
  console.log('🌱 Seeding database...');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const password = await bcrypt.hash('password123', 10);

    // Create demo users (upsert)
    const aliceId = uuidv4();
    const bobId = uuidv4();
    const carolId = uuidv4();

    for (const [id, email, name] of [
      [aliceId, 'alice@demo.com', 'Alice Chen'],
      [bobId, 'bob@demo.com', 'Bob Smith'],
      [carolId, 'carol@demo.com', 'Carol Jones'],
    ] as const) {
      await client.query(
        `INSERT INTO users (id, email, password_hash, display_name)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (email) DO UPDATE SET password_hash = $3, display_name = $4`,
        [id, email, password, name]
      );
    }

    // Re-fetch actual IDs
    const usersRes = await client.query(
      `SELECT id, email FROM users WHERE email IN ($1,$2,$3)`,
      ['alice@demo.com', 'bob@demo.com', 'carol@demo.com']
    );
    const users: Record<string, string> = {};
    for (const row of usersRes.rows) {
      users[row.email] = row.id;
    }
    const actualAlice = users['alice@demo.com'];
    const actualBob = users['bob@demo.com'];
    const actualCarol = users['carol@demo.com'];

    // Create workspace (upsert by name + owner)
    const wsId = uuidv4();
    const wsRes = await client.query(
      `INSERT INTO workspaces (id, name, owner_id) VALUES ($1, $2, $3)
       ON CONFLICT DO NOTHING RETURNING id`,
      [wsId, 'Demo Workspace', actualAlice]
    );
    const actualWsId = wsRes.rows[0]?.id
      || (await client.query(`SELECT id FROM workspaces WHERE name = 'Demo Workspace' AND owner_id = $1`, [actualAlice])).rows[0]?.id
      || wsId;

    // Add members — ALL as editors (upsert role)
    for (const [userId, role] of [
      [actualAlice, 'owner'],
      [actualBob, 'editor'],
      [actualCarol, 'editor'],
    ] as const) {
      await client.query(
        `INSERT INTO workspace_members (workspace_id, user_id, role)
         VALUES ($1, $2, $3)
         ON CONFLICT (workspace_id, user_id) DO UPDATE SET role = $3`,
        [actualWsId, userId, role]
      );
    }

    // ── Board Document ──────────────────────────────
    const boardItem1 = uuidv4();
    const boardItem2 = uuidv4();
    const boardItem3 = uuidv4();

    const boardContent = {
      kind: 'board',
      title: 'Sprint Board',
      description: 'Track sprint tasks in real-time across all connected clients',
      items: {
        [boardItem1]: {
          id: boardItem1,
          text: 'Finalize API design',
          completed: true,
          createdBy: 'Alice Chen',
          createdAt: new Date().toISOString(),
          order: 0,
          priority: 'high',
        },
        [boardItem2]: {
          id: boardItem2,
          text: 'Set up CI/CD pipeline',
          completed: false,
          createdBy: 'Bob Smith',
          createdAt: new Date().toISOString(),
          order: 1,
          priority: 'medium',
        },
        [boardItem3]: {
          id: boardItem3,
          text: 'Write integration tests',
          completed: false,
          createdBy: 'Carol Jones',
          createdAt: new Date().toISOString(),
          order: 2,
          priority: 'low',
        },
      },
    };

    // Delete old seeded docs and re-create fresh ones
    await client.query(
      `DELETE FROM documents WHERE workspace_id = $1`,
      [actualWsId]
    );
    // Also clean up orphaned mutations/snapshots
    await client.query(
      `DELETE FROM mutations WHERE document_id NOT IN (SELECT id FROM documents)`
    );
    await client.query(
      `DELETE FROM snapshots WHERE document_id NOT IN (SELECT id FROM documents)`
    );

    const boardDocId = uuidv4();
    await client.query(
      `INSERT INTO documents (id, workspace_id, title, content, created_by, revision)
       VALUES ($1, $2, $3, $4, $5, 1)`,
      [boardDocId, actualWsId, 'Sprint Board', JSON.stringify(boardContent), actualAlice]
    );
    await client.query(
      `INSERT INTO snapshots (document_id, revision, content) VALUES ($1, 1, $2)
       ON CONFLICT DO NOTHING`,
      [boardDocId, JSON.stringify(boardContent)]
    );

    // ── Doc Document (Meeting Notes) ─────────────────
    const docContent = {
      kind: 'doc',
      title: 'Architecture Notes',
      body: `# Nexus Distributed Sync Engine

This document captures the architectural decisions behind the Nexus sync system.

## Overview
Nexus uses an optimistic mutation protocol with server-side conflict resolution.
Each document maintains a linear revision history. Clients submit patches
against their known base revision and the server resolves any conflicts
using a deterministic last-write-wins strategy.

## Key Components
- **SyncClient SDK** — manages WebSocket lifecycle, heartbeats, and offline buffering
- **Mutation Queue** — server-side FIFO queue per document for serialized apply
- **Snapshot Store** — periodic full-state snapshots for fast client bootstrap
- **Presence Engine** — real-time user awareness via heartbeat aggregation

## Next Steps
- Implement field-level OT for finer conflict granularity
- Add Redis pub/sub for horizontal server scaling
- Build admin dashboard for live system monitoring`,
      comments: {},
      tasks: {},
    };

    const notesDocId = uuidv4();
    await client.query(
      `INSERT INTO documents (id, workspace_id, title, content, created_by, revision)
       VALUES ($1, $2, $3, $4, $5, 1)`,
      [notesDocId, actualWsId, 'Architecture Notes', JSON.stringify(docContent), actualAlice]
    );
    await client.query(
      `INSERT INTO snapshots (document_id, revision, content) VALUES ($1, 1, $2)
       ON CONFLICT DO NOTHING`,
      [notesDocId, JSON.stringify(docContent)]
    );

    await client.query('COMMIT');

    console.log('✅ Seed complete!');
    console.log('');
    console.log('Demo accounts:');
    console.log('  alice@demo.com / password123  (owner)');
    console.log('  bob@demo.com   / password123  (editor)');
    console.log('  carol@demo.com / password123  (editor)');
    console.log('');
    console.log(`Workspace ID: ${actualWsId}`);
    console.log(`Board Doc ID: ${boardDocId}`);
    console.log(`Notes Doc ID: ${notesDocId}`);
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('❌ Seed failed:', e);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

seed();
