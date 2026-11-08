import { createHash, randomBytes } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { createZstdCompress } from 'node:zlib'
import { encodeProjectDir } from '../../src/main/providers/claude-code/encode'
import { createStateDb, type FixtureRow } from '../fixtures/codex-db'

/** Bump when the shape changes, so a cached store on disk is rebuilt. */
const SPEC_VERSION = 3
const MiB = 1024 * 1024
const BASE_MS = Date.parse('2026-06-01T09:00:00.000Z')

export interface SyntheticStore {
  home: string
  claudeRoot: string
  codexRoot: string
  /** A medium Claude transcript the benchmark appends to for the one-change run. */
  changeTarget: string
  files: { count: number; bytes: number; over100MiB: number }
}

/**
 * A store shaped like Karl's second machine, scaled to about 1.1 GB: hundreds of small sessions, a
 * dozen medium ones, and four files over 100 MB (one a Codex `.jsonl.zst` full of image payloads).
 * Deterministic, and built once per spec version under `dir`.
 */
export async function syntheticStore(dir: string): Promise<SyntheticStore> {
  const home = path.join(dir, `v${SPEC_VERSION}`, 'home')
  const claudeRoot = path.join(home, '.claude')
  const codexRoot = path.join(home, '.codex')
  const done = path.join(dir, `v${SPEC_VERSION}`, 'done.json')
  const built = await readFile(done, 'utf8').then((text) => JSON.parse(text) as SyntheticStore, () => null)
  if (built) return built
  await rm(path.join(dir, `v${SPEC_VERSION}`), { recursive: true, force: true })
  const tally = { count: 0, bytes: 0, over100MiB: 0 }
  const note = async (file: string) => {
    const { size } = await stat(file)
    tally.count += 1
    tally.bytes += size
    if (size > 100 * MiB) tally.over100MiB += 1
  }
  const rand = seeded(SPEC_VERSION)
  const changeTarget = await buildClaude(claudeRoot, home, rand, note)
  await buildCodex(codexRoot, home, rand, note)
  const store: SyntheticStore = { home, claudeRoot, codexRoot, changeTarget, files: tally }
  await writeFile(done, JSON.stringify(store))
  return store
}

type Note = (file: string) => Promise<void>

function seeded(seed: number): () => number {
  let state = seed * 2654435761
  return () => {
    state = (state * 1103515245 + 12345) % 2147483648
    return state / 2147483648
  }
}

const uuid = (prefix: number, n: number) => {
  const hex = createHash('sha256').update(`${prefix}:${n}`).digest('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}
const iso = (ms: number) => new Date(ms).toISOString()
const filler = (bytes: number) => 'lorem ipsum dolor sit amet consectetur '.repeat(Math.ceil(bytes / 39)).slice(0, bytes)
const noise = (bytes: number) => randomBytes(Math.ceil((bytes * 3) / 4)).toString('base64').slice(0, bytes)
/** Half prose, half base64, so zstd shrinks it about as much as real rollouts (2.1x measured). */
const text = (bytes: number) => filler(bytes >> 1) + noise(bytes - (bytes >> 1))

/** Writes records produced lazily until `target` bytes, so a 150 MB file never sits in memory whole. */
async function writeLines(file: string, target: number, next: (index: number) => string, compress = false): Promise<number> {
  await mkdir(path.dirname(file), { recursive: true })
  let written = 0
  let index = 0
  async function* lines() {
    let batch: string[] = []
    let batchBytes = 0
    while (written < target) {
      const line = next(index++) + '\n'
      written += Buffer.byteLength(line)
      batch.push(line)
      batchBytes += line.length
      if (batchBytes > 4 * MiB) {
        yield batch.join('')
        batch = []
        batchBytes = 0
      }
    }
    if (batch.length > 0) yield batch.join('')
  }
  if (compress) await pipeline(lines(), createZstdCompress(), createWriteStream(file))
  else await pipeline(lines(), createWriteStream(file))
  return index
}

async function buildClaude(root: string, home: string, rand: () => number, note: Note): Promise<string> {
  const sizes: number[] = [
    ...Array.from({ length: 240 }, () => Math.round((20 + rand() * 380) * 1024)),
    ...Array.from({ length: 14 }, () => Math.round((5 + rand() * 20) * MiB)),
    150 * MiB,
    120 * MiB,
  ]
  let changeTarget = ''
  for (const [n, size] of sizes.entries()) {
    const id = uuid(1, n)
    const cwd = path.join(home, 'code', `project-${n % 30}`)
    const later = path.join(home, 'code', `project-${n % 30}-worktree`)
    const dir = path.join(root, 'projects', encodeProjectDir(cwd))
    const file = path.join(dir, `${id}.jsonl`)
    const start = BASE_MS + n * 3_600_000
    const big = size > 4 * MiB
    const records = await writeLines(file, size, (i) => {
      const at = iso(start + i * 1000)
      // A resume from another folder halfway through, so a partial read can miss a cwd.
      const where = big && i > 400 && i < 420 ? later : cwd
      const base = { parentUuid: null, isSidechain: false, userType: 'external', cwd: where, sessionId: id, version: '2.1.319', gitBranch: 'main', entrypoint: n % 9 === 0 ? 'claude-desktop' : 'cli', uuid: uuid(2, n * 1e6 + i), timestamp: at }
      if (i === 0) return JSON.stringify({ ...base, type: 'user', message: { role: 'user', content: `Session ${n}: make the scheduler retry with backoff` } })
      if (i % 50 === 7) return JSON.stringify({ type: 'ai-title', sessionId: id, aiTitle: `Scheduler retry work ${n}` })
      if (i % 2 === 1) return JSON.stringify({ ...base, type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: text(400) }, { type: 'tool_use', id: `toolu_${i}`, name: 'Read', input: { file_path: `${cwd}/src/file-${i % 40}.ts` } }] } })
      const payload = big && i % 10 === 4 ? noise(64 * 1024) : text(big ? 6 * 1024 : 1500)
      return JSON.stringify({ ...base, type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `toolu_${i - 1}`, content: payload }] } })
    })
    await note(file)
    const end = start + (records - 1) * 1000
    await utimes(file, new Date(end), new Date(end))
    if (n % 6 === 0) {
      for (let a = 0; a < 3; a++) {
        const agentId = `a${String(n * 10 + a).padStart(16, '0')}`
        const sub = path.join(dir, id, 'subagents')
        await writeLines(path.join(sub, `agent-${agentId}.jsonl`), Math.round((50 + rand() * 450) * 1024), (i) =>
          JSON.stringify({ type: i === 0 ? 'user' : 'assistant', isSidechain: true, agentId, cwd, sessionId: id, timestamp: iso(start + i * 500), message: { role: i === 0 ? 'user' : 'assistant', content: i === 0 ? `Explore part ${a} of session ${n}` : text(2000) } }),
        )
        await writeFile(path.join(sub, `agent-${agentId}.meta.json`), JSON.stringify({ agentType: 'Explore', description: `Explore part ${a}`, isBuiltIn: true }))
        await note(path.join(sub, `agent-${agentId}.jsonl`))
      }
    }
    if (n % 5 === 0) {
      const results = path.join(dir, id, 'tool-results')
      await mkdir(results, { recursive: true })
      for (let t = 0; t < 2; t++) await writeFile(path.join(results, `toolu_${n}_${t}.txt`), filler(20 * 1024))
    }
    if (n === 250) changeTarget = file
  }
  return changeTarget
}

async function buildCodex(root: string, home: string, rand: () => number, note: Note): Promise<void> {
  const rows: FixtureRow[] = []
  const index: string[] = []
  const plan: { size: number; compressed: boolean; images: boolean; spawnParent?: string }[] = [
    // Codex compresses a rollout idle for 7 days, so most of an older store is `.jsonl.zst` (67 of 79 here).
    ...Array.from({ length: 160 }, (_, n) => ({ size: Math.round((20 + rand() * 1000) * 1024), compressed: n % 7 !== 0, images: false })),
    ...Array.from({ length: 24 }, (_, n) => ({ size: Math.round((5 + rand() * 25) * MiB), compressed: n % 4 !== 1, images: n % 3 === 0 })),
    { size: 130 * MiB, compressed: false, images: false },
    { size: 170 * MiB, compressed: true, images: true },
  ]
  const ids = plan.map((_, n) => `019b${uuid(3, n).slice(4, 14)}7${uuid(3, n).slice(15)}`)
  // Every tenth small thread spawned the next two as subagents.
  for (let n = 0; n < 160; n += 10) {
    plan[n + 1]!.spawnParent = ids[n]
    plan[n + 2]!.spawnParent = ids[n]
  }
  for (const [n, spec] of plan.entries()) {
    const id = ids[n]!
    const cwd = path.join(home, 'code', `project-${n % 25}`)
    const startMs = BASE_MS + n * 5_400_000
    const day = iso(startMs).slice(0, 10).split('-')
    const name = `rollout-${iso(startMs).slice(0, 19).replace(/:/g, '-')}-${id}.jsonl${spec.compressed ? '.zst' : ''}`
    const rel = n % 23 === 5 ? ['archived_sessions', name] : ['sessions', ...day, name]
    const file = path.join(root, ...rel)
    const big = spec.size > 4 * MiB
    const source = spec.spawnParent ? { subagent: { thread_spawn: { parent_thread_id: spec.spawnParent, depth: 1, agent_nickname: 'Ada', agent_role: 'explorer', agent_path: '/root/explore' } } } : 'cli'
    const records = await writeLines(
      file,
      spec.size,
      (i) => {
        const record = (type: string, payload: Record<string, unknown>) => JSON.stringify({ timestamp: iso(startMs + i * 1000), ordinal: i, type, payload })
        if (i === 0) return record('session_meta', { id, timestamp: iso(startMs), cwd, originator: n % 7 === 0 ? 'Codex Desktop' : 'codex-tui', cli_version: '0.162.1', source, thread_source: 'user', model_provider: 'openai', base_instructions: { text: filler(8000) }, git: { commit_hash: 'a1b2c3d', branch: 'main' } })
        if (i === 1) return record('turn_context', { cwd, model: 'gpt-5.5-codex', effort: 'medium', approval_policy: 'on-request', turn_id: 't0' })
        if (i === 2 && spec.spawnParent) return record('response_item', { type: 'agent_message', content: [{ type: 'input_text', text: `Explore subtask ${n}` }] })
        if (i === 2) return record('event_msg', { type: 'user_message', message: `Thread ${n}: port the tokenizer to the new parser` })
        if (i % 40 === 0) return record('turn_context', { cwd: big && i > 300 && i < 340 ? `${cwd}-worktree` : cwd, model: 'gpt-5.5-codex', effort: 'medium', turn_id: `t${i}` })
        if (i % 9 === 0) return record('event_msg', { type: 'token_count', info: { total_token_usage: { total_tokens: 1000 + i } } })
        if (spec.images && i % 6 === 0) return record('response_item', { type: 'message', role: 'user', content: [{ type: 'input_image', image_url: `data:image/png;base64,${noise(256 * 1024)}` }] })
        return record('response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: text(big ? 5000 : 1200) }] })
      },
      spec.compressed,
    )
    await note(file)
    const end = startMs + (records - 1) * 1000
    await utimes(file, new Date(end), new Date(end))
    if (!spec.spawnParent) rows.push({ id, rollout_path: path.join(root, ...rel).replace(/\.zst$/, ''), cwd, title: `Thread ${n}`, updated_at: Math.floor(end / 1000), archived: rel[0] === 'archived_sessions' ? 1 : 0 })
    if (n % 4 === 0) index.push(JSON.stringify({ id, thread_name: `Named thread ${n}`, updated_at: iso(end) }))
  }
  await writeFile(path.join(root, 'session_index.jsonl'), index.join('\n') + '\n')
  createStateDb(path.join(root, 'state_5.sqlite'), rows)
}
