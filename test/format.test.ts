import { describe, expect, it } from 'vitest'
import { expandTilde, platformLabel, tildePath } from '../src/renderer/src/model/format'

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
})

describe('platformLabel', () => {
  it('names the platforms people know and passes others through', () => {
    expect(['darwin', 'win32', 'linux', 'freebsd'].map(platformLabel)).toEqual(['macOS', 'Windows', 'Linux', 'freebsd'])
  })
})
