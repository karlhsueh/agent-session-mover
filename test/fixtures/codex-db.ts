import { DatabaseSync } from 'node:sqlite'

/**
 * The `threads` table and its triggers as `state_5.sqlite` holds them at migration 62 (desktop app
 * 26.1029, CLI 0.166 alpha), copied from the schema only.
 */
export const THREADS_DDL = `
CREATE TABLE thread_sections (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL
, appearance TEXT);
CREATE TABLE projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    metadata TEXT NOT NULL DEFAULT '{}',
    position INTEGER NOT NULL,
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL
);
CREATE TABLE threads (
    id TEXT PRIMARY KEY,
    rollout_path TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    source TEXT NOT NULL,
    model_provider TEXT NOT NULL,
    cwd TEXT NOT NULL,
    title TEXT NOT NULL,
    sandbox_policy TEXT NOT NULL,
    approval_mode TEXT NOT NULL,
    tokens_used INTEGER NOT NULL DEFAULT 0,
    has_user_event INTEGER NOT NULL DEFAULT 0,
    archived INTEGER NOT NULL DEFAULT 0,
    archived_at INTEGER,
    git_sha TEXT,
    git_branch TEXT,
    git_origin_url TEXT
, cli_version TEXT NOT NULL DEFAULT '', first_user_message TEXT NOT NULL DEFAULT '', agent_nickname TEXT, agent_role TEXT, memory_mode TEXT NOT NULL DEFAULT 'enabled', model TEXT, reasoning_effort TEXT, agent_path TEXT, created_at_ms INTEGER, updated_at_ms INTEGER, thread_source TEXT, preview TEXT NOT NULL DEFAULT '', recency_at INTEGER NOT NULL DEFAULT 0, recency_at_ms INTEGER NOT NULL DEFAULT 0, history_mode TEXT NOT NULL DEFAULT 'legacy', name TEXT, is_pinned INTEGER NOT NULL DEFAULT 0, thread_section_id TEXT
    REFERENCES thread_sections(id) ON DELETE SET NULL, section_position INTEGER, section_entered_at_ms INTEGER, project_id TEXT
    REFERENCES projects(id) ON DELETE SET NULL, originator TEXT, daybreak_enabled BOOLEAN, creator_user_id TEXT, creator_account_id TEXT, attached_thread_parent_id TEXT);
CREATE TRIGGER threads_created_at_ms_after_insert AFTER INSERT ON threads WHEN NEW.created_at_ms IS NULL
BEGIN UPDATE threads SET created_at_ms = NEW.created_at * 1000 WHERE id = NEW.id; END;
CREATE TRIGGER threads_updated_at_ms_after_insert AFTER INSERT ON threads WHEN NEW.updated_at_ms IS NULL
BEGIN UPDATE threads SET updated_at_ms = NEW.updated_at * 1000 WHERE id = NEW.id; END;
CREATE TRIGGER threads_created_at_ms_after_update AFTER UPDATE OF created_at ON threads
WHEN NEW.created_at != OLD.created_at AND NEW.created_at_ms IS OLD.created_at_ms
BEGIN UPDATE threads SET created_at_ms = NEW.created_at * 1000 WHERE id = NEW.id; END;
CREATE TRIGGER threads_updated_at_ms_after_update AFTER UPDATE OF updated_at ON threads
WHEN NEW.updated_at != OLD.updated_at AND NEW.updated_at_ms IS OLD.updated_at_ms
BEGIN UPDATE threads SET updated_at_ms = NEW.updated_at * 1000 WHERE id = NEW.id; END;
CREATE TRIGGER threads_recency_at_after_insert AFTER INSERT ON threads WHEN NEW.recency_at_ms = 0
BEGIN UPDATE threads SET recency_at = NEW.updated_at, recency_at_ms = COALESCE(NEW.updated_at_ms, NEW.updated_at * 1000) WHERE id = NEW.id; END;
`

/** Migration 21. Every real store has it, so `createStateDb` adds it unless asked not to. */
export const SPAWN_EDGES_DDL = `
CREATE TABLE thread_spawn_edges (
    parent_thread_id TEXT NOT NULL,
    child_thread_id TEXT NOT NULL PRIMARY KEY,
    status TEXT NOT NULL
);
CREATE INDEX idx_thread_spawn_edges_parent_status
    ON thread_spawn_edges(parent_thread_id, status);
`

export interface FixtureRow {
  id: string
  rollout_path: string
  cwd: string
  title?: string
  name?: string | null
  preview?: string
  source?: string
  archived?: 0 | 1
  updated_at?: number
}

/** Creates `state_5.sqlite` in WAL mode, the way Codex leaves it. */
export function createStateDb(file: string, rows: FixtureRow[], options: { edges?: boolean } = {}): void {
  const db = new DatabaseSync(file)
  try {
    db.exec('PRAGMA journal_mode = WAL')
    db.exec(THREADS_DDL)
    if (options.edges !== false) db.exec(SPAWN_EDGES_DDL)
    for (const row of rows) insertRow(db, row)
  } finally {
    db.close()
  }
}

export function insertRow(db: DatabaseSync, row: FixtureRow): void {
  const updated = row.updated_at ?? 1_793_000_000
  db.prepare(
    `INSERT INTO threads (id, rollout_path, created_at, updated_at, source, model_provider, cwd, title, sandbox_policy, approval_mode, preview, first_user_message, archived, name, cli_version)
     VALUES (?, ?, ?, ?, ?, 'openai', ?, ?, '{}', 'on-request', ?, ?, ?, ?, '0.162.1')`,
  ).run(row.id, row.rollout_path, updated - 600, updated, row.source ?? 'cli', row.cwd, row.title ?? '', row.preview ?? 'preview', row.preview ?? 'preview', row.archived ?? 0, row.name ?? null)
}

/** Every row and column, ordered, so a test can prove the table is exactly as it was. */
export function threadRows(file: string): Record<string, unknown>[] {
  const db = new DatabaseSync(file)
  try {
    return db.prepare('SELECT * FROM threads ORDER BY id').all() as Record<string, unknown>[]
  } finally {
    db.close()
  }
}

export function threadRow(file: string, id: string): Record<string, unknown> | undefined {
  return threadRows(file).find((row) => row.id === id)
}

/** Every spawn edge, ordered by child. Empty when the table does not exist. */
export function spawnEdges(file: string): Record<string, unknown>[] {
  const db = new DatabaseSync(file)
  try {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'thread_spawn_edges'").get()) return []
    return db.prepare('SELECT parent_thread_id, child_thread_id, status FROM thread_spawn_edges ORDER BY child_thread_id').all() as Record<string, unknown>[]
  } finally {
    db.close()
  }
}

export function insertEdge(file: string, parent: string, child: string, status: string): void {
  const db = new DatabaseSync(file)
  try {
    db.prepare('INSERT INTO thread_spawn_edges (parent_thread_id, child_thread_id, status) VALUES (?, ?, ?)').run(parent, child, status)
  } finally {
    db.close()
  }
}
