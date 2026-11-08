import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { open } from 'node:fs/promises'
import type { Sha256 } from './manifest'

export async function* readRange(absPath: string, length: number): AsyncGenerator<Buffer> {
  if (length === 0) return
  for await (const chunk of createReadStream(absPath, { start: 0, end: length - 1 })) yield chunk as Buffer
}

export interface Digest {
  sha256: Sha256
  size: number
  /** Hash of the first `prefixAt` bytes, when the stream reached that length. */
  prefixSha256: Sha256 | null
}

export async function digest(chunks: AsyncIterable<Buffer>, prefixAt?: number): Promise<Digest> {
  const full = createHash('sha256')
  const prefix = prefixAt === undefined ? null : createHash('sha256')
  let size = 0
  let prefixSha256: Sha256 | null = prefix && prefixAt === 0 ? (prefix.digest('hex') as Sha256) : null
  for await (const chunk of chunks) {
    if (prefix && prefixSha256 === null && prefixAt !== undefined) {
      const take = Math.min(chunk.length, prefixAt - size)
      prefix.update(chunk.subarray(0, take))
      if (size + take === prefixAt) prefixSha256 = prefix.digest('hex') as Sha256
    }
    full.update(chunk)
    size += chunk.length
  }
  return { sha256: full.digest('hex') as Sha256, size, prefixSha256 }
}

export async function sha256File(absPath: string): Promise<Sha256> {
  return (await digest(createReadStream(absPath) as AsyncIterable<Buffer>)).sha256
}

export interface Line {
  bytes: Buffer
  /** False only for a final fragment with no newline after it. */
  terminated: boolean
}

/** Splits a byte stream on `\n`. The yielded bytes exclude the newline. */
export async function* splitLines(chunks: AsyncIterable<Buffer>): AsyncGenerator<Line> {
  let pending: Buffer[] = []
  for await (const chunk of chunks) {
    let start = 0
    for (let newline = chunk.indexOf(0x0a); newline !== -1; newline = chunk.indexOf(0x0a, start)) {
      pending.push(chunk.subarray(start, newline))
      yield { bytes: pending.length === 1 ? pending[0] : Buffer.concat(pending), terminated: true }
      pending = []
      start = newline + 1
    }
    if (start < chunk.length) pending.push(chunk.subarray(start))
  }
  if (pending.length > 0) yield { bytes: Buffer.concat(pending), terminated: false }
}

/** Length of the file up to and including its last newline, so a half-written last line is left out. */
export async function lengthToLastNewline(absPath: string, size: number): Promise<number> {
  const handle = await open(absPath, 'r')
  try {
    const block = Buffer.alloc(64 * 1024)
    let end = size
    while (end > 0) {
      const start = Math.max(0, end - block.length)
      const { bytesRead } = await handle.read(block, 0, end - start, start)
      const index = block.subarray(0, bytesRead).lastIndexOf(0x0a)
      if (index !== -1) return start + index + 1
      end = start
    }
    return 0
  } finally {
    await handle.close()
  }
}
