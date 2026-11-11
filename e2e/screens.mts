import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, type Page } from 'playwright'
import { encode, writeClaudeSession } from './claude-fixture.mts'
import { homeEnv } from './home.mts'
import { scaleArgs, sizeWindow } from './scale.mts'
import { FANOUT_TITLE, LIVE_TITLE, SCREEN_FIXTURES, SELECTED_TITLES, SINGLE_PROJECT_FIXTURES } from './screens-fixture.mts'

/** `pnpm screens [prefix]` writes artifacts/compare/<prefix>-<state>.png for whichever layout the build has. */
const prefix = process.argv[2] ?? 'after'
const outDir = join('artifacts', 'compare')
await mkdir(outDir, { recursive: true })

const root = await realpath(await mkdtemp(join(tmpdir(), 'agent-sessions-screens-')))
const home = join(root, 'home')
for (const fixture of SCREEN_FIXTURES) await writeClaudeSession(join(home, '.claude'), home, fixture)
// code/api stays missing, so the import screens show a folder still to clone beside ones that exist.
for (const project of ['code/agent-session-mover', 'code/local-job-manager']) await mkdir(join(home, project), { recursive: true })
await mkdir(join(home, '.codex'), { recursive: true })

const archive = join(root, 'screens.agentsessions')
const launch = async (at: string, extra: Record<string, string> = {}) =>
  electron.launch({
    args: [...scaleArgs(), '.'],
    env: { ...process.env, ...(await homeEnv(at)), CLAUDE_CONFIG_DIR: join(at, '.claude'), CODEX_HOME: join(at, '.codex'), AGENT_SESSIONS_E2E_USER_DATA: join(at, 'userdata'), ...extra },
  })
const app = await launch(home, { AGENT_SESSIONS_E2E_SAVE_PATH: archive, AGENT_SESSIONS_E2E_OPEN_PATH: archive })

const list = (page: Page) => page.getByRole('tree', { name: 'Sessions' }).or(page.getByRole('listbox', { name: 'Sessions' }))
const row = (page: Page, title: string) => list(page).locator('.row', { hasText: title })
const sidebarScope = (page: Page, name: string) => page.getByRole('listbox', { name: 'Projects' }).locator('.scope', { has: page.locator('.scope-name', { hasText: new RegExp(`^${name}`) }) })

/** Rows whose box lies fully inside their scroll container, so a reader sees them without scrolling. */
async function visibleRows(page: Page, container: string, rowSelector: string): Promise<number> {
  return page.evaluate<number>(`(() => {
    const box = document.querySelector(${JSON.stringify(container)})?.getBoundingClientRect()
    if (!box) return 0
    return [...document.querySelectorAll(${JSON.stringify(`${container} :is(${rowSelector})`)})].filter((el) => {
      const r = el.getBoundingClientRect()
      return r.height > 0 && r.top >= box.top - 1 && r.bottom <= box.bottom + 1
    }).length
  })()`)
}

async function selectAcrossProjects(page: Page) {
  for (const title of SELECTED_TITLES) await row(page, title).locator('.check-cell').click()
}

type State = (page: Page) => Promise<void>

const TREE: Record<string, State> = {
  default: async () => {},
  expanded: async (page) => {
    await row(page, FANOUT_TITLE).click()
    await page.keyboard.press('ArrowRight')
  },
  selection: async (page) => {
    await page.keyboard.press('ArrowLeft')
    await selectAcrossProjects(page)
    for (const folder of ['agent-session-mover', 'api']) await page.getByRole('button', { name: `Collapse ${folder}` }).first().click()
    await list(page).evaluate((el) => el.scrollTo(0, 0))
  },
  light: async (page) => {
    await page.getByRole('button', { name: 'Clear', exact: true }).click()
    for (const folder of ['agent-session-mover', 'api']) await page.getByRole('button', { name: `Expand ${folder}` }).first().click()
    await list(page).focus()
    await page.keyboard.press('Home')
    await page.getByRole('button', { name: 'Use light theme' }).click()
  },
}

const SIDEBAR: Record<string, State> = {
  default: async () => {},
  'project-scope': async (page) => {
    await sidebarScope(page, 'local-job-manager').click()
    await row(page, FANOUT_TITLE).click()
  },
  selection: async (page) => {
    await sidebarScope(page, 'All sessions').click()
    await selectAcrossProjects(page)
    await sidebarScope(page, 'web').first().click()
  },
  search: async (page) => {
    await sidebarScope(page, 'All sessions').click()
    await page.getByRole('searchbox', { name: 'Search sessions' }).fill('queue')
  },
  conversation: async (page) => {
    await page.getByRole('searchbox', { name: 'Search sessions' }).fill('')
    await page.getByRole('button', { name: 'Clear', exact: true }).click()
    await row(page, LIVE_TITLE).click()
    await page.getByRole('tab', { name: 'Conversation' }).click()
    await page.getByRole('list', { name: 'Conversation' }).waitFor()
  },
  light: async (page) => {
    await page.getByRole('tab', { name: 'Overview' }).click()
    await sidebarScope(page, 'All sessions').click()
    await list(page).focus()
    await page.keyboard.press('Home')
    await page.getByRole('button', { name: 'Use light theme' }).click()
  },
}

async function shoot(page: Page, name: string) {
  await page.waitForTimeout(150)
  await page.mouse.move(0, 0)
  const path = join(outDir, `${prefix}-${name}.png`)
  await page.screenshot({ animations: 'disabled', path })
  console.log(path)
}

/** A sheet covers the theme toggle, so this flips the theme attribute directly. */
async function shootBothThemes(page: Page, name: string) {
  await shoot(page, `${name}-dark`)
  await page.evaluate("document.documentElement.dataset.theme = 'light'")
  await shoot(page, `${name}-light`)
  await page.evaluate("document.documentElement.dataset.theme = 'dark'")
}

try {
  const page = await app.firstWindow()
  await sizeWindow(app, page, 1200, 760)
  await page.evaluate(() => localStorage.clear())
  await page.reload()
  await list(page).locator('.row').first().waitFor()
  const sidebar = (await page.getByRole('listbox', { name: 'Projects' }).count()) > 0
  const states = sidebar ? SIDEBAR : TREE
  for (const [name, run] of Object.entries(states)) {
    await run(page)
    await page.waitForTimeout(150)
    await page.mouse.move(0, 0)
    const path = join(outDir, `${prefix}-${name}.png`)
    await page.screenshot({ animations: 'disabled', path })
    const listRows = await visibleRows(page, '[aria-label="Sessions"]', '.row, .group-row, .sub-row')
    const sessionRows = await visibleRows(page, '[aria-label="Sessions"]', '.row')
    const scopes = sidebar ? await visibleRows(page, '[aria-label="Projects"]', '.scope') : 0
    console.log(`${path}: ${listRows} list rows visible (${sessionRows} sessions)${sidebar ? `, ${scopes} sidebar entries` : ''}`)
  }
  await page.getByRole('button', { name: 'Use dark theme' }).click()

  await selectAcrossProjects(page)
  await page.keyboard.press('ControlOrMeta+E')
  await shootBothThemes(page, 'export-confirm')
  await page.getByRole('button', { name: 'Choose location…' }).click()
  await page.getByRole('dialog', { name: 'Archive saved' }).waitFor()
  await shootBothThemes(page, 'export-done')
  await page.getByRole('dialog', { name: 'Archive saved' }).getByRole('button', { name: 'Done' }).click()
  await page.keyboard.press('ControlOrMeta+O')
  await page.locator('.verdict-part').first().waitFor()
  await shoot(page, 'import-all-identical')
  await page.locator('.plan-fold .fold-toggle').click()
  await page.locator('.plan-row', { hasText: FANOUT_TITLE }).getByRole('button', { name: 'Preview' }).click()
  await page.getByRole('list', { name: 'Conversation' }).waitFor()
  await page.locator('.plan-row', { hasText: FANOUT_TITLE }).scrollIntoViewIfNeeded()
  await shoot(page, 'import-preview-conversation')

  const trimmed = SCREEN_FIXTURES.find((fixture) => fixture.title === SELECTED_TITLES[0])!
  const transcript = join(home, '.claude', 'projects', encode(join(home, trimmed.project)), `${trimmed.id}.jsonl`)
  await writeFile(transcript, (await readFile(transcript, 'utf8')).replace(/[^\n]*\n$/, ''))
  await page.getByRole('button', { name: 'Cancel' }).click()
  await page.keyboard.press('ControlOrMeta+O')
  await page.locator('.plan:not(.stale) .badge', { hasText: 'Update' }).waitFor()
  await shoot(page, 'import-update')
  await page.locator('.plan-fold .fold-toggle').click()
  await shoot(page, 'import-update-identical')
  await page.getByRole('button', { name: /^Import \d+ sessions?/ }).click()
  await page.locator('.backups').waitFor()
  await shoot(page, 'import-result-backups')

  // Both copies changed after the export, so the archive and this computer disagree.
  const [replaced, kept] = SELECTED_TITLES.slice(1)
  for (const title of [replaced, kept]) {
    const fixture = SCREEN_FIXTURES.find((candidate) => candidate.title === title)!
    const file = join(home, '.claude', 'projects', encode(join(home, fixture.project)), `${fixture.id}.jsonl`)
    await writeFile(file, (await readFile(file, 'utf8')).replace('"Done."', '"Done here."'))
    // The copy to replace also went on here, so Replace warns that newer messages go to the backup.
    if (title === replaced) {
      const later = { type: 'user', isSidechain: false, cwd: join(home, fixture.project), sessionId: fixture.id, timestamp: new Date().toISOString(), message: { role: 'user', content: 'Also cover the empty page.' } }
      await writeFile(file, `${await readFile(file, 'utf8')}${JSON.stringify(later)}\n`)
    }
  }
  await page.getByRole('button', { name: 'Back to sessions' }).click()
  await page.keyboard.press('ControlOrMeta+O')
  await page.locator('.plan:not(.stale) .badge', { hasText: 'Conflict' }).first().waitFor()
  await page.locator('.plan-bulk').evaluate((el) => el.scrollIntoView({ block: 'start' }))
  await shoot(page, 'import-conflict')
  await page.locator('.plan-row', { hasText: replaced }).getByRole('button', { name: "Replace with the archive's copy" }).click()
  await page.locator('.verdict').evaluate((el) => el.scrollIntoView({ block: 'start' }))
  await shoot(page, 'import-conflict-replace')
  await page.getByRole('button', { name: 'Use light theme' }).click()
  await shoot(page, 'import-conflict-light')
  await page.locator('.plan-row', { hasText: kept }).getByRole('button', { name: /^Preview the archive's copy/ }).click()
  await page.getByRole('list', { name: 'Conversation' }).waitFor()
  await page.locator('.plan-row', { hasText: kept }).evaluate((el) => el.scrollIntoView({ block: 'start' }))
  await shoot(page, 'import-conflict-preview-light')
  await page.keyboard.press('Escape')
  await page.getByRole('dialog', { name: 'Leave the import' }).waitFor()
  await shoot(page, 'import-leave-light')
  await page.evaluate("document.documentElement.dataset.theme = 'dark'")
  await shoot(page, 'import-leave-dark')
  await page.evaluate("document.documentElement.dataset.theme = 'light'")
  await page.keyboard.press('Escape')
  await page.getByRole('dialog', { name: 'Leave the import' }).waitFor({ state: 'detached' })
  await page.getByRole('button', { name: /^Import \d+ sessions?/ }).click()
  await page.locator('.backups').waitFor()
  await shoot(page, 'import-result-conflict-light')
  await page.getByRole('button', { name: 'Use dark theme' }).click()
  await page.locator('.fold-toggle').click()
  await shoot(page, 'import-result-conflict')
} finally {
  await app.close()
}

const single = join(root, 'single')
for (const fixture of SINGLE_PROJECT_FIXTURES) await writeClaudeSession(join(single, '.claude'), single, fixture)
await mkdir(join(single, '.codex'), { recursive: true })
const singleApp = await launch(single)
try {
  const page = await singleApp.firstWindow()
  await sizeWindow(singleApp, page, 1200, 760)
  await list(page).locator('.row').first().waitFor()
  await shoot(page, 'single-project')
} finally {
  await singleApp.close()
  await rm(root, { recursive: true, force: true })
}
