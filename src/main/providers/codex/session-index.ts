import { createReadStream } from 'node:fs'
import { appendFile, lstat, open, readFile, unlink } from 'node:fs/promises'
import path from 'node:path'
import { isNotFound } from '../../core/paths'
import { splitLines } from '../../core/streams'
import { cleanTitle } from '../text'
import { parseObject } from './facts'

export const INDEX_FILE = 'session_index.jsonl'
const MAX_LINE = 64 * 1024

export interface IndexLine {
  absPath: string
  /** Byte offset of the line, so export can carry it as its own blob. */
  start: number
  /** Length including the newline. */
  length: number
  mtimeMs: number
}

/** Each line is `{id, thread_name, updated_at}`. A later line for the same id renames the thread. */
export async function readIndex(root: string): Promise<{ names: Map<string, string>; lines: Map<string, IndexLine> }> {
  const absPath = path.join(root, INDEX_FILE)
  const names = new Map<string, string>()
  const lines = new Map<string, IndexLine>()
  const info = await lstat(absPath).catch((error) => (isNotFound(error) ? null : Promise.reject(error)))
  if (!info?.isFile()) return { names, lines }
  let start = 0
  for await (const line of splitLines(createReadStream(absPath) as AsyncIterable<Buffer>)) {
    const length = line.bytes.length + 1
    const entry = line.terminated ? parseEntry(line.bytes) : null
    if (entry) {
      lines.set(entry.id, { absPath, start, length, mtimeMs: info.mtimeMs })
      const name = cleanTitle(entry.name)
      if (name) names.set(entry.id, name)
    }
    start += length
  }
  return { names, lines }
}

function parseEntry(bytes: Buffer): { id: string; name: string } | null {
  const record = parseObject(bytes)
  if (!record || typeof record.id !== 'string' || typeof record.thread_name !== 'string') return null
  return { id: record.id.toLowerCase(), name: record.thread_name }
}

/** An index entry from an archive: one JSON line for this thread, newline included. Null when it is anything else. */
export function parseIndexBlob(bytes: Buffer, id: string): string | null {
  if (bytes.length > MAX_LINE || bytes.at(-1) !== 0x0a) return null
  const body = bytes.subarray(0, -1)
  if (body.includes(0x0a) || body.includes(0x0d)) return null
  const entry = parseEntry(body)
  if (!entry || entry.id !== id) return null
  return body.toString('utf8')
}

/** Null when the index file does not exist. */
export async function hasLine(root: string, line: string): Promise<boolean | null> {
  const text = await readFile(path.join(root, INDEX_FILE), 'utf8').catch((error) => (isNotFound(error) ? null : Promise.reject(error)))
  return text === null ? null : text.split('\n').includes(line)
}

/** Appends the line unless it is already there. Refuses a file whose last line is unfinished, since a writer is mid-append. */
export async function appendIndexLine(root: string, line: string): Promise<void> {
  const file = path.join(root, INDEX_FILE)
  const text = await readFile(file, 'utf8').catch((error) => (isNotFound(error) ? '' : Promise.reject(error)))
  if (text.split('\n').includes(line)) return
  if (text !== '' && !text.endsWith('\n')) throw new Error(`${INDEX_FILE} ends with an unfinished line`)
  await appendFile(file, line + '\n')
}

/** Removes the line only when it is the file's last line, which is where the append put it. */
export async function removeIndexLine(root: string, line: string, createdFile: boolean): Promise<void> {
  const file = path.join(root, INDEX_FILE)
  const tail = Buffer.from(line + '\n', 'utf8')
  const handle = await open(file, 'r+').catch((error) => (isNotFound(error) ? null : Promise.reject(error)))
  if (!handle) return
  try {
    const { size } = await handle.stat()
    if (size < tail.length) return
    const end = Buffer.alloc(tail.length)
    await handle.read(end, 0, tail.length, size - tail.length)
    const before = Buffer.alloc(1)
    if (size > tail.length) await handle.read(before, 0, 1, size - tail.length - 1)
    if (!end.equals(tail) || (size > tail.length && before[0] !== 0x0a)) return
    await handle.truncate(size - tail.length)
    if (createdFile && size === tail.length) await unlink(file)
  } finally {
    await handle.close()
  }
}
