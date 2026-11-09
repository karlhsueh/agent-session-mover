import { describe, expect, it } from 'vitest'
import { branchesLabel, expandTilde, platformLabel, tildePath } from '../src/renderer/src/model/format'

describe('mapping field paths', () => {
  it('shows a folder under home as ~ and expands it back to the same absolute path', () => {
    for (const [path, home] of [
      ['/Users/me/code/api', '/Users/me'],
      ['/Users/me', '/Users/me/'],
      ['C:\\Users\\me\\code', 'C:\\Users\\me'],
    ]) {
      expect(expandTilde(tildePath(path!, home!), home!)).toBe(path)
    }
    expect(tildePath('/Users/me/code/api', '/Users/me')).toBe('~/code/api')
  })

  it('leaves paths outside home, a ~user path, and an unknown home as typed', () => {
    expect(tildePath('/Users/meg/code', '/Users/me')).toBe('/Users/meg/code')
    expect(expandTilde('~other/code', '/Users/me')).toBe('~other/code')
    expect(expandTilde('~/code', '')).toBe('~/code')
  })

  it('expands a typed ~/ path with the separator of a Windows home', () => {
    expect(expandTilde('~/code/api', 'C:\\Users\\me')).toBe('C:\\Users\\me\\code\\api')
    expect(expandTilde('~/code\\api', '/Users/me')).toBe('/Users/me/code\\api')
  })
})

describe('platformLabel', () => {
  it('names the platforms people know and passes others through', () => {
    expect(['darwin', 'win32', 'linux', 'freebsd'].map(platformLabel)).toEqual(['macOS', 'Windows', 'Linux', 'freebsd'])
  })
})

describe('folder branches', () => {
  const on = (...branches: (string | null)[]) => branches.map((gitBranch) => ({ gitBranch }))
  it('names the distinct branches, sorted, at most three', () => {
    expect(branchesLabel(on(null, null))).toBeNull()
    expect(branchesLabel(on('main', null, 'main'))).toBe('main')
    expect(branchesLabel(on('main', 'feature/x'))).toBe('feature/x, main')
    expect(branchesLabel(on('e', 'd', 'c', 'b', 'a'))).toBe('a, b, c +2')
  })
})
