import { describe, expect, it } from 'vitest'
import type { UpdateStatus } from '../src/shared/ipc'
import { IDLE, nextStatus, type UpdaterEvent } from '../src/main/updater'

const run = (events: UpdaterEvent[], from: UpdateStatus = IDLE) => events.reduce(nextStatus, from)

describe('update status', () => {
  it('shows a found update downloading, then ready to restart', () => {
    expect(run([{ type: 'available', version: '0.2.0' }])).toEqual({ kind: 'downloading', version: '0.2.0', percent: 0 })
    expect(run([{ type: 'available', version: '0.2.0' }, { type: 'progress', percent: 41.6 }])).toEqual({ kind: 'downloading', version: '0.2.0', percent: 42 })
    expect(run([{ type: 'available', version: '0.2.0' }, { type: 'progress', percent: 99 }, { type: 'downloaded', version: '0.2.0' }])).toEqual({ kind: 'ready', version: '0.2.0' })
  })

  it('stays quiet when a check or download fails', () => {
    expect(run([{ type: 'error' }])).toEqual(IDLE)
    expect(run([{ type: 'available', version: '0.2.0' }, { type: 'progress', percent: 30 }, { type: 'error' }])).toEqual(IDLE)
    expect(run([{ type: 'progress', percent: 30 }])).toEqual(IDLE)
  })

  it('keeps offering a downloaded update through later checks', () => {
    const ready: UpdateStatus = { kind: 'ready', version: '0.2.0' }
    expect(run([{ type: 'error' }], ready)).toEqual(ready)
    expect(run([{ type: 'available', version: '0.2.0' }, { type: 'progress', percent: 10 }], ready)).toEqual(ready)
  })

  it('downloads a newer version found after one is ready', () => {
    expect(run([{ type: 'available', version: '0.3.0' }], { kind: 'ready', version: '0.2.0' })).toEqual({ kind: 'downloading', version: '0.3.0', percent: 0 })
  })
})
