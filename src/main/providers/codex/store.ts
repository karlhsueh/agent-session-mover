import { createReadStream } from 'node:fs'
import { lstat, readdir } from 'node:fs/promises'
import path from 'node:path'
import { pipeline, Readable } from 'node:stream'
import { createZstdDecompress } from 'node:zlib'
import { isNotFound, joinStorePath, parseStorePath, type StorePath } from '../../core/paths'
import type { ContentTransform } from '../../core/provider'
import { splitLines } from '../../core/streams'
import type { TranscriptSource } from '../../core/window'
import { isNewer, parseRolloutName, type RolloutName } from './rollout-name'

export const SESSIONS_DIR = 'sessions'
export const ARCHIVED_DIR = 'archived_sessions'
export const IMAGES_DIR = 'generated_images'
const LOCKS_DIR = 'thread-writer-locks'
const LOCK = /^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\.lock$/

export interface RolloutFile {
  name: RolloutName
  /** Store-relative path of the file as it is on disk, compressed or not. */
  rel: StorePath
  absPath: string
  archived: boolean
  size: number
  mtimeMs: number
}

/**
 * Every rollout under `sessions/` and `archived_sessions/`, at any depth, as Codex walks them. A
 * compressed file with a plain sibling is skipped, because Codex reads the plain one.
 */
export async function findRollouts(root: string): Promise<RolloutFile[]> {
  const found: RolloutFile[] = []
  for (const top of [SESSIONS_DIR, ARCHIVED_DIR]) {
    const stack: string[][] = [[top]]
    while (stack.length > 0) {
      const segments = stack.pop()!
      const dir = path.join(root, ...segments)
      const names = await listNames(dir)
      for (const entry of names) {
        if (!parseStorePath(entry)) continue
        const absPath = path.join(dir, entry)
        const info = await lstat(absPath).catch((error) => (isNotFound(error) ? null : Promise.reject(error)))
        if (info?.isDirectory()) stack.push([...segments, entry])
        if (!info?.isFile()) continue
        const name = parseRolloutName(entry)
        if (!name || (name.compressed && names.includes(name.plain))) continue
        found.push({ name, rel: joinStorePath(...segments, entry), absPath, archived: top === ARCHIVED_DIR, size: info.size, mtimeMs: info.mtimeMs })
      }
    }
  }
  return found
}

export function newestByThread(files: readonly RolloutFile[]): Map<string, RolloutFile> {
  const byThread = new Map<string, RolloutFile>()
  for (const file of files) {
    const known = byThread.get(file.name.threadId)
    if (!known || isNewer(file.name, known.name)) byThread.set(file.name.threadId, file)
  }
  return byThread
}

/** Codex follows `history_base` by rollout id and looks in `sessions/` before `archived_sessions/`. */
export function byRolloutId(files: readonly RolloutFile[]): Map<string, RolloutFile> {
  const byId = new Map<string, RolloutFile>()
  for (const file of [...files.filter((f) => !f.archived), ...files.filter((f) => f.archived)]) {
    if (!byId.has(file.name.rolloutId)) byId.set(file.name.rolloutId, file)
  }
  return byId
}

/**
 * Threads with a writer lock file. Codex holds an exclusive lock on the file while it writes, deletes
 * the file when the writer stops, and sweeps stale files at startup. Node cannot probe the lock, so
 * the file's existence is the signal. A crash can leave a stale file until Codex starts again, which
 * makes import refuse a session that is not open. That is the safe direction.
 */
export async function lockedThreadIds(root: string): Promise<Set<string>> {
  const ids = new Set<string>()
  for (const name of await listNames(path.join(root, LOCKS_DIR))) {
    const match = LOCK.exec(name)
    if (match) ids.add(match[1].toLowerCase())
  }
  return ids
}

export interface PlainFile {
  name: string
  absPath: string
  size: number
  mtimeMs: number
}

/** Regular files directly inside `generated_images/<threadId>/`. Dotfiles and symlinks are skipped. */
export async function generatedImages(root: string, threadId: string): Promise<PlainFile[]> {
  const dir = path.join(root, IMAGES_DIR, threadId)
  const files: PlainFile[] = []
  for (const name of await listNames(dir)) {
    if (name.startsWith('.') || !parseStorePath(name)) continue
    const absPath = path.join(dir, name)
    const info = await lstat(absPath)
    if (info.isFile()) files.push({ name, absPath, size: info.size, mtimeMs: info.mtimeMs })
  }
  return files
}

/**
 * Real rollouts compress about 8 to 1. A stream that expands far past that is a zstd bomb from a
 * crafted archive, and decoding it would fill the disk, so it stops with an error instead.
 */
const MAX_EXPANSION = 64
const EXPANSION_FLOOR = 64 * 1024 * 1024

/** Streams zstd-compressed bytes as the plain bytes they hold. Deterministic, so it can be a `ContentTransform`. */
export const unzstd: ContentTransform = (input) => {
  let consumed = 0
  const counted = (async function* () {
    for await (const chunk of input) {
      consumed += chunk.length
      yield chunk
    }
  })()
  const decoder = createZstdDecompress()
  pipeline(Readable.from(counted), decoder, () => {})
  return (async function* () {
    let produced = 0
    for await (const chunk of decoder as AsyncIterable<Buffer>) {
      produced += chunk.length
      if (produced > EXPANSION_FLOOR + MAX_EXPANSION * consumed) throw new Error(`The compressed data expands more than ${MAX_EXPANSION} times its size.`)
      yield chunk
    }
  })()
}

/** The rollout's plain bytes, whichever form it is stored in. */
export function readRollout(file: RolloutFile): AsyncIterable<Buffer> {
  const raw = createReadStream(file.absPath) as AsyncIterable<Buffer>
  return file.name.compressed ? unzstd(raw) : raw
}

/** A plain rollout is read by range. A compressed one has no random access, so it streams through zstd. */
export function rolloutSource(file: RolloutFile): TranscriptSource {
  return file.name.compressed ? { kind: 'stream', chunks: readRollout(file) } : { kind: 'file', absPath: file.absPath }
}

export async function readFirstLine(file: RolloutFile): Promise<Buffer | null> {
  for await (const line of splitLines(readRollout(file))) return line.bytes
  return null
}

/**
 * Runs a read once more when a file vanished under it. Codex compresses an idle rollout and turns it
 * back into plain text on the next write, so a path can disappear between the scan and the read.
 */
export async function retryOnFlip<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read()
  } catch (error) {
    if (!isNotFound(error)) throw error
    return read()
  }
}

export async function listNames(dir: string): Promise<string[]> {
  try {
    return await readdir(dir)
  } catch (error) {
    if (isNotFound(error) || (error as NodeJS.ErrnoException).code === 'ENOTDIR') return []
    throw error
  }
}
