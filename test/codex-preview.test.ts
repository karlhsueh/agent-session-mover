import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { PreviewMessage, SessionPreview } from '../src/shared/sessions'
import type { StorePath } from '../src/main/core/paths'
import { previewRollout } from '../src/main/providers/codex/preview'
import { makeTempDir, removeTempDir } from './fixtures/claude-store'
import { buildCodexStore, CX, rolloutLines } from './fixtures/codex-store'

let dir: string
beforeEach(async () => {
  dir = await makeTempDir('codex-preview')
})
afterEach(async () => {
  await removeTempDir(dir)
})

const CWD = '/w/proj'
const ID = '019a0000-0000-7000-8000-0000000000a1'

function item(minute: number, payload: Record<string, unknown>, type = 'response_item'): string {
  return JSON.stringify({ timestamp: new Date(Date.UTC(2026, 10, 1, 11, minute)).toISOString(), ordinal: 100 + minute, type, payload })
}

async function previewOf(lines: string[], options: { compressed?: boolean; budget?: { maxBytes: number; tailBytes: number } } = {}) {
  const name = `rollout-2026-11-01T10-00-00-${ID}.jsonl${options.compressed ? '.zst' : ''}`
  const absPath = path.join(dir, name)
  const plain = Buffer.from(lines.join('\n') + '\n')
  await writeFile(absPath, options.compressed ? zstdCompressSync(plain) : plain)
  return previewRollout({ absPath, path: `sessions/2026/11/01/${name}` as StorePath }, options.budget)
}

function ok(preview: SessionPreview): Extract<SessionPreview, { kind: 'ok' }> {
  if (preview.kind !== 'ok') throw new Error(`expected a preview, got ${preview.reason}`)
  return preview
}

const shown = (preview: SessionPreview) =>
  [ok(preview).first, ...ok(preview).recent].map((entry: PreviewMessage) => (entry.kind === 'tool' ? `tool:${entry.summary}` : `${entry.kind}:${entry.text}`))

describe('Codex conversation preview', () => {
  it('shows user and assistant messages from response items, skipping injected context and events', async () => {
    const { preview } = await previewOf(rolloutLines({ id: ID, cwd: CWD, prompt: 'Add a unit test for the tokenizer', turns: 2 }))
    const reply = 'assistant:Read /w/proj/src/tokenizer.ts é ✓'
    expect(shown(preview)).toEqual(['user:Add a unit test for the tokenizer', reply, reply])
    expect(ok(preview)).toMatchObject({ counts: { messages: 3, toolCalls: 0 }, complete: true })
  })

  it('turns each tool call into one line and skips reasoning and developer messages', async () => {
    const lines = [
      ...rolloutLines({ id: ID, cwd: CWD, prompt: null, turns: 0 }),
      item(1, { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'rules' }] }),
      item(2, { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context/>' }, { type: 'input_text', text: 'Fix the build' }] }),
      item(3, { type: 'reasoning', summary: [{ type: 'summary_text', text: 'thinking' }] }),
      item(4, { type: 'function_call', name: 'exec_command', arguments: JSON.stringify({ cmd: 'pnpm test\nmore', workdir: CWD }) }),
      item(5, { type: 'function_call', name: 'shell', arguments: JSON.stringify({ command: ['bash', '-lc', 'git status'] }) }),
      item(6, { type: 'custom_tool_call', name: 'apply_patch', input: `*** Begin Patch\n*** Update File: ${CWD}/src/a.ts\n@@\n*** Add File: b.ts\n*** End Patch` }),
      item(7, { type: 'custom_tool_call', name: 'exec', input: 'text(await tools.exec_command({ cmd: "rg \\"needle\\" src", yield_time_ms: 1000 }))' }),
      item(8, { type: 'custom_tool_call', name: 'exec', input: 'const r = await tools.view_image({ path: "x.png" })' }),
      item(9, { type: 'web_search_call', status: 'completed', action: { type: 'search', query: 'zstd node' } }),
      item(10, { type: 'function_call', name: 'view_image', arguments: JSON.stringify({ path: `${CWD}/shot.png` }) }),
      item(11, { type: 'function_call', name: 'mystery_tool', arguments: 'not json' }),
      item(11, { type: 'function_call', name: 'constructor', arguments: JSON.stringify({ path: 'x' }) }),
      item(12, { type: 'function_call_output', call_id: 'c1', output: 'lots of output' }),
      item(13, { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Fixed.' }] }),
      item(14, { type: 'item_completed', item: { type: 'UserMessage', content: [{ type: 'text', text: 'Fix the build' }] } }, 'event_msg'),
    ]
    expect(shown(await previewOf(lines).then((result) => result.preview))).toEqual([
      'user:Fix the build',
      'tool:Ran pnpm test',
      'tool:Ran git status',
      'tool:Edited src/a.ts, b.ts',
      'tool:Ran rg "needle" src',
      'tool:Ran code calling view_image',
      'tool:Searched the web for zstd node',
      'tool:Viewed shot.png',
      'tool:mystery_tool not json',
      'tool:constructor x',
      'assistant:Fixed.',
    ])
  })

  it('reads a compressed rollout the same as the plain one', async () => {
    const lines = rolloutLines({ id: ID, cwd: CWD, prompt: 'Compressed prompt', turns: 3 })
    const plain = await previewOf(lines)
    const compressed = await previewOf(lines, { compressed: true })
    expect(compressed.preview).toEqual(plain.preview)
    expect(ok(compressed.preview).counts.messages).toBe(4)
  })

  it('starts a subagent rollout after the history it copied from its parent', async () => {
    const store = await buildCodexStore(path.join(dir, 'codex'), CWD)
    const sub = store.rollouts[CX.subagent]!
    const { preview } = await previewRollout({ absPath: sub.absPath, path: sub.rel as StorePath })
    expect(ok(preview).first).toMatchObject({ kind: 'user', text: 'Review the tokenizer change' })
    expect(shown(preview).join('\n')).not.toContain('Parent thread')
  })

  it('keeps only a bounded window of a long compressed rollout', async () => {
    const middle = Array.from({ length: 4000 }, (_, index) => item(20, { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: `Middle ${index} ${'m'.repeat(40)}` }] }))
    const lines = [...rolloutLines({ id: ID, cwd: CWD, prompt: null, turns: 0 }), item(1, { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'First prompt' }] }), ...middle, item(30, { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Last reply' }] })]
    const budget = { maxBytes: 64 * 1024, tailBytes: 16 * 1024 }
    const { preview, scannedBytes } = await previewOf(lines, { compressed: true, budget })
    expect(scannedBytes).toBeLessThanOrEqual(budget.maxBytes)
    expect(ok(preview)).toMatchObject({ complete: false, first: { kind: 'user', text: 'First prompt' } })
    expect(ok(preview).recent.at(-1)).toMatchObject({ text: 'Last reply' })
    expect(ok(preview).counts.messages).toBeLessThan(middle.length / 2)
  })

  it('gives unavailable, not an error, for garbage and a damaged .zst', async () => {
    const garbage = ['{"type":"session_meta","payload":5}', 'nope', '{"type":"response_item","payload":{"type":"message","role":"user","content":"text"}}', '{"type":"response_item","payload":{"type":"function_call","arguments":{"cmd":3}}}', '{"type":"response_item","payload":{"type":"web_search_call","action":[]}}']
    const { preview } = await previewOf(garbage.slice(0, 3))
    expect(preview).toEqual({ kind: 'unavailable', reason: 'The transcript holds no messages to show.' })
    expect(shown((await previewOf(garbage)).preview)).toEqual(['tool:function_call', 'tool:Searched the web'])
    await mkdir(path.join(dir, 'z'), { recursive: true })
    const corrupt = path.join(dir, 'z', `rollout-2026-11-01T10-00-00-${ID}.jsonl.zst`)
    await writeFile(corrupt, Buffer.from('not zstd at all'))
    const damaged = await previewRollout({ absPath: corrupt, path: `sessions/z/rollout-2026-11-01T10-00-00-${ID}.jsonl.zst` as StorePath })
    expect(damaged.preview).toEqual({ kind: 'unavailable', reason: 'The compressed transcript is damaged.' })
  })
})
