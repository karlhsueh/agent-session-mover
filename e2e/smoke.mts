import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron } from 'playwright'

const store = await mkdtemp(join(tmpdir(), 'agent-sessions-smoke-'))
const sessionId = '5a000000-0000-4000-8000-000000000001'
await mkdir(join(store, 'projects', '-smoke-proj'), { recursive: true })
await writeFile(
  join(store, 'projects', '-smoke-proj', `${sessionId}.jsonl`),
  JSON.stringify({ type: 'user', cwd: '/smoke/proj', sessionId, timestamp: '2026-11-01T10:00:00.000Z', entrypoint: 'cli', message: { role: 'user', content: 'synthetic smoke prompt' } }) + '\n',
)

const app = await electron.launch({ args: ['.'], env: { ...process.env, CLAUDE_CONFIG_DIR: store } })

try {
  const page = await app.firstWindow()

  const problems: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(message.text())
  })
  page.on('pageerror', (error) => problems.push(error.message))
  await page.reload()

  const name = page.getByLabel('Name')
  const send = page.getByRole('button', { name: 'Send to main' })
  const crossing = page.getByRole('status')
  const value = (label: string) => page.locator('dt', { hasText: label }).locator('+ dd')

  assert.equal(await page.title(), 'Agent Sessions', 'window has the default title')

  const keys = await page.evaluate('Object.keys(window.api)')
  assert.deepEqual(
    keys,
    ['greet', 'listSessions', 'exportSessions', 'openArchive', 'previewImport', 'runImport', 'onProgress'],
    'window.api exposes exactly the declared capabilities',
  )

  const list = await page.evaluate<{ ok: boolean; value: { sessions: { key: string; title: string }[] } }>('window.api.listSessions()')
  assert.equal(list.ok, true, 'listSessions crosses IPC and succeeds')
  assert.deepEqual(
    list.value.sessions.map((session) => [session.key, session.title]),
    [[`claude-code:${sessionId}`, 'synthetic smoke prompt']],
    'listSessions reads the store named by CLAUDE_CONFIG_DIR',
  )
  const badImport = await page.evaluate<{ ok: boolean; error: { code: string } }>("window.api.runImport('not-a-token', [], [])")
  assert.deepEqual([badImport.ok, badImport.error.code], [false, 'invalid-input'], 'main rejects malformed import input')
  const unsubscribe = await page.evaluate("typeof window.api.onProgress(() => {})")
  assert.equal(unsubscribe, 'function', 'onProgress returns an unsubscribe function')

  const globals = await page.evaluate('[typeof process, typeof require]')
  assert.deepEqual(globals, ['undefined', 'undefined'], 'page has no process or require')
  assert.equal(await value('typeof process').textContent(), 'undefined', 'page shows process undefined')
  assert.equal(await value('typeof require').textContent(), 'undefined', 'page shows require undefined')

  await name.fill('Karl')
  await send.click()
  await crossing.getByText('Karl').waitFor()

  const mainPid = await app.evaluate(() => process.pid)
  assert.ok(mainPid > 0, 'main process has a pid')
  assert.equal(await value('pid').textContent(), String(mainPid), 'page shows the pid of main')
  assert.equal(await value('electron').textContent(), await app.evaluate(() => process.versions.electron), 'page shows the electron version of main')

  await page.emulateMedia({ colorScheme: 'light' })
  await page.screenshot({ path: 'artifacts/smoke.png' })
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.screenshot({ path: 'artifacts/smoke-dark.png' })

  await name.fill('   ')
  await send.click()
  await crossing.getByText('non-blank string').waitFor()
  assert.equal(await value('pid').textContent(), '—', 'blank input clears the runtime readout')

  const numberResult = await page.evaluate<{ ok: boolean }>('window.api.greet(123)')
  assert.equal(numberResult.ok, false, 'greet(123) returns ok:false instead of throwing')

  const url = page.url()
  assert.equal(await page.evaluate("window.open('https://example.com')"), null, 'window.open is denied')
  await page.evaluate("location.href = 'https://example.com'")
  await page.waitForTimeout(500)
  assert.equal(page.url(), url, 'external navigation is blocked')
  assert.equal(app.windows().length, 1, 'app still has one window')

  assert.deepEqual(problems, [], 'page logged no console errors')
  console.log('smoke passed')
} finally {
  await app.close()
  await rm(store, { recursive: true, force: true })
}
