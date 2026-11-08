import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { _electron as electron, type ElectronApplication, type Page } from 'playwright'
import { afterAll, expect, it } from 'vitest'
import { writeSession } from '../fixtures/claude-store'
import { buildCodexStore } from '../fixtures/codex-store'

let root = ''
let app: ElectronApplication | null = null

afterAll(async () => {
  await app?.close().catch(() => undefined)
  if (root) await rm(root, { recursive: true, force: true })
})

const rows = (page: Page) => page.getByRole('listbox', { name: 'Sessions' }).locator('.row')
const row = (page: Page, title: string) => rows(page).filter({ hasText: title })
const shot = (page: Page, name: string) => page.screenshot({ animations: 'disabled', path: `artifacts/${name}.png` })
const id = (n: number) => `6c000000-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`

it('shows each agent as it finishes, with progress for the ones still reading', { timeout: 120_000 }, async () => {
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'agent-sessions-scan-ui-')))
  const home = path.join(root, 'home')
  const claude = path.join(home, '.claude')
  const codex = path.join(home, '.codex')
  const cwd = path.join(home, 'code', 'tokenizer')
  await mkdir(cwd, { recursive: true })
  const write = (n: number, title: string, startMinute = n * 10) => writeSession(claude, { id: id(n), cwd, aiTitle: title, startMinute })
  await write(1, 'Claude session one')
  await write(2, 'Claude session two')
  await buildCodexStore(codex, cwd)

  app = await electron.launch({
    args: ['.'],
    env: {
      ...process.env,
      HOME: home,
      CLAUDE_CONFIG_DIR: claude,
      CODEX_HOME: codex,
      AGENT_SESSIONS_E2E_USER_DATA: path.join(root, 'userdata'),
      AGENT_SESSIONS_E2E_SCAN_PACE: 'claude-code:700,codex:450',
    },
  })
  const page = await app.firstWindow()
  const problems: string[] = []
  page.on('console', (message) => message.type() === 'error' && problems.push(message.text()))
  page.on('pageerror', (error) => problems.push(error.message))
  await page.setViewportSize({ width: 1200, height: 760 })

  const panel = page.getByRole('status', { name: 'Reading session stores' })
  await panel.locator('.scan-detail', { hasText: /of 2 files/ }).waitFor()
  expect(await panel.textContent(), 'before any agent answers, each agent shows its own count').toMatch(/Claude Code.*of 2 files.*Codex/)
  await shot(page, 'scan-first-launch-dark')

  await row(page, 'Claude session two').waitFor()
  const line = page.locator('.statusbar .scan-line')
  expect(await line.textContent(), 'Claude Code shows while Codex is still reading').toMatch(/Reading Codex · \d+ of \d+ files/)
  expect(await page.locator('.row .mark-codex').count(), 'no Codex row yet').toBe(0)
  await row(page, 'Claude session two').click()
  await page.getByRole('tab', { name: 'Conversation' }).click()
  await page.getByRole('list', { name: 'Conversation' }).waitFor()
  expect(await line.count(), 'a preview answers while the Codex scan is still running').toBe(1)
  await shot(page, 'scan-incremental-dark')
  await page.getByRole('tab', { name: 'Overview' }).click()

  await line.waitFor({ state: 'detached', timeout: 30_000 })
  expect(await page.locator('.row .mark-codex').count(), 'Codex rows join the list').toBeGreaterThan(0)
  expect(problems, 'no console errors').toEqual([])
})
