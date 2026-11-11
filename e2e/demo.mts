import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, type ElectronApplication, type Locator, type Page } from 'playwright'
import { HOUR, writeClaudeSession, type Fixture } from './claude-fixture.mts'
import { homeEnv } from './home.mts'

/**
 * `pnpm demo` records the export-on-one-machine, import-on-another walkthrough from fake sessions. This
 * saves Chromium's screencast frames to artifacts/demo/frames with an ffmpeg concat list, and
 * scripts/demo.sh encodes them. Playwright's recordVideo hangs Electron's first window, hence the screencast.
 */
const WIDTH = 1200
const HEIGHT = 760
const SCALE = 2
const outDir = join('artifacts', 'demo')
await mkdir(outDir, { recursive: true })

const root = await realpath(await mkdtemp(join(tmpdir(), 'agent-sessions-demo-')))
const archive = join(root, 'laptop', 'Desktop', 'handoff.agentsessions')
const machine = (name: string) => ({ home: join(root, name), userData: join(root, `${name}-userdata`) })
const laptop = machine('laptop')
const desktop = machine('desktop')

const SUBAGENTS = [
  ['Explore', 'Map the worker lifecycle'],
  ['Explore', 'Find every caller of enqueue'],
  ['general-purpose', 'Write the lease migration'],
  ['Plan', 'Sketch the retry backoff'],
].map(([type, description]) => ({ type: type!, description: description! }))

const PICKED = ['Plan the job queue rewrite', 'Add cursor pagination to the orders endpoint', 'Migrate the settings page to the new form library']
const fixtures: Fixture[] = [
  { id: '5a000000-0000-4000-8000-000000000002', title: PICKED[0]!, project: 'code/job-queue', entrypoint: 'cli', ageMinutes: 12, subagents: SUBAGENTS, rounds: 3 },
  { id: '5a000000-0000-4000-8000-000000000003', title: PICKED[1]!, project: 'code/api', entrypoint: 'cli', ageMinutes: 95, rounds: 2 },
  { id: '5a000000-0000-4000-8000-000000000004', title: PICKED[2]!, project: 'code/web', entrypoint: 'claude-vscode', ageMinutes: 26 * HOUR, branch: 'feature/settings-form' },
  { id: '5a000000-0000-4000-8000-000000000005', title: 'Investigate the hydration warning on checkout', project: 'code/web', entrypoint: 'cli', ageMinutes: 50 * HOUR },
  { id: '5a000000-0000-4000-8000-000000000007', title: 'Nightly changelog summary', project: 'code/tools', entrypoint: 'sdk-cli', ageMinutes: 74 * HOUR },
  { id: '5a000000-0000-4000-8000-000000000008', title: 'Tidy the zsh prompt', project: 'dotfiles', entrypoint: 'cli', ageMinutes: 5 * 24 * HOUR },
  { id: '5a000000-0000-4000-8000-000000000009', title: 'Draft the onboarding doc', project: 'notes', entrypoint: 'claude-desktop', ageMinutes: 8 * 24 * HOUR },
]
for (const fixture of fixtures) await writeClaudeSession(join(laptop.home, '.claude'), laptop.home, fixture)
for (const at of [laptop, desktop]) await mkdir(join(at.home, '.codex'), { recursive: true })
await mkdir(join(desktop.home, '.claude'), { recursive: true })
await mkdir(join(laptop.home, 'Desktop'), { recursive: true })
for (const project of ['code/job-queue', 'code/api', 'code/web']) await mkdir(join(desktop.home, project), { recursive: true })

// A drawn pointer and a caption, since a recording shows neither the OS cursor nor what the viewer is looking at.
// Styles go on the elements, because the app's content security policy blocks an injected <style>.
const OVERLAY = `(() => {
  const cursor = document.createElement('div')
  Object.assign(cursor.style, { position: 'fixed', left: '0px', top: '0px', width: '22px', height: '22px', zIndex: '2147483647', pointerEvents: 'none', transform: 'translate(-3px, -2px)', transition: 'scale 120ms' })
  cursor.innerHTML = '<svg viewBox="0 0 22 22" width="22" height="22"><path d="M3 2 L3 18 L7.5 14 L10.5 20.5 L13 19.4 L10 13 L16 13 Z" fill="#fff" stroke="#000" stroke-width="1.4" stroke-linejoin="round"/></svg>'
  const caption = document.createElement('div')
  Object.assign(caption.style, { position: 'fixed', left: '50%', bottom: '3px', translate: '-50% 0', zIndex: '2147483646', pointerEvents: 'none', padding: '8px 16px', borderRadius: '9px',
    font: '600 17px/1.3 -apple-system, system-ui, sans-serif', color: '#fff', background: 'rgba(20, 20, 24, 0.9)', boxShadow: '0 6px 24px rgba(0,0,0,.35)', opacity: '0', transition: 'opacity 250ms', whiteSpace: 'nowrap' })
  document.body.append(cursor, caption)
  addEventListener('mousemove', (e) => { cursor.style.left = e.clientX + 'px'; cursor.style.top = e.clientY + 'px' }, true)
  addEventListener('mousedown', () => { cursor.style.scale = '0.85' }, true)
  addEventListener('mouseup', () => { cursor.style.scale = '1' }, true)
  window.demoCaption = (text) => { if (text) caption.textContent = text; caption.style.opacity = text ? '1' : '0' }
})()`

class Director {
  private x = WIDTH / 2
  private y = HEIGHT / 2
  readonly page: Page
  constructor(page: Page) {
    this.page = page
  }

  async ready(): Promise<void> {
    await this.page.evaluate(OVERLAY)
    await this.page.mouse.move(this.x, this.y)
  }

  async caption(text: string): Promise<void> {
    await this.page.evaluate(`window.demoCaption(${JSON.stringify(text)})`)
  }

  async moveTo(target: Locator): Promise<void> {
    const box = await target.boundingBox()
    if (!box) throw new Error(`Nothing to point at for ${target}`)
    const [toX, toY] = [box.x + Math.min(box.width / 2, 60), box.y + box.height / 2]
    const steps = Math.max(12, Math.round(Math.hypot(toX - this.x, toY - this.y) / 18))
    for (let i = 1; i <= steps; i++) {
      const t = i / steps
      const ease = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2
      await this.page.mouse.move(this.x + (toX - this.x) * ease, this.y + (toY - this.y) * ease)
      await this.page.waitForTimeout(12)
    }
    ;[this.x, this.y] = [toX, toY]
  }

  async click(target: Locator, modifiers: ('ControlOrMeta' | 'Shift')[] = []): Promise<void> {
    await this.moveTo(target)
    await this.page.waitForTimeout(150)
    for (const key of modifiers) await this.page.keyboard.down(key)
    await this.page.mouse.down()
    await this.page.waitForTimeout(90)
    await this.page.mouse.up()
    for (const key of modifiers) await this.page.keyboard.up(key)
  }

  hold(ms: number): Promise<void> {
    return this.page.waitForTimeout(ms)
  }
}

async function launch(at: ReturnType<typeof machine>, extra: Record<string, string>): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({
    args: [`--force-device-scale-factor=${SCALE}`, '.'],
    env: { ...process.env, ...(await homeEnv(at.home)), CLAUDE_CONFIG_DIR: join(at.home, '.claude'), CODEX_HOME: join(at.home, '.codex'), AGENT_SESSIONS_E2E_USER_DATA: at.userData, ...extra },
  })
  const page = await app.firstWindow()
  await app.evaluate(({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0]!.setContentSize(w!, h!), [WIDTH, HEIGHT])
  await page.waitForFunction(`innerWidth === ${WIDTH} && innerHeight === ${HEIGHT}`)
  if (await page.getByRole('button', { name: 'Use dark theme' }).count()) await page.getByRole('button', { name: 'Use dark theme' }).click()
  return { app, page }
}

const framesDir = join(outDir, 'frames')
await rm(framesDir, { recursive: true, force: true })
await mkdir(framesDir, { recursive: true })
const concat: string[] = []
let frameCount = 0

/** Saves every screencast frame until the returned stop is called, and lists each with how long it showed. */
async function record(page: Page): Promise<() => Promise<void>> {
  const cdp = await page.context().newCDPSession(page)
  const frames: { name: string; at: number }[] = []
  const writes: Promise<void>[] = []
  cdp.on('Page.screencastFrame', ({ data, metadata, sessionId }) => {
    const name = `${String(frameCount++).padStart(5, '0')}.jpg`
    frames.push({ name, at: metadata.timestamp ?? Date.now() / 1000 })
    writes.push(writeFile(join(framesDir, name), Buffer.from(data, 'base64')))
    void cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {})
  })
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 95, maxWidth: WIDTH * SCALE, maxHeight: HEIGHT * SCALE })
  return async () => {
    const end = Date.now() / 1000
    await cdp.send('Page.stopScreencast')
    await Promise.all(writes)
    frames.forEach((frame, i) => concat.push(`file 'frames/${frame.name}'`, `duration ${((frames[i + 1]?.at ?? end) - frame.at).toFixed(3)}`))
  }
}

const list = (page: Page) => page.getByRole('listbox', { name: 'Sessions' })
const row = (page: Page, title: string) => list(page).locator('.row').filter({ hasText: title })

try {
  {
    const { app, page } = await launch(laptop, { AGENT_SESSIONS_E2E_SAVE_PATH: archive })
    await list(page).locator('.row').first().waitFor()
    const d = new Director(page)
    await d.ready()
    const stop = await record(page)
    await d.hold(400)
    await d.caption('Your Claude Code sessions, on your laptop')
    await d.hold(1600)
    await d.click(row(page, PICKED[0]!))
    await d.hold(900)
    const detail = page.getByRole('complementary', { name: 'Session details' })
    await d.click(detail.getByRole('tab', { name: 'Conversation' }))
    await d.hold(1400)
    await d.caption('Pick the ones to take with you')
    for (const title of PICKED.slice(0, 3)) {
      await d.click(row(page, title).locator('.check-cell'))
      await d.hold(350)
    }
    await d.hold(800)
    await d.click(page.getByRole('button', { name: /^Export 3 sessions/ }))
    const confirm = page.getByRole('dialog', { name: 'Export 3 sessions' })
    await confirm.waitFor()
    await d.caption('Export them into one file')
    await d.hold(1500)
    await d.click(confirm.getByRole('button', { name: 'Choose location…' }))
    await page.getByRole('dialog', { name: 'Archive saved' }).waitFor()
    await d.hold(1500)
    await stop()
    await app.close()
  }
  {
    const { app, page } = await launch(desktop, { AGENT_SESSIONS_E2E_OPEN_PATH: archive })
    // The empty state names the temporary store folders, so recording starts on the import preview.
    await page.getByRole('heading', { name: 'No sessions on this machine' }).waitFor()
    await page.getByRole('button', { name: /Import archive/ }).click()
    await page.locator('.plan:not(.stale) .badge').first().waitFor()
    const d = new Director(page)
    await d.ready()
    const stop = await record(page)
    await d.caption('On the other computer, import the file')
    await d.hold(1800)
    await d.caption('Check where each project lives here')
    await d.hold(800)
    await d.moveTo(page.locator('.mapping').first())
    await d.hold(1600)
    await d.click(page.getByRole('button', { name: 'Import 3 sessions' }))
    await page.getByRole('heading', { name: '3 sessions imported' }).waitFor()
    await d.caption('Resume right where you left off')
    await d.hold(900)
    await d.moveTo(page.locator('.outcome .command').first())
    await d.hold(2600)
    await stop()
    await app.close()
  }
  // The concat demuxer drops the last entry's duration unless the file is listed once more.
  concat.push(concat.at(-2)!)
  await writeFile(join(outDir, 'frames.txt'), concat.join('\n') + '\n')
  console.log(`Saved ${frameCount} frames.`)
} finally {
  await rm(root, { recursive: true, force: true })
}
