import { describe, expect, it } from 'vitest'
import type { UpdateStatus } from '../src/shared/ipc'
import { IDLE, nextStatus, type UpdaterEvent } from '../src/main/updater'

const run = (events: UpdaterEvent[], from: UpdateStatus = IDLE) => events.reduce(nextStatus, from)

describe('update status', () => {
  it('offers a found update and downloads nothing until asked', () => {
    expect(run([{ type: 'available', version: '0.2.0' }])).toEqual({ kind: 'available', version: '0.2.0' })
    expect(run([{ type: 'available', version: '0.2.0' }, { type: 'progress', percent: 30 }])).toEqual({ kind: 'available', version: '0.2.0' })
  })

  it('downloads when asked, then offers the restart', () => {
    const found: UpdaterEvent[] = [{ type: 'available', version: '0.2.0' }, { type: 'download' }]
    expect(run(found)).toEqual({ kind: 'downloading', version: '0.2.0', percent: 0 })
    expect(run([...found, { type: 'progress', percent: 41.6 }])).toEqual({ kind: 'downloading', version: '0.2.0', percent: 42 })
    expect(run([...found, { type: 'progress', percent: 99 }, { type: 'downloaded', version: '0.2.0' }])).toEqual({ kind: 'ready', version: '0.2.0' })
  })

  it('ignores a download request with no update found', () => {
    expect(run([{ type: 'download' }])).toEqual(IDLE)
  })

  it('stays quiet when a check fails, and offers the update again when its download fails', () => {
    expect(run([{ type: 'error' }])).toEqual(IDLE)
    expect(run([{ type: 'available', version: '0.2.0' }, { type: 'error' }])).toEqual({ kind: 'available', version: '0.2.0' })
    expect(run([{ type: 'available', version: '0.2.0' }, { type: 'download' }, { type: 'progress', percent: 30 }, { type: 'error' }])).toEqual({ kind: 'available', version: '0.2.0' })
  })

  it('keeps the current state through later checks for the same version', () => {
    const downloading: UpdateStatus = { kind: 'downloading', version: '0.2.0', percent: 10 }
    const ready: UpdateStatus = { kind: 'ready', version: '0.2.0' }
    expect(run([{ type: 'available', version: '0.2.0' }], downloading)).toEqual(downloading)
    expect(run([{ type: 'available', version: '0.2.0' }], ready)).toEqual(ready)
    expect(run([{ type: 'error' }], ready)).toEqual(ready)
  })

  it('offers a newer version found after one is offered', () => {
    expect(run([{ type: 'available', version: '0.3.0' }], { kind: 'available', version: '0.2.0' })).toEqual({ kind: 'available', version: '0.3.0' })
  })
})
