import { describe, expect, it } from 'vitest'
import type { Manifest } from '../src/main/core/manifest'
import { suggestMappings } from '../src/main/core/import'

function manifest(homeDir: string, sessions: { cwd: string; cwds: string[] }[]): Manifest {
  return { source: { homeDir, sep: '/' }, sessions } as unknown as Manifest
}

const nowhere = () => false

describe('suggestMappings', () => {
  it('lists a project once, not each subfolder a session moved into', () => {
    const repo = '/Users/a/Code/app'
    const archive = manifest('/Users/a', [{ cwd: repo, cwds: [repo, `${repo}/apps/web`, `${repo}/apps/web/src/app/stats`, `${repo}/packages/core`] }])
    expect(suggestMappings(archive, { homeDir: '/home/b', sep: '/', exists: nowhere })).toEqual([{ source: repo, target: '/home/b/Code/app' }])
  })

  it('lists a subfolder whose session started there when its project folder was never recorded', () => {
    const archive = manifest('/Users/a', [{ cwd: '/Users/a/Code/app/apps/web', cwds: ['/Users/a/Code/app/apps/web', '/Users/a/Code/app/apps/web/e2e'] }])
    expect(suggestMappings(archive, { homeDir: '/home/b', sep: '/', exists: nowhere })).toEqual([
      { source: '/Users/a/Code/app/apps/web', target: '/home/b/Code/app/apps/web' },
    ])
  })

  it('keeps a folder whose name only starts like another one', () => {
    const archive = manifest('/Users/a', [{ cwd: '/Users/a/Code/app', cwds: ['/Users/a/Code/app', '/Users/a/Code/app-two'] }])
    expect(suggestMappings(archive, { homeDir: '/Users/a', sep: '/', exists: nowhere }).map((mapping) => mapping.source)).toEqual([
      '/Users/a/Code/app',
      '/Users/a/Code/app-two',
    ])
  })

  it('keeps a subfolder whose suggestion differs from what its project folder implies', () => {
    const archive = manifest('/Users/a', [{ cwd: '/Users/a/Code/app', cwds: ['/Users/a/Code/app', '/Users/a/Code/app/vendor'] }])
    const exists = (target: string) => target === '/Users/a/Code/app/vendor'
    expect(suggestMappings(archive, { homeDir: '/home/b', sep: '/', exists })).toEqual([
      { source: '/Users/a/Code/app', target: '/home/b/Code/app' },
      { source: '/Users/a/Code/app/vendor', target: '/Users/a/Code/app/vendor' },
    ])
  })
})
