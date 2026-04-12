/* eslint-disable @typescript-eslint/naming-convention */

exports.shorthands = undefined;

exports.up = async function (pgm) {
  // Enable UUID extension
  pgm.createExtension('uuid-ossp', { ifNotExists: true });

  // ──────────────────────────────────────────────
  // users
  // ──────────────────────────────────────────────
  pgm.createTable('users', {
    id: {
      type: 'uuid',
      primaryKey: true,
      default: pgm.func('uuid_generate_v4()'),
    },
    email: { type: 'varchar(255)', notNull: true, unique: true },
    password_hash: { type: 'varchar(255)', notNull: true },
    display_name: { type: 'varchar(100)', notNull: true },
    created_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('now()'),
    },
  });
  pgm.createIndex('users', 'email');

  // ──────────────────────────────────────────────
  // workspaces
  // ──────────────────────────────────────────────
  pgm.createTable('workspaces', {
    id: {
      type: 'uuid',
      primaryKey: true,
      default: pgm.func('uuid_generate_v4()'),
    },
    name: { type: 'varchar(200)', notNull: true },
    owner_id: {
      type: 'uuid',
      notNull: true,
      references: '"users"',
      onDelete: 'CASCADE',
    },
    created_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('now()'),
    },
  });

  // ──────────────────────────────────────────────
  // workspace_members
  // ──────────────────────────────────────────────
  pgm.createTable('workspace_members', {
    workspace_id: {
      type: 'uuid',
      notNull: true,
      references: '"workspaces"',
      onDelete: 'CASCADE',
    },
    user_id: {
      type: 'uuid',
      notNull: true,
      references: '"users"',
      onDelete: 'CASCADE',
    },
    role: {
      type: 'varchar(20)',
      notNull: true,
      check: "role IN ('owner','editor','viewer')",
      default: "'editor'",
    },
    joined_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('now()'),
    },
  });
  pgm.addConstraint('workspace_members', 'wm_pk', 'PRIMARY KEY (workspace_id, user_id)');

  // ──────────────────────────────────────────────
  // documents
  // ──────────────────────────────────────────────
  pgm.createTable('documents', {
    id: {
      type: 'uuid',
      primaryKey: true,
      default: pgm.func('uuid_generate_v4()'),
    },
    workspace_id: {
      type: 'uuid',
      notNull: true,
      references: '"workspaces"',
      onDelete: 'CASCADE',
    },
    title: { type: 'varchar(500)', notNull: true },
    content: { type: 'jsonb', notNull: true, default: pgm.func("'{}'::jsonb") },
    revision: { type: 'integer', notNull: true, default: 0 },
    created_by: {
      type: 'uuid',
      notNull: true,
      references: '"users"',
      onDelete: 'SET NULL',
    },
    created_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('now()'),
    },
    updated_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('now()'),
    },
  });
  pgm.createIndex('documents', 'workspace_id');

  // ──────────────────────────────────────────────
  // snapshots
  // ──────────────────────────────────────────────
  pgm.createTable('snapshots', {
    id: {
      type: 'uuid',
      primaryKey: true,
      default: pgm.func('uuid_generate_v4()'),
    },
    document_id: {
      type: 'uuid',
      notNull: true,
      references: '"documents"',
      onDelete: 'CASCADE',
    },
    revision: { type: 'integer', notNull: true },
    content: { type: 'jsonb', notNull: true },
    created_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('now()'),
    },
  });
  pgm.createIndex('snapshots', ['document_id', 'revision']);

  // ──────────────────────────────────────────────
  // mutations (append-only mutation log)
  // ──────────────────────────────────────────────
  pgm.createTable('mutations', {
    id: {
      type: 'uuid',
      primaryKey: true,
      default: pgm.func('uuid_generate_v4()'),
    },
    document_id: {
      type: 'uuid',
      notNull: true,
      references: '"documents"',
      onDelete: 'CASCADE',
    },
    user_id: {
      type: 'uuid',
      notNull: true,
      references: '"users"',
      onDelete: 'SET NULL',
    },
    revision: { type: 'integer', notNull: true },
    base_revision: { type: 'integer', notNull: true },
    patch: { type: 'jsonb', notNull: true },
    conflict_meta: { type: 'jsonb', default: null },
    correlation_id: { type: 'uuid', notNull: true, unique: true },
    applied_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('now()'),
    },
  });
  pgm.createIndex('mutations', 'document_id');
  pgm.createIndex('mutations', 'correlation_id');
  pgm.createIndex('mutations', ['document_id', 'revision']);

  // ──────────────────────────────────────────────
  // sessions (active WebSocket connections)
  // ──────────────────────────────────────────────
  pgm.createTable('sessions', {
    id: {
      type: 'uuid',
      primaryKey: true,
      default: pgm.func('uuid_generate_v4()'),
    },
    user_id: {
      type: 'uuid',
      notNull: true,
      references: '"users"',
      onDelete: 'CASCADE',
    },
    workspace_id: { type: 'uuid', default: null },
    document_id: { type: 'uuid', default: null },
    connected_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('now()'),
    },
    last_seen_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('now()'),
    },
    disconnected_at: { type: 'timestamptz', default: null },
    ip_address: { type: 'varchar(45)', default: null },
  });

  // ──────────────────────────────────────────────
  // presence_events
  // ──────────────────────────────────────────────
  pgm.createTable('presence_events', {
    id: {
      type: 'uuid',
      primaryKey: true,
      default: pgm.func('uuid_generate_v4()'),
    },
    session_id: { type: 'uuid', notNull: true, references: '"sessions"', onDelete: 'CASCADE' },
    user_id: { type: 'uuid', notNull: true, references: '"users"', onDelete: 'CASCADE' },
    document_id: { type: 'uuid', default: null },
    event_type: {
      type: 'varchar(20)',
      notNull: true,
      check: "event_type IN ('connect','disconnect','heartbeat','subscribe','unsubscribe')",
    },
    ts: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('now()'),
    },
  });
  pgm.createIndex('presence_events', ['document_id', 'ts']);

  // ──────────────────────────────────────────────
  // audit_logs
  // ──────────────────────────────────────────────
  pgm.createTable('audit_logs', {
    id: {
      type: 'uuid',
      primaryKey: true,
      default: pgm.func('uuid_generate_v4()'),
    },
    user_id: { type: 'uuid', default: null },
    workspace_id: { type: 'uuid', default: null },
    action: { type: 'varchar(100)', notNull: true },
    meta: { type: 'jsonb', default: pgm.func("'{}'::jsonb") },
    created_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('now()'),
    },
  });
  pgm.createIndex('audit_logs', ['workspace_id', 'created_at']);
};

exports.down = async function (pgm) {
  pgm.dropTable('audit_logs');
  pgm.dropTable('presence_events');
  pgm.dropTable('sessions');
  pgm.dropTable('mutations');
  pgm.dropTable('snapshots');
  pgm.dropTable('documents');
  pgm.dropTable('workspace_members');
  pgm.dropTable('workspaces');
  pgm.dropTable('users');
};
