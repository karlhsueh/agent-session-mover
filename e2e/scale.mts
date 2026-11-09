import type { ElectronApplication, Page } from 'playwright'

// AGENT_SESSIONS_SHOT_SCALE=2 renders the window at 2x, so screenshots are sharp on high-density displays.
export function scaleArgs(): string[] {
  const scale = process.env.AGENT_SESSIONS_SHOT_SCALE
  return scale ? [`--force-device-scale-factor=${scale}`] : []
}

// Playwright's setViewportSize resets the device pixel ratio to 1, so a scaled run resizes the window itself.
export async function sizeWindow(app: ElectronApplication, page: Page, width: number, height: number): Promise<void> {
  if (!process.env.AGENT_SESSIONS_SHOT_SCALE) return page.setViewportSize({ width, height })
  await app.evaluate(({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0]!.setContentSize(w!, h!), [width, height])
  await page.waitForFunction(`innerWidth === ${width} && innerHeight === ${height}`)
}
