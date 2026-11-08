import { appendFile, mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
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
const titles = (page: Page) => rows(page).locator('.row-title .truncate').allTextContents()
const shot = (page: Page, name: string) => page.screenshot({ animations: 'disabled', path: `artifacts/${name}.png` })
const id = (n: number) => `6c000000-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`

it('shows each agent as it finishes, then refreshes on focus, the button, and Cmd/Ctrl+R', { timeout: 120_000 }, async () => {
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
  await row(page, 'Claude session one').click({ modifiers: ['ControlOrMeta'] })
  const selected = () => page.locator('.row[aria-selected=true] .row-title .truncate').allTextContents()
  expect((await selected()).sort()).toEqual(['Claude session one', 'Claude session two'])

  await write(3, 'Created after launch', 500)
  await page.waitForTimeout(2100)
  await page.evaluate("window.dispatchEvent(new Event('focus'))")
  await row(page, 'Created after launch').waitFor()
  expect((await selected()).sort(), 'the selection survives a refresh').toEqual(['Claude session one', 'Claude session two'])
  expect(await page.locator('.statusbar').textContent()).toMatch(/2 selected/)
  await shot(page, 'scan-refreshed-dark')

  await write(4, 'Found by the refresh button', 510)
  await page.getByRole('button', { name: 'Refresh sessions' }).click()
  await row(page, 'Found by the refresh button').waitFor()

  await rm(path.join(claude, 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'), `${id(1)}.jsonl`))
  await write(5, 'Found by the shortcut', 520)
  await page.getByRole('listbox', { name: 'Sessions' }).focus()
  await page.keyboard.press('ControlOrMeta+R')
  await row(page, 'Found by the shortcut').waitFor()
  expect(await titles(page), 'a session that vanished drops out of the list').not.toContain('Claude session one')
  expect(await selected(), 'and out of the selection').toEqual(['Claude session two'])

  const long = await write(6, 'A transcript too long to read whole', 530)
  const filler = (where: string, megabytes: number) =>
    Array.from({ length: megabytes * 16 }, () => JSON.stringify({ type: 'progress', cwd: where, sessionId: id(6), padding: 'x'.repeat(64 * 1024) }) + '\n').join('')
  await appendFile(long.transcriptPath, filler(cwd, 30) + filler(path.join(home, 'code', 'other-checkout'), 1) + filler(cwd, 5))
  await page.getByRole('button', { name: 'Refresh sessions' }).click()
  await expect.poll(async () => (await row(page, 'A transcript too long').count()) > 0).toBe(true)
  await row(page, 'A transcript too long').click()
  const detail = page.getByRole('complementary', { name: 'Session details' })
  await expect.poll(() => detail.textContent()).toMatch(/Also ran inNot known\. The list reads only the start and end of a transcript this long/)
  await shot(page, 'scan-long-transcript-dark')

  const reloads = await app.evaluate(({ Menu }) => {
    const found: string[] = []
    const walk = (items: Electron.MenuItem[]) => items.forEach((item) => (item.role === 'reload' && found.push(item.label), item.submenu && walk(item.submenu.items)))
    walk(Menu.getApplicationMenu()?.items ?? [])
    return found
  })
  expect(reloads, 'no menu item reloads the page on Cmd/Ctrl+R').toEqual([])
  expect(problems, 'no console errors').toEqual([])
})
