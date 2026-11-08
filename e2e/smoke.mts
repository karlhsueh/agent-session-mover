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
const HOUR = 60

interface Fixture {
  id: string
  title: string
  project: string
  entrypoint: string
  ageMinutes: number
  live?: boolean
  subagents?: { type: string; description: string }[]
}

const AGENT_TASKS = [
  ['Explore', 'Map the worker lifecycle'],
  ['Explore', 'Find every caller of enqueue'],
  ['general-purpose', 'Write the lease migration'],
  ['Plan', 'Sketch the retry backoff'],
  ['general-purpose', 'Port the scheduler tests'],
  ['Explore', 'Read the socket permission code'],
  ['general-purpose', 'Fix the flaky heartbeat test'],
  ['Plan', 'Review the queue schema'],
].map(([type, description]) => ({ type: type!, description: description! }))

// Shaped like a real store: a handful of projects, most with one session, and one session that fanned out to many subagents.
const fixtures: Fixture[] = [
  { id: '5a000000-0000-4000-8000-000000000001', title: 'Fix flaky retry in the payment client', project: 'code/api', entrypoint: 'cli', ageMinutes: 4, live: true },
  { id: '5a000000-0000-4000-8000-000000000002', title: 'Plan the job queue rewrite', project: 'code/local-job-manager', entrypoint: 'cli', ageMinutes: 40, subagents: AGENT_TASKS },
  { id: '5a000000-0000-4000-8000-000000000003', title: 'Add cursor pagination to the orders endpoint', project: 'code/api', entrypoint: 'claude-desktop', ageMinutes: 95 },
  { id: '5a000000-0000-4000-8000-000000000004', title: 'Migrate the settings page to the new form library', project: 'code/web', entrypoint: 'claude-vscode', ageMinutes: 26 * HOUR },
  { id: '5a000000-0000-4000-8000-000000000005', title: 'Investigate the hydration warning on checkout', project: 'code/web', entrypoint: 'cli', ageMinutes: 50 * HOUR },
  { id: '5a000000-0000-4000-8000-000000000006', title: 'Why is the localhost socket refusing connections', project: 'code/local-job-manager', entrypoint: 'cli', ageMinutes: 60 * HOUR },
  { id: '5a000000-0000-4000-8000-000000000007', title: 'Nightly changelog summary', project: 'code/tools', entrypoint: 'sdk-cli', ageMinutes: 74 * HOUR },
  { id: '5a000000-0000-4000-8000-000000000008', title: 'Tidy the zsh prompt', project: 'dotfiles', entrypoint: 'cli', ageMinutes: 5 * 24 * HOUR },
  { id: '5a000000-0000-4000-8000-000000000009', title: 'Draft the onboarding doc', project: 'notes', entrypoint: 'claude-desktop', ageMinutes: 8 * 24 * HOUR },
  { id: '5a000000-0000-4000-8000-00000000000a', title: 'Review the terraform plan for the staging VPC', project: 'infra', entrypoint: 'cli', ageMinutes: 9 * 24 * HOUR },
]
const byTitle = (title: string) => fixtures.find((fixture) => fixture.title === title)!
const fanout = fixtures[1]!

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
  for (const [index, agent] of (fixture.subagents ?? []).entries()) {
    const sub = join(dir, fixture.id, 'subagents')
    await mkdir(sub, { recursive: true })
    const agentId = `a${String(index).padStart(16, '0')}`
    const timestamp = new Date(end - (index + 5) * MINUTE).toISOString()
    const record = { type: 'user', isSidechain: true, agentId, cwd, sessionId: fixture.id, timestamp, message: { role: 'user', content: agent.description } }
    await writeFile(join(sub, `agent-${agentId}.jsonl`), JSON.stringify(record) + '\n')
    await writeFile(join(sub, `agent-${agentId}.meta.json`), JSON.stringify({ agentType: agent.type, description: agent.description, isBuiltIn: true }))
  }
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

const tree = (page: Page) => page.getByRole('tree', { name: 'Sessions' })
const rows = (page: Page) => tree(page).locator('.row')
const rowTitles = (page: Page) => rows(page).locator('.row-title .truncate').allTextContents()
const groupNames = (page: Page) => tree(page).locator('.group-row strong').allTextContents()
const group = (page: Page, name: string) => tree(page).locator('.group-row', { has: page.locator('strong', { hasText: new RegExp(`^${name}$`) }) })
const subRows = (page: Page) => tree(page).locator('.sub-row')
const selectedCount = (page: Page) => tree(page).locator('.row[aria-selected=true]').count()
const selectedTitles = (page: Page) => tree(page).locator('.row[aria-selected=true] .row-title .truncate').allTextContents()
const row = (page: Page, title: string) => rows(page).filter({ hasText: title })
const titlesByAge = fixtures.map((fixture) => fixture.title)
const projectsByAge = ['api', 'local-job-manager', 'web', 'tools', 'dotfiles', 'notes', 'infra']
const shot = (page: Page, name: string) => page.screenshot({ animations: 'disabled', path: `artifacts/${name}.png` })

const laptop = await launch(source, { AGENT_SESSIONS_E2E_SAVE_PATH: archivePath })
try {
  const { app, page, problems } = laptop
  assert.equal(await page.title(), 'Agent Sessions', 'window has the default title')
  assert.deepEqual(
    await page.evaluate('Object.keys(window.api)'),
    ['listSessions', 'exportSessions', 'openArchive', 'previewImport', 'runImport', 'onProgress', 'storeRoots', 'chooseFolder', 'revealExport', 'copyText', 'homeDir'],
    'window.api exposes exactly the declared capabilities',
  )
  assert.deepEqual(await page.evaluate('[typeof process, typeof require]'), ['undefined', 'undefined'], 'page has no process or require')
  const badImport = await page.evaluate<{ ok: boolean; error: { code: string } }>("window.api.runImport('not-a-token', [], [])")
  assert.deepEqual([badImport.ok, badImport.error.code], [false, 'invalid-input'], 'main rejects malformed import input')

  await rows(page).first().waitFor()
  assert.deepEqual(await groupNames(page), projectsByAge, 'sessions are grouped by project, newest project first')
  assert.deepEqual(await tree(page).locator('.group-row .group-count').allTextContents(), ['2', '2', '2', '1', '1', '1', '1'], 'each project header counts its sessions')
  assert.match((await group(page, 'api').textContent()) ?? '', /~\/code\/api/, 'the header shows the folder relative to home')
  assert.deepEqual(await rowTitles(page), projectsByAge.flatMap((name) => fixtures.filter((f) => f.project.endsWith(name)).map((f) => f.title)), 'sessions sit under their project, newest first')
  assert.equal(await row(page, 'payment client').locator('.badge.live').count(), 1, 'the running session carries a live badge')
  assert.equal(await row(page, fanout.title).locator('.subcount').textContent(), '+8', 'a session with subagents shows their count')
  assert.equal(await subRows(page).count(), 0, 'subagents stay folded until asked for')

  await page.getByRole('button', { name: 'Collapse web' }).click()
  assert.equal(await row(page, 'hydration').count(), 0, 'collapsing a project hides its sessions')
  assert.equal(await group(page, 'web').getAttribute('aria-expanded'), 'false', 'the header reports it is collapsed')
  await shot(page, 'browse-collapsed-dark')
  await group(page, 'web').click()
  await page.keyboard.press('ArrowRight')
  assert.equal(await row(page, 'hydration').count(), 1, 'Right on a collapsed header expands it')
  await page.keyboard.press('ArrowLeft')
  assert.equal(await row(page, 'hydration').count(), 0, 'Left on an open header collapses it')
  await page.reload()
  await rows(page).first().waitFor()
  assert.equal(await group(page, 'web').getAttribute('aria-expanded'), 'false', 'collapsed projects stay collapsed after a reload')
  await page.getByRole('button', { name: 'Expand web' }).click()

  const apiCheck = group(page, 'api').getByRole('checkbox')
  await apiCheck.click()
  assert.deepEqual(await selectedTitles(page), [fixtures[0]!.title, fixtures[2]!.title], 'the header checkbox selects every session in the project')
  assert.equal(await apiCheck.getAttribute('aria-checked'), 'true', 'a fully selected project reads as checked')
  await row(page, fixtures[2]!.title).click({ modifiers: ['ControlOrMeta'] })
  assert.equal(await apiCheck.getAttribute('aria-checked'), 'mixed', 'a partly selected project reads as mixed')
  await page.keyboard.press('Escape')
  await group(page, 'web').click()
  await page.keyboard.press('Space')
  assert.equal(await selectedCount(page), 2, 'Space on a focused header selects its project')
  await page.keyboard.press('Escape')

  await row(page, fanout.title).click()
  await page.keyboard.press('ArrowRight')
  assert.equal(await subRows(page).count(), 8, 'Right on a session with subagents shows them')
  const detail = page.getByRole('complementary', { name: 'Session details' })
  const detailAgents = detail.getByRole('region', { name: 'Subagents' }).locator('li')
  assert.equal(await detailAgents.count(), 8, 'the detail panel lists every subagent')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('ArrowDown')
  assert.match((await detail.locator('h2').textContent()) ?? '', /job queue rewrite/, 'a focused subagent row keeps its parent in the detail panel')
  assert.equal(await detail.locator('li.current').textContent(), `general-purpose${AGENT_TASKS[2]!.description}${await detail.locator('li.current time').textContent()}`, 'the detail list marks the focused subagent')
  await shot(page, 'browse-subagents-dark')
  await page.keyboard.press('ArrowLeft')
  await page.keyboard.press('ArrowLeft')
  assert.equal(await subRows(page).count(), 0, 'Left goes to the parent, then folds its subagents')

  const search = page.getByRole('searchbox', { name: 'Search sessions' })
  await search.fill('lease migration')
  assert.deepEqual(await rowTitles(page), [fanout.title], 'search finds a parent through a subagent title')
  assert.deepEqual(await subRows(page).locator('.sub-title').allTextContents(), ['Write the lease migration'], 'the matching subagent is shown under it')
  assert.equal(await subRows(page).locator('mark').textContent(), 'lease migration', 'the match is highlighted')
  await search.fill('hydration')
  assert.deepEqual(await rowTitles(page), [fixtures[4]!.title], 'search matches titles')
  assert.equal(await rows(page).locator('mark').textContent(), 'hydration', 'title matches are highlighted')
  await search.fill(fixtures[6]!.id.slice(-6))
  assert.deepEqual(await rowTitles(page), [fixtures[6]!.title], 'search matches session ids')
  await search.fill('code/web')
  assert.equal((await rowTitles(page)).length, 2, 'search matches folders')
  await search.press('Escape')
  assert.equal(await search.inputValue(), '', 'Escape clears the search')

  await page.getByRole('combobox', { name: 'Client' }).selectOption({ label: 'Desktop' })
  assert.deepEqual(await rowTitles(page), [fixtures[2]!.title, fixtures[8]!.title], 'client filter narrows the list')
  await page.getByRole('combobox', { name: 'Client' }).selectOption({ label: 'All clients' })

  await page.getByRole('button', { name: 'Flat list' }).click()
  assert.equal(await tree(page).locator('.group-row').count(), 0, 'flat mode has no project headers')
  assert.deepEqual(await rowTitles(page), titlesByAge, 'flat mode lists every session, newest activity first')
  await page.getByRole('combobox', { name: 'Sort by' }).selectOption({ label: 'Sort: Title' })
  assert.deepEqual(await rowTitles(page), [...titlesByAge].sort((a, b) => a.localeCompare(b)), 'title sort orders rows by title')
  await page.getByRole('combobox', { name: 'Sort by' }).selectOption({ label: 'Sort: Last activity' })

  await tree(page).focus()
  await page.keyboard.press('Escape')
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
  await row(page, fixtures[0]!.title).click()
  await row(page, fixtures[3]!.title).click({ modifiers: ['Shift'] })
  assert.equal(await selectedCount(page), 4, 'shift-click selects a range')
  await row(page, fixtures[1]!.title).click({ modifiers: ['ControlOrMeta'] })
  assert.equal(await selectedCount(page), 3, 'cmd/ctrl-click toggles one row')
  await page.getByRole('button', { name: 'Group by project' }).click()
  assert.deepEqual(await groupNames(page), projectsByAge, 'the project view comes back')

  await row(page, fixtures[2]!.title).click({ modifiers: ['ControlOrMeta'] })
  assert.match((await detail.textContent()) ?? '', /claude --resume 5a000000-0000-4000-8000-000000000003/, 'detail shows the focused session and its resume command')
  assert.match((await detail.locator('.command-block').textContent()) ?? '', /^cd ~\/'code\/api' && claude --resume/, 'the resume command shows the folder relative to home')
  await row(page, fixtures[6]!.title).click({ modifiers: ['ControlOrMeta'] })
  assert.match((await detail.textContent()) ?? '', /resume picker and --continue skip/, 'detail explains an sdk-cli session is hidden from the picker')
  await shot(page, 'browse-dark')

  await page.keyboard.press('?')
  const help = page.getByRole('dialog', { name: 'Keyboard shortcuts' })
  await help.waitFor()
  assert.match((await help.textContent()) ?? '', /Fold or unfold/, 'the shortcut overlay explains folding')
  await shot(page, 'shortcuts-dark')
  await page.keyboard.press('Escape')
  await help.waitFor({ state: 'detached' })

  await page.keyboard.press('ControlOrMeta+A')
  assert.equal(await selectedCount(page), fixtures.length, 'Cmd/Ctrl+A selects every session')
  await page.keyboard.press('ControlOrMeta+E')
  const confirm = page.getByRole('dialog', { name: `Export ${fixtures.length} sessions` })
  await confirm.waitFor()
  assert.match((await confirm.textContent()) ?? '', /account email/, 'export confirm warns about private content')
  assert.match((await confirm.textContent()) ?? '', /payment client/, 'export confirm lists the live session it will snapshot')
  await shot(page, 'export-confirm-dark')
  await confirm.getByRole('button', { name: 'Choose location…' }).click()
  const saved = page.getByRole('dialog', { name: 'Archive saved' })
  await saved.waitFor()
  assert.match((await saved.textContent()) ?? '', /handoff\.agentsessions/, 'export result names the saved file')
  assert.ok(existsSync(archivePath), 'export wrote the archive')
  await saved.getByRole('button', { name: 'Done' }).click()
  await page.keyboard.press('Escape')

  await page.getByRole('button', { name: 'Use light theme' }).click()
  assert.equal(await page.evaluate('document.documentElement.dataset.theme'), 'light', 'theme toggle switches to light')
  await row(page, fanout.title).click()
  await shot(page, 'browse-light')
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
  await shot(page, 'empty-dark')

  await page.getByRole('button', { name: /Import archive/ }).click()
  await page.getByRole('heading', { name: 'Import handoff.agentsessions' }).waitFor()
  const plan = page.locator('.plan')
  await page.locator('.plan:not(.stale) .badge').first().waitFor()
  assert.equal(await plan.locator('.badge', { hasText: 'Create' }).count(), fixtures.length, 'preview plans a create for every session')
  assert.match((await plan.textContent()) ?? '', /resume picker and --continue skip/, 'preview warns about the sdk-cli session')

  const webSource = join(source.home, 'code', 'web')
  const webTarget = page.getByLabel(`Folder on this machine for ${webSource}`)
  assert.equal(await webTarget.inputValue(), join(target.home, 'code', 'web'), 'mapping suggests the same folder under this home')
  const webRow = page.locator('.mapping', { has: webTarget })
  assert.equal(await webRow.locator('.mapping-status').textContent(), 'Folder does not exist yet', 'mapping flags a missing folder')
  await webRow.getByRole('button', { name: 'Choose…' }).click()
  await page.locator(`.plan:not(.stale) .plan-target[title="${chosenWebFolder}"]`).first().waitFor()
  assert.equal(await webTarget.inputValue(), chosenWebFolder, 'folder picker fills the mapping')
  assert.equal(await webRow.locator('.mapping-status').textContent(), 'Folder exists', 'preview re-runs with the chosen folder')
  await shot(page, 'import-preview-dark')

  const skipped = fixtures.at(-1)!
  await page.getByLabel(new RegExp(skipped.title)).uncheck()
  const run = page.getByRole('button', { name: `Import ${fixtures.length - 1} sessions` })
  await run.click()
  await page.getByRole('heading', { name: `${fixtures.length - 1} sessions placed` }).waitFor()
  assert.equal(await page.locator('.outcome .badge', { hasText: 'Placed' }).count(), fixtures.length - 1, 'every chosen session was placed')
  assert.equal(await page.locator('.outcome .command').count(), fixtures.length - 1, 'each placed session shows its resume command')
  assert.match((await page.locator('.outcome').first().textContent()) ?? '', /claude --resume/, 'resume command is a claude resume line')
  await shot(page, 'import-result-dark')

  await page.getByRole('button', { name: 'Back to sessions' }).click()
  await rows(page).first().waitFor()
  assert.deepEqual((await rowTitles(page)).sort(), titlesByAge.filter((title) => title !== skipped.title).sort(), 'the target machine now lists the imported sessions')
  assert.equal(await row(page, fanout.title).locator('.subcount').textContent(), '+8', 'subagents travelled with their parent')
  const placed = await readdir(join(target.claude, 'projects', encode(chosenWebFolder)))
  assert.deepEqual(placed.sort(), [`${byTitle(titlesByAge[3]!).id}.jsonl`, `${byTitle(titlesByAge[4]!).id}.jsonl`], 'web sessions landed in the chosen folder’s project')
  assert.deepEqual(problems, [], 'target machine logged no console errors')
  console.log('smoke passed')
} finally {
  await desktop.app.close()
  await rm(root, { recursive: true, force: true })
}
