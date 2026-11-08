import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { PreviewMessage, SessionPreview } from '../src/shared/sessions'
import type { StorePath } from '../src/main/core/paths'
import { previewClaudeTranscript } from '../src/main/providers/claude-code/preview'
import { makeTempDir, removeTempDir, writeSession } from './fixtures/claude-store'

let dir: string
beforeEach(async () => {
  dir = await makeTempDir('claude-preview')
})
afterEach(async () => {
  await removeTempDir(dir)
})

const SID = '7a000000-0000-4000-8000-000000000001'
let clock = 0
function record(type: string, content: unknown, extra: Record<string, unknown> = {}): string {
  clock += 1
  return JSON.stringify({ type, cwd: '/w/proj', sessionId: SID, timestamp: new Date(Date.UTC(2026, 10, 1, 10, clock)).toISOString(), message: { role: type, content }, ...extra })
}
const user = (content: unknown, extra?: Record<string, unknown>) => record('user', content, extra)
const assistant = (blocks: unknown[]) => record('assistant', blocks)

async function previewOf(lines: string[], tail = '\n', budget?: { maxBytes: number; tailBytes: number }) {
  const absPath = path.join(dir, `${SID}.jsonl`)
  await writeFile(absPath, lines.join('\n') + tail)
  return previewClaudeTranscript({ absPath, path: `projects/-w-proj/${SID}.jsonl` as StorePath }, budget)
}

function ok(preview: SessionPreview): Extract<SessionPreview, { kind: 'ok' }> {
  if (preview.kind !== 'ok') throw new Error(`expected a preview, got ${preview.reason}`)
  return preview
}

const shown = (preview: SessionPreview) => {
  const value = ok(preview)
  return [value.first, ...value.recent].map((entry: PreviewMessage) => (entry.kind === 'tool' ? `tool:${entry.summary}` : `${entry.kind}:${entry.text}`))
}

describe('Claude Code conversation preview', () => {
  it('shows the prompt, the replies, and one line per tool call from a store transcript', async () => {
    const cwd = '/Users/alice/proj'
    const built = await writeSession(path.join(dir, 'store'), { id: SID, cwd, toolResult: true, turns: 2 })
    const { preview } = await previewClaudeTranscript({ absPath: built.transcriptPath, path: `projects/x/${SID}.jsonl` as StorePath })
    expect(shown(preview)).toEqual(['user:Add a unit test for the tokenizer', 'tool:Read src/tokenizer.ts', 'tool:Read src/tokenizer.ts', `assistant:Done. See ${cwd}/test/tokenizer.test.ts`])
    expect(ok(preview)).toMatchObject({ counts: { messages: 2, toolCalls: 2 }, omitted: { messages: 0, toolCalls: 0 }, complete: true })
    expect(ok(preview).first.at).toBe('2026-11-01T10:00:00.000Z')
  })

  it('names each tool by its most telling input', async () => {
    const { preview } = await previewOf([
      user('Start'),
      assistant([
        { type: 'thinking', thinking: 'hidden' },
        { type: 'text', text: 'Looking.' },
        { type: 'tool_use', name: 'Bash', input: { command: 'pnpm test --run\necho second line', description: 'Run tests' } },
        { type: 'tool_use', name: 'Grep', input: { pattern: 'readFacts', path: '/w/proj/src' } },
        { type: 'tool_use', name: 'Edit', input: { file_path: '/elsewhere/a.ts', old_string: 'x', new_string: 'y' } },
        { type: 'tool_use', name: 'mcp__docs__fetch', input: { url: 'https://example.invalid/page' } },
        { type: 'tool_use', name: 'TodoWrite', input: { todos: [] } },
        { type: 'text', text: 'Done.' },
      ]),
    ])
    expect(shown(preview)).toEqual([
      'user:Start',
      'assistant:Looking.',
      'tool:Ran pnpm test --run',
      'tool:Searched for readFacts',
      'tool:Edited /elsewhere/a.ts',
      'tool:mcp__docs__fetch https://example.invalid/page',
      'tool:Updated the todo list',
      'assistant:Done.',
    ])
  })

  it('skips meta records, tool results, tag-wrapped text, compact summaries, and non-message records', async () => {
    const { preview } = await previewOf([
      user('<command-name>/clear</command-name>'),
      user('Caveat: injected', { isMeta: true }),
      user('Real prompt'),
      record('system', 'hook output', { subtype: 'local_command' }),
      JSON.stringify({ type: 'attachment', attachment: { type: 'environment' } }),
      user([{ type: 'tool_result', tool_use_id: 't1', content: 'output' }]),
      user([{ type: 'text', text: '<system-reminder>x</system-reminder>' }, { type: 'text', text: 'and the rest' }]),
      user('Summary of the earlier conversation', { isCompactSummary: true }),
      user('From a sidechain', { isSidechain: true }),
      JSON.stringify({ type: 'ai-title', aiTitle: 'Title' }),
      JSON.stringify({ type: 'api-request-blob', message: { content: [{ type: 'text', text: 'request copy' }] } }),
    ])
    expect(shown(preview)).toEqual(['user:Real prompt', 'user:and the rest'])
  })

  it('collapses whitespace, caps long text without splitting a character, and keeps unicode', async () => {
    const long = `${'word '.repeat(119)}abc😀 and more\n\n${'x'.repeat(5000)}`
    const { preview } = await previewOf([user('é ✓\n\n  über  日本語'), assistant([{ type: 'text', text: long }])])
    const [first, reply] = [ok(preview).first, ok(preview).recent[0]!]
    expect(first).toMatchObject({ kind: 'user', text: 'é ✓ über 日本語' })
    if (reply.kind !== 'assistant') throw new Error('expected a reply')
    expect(reply.text.length).toBeLessThanOrEqual(600)
    expect(reply.text.endsWith('…')).toBe(true)
    expect(reply.text).not.toMatch(/[\n\uD800-\uDBFF]…$/)
    expect(reply.text).not.toContain('\n')
  })

  it('leaves out a half-written last line', async () => {
    const { preview } = await previewOf([user('Prompt'), assistant([{ type: 'text', text: 'Reply' }])], '\n{"type":"assistant","message":{"content":[{"type":"text","text":"cut')
    expect(shown(preview)).toEqual(['user:Prompt', 'assistant:Reply'])
  })

  it('reads a transcript over budget as its head and tail only', async () => {
    const middle = Array.from({ length: 3000 }, (_, index) => user(`Middle ${index} ${'m'.repeat(40)}`))
    const lines = [user('First prompt'), ...middle, assistant([{ type: 'text', text: 'Last reply' }])]
    const budget = { maxBytes: 64 * 1024, tailBytes: 16 * 1024 }
    const { preview, scannedBytes } = await previewOf(lines, '\n', budget)
    const value = ok(preview)
    expect(scannedBytes).toBeLessThanOrEqual(budget.maxBytes)
    expect(value.complete).toBe(false)
    expect(value.first).toMatchObject({ kind: 'user', text: 'First prompt' })
    expect(value.recent.at(-1)).toMatchObject({ kind: 'assistant', text: 'Last reply' })
    expect(value.recent).toHaveLength(24)
    expect(value.counts.messages, 'the skipped middle is not counted').toBeLessThan(lines.length / 2)
    expect(value.omitted.messages).toBe(value.counts.messages - 25)
  })

  it('gives unavailable, not an error, for a transcript with nothing to show', async () => {
    const garbage = ['not json', '[1,2,3]', '{"type":"user"}', '{"type":"user","message":{"content":[{"type":"text","text":5}]}}', '{"type":"assistant","message":{"content":[null,{"type":"tool_use","name":7}]}}', '\u0000\u0001']
    expect((await previewOf(garbage)).preview).toEqual({ kind: 'unavailable', reason: 'The transcript holds no messages to show.' })
    expect((await previewOf([], '')).preview.kind).toBe('unavailable')
  })
})
