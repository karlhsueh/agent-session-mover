import { stat } from 'node:fs/promises'
import { readRange, splitLines } from './streams'

const MiB = 1024 * 1024

/**
 * How much of a transcript a reader parses. A transcript up to `maxBytes` is read whole. A longer one
 * is read as its first `maxBytes - tailBytes` and its last `tailBytes`, so no read parses more than `maxBytes`.
 */
export interface ReadBudget {
  maxBytes: number
  tailBytes: number
}

/** Parsing every line of a 36 MB transcript took about 50 ms, so most previews read the whole file. */
export const PREVIEW_BUDGET: ReadBudget = { maxBytes: 64 * MiB, tailBytes: 4 * MiB }

/**
 * Listing reads every session, so it stops at half the preview budget. A session's start (id, first
 * prompt, first cwd, client) sits in the head and its latest activity in the tail.
 */
export const LIST_BUDGET: ReadBudget = { maxBytes: 32 * MiB, tailBytes: 4 * MiB }

/** A plain file is read by range. A stream, such as decompressed bytes, is read from start to end. */
export type TranscriptSource = { kind: 'file'; absPath: string } | { kind: 'stream'; chunks: AsyncIterable<Buffer> }

/** Marks where a window skipped the middle of a transcript. */
export const GAP = Symbol('gap')
export type WindowLine = Buffer | typeof GAP

/**
 * The complete lines of a transcript within `budget`, with `GAP` where the middle was skipped. A
 * half-written last line is left out, like the cut lines at either edge of a window.
 */
export function readWindow(source: TranscriptSource, budget: ReadBudget): AsyncGenerator<WindowLine> {
  return source.kind === 'file' ? fileWindow(source.absPath, budget) : streamWindow(source.chunks, budget)
}

/** Every complete line of a byte stream, for a reader that needs them all. */
export async function* terminatedLines(chunks: AsyncIterable<Buffer>): AsyncGenerator<Buffer> {
  for await (const line of splitLines(chunks)) if (line.terminated) yield line.bytes
}

async function* fileWindow(absPath: string, budget: ReadBudget): AsyncGenerator<WindowLine> {
  const { size } = await stat(absPath)
  if (size <= budget.maxBytes) {
    yield* terminatedLines(readRange(absPath, size))
    return
  }
  yield* terminatedLines(readRange(absPath, budget.maxBytes - budget.tailBytes))
  yield GAP
  // One byte before the tail tells whether its first line starts there or is a cut-off end.
  const start = size - budget.tailBytes - 1
  let first = true
  for await (const line of terminatedLines(readRange(absPath, budget.tailBytes + 1, start))) {
    if (!first) yield line
    first = false
  }
}

/** Every byte passes through, but only the head and the newest `tailBytes` of lines reach the reader. */
async function* streamWindow(chunks: AsyncIterable<Buffer>, budget: ReadBudget): AsyncGenerator<WindowLine> {
  const headLimit = budget.maxBytes - budget.tailBytes
  let head = 0
  let inTail = false
  const tail: Buffer[] = []
  let tailSize = 0
  let dropped = false
  for await (const line of terminatedLines(chunks)) {
    if (!inTail && head + line.length + 1 <= headLimit) {
      head += line.length + 1
      yield line
      continue
    }
    inTail = true
    tail.push(line)
    tailSize += line.length + 1
    while (tailSize > budget.tailBytes) {
      tailSize -= tail.shift()!.length + 1
      dropped = true
    }
  }
  if (dropped) yield GAP
  yield* tail
}
