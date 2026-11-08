import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, type Page } from 'playwright'
import { writeClaudeSession } from './claude-fixture.mts'
import { FANOUT_TITLE, LIVE_TITLE, SCREEN_FIXTURES, SELECTED_TITLES, SINGLE_PROJECT_FIXTURES } from './screens-fixture.mts'

/** `pnpm screens [prefix]` writes artifacts/compare/<prefix>-<state>.png for whichever layout the build has. */
const prefix = process.argv[2] ?? 'after'
const outDir = join('artifacts', 'compare')
await mkdir(outDir, { recursive: true })

const root = await realpath(await mkdtemp(join(tmpdir(), 'agent-sessions-screens-')))
const home = join(root, 'home')
for (const fixture of SCREEN_FIXTURES) await writeClaudeSession(join(home, '.claude'), home, fixture)
await mkdir(join(home, '.codex'), { recursive: true })

const archive = join(root, 'screens.agentsessions')
const launch = (at: string, extra: Record<string, string> = {}) =>
  electron.launch({
    args: ['.'],
    env: { ...process.env, HOME: at, USERPROFILE: at, CLAUDE_CONFIG_DIR: join(at, '.claude'), CODEX_HOME: join(at, '.codex'), AGENT_SESSIONS_E2E_USER_DATA: join(at, 'userdata'), ...extra },
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
  await row(page, SELECTED_TITLES[0]!).click()
  for (const title of SELECTED_TITLES.slice(1)) await row(page, title).click({ modifiers: ['ControlOrMeta'] })
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
    for (const folder of ['agent-sessions', 'api']) await page.getByRole('button', { name: `Collapse ${folder}` }).first().click()
    await list(page).evaluate((el) => el.scrollTo(0, 0))
  },
  light: async (page) => {
    await page.getByRole('button', { name: 'Clear', exact: true }).click()
    for (const folder of ['agent-sessions', 'api']) await page.getByRole('button', { name: `Expand ${folder}` }).first().click()
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
  const path = join(outDir, `${prefix}-${name}.png`)
  await page.screenshot({ animations: 'disabled', path })
  console.log(path)
}

try {
  const page = await app.firstWindow()
  await page.setViewportSize({ width: 1200, height: 760 })
  await page.evaluate(() => localStorage.clear())
  await page.reload()
  await list(page).locator('.row').first().waitFor()
  const sidebar = (await page.getByRole('listbox', { name: 'Projects' }).count()) > 0
  const states = sidebar ? SIDEBAR : TREE
  for (const [name, run] of Object.entries(states)) {
    await run(page)
    await page.waitForTimeout(150)
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
  await page.getByRole('button', { name: 'Choose location…' }).click()
  await page.getByRole('dialog', { name: 'Archive saved' }).getByRole('button', { name: 'Done' }).click()
  await page.keyboard.press('ControlOrMeta+O')
  await page.locator('.plan:not(.stale) .badge').first().waitFor()
  await page.locator('.plan-row', { hasText: FANOUT_TITLE }).getByRole('button', { name: 'Preview' }).click()
  await page.getByRole('list', { name: 'Conversation' }).waitFor()
  await page.locator('.plan-row', { hasText: FANOUT_TITLE }).scrollIntoViewIfNeeded()
  await shoot(page, 'import-preview-conversation')
} finally {
  await app.close()
}

const single = join(root, 'single')
for (const fixture of SINGLE_PROJECT_FIXTURES) await writeClaudeSession(join(single, '.claude'), single, fixture)
await mkdir(join(single, '.codex'), { recursive: true })
const singleApp = await launch(single)
try {
  const page = await singleApp.firstWindow()
  await page.setViewportSize({ width: 1200, height: 760 })
  await list(page).locator('.row').first().waitFor()
  await shoot(page, 'single-project')
} finally {
  await singleApp.close()
  await rm(root, { recursive: true, force: true })
}
