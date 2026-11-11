import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { _electron as electron, type ElectronApplication, type Page } from 'playwright'
import { afterAll, expect, it } from 'vitest'
import { createStateDb, threadRows } from '../fixtures/codex-db'
import { homeEnv } from '../../e2e/home.mts'
import { buildCodexStore } from '../fixtures/codex-store'

interface Machine {
  home: string
  codex: string
  claude: string
  userData: string
}

let root = ''
const apps: ElectronApplication[] = []

afterAll(async () => {
  for (const app of apps) await app.close().catch(() => undefined)
  if (root) await rm(root, { recursive: true, force: true })
})

async function machine(name: string): Promise<Machine> {
  const home = path.join(root, name)
  const result = { home, codex: path.join(home, '.codex'), claude: path.join(home, '.claude'), userData: path.join(root, `${name}-userdata`) }
  await mkdir(result.codex, { recursive: true })
  await mkdir(result.claude, { recursive: true })
  return result
}

async function launch(on: Machine, extra: Record<string, string>): Promise<{ page: Page; problems: string[] }> {
  const app = await electron.launch({
    args: ['.'],
    env: { ...process.env, ...(await homeEnv(on.home)), CLAUDE_CONFIG_DIR: on.claude, CODEX_HOME: on.codex, AGENT_SESSIONS_E2E_USER_DATA: on.userData, ...extra },
  })
  apps.push(app)
  const page = await app.firstWindow()
  const problems: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(message.text())
  })
  page.on('pageerror', (error) => problems.push(error.message))
  await page.setViewportSize({ width: 1200, height: 760 })
  return { page, problems }
}

const rows = (page: Page) => page.getByRole('listbox', { name: 'Sessions' }).locator('.row')

it('lists, exports, and imports Codex sessions through the app', { timeout: 120_000 }, async () => {
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'agent-sessions-codex-ui-')))
  const source = await machine('laptop')
  const target = await machine('desktop')
  const sourceCwd = path.join(source.home, 'code', 'tokenizer')
  await mkdir(sourceCwd, { recursive: true })
  await buildCodexStore(source.codex, sourceCwd)
  createStateDb(path.join(target.codex, 'state_5.sqlite'), [])
  const archive = path.join(root, 'codex.agentsessions')

  const laptop = await launch(source, { AGENT_SESSIONS_E2E_SAVE_PATH: archive })
  await rows(laptop.page).first().waitFor()
  const listed = await rows(laptop.page).allTextContents()
  expect(listed.length, 'the list shows the Codex fixture sessions').toBeGreaterThanOrEqual(6)
  expect(await laptop.page.locator('.row .mark-codex').count(), 'every row carries the Codex mark').toBe(listed.length)
  expect(listed.some((text) => text.includes('+3')), 'the parent session shows its 3 nested subagents').toBe(true)
  expect(listed.some((text) => text.includes('Renamed tokenizer work')), 'the session index name is the title').toBe(true)
  expect(await laptop.page.getByRole('listbox', { name: 'Projects' }).count(), 'a one-project store hides the sidebar').toBe(0)
  await rows(laptop.page).filter({ hasText: 'Renamed tokenizer work' }).click()
  await laptop.page.getByRole('tab', { name: 'Conversation' }).click()
  const conversation = laptop.page.getByRole('list', { name: 'Conversation' })
  await conversation.waitFor()
  expect(await conversation.locator('.turn').first().textContent(), 'the conversation starts with the user prompt, not injected context').toBe('Add a unit test for the tokenizer')
  await laptop.page.screenshot({ animations: 'disabled', path: 'artifacts/codex-browse-dark.png' })
  await laptop.page.getByRole('tab', { name: 'Overview' }).click()

  await laptop.page.keyboard.press('ControlOrMeta+A')
  await laptop.page.keyboard.press('ControlOrMeta+E')
  await laptop.page.getByRole('button', { name: 'Choose location…' }).click()
  await laptop.page.getByRole('dialog', { name: 'Archive saved' }).waitFor()
  expect(existsSync(archive), 'export wrote the archive').toBe(true)
  expect(laptop.problems, 'source machine logged no console errors').toEqual([])

  const mappedCwd = path.join(target.home, 'code', 'tokenizer')
  const desktop = await launch(target, { AGENT_SESSIONS_E2E_OPEN_PATH: archive })
  await desktop.page.getByRole('button', { name: /Import archive/ }).click()
  await desktop.page.locator('.plan:not(.stale) .badge').first().waitFor()
  const planText = (await desktop.page.locator('.plan').textContent()) ?? ''
  expect(planText, 'preview plans creates').toMatch(/Add/)
  expect(planText, 'the picker note names Codex, not Claude Code').toMatch(/Codex's resume picker/)
  expect(planText, 'no Claude wording on a Codex archive').not.toMatch(/Claude Code/)
  const mappingInput = desktop.page.getByLabel(`Folder on this machine for ${sourceCwd}`)
  const mappingRow = desktop.page.locator('.mapping', { has: mappingInput })
  const blocked = path.join(archive, 'tokenizer')
  await mappingInput.fill(blocked)
  await mappingInput.press('Enter')
  await mappingRow.getByRole('button', { name: 'Create folder' }).click()
  await expect.poll(() => mappingRow.locator('.mapping-status').textContent(), { message: 'a failed create shows on the row' }).toBe('Part of this path is a file, not a folder.')
  await mappingRow.screenshot({ animations: 'disabled', path: 'artifacts/codex-import-folder-error-dark.png' })
  await mappingInput.fill('~/code/tokenizer')
  await mappingInput.press('Enter')
  expect(await mappingInput.getAttribute('title'), 'a typed ~ path expands to this home before it reaches main').toBe(mappedCwd)
  await expect.poll(() => mappingRow.locator('.mapping-status').textContent(), { message: 'mapping flags the missing folder' }).toBe('Folder does not exist yet')
  await desktop.page.locator('.plan:not(.stale) .badge').first().waitFor()
  expect(await desktop.page.locator('.plan').textContent(), 'the plan warns about the missing folder').toMatch(/does not exist yet/)
  await mappingRow.screenshot({ animations: 'disabled', path: 'artifacts/codex-import-missing-folder-dark.png' })
  await mappingRow.getByRole('button', { name: 'Create folder' }).click()
  await expect.poll(() => mappingRow.locator('.mapping-status').textContent(), { message: 'the row rechecks after the folder is made' }).toBe('Folder exists')
  expect(existsSync(mappedCwd), 'Create folder made the folder and its missing parent').toBe(true)
  expect(await mappingRow.getByRole('button', { name: 'Create folder' }).count(), 'the action leaves once the folder exists').toBe(0)
  await desktop.page.locator('.plan:not(.stale) .badge').first().waitFor()
  expect(await desktop.page.locator('.plan').textContent(), 'the plan no longer warns about the folder').not.toMatch(/does not exist yet/)
  await desktop.page.screenshot({ animations: 'disabled', path: 'artifacts/codex-import-preview-dark.png' })

  await desktop.page.getByRole('button', { name: /^Import \d+ sessions?/ }).click()
  await desktop.page.getByRole('heading', { name: /imported$/ }).waitFor()
  expect(await desktop.page.locator('.outcome').first().textContent(), 'resume command is a codex resume line').toMatch(/codex resume/)
  await desktop.page.screenshot({ animations: 'disabled', path: 'artifacts/codex-import-result-dark.png' })

  await desktop.page.getByRole('button', { name: 'Back to sessions' }).click()
  await rows(desktop.page).first().waitFor()
  const imported = await rows(desktop.page).allTextContents()
  expect(imported.some((text) => text.includes('Renamed tokenizer work')), 'the target lists the imported session').toBe(true)
  const dbRows = threadRows(path.join(target.codex, 'state_5.sqlite'))
  expect(dbRows.length, 'import inserted threads rows').toBeGreaterThan(0)
  expect(dbRows.map((row) => [row.id, row.cwd]), 'every row carries the mapped folder').toEqual(dbRows.map((row) => [row.id, mappedCwd]))
  expect(desktop.problems, 'target machine logged no console errors').toEqual([])
})
