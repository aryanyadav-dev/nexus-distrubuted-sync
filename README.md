# Nexus — Distributed Real-Time Sync Engine

A production-ready distributed real-time sync engine that lets multiple clients share, edit, and reconcile a collaborative JSON document over WebSocket.

**Demo use-case:** Shared collaborative checklist/notes board — multiple users can create items, check them off, reorder, and annotate them in real time.

## Architecture

- **Sync Strategy:** Revision-based optimistic sync with last-write-wins field merge + conflict metadata
- **Transport:** WebSocket (real-time bidirectional) + REST (auth, management, history)
- **Scaling:** Redis Pub/Sub for cross-instance broadcast
- **Conflict Resolution:** Field-level detection — if the same field was changed by another client since your base revision, server wins; all data preserved in mutation log

## Tech Stack

| Layer | Tech |
|-------|------|
| Frontend | React + TypeScript + Vite + Tailwind |
| Backend | Node.js + TypeScript + Express |
| WebSocket | `ws` library (raw, no socket.io) |
| Database | PostgreSQL (node-pg-migrate) |
| Cache/Pub-Sub | Redis (ioredis) |
| Validation | Zod |
| Auth | JWT (jsonwebtoken + bcryptjs) |
| Testing | Vitest + Supertest |
| Container | Docker + Docker Compose |

## Quick Start

### Prerequisites
- Docker (for Postgres + Redis)
- Node.js v18+
- npm

### 1. Start Infrastructure

```bash
docker compose up -d
```

This starts PostgreSQL and Redis containers.

### 2. Install Dependencies

```bash
npm install
```

### 3. Configure Environment

```bash
cp .env.example .env
```

Defaults work with Docker Compose — no edits needed for local dev.

### 4. Database Setup (First Time Only)

Run migrations and seed demo data:

```bash
cd packages/server

# Run migrations
DATABASE_URL=postgres://dsync:dsync@localhost:5432/dsync \
  npx node-pg-migrate up --config-file src/db/migrate.config.js

# Seed demo accounts
DATABASE_URL=postgres://dsync:dsync@localhost:5432/dsync \
REDIS_URL=redis://localhost:6379 \
JWT_SECRET=change-this-to-a-long-random-string-in-production \
JWT_EXPIRES_IN=7d \
npx ts-node -r tsconfig-paths/register src/db/seed.ts
```

### 5. Start Development Servers

Run these in **two separate terminals**:

**Terminal 1 — Backend (port 4000):**
```bash
cd packages/server

DATABASE_URL=postgres://dsync:dsync@localhost:5432/dsync \
REDIS_URL=redis://localhost:6379 \
JWT_SECRET=change-this-to-a-long-random-string-in-production \
JWT_EXPIRES_IN=7d \
CORS_ORIGIN=http://localhost:3000 \
npx ts-node-dev --respawn --transpile-only -r tsconfig-paths/register src/index.ts
```

**Terminal 2 — Frontend (port 3000):**
```bash
cd packages/client

npx vite --port 3000
```

### 6. Open the App

- **App:** http://localhost:3000
- **Backend REST:** http://localhost:4000/api
- **WebSocket:** ws://localhost:4000/ws
- **Health:** http://localhost:4000/health

### Demo Accounts

| Email | Password | Role |
|-------|----------|------|
| alice@demo.com | password123 | owner |
| bob@demo.com | password123 | editor |
| carol@demo.com | password123 | viewer |

---

## How to Demo Real-Time Sync

1. Open **two browser windows** (use normal + incognito to avoid shared localStorage)
2. Sign in as `alice@demo.com` in one, `bob@demo.com` in the other
3. Both enter the same workspace → same document
4. Add/edit/toggle kanban items simultaneously — changes sync instantly
5. Click **Debug** button in header to see WebSocket events, mutations, and conflicts

### Testing Concurrent Edits
- Both users edit the **same task** at the same time
- Server detects conflict → applies server-wins resolution
- Check debug log for conflict metadata

## WebSocket Protocol

| Message | Direction | Purpose |
|---------|-----------|---------|
| `hello` | Client → Server | Authenticate with JWT |
| `subscribe` | Client → Server | Join a document channel |
| `unsubscribe` | Client → Server | Leave a document channel |
| `mutation` | Client → Server | Send an atomic patch |
| `heartbeat` | Client → Server | Keep-alive ping |
| `authenticated` | Server → Client | Auth confirmation |
| `snapshot` | Server → Client | Full document state |
| `mutation_ack` | Server → Client | Mutation applied confirmation |
| `remote_update` | Server → Client | Broadcast of another user's mutation |
| `presence_update` | Server → Client | Who is currently connected |
| `heartbeat_ack` | Server → Client | Keep-alive pong |
| `conflict` | Server → Client | Field was auto-merged differently |
| `error` | Server → Client | Protocol or auth error |

## REST API

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/auth/signup` | POST | Register new user |
| `/api/auth/signin` | POST | Sign in |
| `/api/workspaces` | GET | List my workspaces |
| `/api/workspaces` | POST | Create workspace |
| `/api/workspaces/:id` | GET | Get workspace |
| `/api/workspaces/:id/members` | GET | List members |
| `/api/workspaces/:id/members` | POST | Invite member |
| `/api/workspaces/:id/audit` | GET | View audit logs |
| `/api/workspaces/:wsId/documents` | GET | List documents |
| `/api/workspaces/:wsId/documents` | POST | Create document |
| `/api/workspaces/:wsId/documents/:docId` | GET | Get document |
| `/api/workspaces/:wsId/documents/:docId/history` | GET | Mutation history |
| `/api/workspaces/:wsId/documents/:docId/snapshot` | GET | Latest snapshot |
| `/api/admin/sessions` | GET | Live sessions |
| `/api/admin/health` | GET | Server health/metrics |

## Conflict Resolution

When a client sends a mutation with `baseRevision < currentRevision`:

1. Server fetches all mutations applied since the client's base revision (the delta set)
2. For each field in the incoming patch, checks if the same field exists in the delta
3. **No overlap** → clean apply, revision bumps
4. **Overlap** → field loses (server wins), conflict metadata emitted on the wire
5. All data is preserved in the mutation log — nothing is silently discarded

---

## Core Algorithms

This system implements two key backend algorithms that are central to how real-time sync works.

### Algorithm 1: Deterministic Mutation Reconciliation

**File:** `packages/server/src/sync/mutationQueue.ts`

When multiple clients edit concurrently or a reconnecting client replays buffered mutations, the server must apply them in a **deterministic total order** — every server instance must process the same set of mutations in the same order, producing identical document state.

#### How it works

1. **Enqueue**: Each incoming mutation is placed into a per-document queue with a server-assigned `receivedAt` timestamp.

2. **Sort**: When flushing the queue, mutations are sorted by the deterministic rule:
   - **Primary**: `baseRevision` ascending — mutations rooted on earlier state go first
   - **Secondary**: `receivedAt` ascending — earlier server arrivals go first
   - **Tertiary**: `userId` lexicographic ascending — stable tie-break by author
   - **Quaternary**: `correlationId` lexicographic ascending — final deterministic tie-break (always unique)

3. **Apply**: Mutations are applied sequentially through the mutation engine (field-level conflict detection).

4. **Idempotency**: Before processing, each mutation's `correlationId` is checked against the database. Duplicates are rejected and the existing result is re-acked.

#### Why this ordering matters

- **Offline replay**: A client that disconnects at revision 5, makes 3 edits offline, then reconnects sends mutations with `baseRevision = 5, 6, 7`. The queue orders them by base revision, ensuring they replay in causal order.
- **Concurrent edits**: Two users editing the same document "simultaneously" — their mutations arrive at slightly different times. The `receivedAt` tie-break ensures deterministic ordering regardless of which server instance processes them.
- **Cross-instance consistency**: Redis Pub/Sub broadcasts mutations to all server instances. The deterministic ordering rule guarantees all instances converge to the same state.

#### Data structures maintained

| Structure | Purpose |
|-----------|---------|
| Per-document queue | Buffers incoming mutations before deterministic processing |
| `receivedAt` timestamp | Server-side monotonic clock for arrival ordering |
| `correlationId` (UUID) | Idempotency key — prevents duplicate application |
| Document `revision` | Monotonically increasing, incremented per applied mutation |
| Mutation log (append-only) | Full audit trail of every patch and conflict |

#### Live demo flow

1. Open two browser tabs, sign in as different users (alice@demo.com, bob@demo.com)
2. Both subscribe to the same document
3. Both add checklist items simultaneously
4. The debug panel shows mutations being applied in deterministic order
5. Both tabs converge to the same document state

---

### Algorithm 2: Binary Search Snapshot Restore

**File:** `packages/server/src/sync/snapshotRestore.ts`

Snapshots are created every N mutations (default: 10). To reconstruct the document at any historical revision without storing a full snapshot at every revision, this algorithm uses binary search + forward replay.

#### How it works

1. **Find nearest snapshot**: Query the database for the snapshot with the highest `revision ≤ targetRevision`. This is an indexed O(1) lookup using PostgreSQL's B-tree index on `(document_id, revision)`.

2. **Exact match shortcut**: If `snapshot.revision == targetRevision`, return the snapshot content directly — no replay needed.

3. **Forward replay**: Otherwise, fetch all mutations in the range `(snapshot.revision, targetRevision]` and apply them sequentially onto the snapshot content using a shallow field-level merge.

4. **Return**: The reconstructed document state at the target revision.

#### Complexity

| Scenario | Cost |
|----------|------|
| Exact snapshot match | O(1) — return directly |
| Snapshot within N revisions | O(k) where k ≤ N mutations to replay |
| No snapshot exists | O(R) — replay from revision 0 |
| Snapshot lookup (in-memory) | O(log S) where S = number of snapshots |

For a document with 10,000 revisions and snapshots every 10 mutations, at most 10 mutations need replay — a 1000x improvement over naive full replay.

#### Pure function for testing

The `binarySearchSnapshot` function implements the binary search over a sorted revisions array and is tested independently:

```typescript
// Find nearest snapshot at or below revision 35
// Given snapshots at [0, 10, 20, 30, 40, 50]
binarySearchSnapshot([0, 10, 20, 30, 40, 50], 35) // → index 3 (revision 30)
```

#### REST API

```
GET /api/workspaces/:wsId/documents/:docId/restore/:revision
GET /api/workspaces/:wsId/documents/:docId/restore/:revision/cost
```

The `/cost` endpoint returns how many mutations would need replay, useful for UI decisions about whether to restore.

## Testing

```bash
npm test
```

Tests cover:
- Mutation engine conflict detection
- Revision bumping
- Idempotency (same correlationId returns same result)
- Access control (viewer cannot mutate)
- Reconnect replay buffer
- **Deterministic mutation ordering** (baseRevision → receivedAt → userId → correlationId)
- **Offline replay scenario** (buffered mutations sorted by base revision)
- **Binary search snapshot restore** (exact match, nearest-below, edge cases)
- **Mutation replay** (pure function, sequential patch application)
- **Field-level conflict detection** (partial conflicts, server-wins resolution)

## Project Structure

```
dsync-software/
├── packages/
│   ├── shared/            # Shared types + Zod schemas
│   ├── server/            # Backend Node.js + WebSocket server
│   │   ├── src/
│   │   │   ├── auth/      # JWT, bcrypt, middlewares
│   │   │   ├── db/        # pg pool, migrations, queries
│   │   │   ├── redis/     # pub/sub, presence TTL
│   │   │   ├── sync/      # mutation engine, conflict resolution
│   │   │   ├── ws/        # WebSocket handler, session registry
│   │   │   ├── routes/    # REST endpoints
│   │   │   └── index.ts
│   │   └── migrations/
│   └── client/            # React Vite frontend
│       └── src/
│           ├── lib/       # SyncClient SDK + REST API client
│           ├── pages/     # Auth, Workspace, Board pages
│           └── stores/    # Zustand state (auth, sync)
├── docker-compose.yml
├── .env.example
└── README.md
```

## License

MIT
