import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, type ElectronApplication, type Page } from 'playwright'
import { encode, HOUR, writeClaudeSession, type Fixture } from './claude-fixture.mts'
import { homeEnv } from './home.mts'
import { scaleArgs, sizeWindow } from './scale.mts'

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
  { id: '5a000000-0000-4000-8000-000000000004', title: 'Migrate the settings page to the new form library', project: 'code/web', entrypoint: 'claude-vscode', ageMinutes: 26 * HOUR, branch: 'feature/settings-form' },
  { id: '5a000000-0000-4000-8000-000000000005', title: 'Investigate the hydration warning on checkout', project: 'code/web', entrypoint: 'cli', ageMinutes: 50 * HOUR },
  { id: '5a000000-0000-4000-8000-000000000006', title: 'Why is the localhost socket refusing connections', project: 'code/local-job-manager', entrypoint: 'cli', ageMinutes: 60 * HOUR },
  { id: '5a000000-0000-4000-8000-000000000007', title: 'Nightly changelog summary', project: 'code/tools', entrypoint: 'sdk-cli', ageMinutes: 74 * HOUR },
  { id: '5a000000-0000-4000-8000-000000000008', title: 'Tidy the zsh prompt', project: 'dotfiles', entrypoint: 'cli', ageMinutes: 5 * 24 * HOUR },
  { id: '5a000000-0000-4000-8000-000000000009', title: 'Draft the onboarding doc', project: 'notes', entrypoint: 'claude-desktop', ageMinutes: 8 * 24 * HOUR },
  { id: '5a000000-0000-4000-8000-00000000000a', title: 'Review the terraform plan for the staging VPC', project: 'infra', entrypoint: 'cli', ageMinutes: 9 * 24 * HOUR },
]
const byTitle = (title: string) => fixtures.find((fixture) => fixture.title === title)!
const fanout = fixtures[1]!

for (const fixture of fixtures) await writeClaudeSession(source.claude, source.home, fixture)
await mkdir(source.codex, { recursive: true })
await mkdir(target.claude, { recursive: true })
await mkdir(target.codex, { recursive: true })
await mkdir(join(target.home, 'code', 'api'), { recursive: true })
const chosenWebFolder = join(target.home, 'checkouts', 'web-main')
await mkdir(chosenWebFolder, { recursive: true })

async function launch(on: Machine, extra: Record<string, string>): Promise<{ app: ElectronApplication; page: Page; problems: string[] }> {
  const app = await electron.launch({
    args: [...scaleArgs(), '.'],
    env: { ...process.env, ...(await homeEnv(on.home)), CLAUDE_CONFIG_DIR: on.claude, CODEX_HOME: on.codex, AGENT_SESSIONS_E2E_USER_DATA: on.userData, ...extra },
  })
  const page = await app.firstWindow()
  const problems: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(message.text())
  })
  page.on('pageerror', (error) => problems.push(error.message))
  await page.reload()
  await sizeWindow(app, page, 1200, 760)
  return { app, page, problems }
}

const list = (page: Page) => page.getByRole('listbox', { name: 'Sessions' })
const rows = (page: Page) => list(page).locator('.row')
const rowTitles = (page: Page) => rows(page).locator('.row-title .truncate').allTextContents()
const sidebar = (page: Page) => page.getByRole('listbox', { name: 'Projects' })
const scopeNames = (page: Page) => sidebar(page).locator('.scope-name').allTextContents()
const scope = (page: Page, name: string) => sidebar(page).locator('.scope', { has: page.locator('.scope-name', { hasText: new RegExp(`^${name}$`) }) })
const focusedPane = (page: Page) => page.evaluate<string | null>("document.activeElement?.getAttribute('aria-label') ?? null")
const selectedCount = (page: Page) => list(page).locator('.row[aria-selected=true]').count()
const selectedTitles = (page: Page) => list(page).locator('.row[aria-selected=true] .row-title .truncate').allTextContents()
const row = (page: Page, title: string) => rows(page).filter({ hasText: title })
const titlesByAge = fixtures.map((fixture) => fixture.title)
const projectsByAge = ['api', 'local-job-manager', 'web', 'tools', 'dotfiles', 'notes', 'infra']
// Under xvfb, Chromium sometimes fails a capture with a protocol error. The capture is evidence, not an assertion, so try once more.
const shot = async (page: Page, name: string) => {
  const capture = () => page.screenshot({ animations: 'disabled', path: `artifacts/${name}.png` })
  await capture().catch(capture)
}

const laptop = await launch(source, { AGENT_SESSIONS_E2E_SAVE_PATH: archivePath })
try {
  const { app, page, problems } = laptop
  assert.equal(await page.title(), 'Agent Sessions', 'window has the default title')
  assert.deepEqual(
    await page.evaluate('Object.keys(window.api)'),
    ['listSessions', 'previewSession', 'exportSessions', 'openArchive', 'previewImport', 'previewArchiveSession', 'runImport', 'createFolder', 'onProgress', 'storeRoots', 'chooseFolder', 'revealExport', 'revealBackups', 'copyText', 'homeDir'],
    'window.api exposes exactly the declared capabilities',
  )
  assert.deepEqual(await page.evaluate('[typeof process, typeof require]'), ['undefined', 'undefined'], 'page has no process or require')
  const badImport = await page.evaluate<{ ok: boolean; error: { code: string } }>("window.api.runImport('not-a-token', [], [])")
  assert.deepEqual([badImport.ok, badImport.error.code], [false, 'invalid-input'], 'main rejects malformed import input')

  await rows(page).first().waitFor()
  assert.deepEqual(await scopeNames(page), ['All sessions', ...projectsByAge], 'the sidebar lists All sessions, then projects newest first')
  assert.deepEqual(await sidebar(page).locator('.scope-count').allTextContents(), ['10', '2', '2', '2', '1', '1', '1', '1'], 'each project counts its sessions')
  assert.equal(await scope(page, 'api').getAttribute('title'), join('~', 'code', 'api'), 'the full folder is in the tooltip, relative to home')
  assert.equal(await scope(page, 'api').locator('.scope-live').count(), 1, 'a project with a running session shows a live dot')
  assert.deepEqual(await rowTitles(page), titlesByAge, 'All sessions lists every session flat, newest activity first')
  assert.equal(await row(page, 'payment client').locator('.row-project').textContent(), 'api', 'in All sessions each row names its project')
  assert.equal(await row(page, 'payment client').locator('.badge.live').count(), 1, 'the running session carries a live badge')
  assert.equal(await row(page, fanout.title).locator('.subcount').textContent(), '+8', 'a session with subagents shows their count')

  await scope(page, 'web').click()
  assert.deepEqual(await rowTitles(page), [fixtures[3]!.title, fixtures[4]!.title], "a project scope lists only that folder's sessions")
  assert.equal(await page.locator('.list-head').textContent(), `${join('~', 'code', 'web')}2`, 'the list header names the folder and its count')
  assert.equal(await list(page).locator('.row-project').count(), 0, 'a project scope drops the project column')
  await page.keyboard.press('ArrowDown')
  assert.equal(await scope(page, 'tools').getAttribute('aria-selected'), 'true', 'Down in the sidebar moves to the next project')
  await page.keyboard.press('ArrowUp')
  await page.keyboard.press('ArrowRight')
  assert.equal(await focusedPane(page), 'Sessions', 'Right moves focus into the list')
  await page.keyboard.press('Space')
  await page.keyboard.press('ArrowLeft')
  assert.equal(await focusedPane(page), 'Projects', 'Left moves focus back to the sidebar')
  await scope(page, 'api').click()
  await page.keyboard.press('Enter')
  await page.keyboard.press('ControlOrMeta+A')
  assert.deepEqual(await selectedTitles(page), [fixtures[0]!.title, fixtures[2]!.title], 'Cmd/Ctrl+A selects every session in the scope')
  assert.equal(await scope(page, 'web').locator('.scope-pill').textContent(), '1', 'the sidebar shows a selection in another project')
  assert.equal(await scope(page, 'All sessions').locator('.scope-pill').textContent(), '3', 'All sessions counts every selected session')
  assert.match((await page.locator('.statusbar').textContent()) ?? '', /3 selected \(1 not in this view\)/, 'the footer counts the selection globally')
  await page.keyboard.press('Escape')
  assert.equal(await sidebar(page).locator('.scope-pill').count(), 0, 'Escape clears the selection everywhere')

  await scope(page, 'local-job-manager').click()
  await row(page, fanout.title).click()
  assert.equal(await rows(page).count(), 2, 'subagents never appear as list rows')
  const detail = page.getByRole('complementary', { name: 'Session details' })
  assert.equal(await detail.getByRole('region', { name: 'Subagents' }).locator('li').count(), 8, 'the detail panel lists every subagent')
  await shot(page, 'browse-subagents-dark')

  const search = page.getByRole('searchbox', { name: 'Search sessions' })
  await scope(page, 'All sessions').click()
  await search.fill('lease migration')
  assert.deepEqual(await rowTitles(page), [fanout.title], 'search finds a parent through a subagent title')
  assert.equal(await scope(page, 'local-job-manager').locator('.scope-count').textContent(), '1', 'while searching, the sidebar counts matches')
  assert.match((await scope(page, 'web').getAttribute('class')) ?? '', /no-match/, 'projects with no match dim')
  await search.fill('hydration')
  assert.deepEqual(await rowTitles(page), [fixtures[4]!.title], 'search matches titles')
  assert.equal(await rows(page).locator('mark').textContent(), 'hydration', 'title matches are highlighted')
  await search.fill(fixtures[6]!.id.slice(-6))
  assert.deepEqual(await rowTitles(page), [fixtures[6]!.title], 'search matches session ids')
  await search.fill('code/web')
  assert.equal((await rowTitles(page)).length, 2, 'search matches folders')
  await scope(page, 'api').click()
  assert.match((await page.locator('.list-pane').textContent()) ?? '', /No sessions in api match/, 'a project scope searches only that project')
  await page.getByRole('button', { name: 'Show 2 matches in all projects' }).click()
  assert.equal((await rowTitles(page)).length, 2, 'the empty scope offers the matches elsewhere')
  await search.focus()
  await search.press('Escape')
  assert.equal(await search.inputValue(), '', 'Escape clears the search')

  await page.getByRole('combobox', { name: 'Client' }).selectOption({ label: 'Desktop' })
  assert.deepEqual(await rowTitles(page), [fixtures[2]!.title, fixtures[8]!.title], 'client filter narrows the list')
  await page.getByRole('combobox', { name: 'Client' }).selectOption({ label: 'All clients' })
  await page.getByRole('combobox', { name: 'Sort by' }).selectOption({ label: 'Sort: Title' })
  assert.deepEqual(await rowTitles(page), [...titlesByAge].sort((a, b) => a.localeCompare(b)), 'title sort orders rows by title')
  await page.getByRole('combobox', { name: 'Sort by' }).selectOption({ label: 'Sort: Last activity' })

  await list(page).focus()
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

  await row(page, fixtures[2]!.title).click({ modifiers: ['ControlOrMeta'] })
  assert.match((await detail.textContent()) ?? '', /claude --resume 5a000000-0000-4000-8000-000000000003/, 'detail shows the focused session and its resume command')
  const resumeCd = process.platform === 'win32' ? `cd "${join(source.home, 'code', 'api')}" && claude --resume` : "cd ~/'code/api' && claude --resume"
  assert.ok(((await detail.locator('.command-block').textContent()) ?? '').startsWith(resumeCd), 'the resume command cds into the session folder, relative to home where the shell allows')
  await row(page, fixtures[6]!.title).click({ modifiers: ['ControlOrMeta'] })
  assert.match((await detail.textContent()) ?? '', /resume picker and --continue skip/, 'detail explains an sdk-cli session is hidden from the picker')
  assert.equal(await detail.locator('dt:has-text("Branch") + dd .mono').textContent(), 'main', 'detail shows the branch the session was on')
  await shot(page, 'browse-dark')

  const conversationTab = detail.getByRole('tab', { name: 'Conversation' })
  const conversation = detail.getByRole('list', { name: 'Conversation' })
  assert.equal(await detail.getByRole('tab', { name: 'Overview' }).getAttribute('aria-selected'), 'true', 'the detail panel opens on Overview, with no conversation text on screen')
  await conversationTab.click()
  await conversation.waitFor()
  assert.equal(await conversation.locator('.turn').first().textContent(), fixtures[6]!.title, 'the Conversation tab starts with the first prompt')
  assert.deepEqual(await conversation.locator('.turn-tool').allTextContents(), [`Read ${join('src', 'index.ts')}`, 'Ran pnpm test'], 'each tool call is one line')
  assert.equal(await focusedPane(page), 'Sessions', 'clicking a tab leaves focus in the list')
  await page.reload()
  await row(page, fixtures[2]!.title).click()
  assert.equal(await conversationTab.getAttribute('aria-selected'), 'true', 'the chosen tab survives a reload')
  assert.equal(await conversation.locator('.turn').first().textContent(), fixtures[2]!.title, 'the conversation loads for the newly focused session')
  await detail.getByRole('tab', { name: 'Overview' }).click()

  await page.keyboard.press('ControlOrMeta+\\')
  assert.equal(await sidebar(page).count(), 0, 'Cmd/Ctrl+\\ hides the sidebar')
  await page.keyboard.press('ControlOrMeta+\\')
  assert.equal(await sidebar(page).count(), 1, 'and shows it again')

  await page.keyboard.press('?')
  const help = page.getByRole('dialog', { name: 'Keyboard shortcuts' })
  await help.waitFor()
  assert.match((await help.textContent()) ?? '', /Go to the projects or the sessions/, 'the shortcut overlay explains moving between panes')
  await shot(page, 'shortcuts-dark')
  await page.keyboard.press('Escape')
  await help.waitFor({ state: 'detached' })
  await list(page).focus()

  await page.keyboard.press('ControlOrMeta+A')
  assert.equal(await selectedCount(page), fixtures.length, 'Cmd/Ctrl+A selects every session')
  await page.keyboard.press('ControlOrMeta+E')
  const confirm = page.getByRole('dialog', { name: `Export ${fixtures.length} sessions` })
  await confirm.waitFor()
  assert.match((await confirm.textContent()) ?? '', /account email/, 'export confirm warns about private content')
  assert.match((await confirm.textContent()) ?? '', /or your project files\. Push or copy the project/, 'export confirm reminds that project files travel separately')
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
  const { app, page, problems } = desktop
  await page.getByRole('heading', { name: 'No sessions on this machine' }).waitFor()
  assert.match((await page.locator('.roots').textContent()) ?? '', new RegExp(target.claude.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'empty state names the store folder it searched')
  await shot(page, 'empty-dark')

  await page.getByRole('button', { name: /Import archive/ }).click()
  await page.getByRole('heading', { name: 'Import handoff.agentsessions' }).waitFor()
  assert.match((await page.locator('.import-head p').textContent()) ?? '', /^10 sessions · exported from (macOS|Windows|Linux) on \w{3} \d+, \d+:\d\d/, 'the subtitle names the platform and date, not the source home path')
  const plan = page.locator('.plan')
  await page.locator('.plan:not(.stale) .badge').first().waitFor()
  assert.equal(await plan.locator('.badge', { hasText: 'Create' }).count(), fixtures.length, 'preview plans a create for every session')
  assert.match((await plan.textContent()) ?? '', /resume picker and --continue skip/, 'preview warns about the sdk-cli session')

  const webSource = join(source.home, 'code', 'web')
  const webTarget = page.getByLabel(`Folder on this machine for ${webSource}`)
  assert.equal(await webTarget.inputValue(), join('~', 'code', 'web'), 'mapping suggests the same folder under this home, shown relative to it')
  assert.equal(await page.getByText(/Pull or copy each project into its folder here before you resume/).count(), 1, 'import preview reminds to bring the project files')
  assert.equal(await webTarget.getAttribute('title'), join(target.home, 'code', 'web'), 'the field keeps the absolute folder in its tooltip')
  const webRow = page.locator('.mapping', { has: webTarget })
  assert.equal(await webRow.locator('.mapping-branches').textContent(), 'feature/settings-form, main', 'the folder row names the branches to check out')
  assert.equal(await webRow.locator('.mapping-status').textContent(), 'Folder does not exist yet', 'mapping flags a missing folder')
  await webRow.getByRole('button', { name: 'Choose…' }).click()
  await page.locator(`.plan:not(.stale) .plan-target[title="${chosenWebFolder.replace(/[\\"]/g, '\\$&')}"]`).first().waitFor()
  assert.equal(await webTarget.inputValue(), join('~', 'checkouts', 'web-main'), 'folder picker fills the mapping')
  assert.equal(await webRow.locator('.mapping-status').textContent(), 'Folder exists', 'preview re-runs with the chosen folder')
  await shot(page, 'import-preview-dark')
  await page.getByRole('button', { name: 'Use light theme' }).click()
  await shot(page, 'import-preview-light')
  await page.getByRole('button', { name: 'Use dark theme' }).click()

  const fanoutRow = page.locator('.plan-row', { hasText: fanout.title })
  await fanoutRow.getByRole('button', { name: /^Preview the conversation/ }).click()
  const archived = fanoutRow.getByRole('list', { name: 'Conversation' })
  await archived.waitFor()
  assert.equal(await archived.locator('.turn').first().textContent(), fanout.title, "import preview shows an archived session's conversation")
  assert.equal(await archived.locator('.turn-tool').first().textContent(), `Read ${join('src', 'index.ts')}`, 'the archived conversation lists its tool calls')
  await fanoutRow.getByRole('button', { name: /^Hide the conversation/ }).click()
  assert.equal(await archived.count(), 0, 'Hide folds the conversation away')

  const skipped = fixtures.at(-1)!
  await page.getByRole('checkbox', { name: skipped.title }).uncheck()
  const run = page.getByRole('button', { name: `Import ${fixtures.length - 1} sessions` })
  await run.click()
  await page.getByRole('heading', { name: `${fixtures.length - 1} sessions placed` }).waitFor()
  assert.equal(await page.locator('.outcome .badge', { hasText: 'Placed' }).count(), fixtures.length - 1, 'every chosen session was placed')
  assert.equal(await page.getByText(/Pull your latest changes into each folder/).count(), 1, 'the result asks to pull changes before resuming')
  assert.equal(await page.locator('.outcome .command').count(), fixtures.length - 1, 'each placed session shows its resume command')
  assert.match((await page.locator('.outcome').first().textContent()) ?? '', /claude --resume/, 'resume command is a claude resume line')
  assert.doesNotMatch((await page.locator('.statusbar').textContent()) ?? '', /Run |Backups/, 'a run with no backups leaves the run id out of the footer')
  await shot(page, 'import-result-dark')
  await page.getByRole('button', { name: 'Use light theme' }).click()
  await shot(page, 'import-result-light')
  await page.getByRole('button', { name: 'Use dark theme' }).click()
  const clipboardBefore = await app.evaluate(({ clipboard }) => clipboard.readText())
  try {
    await page.getByRole('button', { name: 'Copy all commands' }).click()
    await page.locator('.panel-head').getByRole('button', { name: 'Copied' }).waitFor()
    const commands = await page.locator('.outcome .command code').allTextContents()
    assert.equal(await app.evaluate(({ clipboard }) => clipboard.readText()), commands.join('\n'), 'Copy all commands copies every resume command, one per line')
  } finally {
    await app.evaluate(({ clipboard }, text) => clipboard.writeText(text), clipboardBefore)
  }

  await page.getByRole('button', { name: 'Back to sessions' }).click()
  await rows(page).first().waitFor()
  assert.deepEqual((await rowTitles(page)).sort(), titlesByAge.filter((title) => title !== skipped.title).sort(), 'the target machine now lists the imported sessions')
  assert.equal(await row(page, fanout.title).locator('.subcount').textContent(), '+8', 'subagents travelled with their parent')
  const placed = await readdir(join(target.claude, 'projects', encode(chosenWebFolder)))
  assert.deepEqual(placed.sort(), [`${byTitle(titlesByAge[3]!).id}.jsonl`, `${byTitle(titlesByAge[4]!).id}.jsonl`], "web sessions landed in the chosen folder's project")
  assert.deepEqual(problems, [], 'target machine logged no console errors')
  console.log('smoke passed')
} finally {
  await desktop.app.close()
  await rm(root, { recursive: true, force: true })
}
