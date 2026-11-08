import { stat } from 'node:fs/promises'
import type { PreviewCounts, PreviewMessage, SessionPreview } from '../../shared/sessions'
import type { StorePath } from './paths'
import { readRange, splitLines } from './streams'

const MiB = 1024 * 1024

/**
 * How much of a transcript preview parses. A transcript up to `maxBytes` is read whole, so its counts
 * are exact. A longer one is read as its first `maxBytes - tailBytes` and its last `tailBytes`.
 */
export interface PreviewBudget {
  maxBytes: number
  tailBytes: number
}

/** Parsing every line of a 36 MB transcript took about 50 ms, so most sessions are read whole. */
export const PREVIEW_BUDGET: PreviewBudget = { maxBytes: 64 * MiB, tailBytes: 4 * MiB }

/** A session's main transcript: a file in a store, or a staged archive blob with the store path it came from. */
export interface TranscriptFile {
  absPath: string
  /** Store-relative, so a provider can tell the file's form from its name. */
  path: StorePath
}

/** A plain file is read by range. A stream, such as decompressed bytes, is read from start to end. */
export type TranscriptSource = { kind: 'file'; absPath: string } | { kind: 'stream'; chunks: AsyncIterable<Buffer> }

/** Turns one transcript line into the entries it shows. A line that is not part of the conversation gives none. */
export type EntryReader = (line: Buffer) => PreviewMessage[]

export interface TranscriptPreview {
  preview: SessionPreview
  /** Plain transcript bytes handed to the reader. */
  scannedBytes: number
}

const RECENT = 24
const TEXT_LIMIT = 600
const SUMMARY_LIMIT = 160

const GAP = Symbol('gap')

export async function readPreview(source: TranscriptSource, reader: EntryReader, budget: PreviewBudget = PREVIEW_BUDGET): Promise<TranscriptPreview> {
  const builder = previewBuilder()
  let scannedBytes = 0
  const lines = source.kind === 'file' ? fileWindow(source.absPath, budget) : streamWindow(source.chunks, budget)
  for await (const line of lines) {
    if (line === GAP) {
      builder.gap()
      continue
    }
    scannedBytes += line.length + 1
    let entries: PreviewMessage[] = []
    try {
      entries = reader(line)
    } catch {
      // A record shape no reader expected is skipped like any other unknown record.
    }
    for (const entry of entries) builder.add(entry)
  }
  return { preview: builder.finish(), scannedBytes }
}

async function* terminatedLines(chunks: AsyncIterable<Buffer>): AsyncGenerator<Buffer> {
  for await (const line of splitLines(chunks)) if (line.terminated) yield line.bytes
}

/** A half-written last line is left out, like the cut lines at either edge of a window. */
async function* fileWindow(absPath: string, budget: PreviewBudget): AsyncGenerator<Buffer | typeof GAP> {
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
async function* streamWindow(chunks: AsyncIterable<Buffer>, budget: PreviewBudget): AsyncGenerator<Buffer | typeof GAP> {
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

function previewBuilder() {
  let first: PreviewMessage | null = null
  let recent: PreviewMessage[] = []
  const counts = noCounts()
  const omitted = noCounts()
  let complete = true
  return {
    add(entry: PreviewMessage) {
      tally(counts, entry)
      if (!first) {
        first = entry
        return
      }
      recent.push(entry)
      if (recent.length > RECENT) tally(omitted, recent.shift()!)
    },
    gap() {
      complete = false
      for (const entry of recent) tally(omitted, entry)
      recent = []
    },
    finish(): SessionPreview {
      if (!first) return { kind: 'unavailable', reason: complete ? 'The transcript holds no messages to show.' : 'No messages were found in the parts of this long transcript that preview reads.' }
      return { kind: 'ok', first, recent, omitted, counts, complete }
    },
  }
}

function noCounts(): PreviewCounts {
  return { messages: 0, toolCalls: 0 }
}

function tally(counts: PreviewCounts, entry: PreviewMessage): void {
  if (entry.kind === 'tool') counts.toolCalls += 1
  else counts.messages += 1
}

/** Collapses whitespace and caps the length. Null when nothing is left. */
export function previewText(raw: string, limit = TEXT_LIMIT): string | null {
  // Only the start is ever shown, so a pasted log of megabytes is not collapsed whole.
  const cut = raw.length > limit * 4
  const text = (cut ? raw.slice(0, limit * 4) : raw).replace(/\s+/g, ' ').trim()
  if (text === '') return null
  if (text.length <= limit && !cut) return text
  let end = Math.min(limit - 1, text.length)
  const code = text.charCodeAt(end - 1)
  if (code >= 0xd800 && code <= 0xdbff) end -= 1
  return `${text.slice(0, end).trimEnd()}…`
}

/** The first line of a command or patch, capped for a one-line tool entry. */
export function summaryText(raw: string): string | null {
  const line = raw.trim().split(/\r?\n/, 1)[0] ?? ''
  return previewText(line, SUMMARY_LIMIT)
}

export function toolEntry(name: string, summary: string, at: string | null): PreviewMessage {
  return { kind: 'tool', name, summary: summaryText(summary) ?? name, at }
}

/** A path under the session's folder is shown relative to it. */
export function relativeTo(target: string, cwd: string | null): string {
  if (!cwd) return target
  const base = cwd.replace(/[\\/]+$/, '')
  return target.startsWith(base) && /[\\/]/.test(target.charAt(base.length)) ? target.slice(base.length + 1) : target
}
