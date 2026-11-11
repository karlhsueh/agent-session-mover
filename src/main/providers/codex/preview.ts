import { createReadStream } from 'node:fs'
import type { PreviewMessage } from '../../../shared/sessions'
import { type EntryReader, previewText, readPreview, relativeTo, toolEntry, type TranscriptFile, type TranscriptPreview } from '../../core/preview'
import type { ReadBudget } from '../../core/window'
import { isObject, parseObject, sessionMeta, str } from './facts'
import { unzstd } from './store'

/** A compressed rollout has no random access, so it streams through zstd and only its window is parsed. */
export async function previewRollout(file: TranscriptFile, budget?: ReadBudget): Promise<TranscriptPreview> {
  if (!file.path.endsWith('.zst')) return readPreview({ kind: 'file', absPath: file.absPath }, codexEntries(), budget)
  try {
    return await readPreview({ kind: 'stream', chunks: unzstd(createReadStream(file.absPath) as AsyncIterable<Buffer>) }, codexEntries(), budget)
  } catch (error) {
    if (!String((error as NodeJS.ErrnoException).code).startsWith('ZSTD_')) throw error
    return { preview: { kind: 'unavailable', reason: 'The compressed transcript is damaged.' }, scannedBytes: 0, lines: 0 }
  }
}

type Payload = Record<string, unknown>
type Summarize = (args: Payload, cwd: string | null) => string

/** The text of each message part of `partType`. Injected context (environment, AGENTS.md, skills) is wrapped in tags. */
function messageText(content: unknown, partType: string, skipTagged: boolean): string | null {
  if (!Array.isArray(content)) return null
  const texts = content
    .filter((part): part is { text: string } => isObject(part) && part.type === partType && typeof part.text === 'string')
    .map((part) => part.text)
    .filter((text) => !(skipTagged && text.trimStart().startsWith('<')))
  return previewText(texts.join('\n'))
}

/** `bash -lc "<script>"` shows as the script. */
function commandLine(command: unknown): string | null {
  if (typeof command === 'string') return command
  if (!Array.isArray(command) || !command.every((part) => typeof part === 'string')) return null
  const [shell, flag, script] = command as string[]
  if (command.length === 3 && /(^|\/)(ba|z)?sh$/.test(shell ?? '') && (flag === '-lc' || flag === '-c')) return script ?? null
  return command.join(' ')
}

function patchedFiles(patch: string, cwd: string | null): string {
  const files = [...patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)].map((match) => relativeTo(match[1]!.trim(), cwd))
  return files.length > 0 ? `Edited ${files.join(', ')}` : 'Edited files'
}

/** Code-mode `exec` runs a script that calls tools. Its first `cmd` literal says most about it. */
function codeSummary(code: string): string {
  if (code.startsWith('*** Begin Patch')) return patchedFiles(code, null)
  const command = /\bcmd\s*:\s*(["'`])((?:\\.|(?!\1)[^\\])*)\1/.exec(code)
  if (command) return `Ran ${command[2]!.replace(/\\(.)/g, '$1')}`
  const tools = [...new Set([...code.matchAll(/\btools\.(\w+)\s*\(/g)].map((match) => match[1]))]
  return tools.length > 0 ? `Ran code calling ${tools.join(', ')}` : 'Ran code'
}

const FUNCTIONS: Record<string, Summarize> = {
  exec_command: (args) => `Ran ${commandLine(args.cmd) ?? ''}`,
  shell: (args) => `Ran ${commandLine(args.command) ?? ''}`,
  'container.exec': (args) => `Ran ${commandLine(args.command) ?? ''}`,
  apply_patch: (args, cwd) => patchedFiles(str(args.input) ?? '', cwd),
  view_image: (args, cwd) => `Viewed ${relativeTo(str(args.path) ?? 'an image', cwd)}`,
  update_plan: () => 'Updated the plan',
  spawn_agent: (args) => `Started an agent: ${str(args.task_name) ?? str(args.message) ?? ''}`,
  send_message: (args) => `Messaged ${str(args.target) ?? 'an agent'}`,
  write_stdin: () => 'Wrote to a running command',
}
const TELLING_ARGS = ['path', 'file', 'cmd', 'command', 'query', 'url', 'pattern', 'title']

function functionSummary(name: string, args: Payload, cwd: string | null): string {
  const known = Object.hasOwn(FUNCTIONS, name) ? FUNCTIONS[name] : undefined
  if (known) return known(args, cwd)
  const key = TELLING_ARGS.find((candidate) => str(args[candidate])) ?? Object.keys(args).find((candidate) => str(args[candidate]))
  return [name, key && str(args[key])].filter(Boolean).join(' ')
}

function searchSummary(action: unknown): string {
  if (!isObject(action)) return 'Searched the web'
  if (action.type === 'open_page' && str(action.url)) return `Opened ${action.url}`
  if (action.type === 'find_in_page' && str(action.pattern)) return `Searched the page for ${action.pattern}`
  const query = str(action.query) ?? (Array.isArray(action.queries) ? str(action.queries[0]) : null)
  return query ? `Searched the web for ${query}` : 'Searched the web'
}

function parseArgs(value: unknown): Payload {
  if (isObject(value)) return value
  if (typeof value !== 'string') return {}
  const parsed = parseObject(Buffer.from(value))
  return parsed ?? { input: value }
}

function itemEntries(payload: Payload, at: string | null, cwd: string | null): PreviewMessage[] {
  const name = str(payload.name) ?? payload.type
  switch (payload.type) {
    case 'message': {
      const text = payload.role === 'user' ? messageText(payload.content, 'input_text', true) : payload.role === 'assistant' ? messageText(payload.content, 'output_text', false) : null
      return text ? [{ kind: payload.role as 'user' | 'assistant', text, at }] : []
    }
    case 'agent_message': {
      const text = messageText(payload.content, 'input_text', false)
      return text ? [{ kind: 'user', text, at }] : []
    }
    case 'function_call':
      return [toolEntry(String(name), functionSummary(String(name), parseArgs(payload.arguments), cwd), at)]
    case 'custom_tool_call': {
      const input = str(payload.input) ?? ''
      const summary = name === 'apply_patch' ? patchedFiles(input, cwd) : name === 'exec' ? codeSummary(input) : `${name} ${input}`
      return [toolEntry(String(name), summary, at)]
    }
    case 'local_shell_call':
      return [toolEntry('shell', `Ran ${commandLine(isObject(payload.action) ? payload.action.command : null) ?? ''}`, at)]
    case 'web_search_call':
      return [toolEntry('web_search', searchSummary(payload.action), at)]
    default:
      return []
  }
}

/**
 * A reader for one rollout. Only `response_item` records count, since `event_msg` repeats them. A
 * subagent's rollout starts with a copy of its parent's history, which is skipped by ordinal.
 */
export function codexEntries(): EntryReader {
  let started = false
  let historyStart = 0
  let cwd: string | null = null
  return (line) => {
    const record = parseObject(line)
    if (!record || !isObject(record.payload)) return []
    const payload = record.payload
    if (record.type === 'session_meta') {
      if (!started) {
        const meta = sessionMeta(payload)
        historyStart = meta?.historyStart ?? 0
        cwd = meta?.cwd ?? null
      }
      started = true
      return []
    }
    if (typeof record.ordinal === 'number' && record.ordinal < historyStart) return []
    if (record.type === 'turn_context') cwd = str(payload.cwd) ?? cwd
    if (record.type !== 'response_item') return []
    return itemEntries(payload, str(record.timestamp), cwd)
  }
}
