import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, type ElectronApplication, type Page } from 'playwright'

const root = await realpath(await mkdtemp(join(tmpdir(), 'agent-sessions-smoke-')))
const archivePath = join(root, 'handoff.agentsessions')
await mkdir('artifacts', { recursive: true })

interface Machine {
  home: string
  claude: string
  codex: string
  userData: string
}

function machine(name: string): Machine {
  const home = join(root, name)
  return { home, claude: join(home, '.claude'), codex: join(home, '.codex'), userData: join(root, `${name}-userdata`) }
}

const source = machine('laptop')
const target = machine('desktop')

const encode = (cwd: string) => cwd.replace(/[^A-Za-z0-9]/g, '-')
const MINUTE = 60_000

interface Fixture {
  id: string
  title: string
  project: string
  entrypoint: string
  ageMinutes: number
  live?: boolean
}

const fixtures: Fixture[] = [
  { id: '5a000000-0000-4000-8000-000000000001', title: 'Fix flaky retry in the payment client', project: 'code/api', entrypoint: 'cli', ageMinutes: 4, live: true },
  { id: '5a000000-0000-4000-8000-000000000002', title: 'Add cursor pagination to the orders endpoint', project: 'code/api', entrypoint: 'claude-desktop', ageMinutes: 95 },
  { id: '5a000000-0000-4000-8000-000000000003', title: 'Migrate the settings page to the new form library', project: 'code/web', entrypoint: 'claude-vscode', ageMinutes: 60 * 26 },
  { id: '5a000000-0000-4000-8000-000000000004', title: 'Investigate the hydration warning on checkout', project: 'code/web', entrypoint: 'cli', ageMinutes: 60 * 50 },
  { id: '5a000000-0000-4000-8000-000000000005', title: 'Nightly changelog summary', project: 'code/tools', entrypoint: 'sdk-cli', ageMinutes: 60 * 74 },
  { id: '5a000000-0000-4000-8000-000000000006', title: 'Review the terraform plan for the staging VPC', project: 'infra', entrypoint: 'cli', ageMinutes: 60 * 24 * 9 },
]

async function writeClaudeSession(store: string, home: string, fixture: Fixture): Promise<void> {
  const cwd = join(home, fixture.project)
  const dir = join(store, 'projects', encode(cwd))
  await mkdir(dir, { recursive: true })
  const end = Date.now() - fixture.ageMinutes * MINUTE
  let parentUuid: string | null = null
  const lines = [0, 1, 2, 3].map((turn) => {
    const uuid = `${fixture.id.slice(0, 8)}-000${turn}-4000-8000-000000000000`
    const message = turn % 2 === 0 ? { role: 'user', content: turn === 0 ? fixture.title : 'Looks good, continue.' } : { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] }
    const record = { parentUuid, isSidechain: false, userType: 'external', cwd, sessionId: fixture.id, version: '2.1.319', gitBranch: 'main', entrypoint: fixture.entrypoint, uuid, timestamp: new Date(end - (3 - turn) * MINUTE).toISOString(), type: turn % 2 === 0 ? 'user' : 'assistant', message }
    parentUuid = uuid
    return JSON.stringify(record)
  })
  lines.push(JSON.stringify({ type: 'ai-title', sessionId: fixture.id, aiTitle: fixture.title }))
  await writeFile(join(dir, `${fixture.id}.jsonl`), lines.join('\n') + '\n')
  if (fixture.live) {
    await mkdir(join(store, 'sessions'), { recursive: true })
    await writeFile(join(store, 'sessions', `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: fixture.id, cwd, startedAt: Date.now(), kind: 'interactive', entrypoint: 'cli' }))
  }
}

for (const fixture of fixtures) await writeClaudeSession(source.claude, source.home, fixture)
await mkdir(source.codex, { recursive: true })
await mkdir(target.claude, { recursive: true })
await mkdir(target.codex, { recursive: true })
await mkdir(join(target.home, 'code', 'api'), { recursive: true })
const chosenWebFolder = join(target.home, 'checkouts', 'web-main')
await mkdir(chosenWebFolder, { recursive: true })

async function launch(on: Machine, extra: Record<string, string>): Promise<{ app: ElectronApplication; page: Page; problems: string[] }> {
  const app = await electron.launch({
    args: ['.'],
    env: { ...process.env, HOME: on.home, CLAUDE_CONFIG_DIR: on.claude, CODEX_HOME: on.codex, AGENT_SESSIONS_E2E_USER_DATA: on.userData, ...extra },
  })
  const page = await app.firstWindow()
  const problems: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(message.text())
  })
  page.on('pageerror', (error) => problems.push(error.message))
  await page.reload()
  await page.setViewportSize({ width: 1200, height: 760 })
  return { app, page, problems }
}

const rows = (page: Page) => page.getByRole('listbox', { name: 'Sessions' }).getByRole('option')
const rowTitles = (page: Page) => rows(page).locator('.row-title .truncate').allTextContents()
const selectedCount = (page: Page) => page.locator('[role=option][aria-selected=true]').count()
const selectedTitles = (page: Page) => page.locator('[role=option][aria-selected=true] .row-title .truncate').allTextContents()
const titlesByAge = fixtures.map((fixture) => fixture.title)

const laptop = await launch(source, { AGENT_SESSIONS_E2E_SAVE_PATH: archivePath })
try {
  const { app, page, problems } = laptop
  assert.equal(await page.title(), 'Agent Sessions', 'window has the default title')
  assert.deepEqual(
    await page.evaluate('Object.keys(window.api)'),
    ['listSessions', 'exportSessions', 'openArchive', 'previewImport', 'runImport', 'onProgress', 'storeRoots', 'chooseFolder', 'revealExport', 'copyText'],
    'window.api exposes exactly the declared capabilities',
  )
  assert.deepEqual(await page.evaluate('[typeof process, typeof require]'), ['undefined', 'undefined'], 'page has no process or require')
  const badImport = await page.evaluate<{ ok: boolean; error: { code: string } }>("window.api.runImport('not-a-token', [], [])")
  assert.deepEqual([badImport.ok, badImport.error.code], [false, 'invalid-input'], 'main rejects malformed import input')

  await rows(page).first().waitFor()
  assert.deepEqual(await rowTitles(page), titlesByAge, 'list shows every session, newest activity first')
  assert.equal(await rows(page).filter({ hasText: 'payment client' }).locator('.badge.live').count(), 1, 'the running session carries a live badge')

  const search = page.getByRole('searchbox', { name: 'Search sessions' })
  await search.fill('hydration')
  assert.deepEqual(await rowTitles(page), [fixtures[3]!.title], 'search matches titles')
  await search.fill(fixtures[4]!.id.slice(-6))
  assert.deepEqual(await rowTitles(page), [fixtures[4]!.title], 'search matches session ids')
  await search.fill('code/web')
  assert.equal((await rowTitles(page)).length, 2, 'search matches folders')
  await search.press('Escape')
  assert.equal(await search.inputValue(), '', 'Escape clears the search')

  await page.getByRole('combobox', { name: 'Client' }).selectOption({ label: 'Desktop' })
  assert.deepEqual(await rowTitles(page), [fixtures[1]!.title], 'client filter narrows the list')
  await page.getByRole('combobox', { name: 'Client' }).selectOption({ label: 'All clients' })
  await page.getByRole('combobox', { name: 'Project' }).selectOption({ label: 'web (2)' })
  assert.deepEqual(await rowTitles(page), [fixtures[2]!.title, fixtures[3]!.title], 'project filter narrows the list')
  await page.getByRole('combobox', { name: 'Project' }).selectOption({ label: 'All projects' })
  await page.getByRole('combobox', { name: 'Sort by' }).selectOption({ label: 'Sort: Title' })
  assert.deepEqual(await rowTitles(page), [...titlesByAge].sort((a, b) => a.localeCompare(b)), 'title sort orders rows by title')
  await page.getByRole('combobox', { name: 'Sort by' }).selectOption({ label: 'Sort: Last activity' })

  const list = page.getByRole('listbox', { name: 'Sessions' })
  await list.focus()
  await page.keyboard.press('Home')
  await page.keyboard.press('Space')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Space')
  assert.deepEqual(await selectedTitles(page), [fixtures[0]!.title, fixtures[2]!.title], 'arrows move focus and Space toggles the focused row')
  await page.keyboard.press('Shift+ArrowDown')
  assert.deepEqual(await selectedTitles(page), [fixtures[2]!.title, fixtures[3]!.title], 'Shift+ArrowDown selects the range from the anchor')
  await page.keyboard.press('Escape')
  assert.equal(await selectedCount(page), 0, 'Escape clears the selection')
  await page.keyboard.press('ControlOrMeta+A')
  assert.equal(await selectedCount(page), fixtures.length, 'Cmd/Ctrl+A selects every visible row')
  await page.keyboard.press('Escape')

  const row = (index: number) => rows(page).filter({ hasText: fixtures[index]!.title })
  await row(0).click()
  await row(3).click({ modifiers: ['Shift'] })
  assert.equal(await selectedCount(page), 4, 'shift-click selects a range')
  await row(1).click({ modifiers: ['ControlOrMeta'] })
  assert.equal(await selectedCount(page), 3, 'cmd/ctrl-click toggles one row')
  const detail = page.getByRole('complementary', { name: 'Session details' })
  assert.match((await detail.textContent()) ?? '', /claude --resume 5a000000-0000-4000-8000-000000000002/, 'detail shows the focused session and its resume command')
  await row(4).click({ modifiers: ['ControlOrMeta'] })
  assert.match((await detail.textContent()) ?? '', /resume picker and --continue hide/, 'detail explains an sdk-cli session is hidden from the picker')
  await page.screenshot({ animations: 'disabled', path: 'artifacts/browse-dark.png' })

  await page.keyboard.press('ControlOrMeta+A')
  await page.keyboard.press('ControlOrMeta+E')
  const confirm = page.getByRole('dialog', { name: `Export ${fixtures.length} sessions` })
  await confirm.waitFor()
  assert.match((await confirm.textContent()) ?? '', /account email/, 'export confirm warns about private content')
  assert.match((await confirm.textContent()) ?? '', /payment client/, 'export confirm lists the live session it will snapshot')
  await page.screenshot({ animations: 'disabled', path: 'artifacts/export-confirm-dark.png' })
  await confirm.getByRole('button', { name: 'Choose location…' }).click()
  const saved = page.getByRole('dialog', { name: 'Archive saved' })
  await saved.waitFor()
  assert.match((await saved.textContent()) ?? '', /handoff\.agentsessions/, 'export result names the saved file')
  assert.ok(existsSync(archivePath), 'export wrote the archive')
  await saved.getByRole('button', { name: 'Done' }).click()

  await page.getByRole('button', { name: 'Use light theme' }).click()
  assert.equal(await page.evaluate('document.documentElement.dataset.theme'), 'light', 'theme toggle switches to light')
  await page.screenshot({ animations: 'disabled', path: 'artifacts/browse-light.png' })
  await page.reload()
  await rows(page).first().waitFor()
  assert.equal(await page.evaluate('document.documentElement.dataset.theme'), 'light', 'theme survives a reload')
  await page.getByRole('button', { name: 'Use dark theme' }).click()

  const url = page.url()
  assert.equal(await page.evaluate("window.open('https://example.com')"), null, 'window.open is denied')
  await page.evaluate("location.href = 'https://example.com'")
  await page.waitForTimeout(500)
  assert.equal(page.url(), url, 'external navigation is blocked')
  assert.equal(app.windows().length, 1, 'app still has one window')
  assert.deepEqual(problems, [], 'source machine logged no console errors')
} finally {
  await laptop.app.close()
}

const desktop = await launch(target, { AGENT_SESSIONS_E2E_OPEN_PATH: archivePath, AGENT_SESSIONS_E2E_FOLDER_PATH: chosenWebFolder })
try {
  const { page, problems } = desktop
  await page.getByRole('heading', { name: 'No sessions on this machine' }).waitFor()
  assert.match((await page.locator('.roots').textContent()) ?? '', new RegExp(target.claude.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'empty state names the store folder it searched')
  await page.screenshot({ animations: 'disabled', path: 'artifacts/empty-dark.png' })

  await page.getByRole('button', { name: /Import archive/ }).click()
  await page.getByRole('heading', { name: 'Import handoff.agentsessions' }).waitFor()
  const plan = page.locator('.plan')
  await page.locator('.plan:not(.stale) .badge').first().waitFor()
  assert.equal(await plan.locator('.badge', { hasText: 'Create' }).count(), fixtures.length, 'preview plans a create for every session')
  assert.match((await plan.textContent()) ?? '', /resume picker hides/, 'preview warns about the sdk-cli session')

  const webSource = join(source.home, 'code', 'web')
  const webTarget = page.getByLabel(`Folder on this machine for ${webSource}`)
  assert.equal(await webTarget.inputValue(), join(target.home, 'code', 'web'), 'mapping suggests the same folder under this home')
  const webRow = page.locator('.mapping', { has: webTarget })
  assert.equal(await webRow.locator('.mapping-status').textContent(), 'Folder does not exist yet', 'mapping flags a missing folder')
  await webRow.getByRole('button', { name: 'Choose…' }).click()
  await page.locator(`.plan:not(.stale) .plan-target[title="${chosenWebFolder}"]`).first().waitFor()
  assert.equal(await webTarget.inputValue(), chosenWebFolder, 'folder picker fills the mapping')
  assert.equal(await webRow.locator('.mapping-status').textContent(), 'Folder exists', 'preview re-runs with the chosen folder')
  await page.screenshot({ animations: 'disabled', path: 'artifacts/import-preview-dark.png' })

  await page.getByLabel(new RegExp(fixtures[5]!.title)).uncheck()
  const run = page.getByRole('button', { name: `Import ${fixtures.length - 1} sessions` })
  await run.click()
  await page.getByRole('heading', { name: `${fixtures.length - 1} sessions ready to resume` }).waitFor()
  assert.equal(await page.locator('.outcome .badge', { hasText: 'Placed' }).count(), fixtures.length - 1, 'every chosen session was placed')
  assert.equal(await page.locator('.outcome .command').count(), fixtures.length - 1, 'each placed session shows its resume command')
  assert.match((await page.locator('.outcome').first().textContent()) ?? '', /claude --resume/, 'resume command is a claude resume line')
  await page.screenshot({ animations: 'disabled', path: 'artifacts/import-result-dark.png' })

  await page.getByRole('button', { name: 'Back to sessions' }).click()
  await rows(page).first().waitFor()
  assert.deepEqual(await rowTitles(page), titlesByAge.slice(0, -1), 'the target machine now lists the imported sessions')
  const placed = await readdir(join(target.claude, 'projects', encode(chosenWebFolder)))
  assert.deepEqual(placed.sort(), [`${fixtures[2]!.id}.jsonl`, `${fixtures[3]!.id}.jsonl`], 'web sessions landed in the chosen folder’s project')
  assert.deepEqual(problems, [], 'target machine logged no console errors')
  console.log('smoke passed')
} finally {
  await desktop.app.close()
  await rm(root, { recursive: true, force: true })
}
