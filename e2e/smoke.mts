import assert from 'node:assert/strict'
import { _electron as electron } from 'playwright'

const app = await electron.launch({ args: ['.'] })

try {
  const page = await app.firstWindow()

  const problems: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(message.text())
  })
  page.on('pageerror', (error) => problems.push(error.message))
  await page.reload()

  const name = page.getByLabel('Name')
  const send = page.getByRole('button', { name: 'Send to main' })
  const crossing = page.getByRole('status')
  const value = (label: string) => page.locator('dt', { hasText: label }).locator('+ dd')

  assert.equal(await page.title(), 'Agent Sessions', 'window has the default title')

  const keys = await page.evaluate('Object.keys(window.api)')
  assert.deepEqual(keys, ['greet'], 'window.api exposes exactly greet')

  const globals = await page.evaluate('[typeof process, typeof require]')
  assert.deepEqual(globals, ['undefined', 'undefined'], 'page has no process or require')
  assert.equal(await value('typeof process').textContent(), 'undefined', 'page shows process undefined')
  assert.equal(await value('typeof require').textContent(), 'undefined', 'page shows require undefined')

  await name.fill('Karl')
  await send.click()
  await crossing.getByText('Karl').waitFor()

  const mainPid = await app.evaluate(() => process.pid)
  assert.ok(mainPid > 0, 'main process has a pid')
  assert.equal(await value('pid').textContent(), String(mainPid), 'page shows the pid of main')
  assert.equal(await value('electron').textContent(), await app.evaluate(() => process.versions.electron), 'page shows the electron version of main')

  await page.emulateMedia({ colorScheme: 'light' })
  await page.screenshot({ path: 'artifacts/smoke.png' })
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.screenshot({ path: 'artifacts/smoke-dark.png' })

  await name.fill('   ')
  await send.click()
  await crossing.getByText('non-blank string').waitFor()
  assert.equal(await value('pid').textContent(), '—', 'blank input clears the runtime readout')

  const numberResult = await page.evaluate<{ ok: boolean }>('window.api.greet(123)')
  assert.equal(numberResult.ok, false, 'greet(123) returns ok:false instead of throwing')

  assert.deepEqual(problems, [], 'page logged no console errors')
  console.log('smoke passed')
} finally {
  await app.close()
}
