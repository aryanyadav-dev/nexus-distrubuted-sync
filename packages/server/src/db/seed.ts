/**
 * Seed script — creates demo users, workspace, and document.
 * Run: npm run seed -w packages/server
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

    // Create demo users
    const aliceId = uuidv4();
    const bobId = uuidv4();
    const carolId = uuidv4();

    await client.query(
      `INSERT INTO users (id, email, password_hash, display_name) VALUES
       ($1, 'alice@demo.com', $4, 'Alice Chen'),
       ($2, 'bob@demo.com', $4, 'Bob Smith'),
       ($3, 'carol@demo.com', $4, 'Carol Jones')
       ON CONFLICT (email) DO NOTHING`,
      [aliceId, bobId, carolId, password]
    );

    // Re-fetch actual IDs (in case of conflict)
    const usersRes = await client.query(`SELECT id, email FROM users WHERE email IN ($1,$2,$3)`, [
      'alice@demo.com',
      'bob@demo.com',
      'carol@demo.com',
    ]);
    const users: Record<string, string> = {};
    for (const row of usersRes.rows) {
      users[row.email] = row.id;
    }

    const actualAlice = users['alice@demo.com'];
    const actualBob = users['bob@demo.com'];
    const actualCarol = users['carol@demo.com'];

    // Create workspace
    const wsId = uuidv4();
    await client.query(
      `INSERT INTO workspaces (id, name, owner_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
      [wsId, 'Demo Workspace', actualAlice]
    );

    // Add members
    await client.query(
      `INSERT INTO workspace_members (workspace_id, user_id, role) VALUES
       ($1, $2, 'owner'), ($1, $3, 'editor'), ($1, $4, 'viewer')
       ON CONFLICT (workspace_id, user_id) DO NOTHING`,
      [wsId, actualAlice, actualBob, actualCarol]
    );

    // Create shared checklist document
    const docId = uuidv4();
    const item1 = uuidv4();
    const item2 = uuidv4();
    const item3 = uuidv4();

    const initialContent = {
      title: 'Project Launch Checklist',
      description: 'Track our Q2 launch milestones collaboratively!',
      items: {
        [item1]: {
          id: item1,
          text: 'Finalize API design',
          completed: true,
          createdBy: 'Alice Chen',
          createdAt: new Date().toISOString(),
          order: 0,
          note: 'Done! Great work team.',
        },
        [item2]: {
          id: item2,
          text: 'Set up CI/CD pipeline',
          completed: false,
          createdBy: 'Bob Smith',
          createdAt: new Date().toISOString(),
          order: 1,
          note: 'In progress.',
        },
        [item3]: {
          id: item3,
          text: 'Write integration tests',
          completed: false,
          createdBy: 'Alice Chen',
          createdAt: new Date().toISOString(),
          order: 2,
        },
      },
    };

    await client.query(
      `INSERT INTO documents (id, workspace_id, title, content, created_by) 
       VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING`,
      [docId, wsId, 'Project Launch Checklist', JSON.stringify(initialContent), actualAlice]
    );

    // Store initial snapshot at revision 0
    await client.query(
      `INSERT INTO snapshots (document_id, revision, content) VALUES ($1, 0, $2) ON CONFLICT DO NOTHING`,
      [docId, JSON.stringify(initialContent)]
    );

    await client.query('COMMIT');

    console.log('✅ Seed complete!');
    console.log('');
    console.log('Demo accounts:');
    console.log('  alice@demo.com / password123  (owner)');
    console.log('  bob@demo.com   / password123  (editor)');
    console.log('  carol@demo.com / password123  (viewer)');
    console.log('');
    console.log(`Workspace ID: ${wsId}`);
    console.log(`Document ID:  ${docId}`);
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
