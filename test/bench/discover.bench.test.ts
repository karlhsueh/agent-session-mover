import { execFileSync } from 'node:child_process'
import { appendFile, mkdir, mkdtemp, rm, stat, truncate, utimes, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import { expect, it } from 'vitest'
import { createDiscovery } from '../../src/main/core/discovery'
import { providers } from '../../src/main/providers/registry'
import type { ProviderEnv } from '../../src/main/core/provider'
import { AGENT_IDS, type AgentId } from '../../src/shared/sessions'
import { syntheticStore } from './synthetic-store'

const RUNS = Number(process.env.AGENT_SESSIONS_BENCH_RUNS ?? 5)
const STORE_DIR = process.env.AGENT_SESSIONS_BENCH_DIR ?? path.join(tmpdir(), 'agent-sessions-bench')

interface Sample {
  ms: Record<AgentId, number>
  sessions: Record<AgentId, number>
  /** Longest event-loop stall during the scan. */
  stallMs: number
}

/** One app launch: the scanner holds whatever the app would keep between scans. */
function launch(env: ProviderEnv, appDataDir: string) {
  const discovery = createDiscovery({ providers, env, appDataDir, appVersion: 'bench' })
  return {
    async scan(): Promise<Sample> {
      const ms = {} as Record<AgentId, number>
      const sessions = {} as Record<AgentId, number>
      const delay = monitorEventLoopDelay({ resolution: 5 })
      delay.enable()
      for (const agent of AGENT_IDS) {
        const started = performance.now()
        const found = await discovery.list(agent)
        ms[agent] = performance.now() - started
        expect(found.problems).toEqual([])
        sessions[agent] = found.sessions.length
      }
      delay.disable()
      return { ms, sessions, stallMs: delay.max / 1e6 }
    },
  }
}

function summary(label: string, samples: Sample[]) {
  const stats = (values: number[]) => {
    const sorted = [...values].sort((a, b) => a - b)
    return { median: sorted[Math.floor(sorted.length / 2)]!, min: sorted[0]!, max: sorted.at(-1)! }
  }
  const row = { label, runs: samples.length } as Record<string, unknown>
  for (const agent of AGENT_IDS) row[agent] = stats(samples.map((s) => s.ms[agent]))
  row.total = stats(samples.map((s) => AGENT_IDS.reduce((sum, agent) => sum + s.ms[agent], 0)))
  row.stall = stats(samples.map((s) => s.stallMs))
  row.sessions = samples[0]!.sessions
  return row
}

function print(title: string, rows: Record<string, unknown>[]) {
  const cell = (value: unknown) => {
    const s = value as { median: number; min: number; max: number }
    return `${s.median.toFixed(0)} ms (${s.min.toFixed(0)}–${s.max.toFixed(0)})`
  }
  const lines = rows.map((row) => [row.label, ...AGENT_IDS.map((agent) => cell(row[agent])), cell(row.total), cell(row.stall), JSON.stringify(row.sessions)].join(' | '))
  console.log(`\n${title}\nscenario | ${AGENT_IDS.join(' | ')} | total | max stall | sessions\n${lines.join('\n')}`)
}

async function measure(env: ProviderEnv, change: string | null): Promise<Record<string, unknown>[]> {
  const cold: Sample[] = []
  const warm: Sample[] = []
  const refresh: Sample[] = []
  const changed: Sample[] = []
  for (let run = 0; run < RUNS; run++) {
    const appData = await mkdtemp(path.join(tmpdir(), 'agent-sessions-bench-appdata-'))
    try {
      cold.push(await launch(env, appData).scan())
      const relaunched = launch(env, appData)
      warm.push(await relaunched.scan())
      refresh.push(await relaunched.scan())
      if (change) {
        const before = await stat(change)
        await appendFile(change, JSON.stringify({ type: 'ai-title', sessionId: 'bench', aiTitle: `bench ${run}` }) + '\n')
        try {
          changed.push(await relaunched.scan())
        } finally {
          await truncate(change, before.size)
          await utimes(change, before.atime, before.mtime)
        }
      }
    } finally {
      await rm(appData, { recursive: true, force: true })
    }
  }
  const rows = [summary('cold (no app cache)', cold), summary('warm launch', warm), summary('refresh, nothing changed', refresh)]
  if (change) rows.push(summary('refresh, one file changed', changed))
  return rows
}

async function record(name: string, rows: Record<string, unknown>[]) {
  const commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim()
  const dirty = execFileSync('git', ['status', '--porcelain', 'src'], { encoding: 'utf8' }).trim() !== ''
  await mkdir('artifacts/bench', { recursive: true })
  await writeFile(`artifacts/bench/${name}-${commit}${dirty ? '-dirty' : ''}.json`, JSON.stringify({ commit, dirty, at: new Date().toISOString(), rows }, null, 2))
}

it('times discovery on a synthetic 1 GB store', { timeout: 30 * 60_000 }, async () => {
  const store = await syntheticStore(STORE_DIR)
  console.log(`synthetic store: ${store.files.count} session files, ${(store.files.bytes / 1e9).toFixed(2)} GB, ${store.files.over100MiB} over 100 MiB`)
  expect(store.files.over100MiB).toBeGreaterThanOrEqual(3)
  const env: ProviderEnv = { homeDir: store.home, env: { CLAUDE_CONFIG_DIR: store.claudeRoot, CODEX_HOME: store.codexRoot }, platform: process.platform }
  const rows = await measure(env, store.changeTarget)
  print('synthetic store', rows)
  await record('synthetic', rows)
})

it.runIf(process.env.AGENT_SESSIONS_BENCH_REAL === '1')('times discovery read-only on this machine’s real stores', { timeout: 30 * 60_000 }, async () => {
  const env: ProviderEnv = { homeDir: homedir(), env: { CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, CODEX_HOME: process.env.CODEX_HOME }, platform: process.platform }
  const rows = await measure(env, null)
  print('real stores (read-only)', rows)
  await record('real', rows)
})
