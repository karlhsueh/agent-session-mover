import type { ClientKind } from '../../../shared/sessions'
import { type Line, splitLines } from '../../core/streams'
import { GAP, type WindowLine } from '../../core/window'
import { cleanTitle } from '../text'

export interface TranscriptFacts {
  cwds: string[]
  firstMs: number | null
  lastMs: number | null
  customTitle: string | null
  aiTitle: string | null
  firstPrompt: string | null
  entrypoint: string | null
  version: string | null
  gitBranch: string | null
  /**
   * False when the transcript was too long to read whole and its middle was skipped. `cwds` then
   * holds only the folders in the parts read, and a title set only in the middle is missed.
   */
  complete: boolean
}

const CLIENT_BY_ENTRYPOINT: Record<string, ClientKind> = {
  cli: 'cli',
  'claude-desktop': 'desktop',
  'claude-vscode': 'ide',
  'sdk-cli': 'sdk',
  'sdk-ts': 'sdk',
  'sdk-py': 'sdk',
}

export function clientFromEntrypoint(entrypoint: string | null): ClientKind {
  return (entrypoint && CLIENT_BY_ENTRYPOINT[entrypoint]) || 'unknown'
}

/** Entry points that the `/resume` picker and plain `--continue` hide. */
export function isHiddenEntrypoint(entrypoint: string): boolean {
  return entrypoint.startsWith('sdk-')
}

/** Reads complete lines only, so a half-written last line, which belongs to a writer still at work, never counts. */
export async function readFacts(lines: AsyncIterable<WindowLine>): Promise<TranscriptFacts> {
  const facts: TranscriptFacts = {
    cwds: [],
    firstMs: null,
    lastMs: null,
    customTitle: null,
    aiTitle: null,
    firstPrompt: null,
    entrypoint: null,
    version: null,
    gitBranch: null,
    complete: true,
  }
  for await (const line of lines) {
    if (line === GAP) {
      facts.complete = false
      continue
    }
    const record = parseRecord(line)
    if (record) absorb(facts, record)
  }
  return facts
}

function absorb(facts: TranscriptFacts, record: Record<string, unknown>): void {
  if (typeof record.cwd === 'string' && record.cwd !== '' && !facts.cwds.includes(record.cwd)) facts.cwds.push(record.cwd)
  if (typeof record.timestamp === 'string') {
    const ms = Date.parse(record.timestamp)
    if (!Number.isNaN(ms)) {
      facts.firstMs = facts.firstMs === null ? ms : Math.min(facts.firstMs, ms)
      facts.lastMs = facts.lastMs === null ? ms : Math.max(facts.lastMs, ms)
    }
  }
  if (typeof record.entrypoint === 'string' && record.entrypoint !== '' && facts.entrypoint === null) facts.entrypoint = record.entrypoint
  if (typeof record.version === 'string' && record.version !== '') facts.version = record.version
  if (typeof record.gitBranch === 'string' && record.gitBranch !== '') facts.gitBranch = record.gitBranch
  if (record.type === 'custom-title' && typeof record.customTitle === 'string') facts.customTitle = cleanTitle(record.customTitle)
  if (record.type === 'ai-title' && typeof record.aiTitle === 'string') facts.aiTitle = cleanTitle(record.aiTitle)
  if (record.type === 'user' && facts.firstPrompt === null && record.isMeta !== true && record.isSidechain !== true) {
    const prompt = promptText(record.message)
    if (prompt) facts.firstPrompt = cleanTitle(prompt)
  }
}

export function promptText(message: unknown): string | null {
  if (!isObject(message)) return null
  const content = message.content
  let text: string | null = null
  if (typeof content === 'string') text = content
  if (Array.isArray(content)) {
    if (content.some((block) => isObject(block) && block.type === 'tool_result')) return null
    const first = content.find((block) => isObject(block) && block.type === 'text' && typeof block.text === 'string')
    text = first ? (first.text as string) : null
  }
  // Slash commands, hook output, and injected reminders are wrapped in tags. They are not the user's prompt.
  if (!text || text.trimStart().startsWith('<')) return null
  return text
}


export function titleOf(facts: TranscriptFacts): string | null {
  return facts.customTitle ?? facts.aiTitle ?? facts.firstPrompt
}

export function parseRecord(bytes: Buffer): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(bytes.toString('utf8'))
    return isObject(value) ? value : null
  } catch {
    return null
  }
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export interface RewriteRules {
  /** Maps a source working directory, or a path under one, to this machine. Null leaves the value alone. */
  mapCwd: (value: string) => string | null
  /** Source absolute path of each exported store file mapped to its absolute path on this machine. */
  storeFiles: ReadonlyMap<string, string>
}

/**
 * The import transform for transcripts. Rewrites only record `cwd`, `attachment.snapshot.workingDirectory`
 * and `toolUseResult.persistedOutputPath`. Every other line keeps its exact bytes. A line is re-serialized
 * only when `JSON.stringify` reproduces it byte for byte, so no other content in it can shift; otherwise it
 * stays as it was. An unparsable final line is dropped, and a final line missing its newline gets one.
 */
export function rewriteTranscript(rules: RewriteRules): (input: AsyncIterable<Buffer>) => AsyncGenerator<Buffer> {
  return async function* (input) {
    let previous: Line | null = null
    for await (const line of splitLines(input)) {
      if (previous) yield* emit(previous, rules)
      previous = line
    }
    if (previous && parseRecord(previous.bytes) !== null) yield* emit({ bytes: previous.bytes, terminated: true }, rules)
  }
}

const NEWLINE = Buffer.from('\n')

function* emit(line: Line, rules: RewriteRules): Generator<Buffer> {
  yield rewriteLine(line.bytes, rules)
  if (line.terminated) yield NEWLINE
}

function rewriteLine(bytes: Buffer, rules: RewriteRules): Buffer {
  const record = parseRecord(bytes)
  if (!record) return bytes
  const edits: (() => void)[] = []
  const plan = (holder: Record<string, unknown>, key: string, map: (value: string) => string | null | undefined) => {
    const value = holder[key]
    if (typeof value !== 'string') return
    const mapped = map(value)
    if (mapped != null && mapped !== value) edits.push(() => (holder[key] = mapped))
  }
  plan(record, 'cwd', rules.mapCwd)
  const attachment = record.attachment
  if (isObject(attachment) && isObject(attachment.snapshot)) plan(attachment.snapshot, 'workingDirectory', rules.mapCwd)
  if (isObject(record.toolUseResult)) plan(record.toolUseResult, 'persistedOutputPath', (value) => rules.storeFiles.get(value))
  if (edits.length === 0) return bytes

  const text = bytes.toString('utf8')
  if (!Buffer.from(text, 'utf8').equals(bytes) || JSON.stringify(record) !== text) return bytes
  for (const edit of edits) edit()
  return Buffer.from(JSON.stringify(record), 'utf8')
}
