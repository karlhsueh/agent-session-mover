import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdir, mkdtemp, readdir, realpath } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterAll, expect, it } from 'vitest'
import { exportSessions } from '../../src/main/core/export'
import type { CoreContext } from '../../src/main/core/export'
import { closeArchive, openArchive, previewImport, runImport } from '../../src/main/core/import'
import { encodeProjectDir } from '../../src/main/providers/claude-code/encode'
import { providers } from '../../src/main/providers/registry'
import { sessionKey } from '../../src/shared/sessions'

const run = promisify(execFile)
const home = os.homedir()
const store = process.env.CLAUDE_CONFIG_DIR ?? path.join(home, '.claude')
const created: string[] = []

function cleanEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('CLAUDE')))
}

async function claude(cwd: string, args: string[]): Promise<{ result: string; session_id: string; is_error: boolean }> {
  const { stdout } = await run('claude', ['-p', '--model', 'haiku', '--output-format', 'json', ...args], {
    cwd,
    env: cleanEnv(),
    timeout: 180_000,
  })
  return JSON.parse(stdout)
}

async function trash(...targets: string[]): Promise<void> {
  const present = []
  for (const target of targets) if (await readdir(path.dirname(target)).then((names) => names.includes(path.basename(target)), () => false)) present.push(target)
  if (present.length > 0) await run('trash', present)
}

afterAll(async () => {
  await trash(...created)
})

it('resumes a Claude Code session after export, removal, and import under another project folder', { timeout: 600_000 }, async () => {
  const scratch = await realpath(await mkdtemp(path.join(os.tmpdir(), 'agent-sessions-real-')))
  const machineA = path.join(scratch, 'machine-a-project')
  const machineB = path.join(scratch, 'machine-b-project')
  await mkdir(machineA)
  await mkdir(machineB)
  const word = `WORD${randomBytes(3).toString('hex').toUpperCase()}`
  const context: CoreContext = {
    providers,
    env: { homeDir: home, env: { CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR }, platform: process.platform },
    appDataDir: path.join(scratch, 'appdata'),
    appVersion: '0.0.0-real',
  }

  const first = await claude(machineA, [`Remember the code word ${word}. Reply with OK and nothing else.`])
  expect(first.is_error, 'origin session ran').toBe(false)
  const id = first.session_id
  const sourceDir = path.join(store, 'projects', encodeProjectDir(machineA))
  const targetDir = path.join(store, 'projects', encodeProjectDir(machineB))
  created.push(sourceDir, targetDir, path.join(store, 'session-env', id), scratch)

  const archive = path.join(scratch, 'moved.agentsessions')
  await exportSessions(context, [sessionKey('claude-code', id)], archive)
  await trash(sourceDir)

  const opened = await openArchive(context, archive)
  const mappings = [{ source: machineA, target: machineB }]
  const preview = await previewImport(context, opened, mappings)
  expect(preview.sessions.map((s) => s.action.kind), 'import plans a create').toEqual(['create'])
  const result = await runImport(context, opened, mappings, [sessionKey('claude-code', id)])
  expect(result.outcomes.map((o) => o.status), 'import created the session').toEqual(['created'])
  await closeArchive(opened)
  expect(await readdir(targetDir), 'transcript placed under the new project folder').toContain(`${id}.jsonl`)

  const resumed = await claude(machineB, ['--resume', id, 'What was the code word? Reply with the word only.'])
  expect(resumed.is_error, 'resume by id ran').toBe(false)
  expect(resumed.result, 'resume by id recalls the word').toContain(word)

  const continued = await claude(machineB, ['--continue', 'Repeat the code word once more. Reply with the word only.'])
  expect(continued.session_id, '--continue from the new folder picks the imported session').toBe(id)
  expect(continued.result, '--continue recalls the word').toContain(word)
})
