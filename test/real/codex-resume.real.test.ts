import { execFile, spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, readFile, realpath, unlink } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { promisify } from 'node:util'
import { afterAll, expect, it } from 'vitest'
import { exportSessions, type CoreContext } from '../../src/main/core/export'
import { closeArchive, openArchive, previewImport, runImport } from '../../src/main/core/import'
import { providers } from '../../src/main/providers/registry'
import { requestsFor, sessionKey } from '../../src/shared/sessions'

const run = promisify(execFile)
const realAuth = path.join(process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex'), 'auth.json')
const authCopies: string[] = []
let scratch = ''

const sha = async (file: string) => createHash('sha256').update(await readFile(file)).digest('hex')

/** A refresh inside a copy would rotate the refresh token and could sign the real Codex out, so refuse to run near expiry. */
async function assertNoRefreshDue(): Promise<void> {
  const auth = JSON.parse(await readFile(realAuth, 'utf8')) as { tokens?: { access_token?: string } }
  const payload = auth.tokens?.access_token?.split('.')[1]
  if (!payload) return
  const { exp } = JSON.parse(Buffer.from(payload, 'base64url').toString()) as { exp: number }
  expect(exp * 1000 - Date.now(), 'access token is valid for at least 2 more hours; run codex once to refresh it first').toBeGreaterThan(2 * 3600_000)
}

afterAll(async () => {
  const original = await sha(realAuth)
  for (const copy of authCopies) {
    const unchanged = (await sha(copy).catch(() => original)) === original
    await unlink(copy).catch(() => undefined)
    expect(unchanged, `codex rewrote ${copy}; check that the real Codex login still works`).toBe(true)
  }
  if (scratch) await run('trash', [scratch])
})

async function makeHome(name: string): Promise<string> {
  const home = path.join(scratch, name)
  await mkdir(home)
  const auth = path.join(home, 'auth.json')
  await copyFile(realAuth, auth)
  authCopies.push(auth)
  return home
}

/** Runs `codex exec` against an isolated home and returns the thread id and the final agent message. */
async function codex(home: string, cwd: string, args: string[]): Promise<{ threadId: string; text: string }> {
  const output = path.join(cwd, `.last-${randomBytes(4).toString('hex')}.txt`)
  const stdout = await new Promise<string>((resolve, reject) => {
    const child = spawn('codex', ['exec', '--skip-git-repo-check', '--json', '-c', 'model_reasoning_effort="low"', '-o', output, ...args], {
      cwd,
      env: { ...process.env, CODEX_HOME: home },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 300_000,
    })
    let out = ''
    let err = ''
    child.stdout.on('data', (chunk) => (out += chunk))
    child.stderr.on('data', (chunk) => (err += chunk))
    child.on('error', reject)
    child.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`codex exited ${code}: ${err.slice(-2000)}`))))
  })
  const started = stdout
    .split('\n')
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as { type?: string; thread_id?: string }]
      } catch {
        return []
      }
    })
    .find((event) => event.type === 'thread.started')
  expect(started?.thread_id, 'codex reported a thread id').toBeTruthy()
  return { threadId: started!.thread_id!, text: await readFile(output, 'utf8') }
}

it('resumes a Codex session by id after export and import into another CODEX_HOME and project folder', { timeout: 900_000 }, async () => {
  await assertNoRefreshDue()
  scratch = await realpath(await mkdtemp(path.join(os.tmpdir(), 'agent-sessions-codex-real-')))
  const projectA = path.join(scratch, 'machine-a-project')
  const projectB = path.join(scratch, 'machine-b-project')
  await mkdir(projectA)
  await mkdir(projectB)
  const homeA = await makeHome('home-a')
  const homeB = await makeHome('home-b')
  const word = `WORD${randomBytes(3).toString('hex').toUpperCase()}`
  const contextFor = (home: string): CoreContext => ({
    providers,
    env: { homeDir: os.homedir(), env: { CODEX_HOME: home }, platform: process.platform },
    appDataDir: path.join(home, '..', `${path.basename(home)}-appdata`),
    appVersion: '0.0.0-real',
  })

  const decoy = await codex(homeB, projectB, ['Reply with OK and nothing else.'])
  const origin = await codex(homeA, projectA, [`Remember the code word ${word}. Reply with OK and nothing else.`])
  expect(origin.threadId, 'origin and decoy are different threads').not.toBe(decoy.threadId)

  const archive = path.join(scratch, 'moved.agentsessions')
  await exportSessions(contextFor(homeA), [sessionKey('codex', origin.threadId)], archive)

  const target = contextFor(homeB)
  const opened = await openArchive(target, archive)
  const mappings = [{ source: projectA, target: projectB }]
  const preview = await previewImport(target, opened, mappings)
  expect(preview.sessions.map((s) => s.action.kind), 'import plans a create').toEqual(['create'])
  const result = await runImport(target, opened, mappings, requestsFor([sessionKey('codex', origin.threadId)]))
  expect(result.outcomes.map((o) => o.status), 'import created the session').toEqual(['created'])
  await closeArchive(opened)

  const db = new DatabaseSync(path.join(homeB, 'state_5.sqlite'), { readOnly: true })
  const row = db.prepare('SELECT cwd FROM threads WHERE id = ?').get(origin.threadId) as { cwd: string } | undefined
  db.close()
  expect(row?.cwd, 'the threads row carries the mapped folder, which the TUI picker filters on').toBe(projectB)

  const byId = await codex(homeB, projectB, ['resume', origin.threadId, 'Repeat the code word once more. Reply with the word only.'])
  expect(byId.threadId, 'resume by id continues the imported thread').toBe(origin.threadId)
  expect(byId.text, 'resume by id recalls the word').toContain(word)
})
