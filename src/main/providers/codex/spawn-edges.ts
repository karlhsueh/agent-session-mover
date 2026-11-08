import type { DatabaseSync } from 'node:sqlite'
import { inTransaction, isFile } from './state-db'

/**
 * Codex records which thread spawned which in `thread_spawn_edges`, and reads it to reopen a parent's
 * subagents on resume. Whenever Codex writes a thread row it also inserts that thread's edge from the
 * row's `source` with status `open`, unless one exists (`insert_thread_spawn_edge_from_source_if_absent`
 * in `state/src/runtime/threads.rs`, Codex 0.162.1). Import writes rows itself, so it adds the edge the
 * same way.
 */
export const OPEN = 'open'

export interface EdgeChange {
  db: string
  parent: string
  child: string
}

/** Null when the database has no edge table. */
export function readEdge(db: DatabaseSync, child: string): 'absent' | 'present' | null {
  const table = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'thread_spawn_edges'").get()
  if (!table) return null
  return db.prepare('SELECT 1 FROM thread_spawn_edges WHERE child_thread_id = ?').get(child) ? 'present' : 'absent'
}

export async function applyEdge(change: EdgeChange): Promise<void> {
  if (!(await isFile(change.db))) throw new Error(`${change.db} disappeared after import planned its spawn edge`)
  inTransaction(change.db, (db) => {
    if (db.prepare('SELECT 1 FROM thread_spawn_edges WHERE child_thread_id = ?').get(change.child)) {
      throw new Error(`Thread ${change.child} got a spawn edge after import planned one`)
    }
    db.prepare('INSERT INTO thread_spawn_edges (parent_thread_id, child_thread_id, status) VALUES (?, ?, ?)').run(change.parent, change.child, OPEN)
  })
}

/** Deletes the edge only while it is the one import wrote. Safe when apply never ran, and safe twice. */
export async function undoEdge(change: EdgeChange): Promise<void> {
  if (!(await isFile(change.db))) return
  inTransaction(change.db, (db) => {
    if (readEdge(db, change.child) === null) return
    db.prepare('DELETE FROM thread_spawn_edges WHERE child_thread_id = ? AND parent_thread_id = ? AND status = ?').run(change.child, change.parent, OPEN)
  })
}
