import type { PreviewMessage } from '../../../shared/sessions'
import { type PreviewBudget, previewText, readPreview, relativeTo, toolEntry, type TranscriptFile, type TranscriptPreview } from '../../core/preview'
import { isObject, parseRecord } from './transcript'

type Input = Record<string, unknown>

/** The verb a tool entry starts with and the input field that says most about the call. */
const TOOLS: Record<string, { verb: string; field?: string }> = {
  Read: { verb: 'Read', field: 'file_path' },
  Write: { verb: 'Wrote', field: 'file_path' },
  Edit: { verb: 'Edited', field: 'file_path' },
  MultiEdit: { verb: 'Edited', field: 'file_path' },
  NotebookEdit: { verb: 'Edited', field: 'notebook_path' },
  Bash: { verb: 'Ran', field: 'command' },
  Grep: { verb: 'Searched for', field: 'pattern' },
  Glob: { verb: 'Listed', field: 'pattern' },
  WebFetch: { verb: 'Fetched', field: 'url' },
  WebSearch: { verb: 'Searched the web for', field: 'query' },
  Agent: { verb: 'Started an agent:', field: 'description' },
  Task: { verb: 'Started an agent:', field: 'description' },
  Skill: { verb: 'Used skill', field: 'skill' },
  TodoWrite: { verb: 'Updated the todo list' },
  AskUserQuestion: { verb: 'Asked a question' },
}
const TELLING_FIELDS = ['file_path', 'path', 'command', 'pattern', 'url', 'query', 'description', 'prompt']
const PATH_FIELDS = new Set(['file_path', 'notebook_path', 'path'])

export function previewClaudeTranscript(file: TranscriptFile, budget?: PreviewBudget): Promise<TranscriptPreview> {
  return readPreview({ kind: 'file', absPath: file.absPath }, claudeEntries, budget)
}

/** One Claude Code transcript line as Conversation entries. Meta, sidechain, and tool-result records give none. */
export function claudeEntries(line: Buffer): PreviewMessage[] {
  const record = parseRecord(line)
  if (!record || record.isMeta === true || record.isSidechain === true || record.isCompactSummary === true) return []
  if (!isObject(record.message)) return []
  const at = typeof record.timestamp === 'string' ? record.timestamp : null
  const content = record.message.content
  if (record.type === 'user') {
    const text = userText(content)
    return text ? [{ kind: 'user', text, at }] : []
  }
  if (record.type !== 'assistant' || !Array.isArray(content)) return []
  const cwd = typeof record.cwd === 'string' ? record.cwd : null
  const entries: PreviewMessage[] = []
  let texts: string[] = []
  const flush = () => {
    const text = previewText(texts.join('\n'))
    if (text) entries.push({ kind: 'assistant', text, at })
    texts = []
  }
  for (const block of content) {
    if (!isObject(block)) continue
    if (block.type === 'text' && typeof block.text === 'string') texts.push(block.text)
    if (block.type === 'tool_use' && typeof block.name === 'string') {
      flush()
      entries.push(toolEntry(block.name, toolSummary(block.name, isObject(block.input) ? block.input : {}, cwd), at))
    }
  }
  flush()
  return entries
}

/** The prompt text of a user record. Tool results and tag-wrapped text (commands, hooks, reminders) are not prompts. */
function userText(content: unknown): string | null {
  if (typeof content === 'string') return isTagged(content) ? null : previewText(content)
  if (!Array.isArray(content) || content.some((block) => isObject(block) && block.type === 'tool_result')) return null
  const texts = content.filter((block): block is { text: string } => isObject(block) && block.type === 'text' && typeof block.text === 'string' && !isTagged(block.text))
  return previewText(texts.map((block) => block.text).join('\n'))
}

function isTagged(text: string): boolean {
  return text.trimStart().startsWith('<')
}

function toolSummary(name: string, input: Input, cwd: string | null): string {
  const known = Object.hasOwn(TOOLS, name) ? TOOLS[name] : undefined
  const field = known ? known.field : TELLING_FIELDS.find((key) => typeof input[key] === 'string' && input[key] !== '')
  const value = field && typeof input[field] === 'string' ? (input[field] as string) : null
  const shown = value && field && PATH_FIELDS.has(field) ? relativeTo(value, cwd) : value
  return [known?.verb ?? name, shown].filter(Boolean).join(' ')
}
