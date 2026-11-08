import { copyFile, lstat, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { isNotFound } from '../../core/paths'
import type { ProviderEnv } from '../../core/provider'
import { cleanTitle } from '../text'

export const DB_FILE = 'state_5.sqlite'
const BUSY_TIMEOUT_MS = 5000
const COLUMN_NAME = /^[a-z_]+$/

export type SqlValue = string | number | null
export type Row = Record<string, SqlValue>

/** `CODEX_SQLITE_HOME` moves the databases out of the store. The `sqlite_home` config key is not read. */
export function dbPath(root: string, env: ProviderEnv): string {
  const home = env.env.CODEX_SQLITE_HOME
  return path.join(home ? path.resolve(home) : root, DB_FILE)
}

/**
 * Reads a copy of the database, never the live file. Codex keeps it open in WAL mode, and a read-only
 * open fails without the `-wal` and `-shm` files. The copy leaves out `-shm` on purpose: with no
 * index file, SQLite rebuilds it from the copied WAL instead of trusting a stale one.
 */
export async function withSnapshot<T>(file: string, read: (db: DatabaseSync) => T): Promise<T | null> {
  if (!(await isFile(file))) return null
  const dir = await mkdtemp(path.join(tmpdir(), 'agent-sessions-codex-db-'))
  try {
    const copy = path.join(dir, DB_FILE)
    await copyFile(file, copy)
    await copyFile(`${file}-wal`, `${copy}-wal`).catch((error) => (isNotFound(error) ? undefined : Promise.reject(error)))
    const db = new DatabaseSync(copy)
    try {
      return read(db)
    } finally {
      db.close()
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

export function tableColumns(db: DatabaseSync): Set<string> {
  const rows = db.prepare('PRAGMA table_info(threads)').all() as { name: string }[]
  return new Set(rows.map((row) => row.name).filter((name) => COLUMN_NAME.test(name)))
}

export interface ThreadSummary {
  title: string | null
  name: string | null
  cwd: string | null
  archived: boolean
  updatedMs: number | null
}

export function readThreadSummaries(db: DatabaseSync): Map<string, ThreadSummary> {
  const columns = tableColumns(db)
  const wanted = ['id', 'title', 'name', 'cwd', 'archived', 'updated_at'].filter((name) => columns.has(name))
  const summaries = new Map<string, ThreadSummary>()
  if (!columns.has('id')) return summaries
  for (const row of db.prepare(`SELECT ${wanted.join(', ')} FROM threads`).all() as Row[]) {
    const text = (value: SqlValue | undefined) => (typeof value === 'string' && value !== '' ? value : null)
    summaries.set(String(row.id).toLowerCase(), {
      title: text(row.title) && cleanTitle(String(row.title)),
      name: text(row.name) && cleanTitle(String(row.name)),
      cwd: text(row.cwd),
      archived: row.archived === 1,
      updatedMs: typeof row.updated_at === 'number' ? row.updated_at * 1000 : null,
    })
  }
  return summaries
}

/** The target's `threads` columns and the thread's current row. Null when the store has no table to write. */
export function readTargetRow(db: DatabaseSync, id: string): { columns: Set<string>; current: Row | null } | null {
  const columns = tableColumns(db)
  if (!columns.has('id')) return null
  const current = (db.prepare('SELECT * FROM threads WHERE id = ?').get(id) as Row | undefined) ?? null
  return { columns, current }
}

/**
 * Writes one `threads` row in a short transaction. `prior` null means insert. Otherwise the row must
 * still hold `prior` in every written column, so an update never overwrites a change made since planning.
 */
export interface RowChange {
  db: string
  id: string
  row: Row
  prior: Row | null
}

export async function applyRowChange(change: RowChange): Promise<void> {
  // Opening a missing file would create an empty database in the store.
  if (!(await isFile(change.db))) throw new Error(`${change.db} disappeared after import planned its row`)
  inTransaction(change.db, (db) => {
    const current = selectColumns(db, change.id, Object.keys(change.prior ?? change.row))
    if (change.prior === null) {
      if (current) throw new Error(`Thread ${change.id} got a database row after import planned one`)
      const names = Object.keys(change.row)
      db.prepare(`INSERT INTO threads (${names.map(quote).join(', ')}) VALUES (${names.map(() => '?').join(', ')})`).run(...names.map((n) => change.row[n]))
      return
    }
    if (!current || !sameValues(current, change.prior)) throw new Error(`Thread ${change.id} changed in the database after import planned its update`)
    setColumns(db, change.id, change.row)
  })
}

/** Restores the earlier state only while the row still holds what the import wrote. Safe when apply never ran, and safe twice. */
export async function undoRowChange(change: RowChange): Promise<void> {
  if (!(await isFile(change.db))) return
  inTransaction(change.db, (db) => {
    const current = selectColumns(db, change.id, Object.keys(change.row))
    if (!current || !sameValues(current, change.row)) return
    if (change.prior === null) db.prepare('DELETE FROM threads WHERE id = ?').run(change.id)
    else setColumns(db, change.id, change.prior)
  })
}

function inTransaction(file: string, work: (db: DatabaseSync) => void): void {
  const db = new DatabaseSync(file)
  try {
    db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`)
    db.exec('BEGIN IMMEDIATE')
    try {
      work(db)
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  } finally {
    db.close()
  }
}

function selectColumns(db: DatabaseSync, id: string, names: string[]): Row | null {
  if (names.length === 0) return null
  return (db.prepare(`SELECT ${names.map(quote).join(', ')} FROM threads WHERE id = ?`).get(id) as Row | undefined) ?? null
}

function setColumns(db: DatabaseSync, id: string, values: Row): void {
  const names = Object.keys(values)
  if (names.length === 0) return
  db.prepare(`UPDATE threads SET ${names.map((n) => `${quote(n)} = ?`).join(', ')} WHERE id = ?`).run(...names.map((n) => values[n]), id)
}

function sameValues(current: Row, expected: Row): boolean {
  return Object.keys(expected).every((name) => current[name] === expected[name])
}

export function isRow(value: unknown): value is Row {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  return Object.entries(value).every(([name, v]) => COLUMN_NAME.test(name) && (v === null || typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v))))
}

function quote(name: string): string {
  if (!COLUMN_NAME.test(name)) throw new Error(`Not a threads column: ${name}`)
  return `"${name}"`
}

async function isFile(file: string): Promise<boolean> {
  return lstat(file).then(
    (info) => info.isFile(),
    (error) => (isNotFound(error) ? false : Promise.reject(error)),
  )
}
