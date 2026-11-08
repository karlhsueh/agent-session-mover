import { describe, expect, it } from 'vitest'
import { encodeProjectDir } from '../src/main/providers/claude-code/encode'

// Expected values were computed by a separate Python port of Claude Code's algorithm, not by this code.
describe('encodeProjectDir', () => {
  it('replaces every non-alphanumeric character with a dash', () => {
    expect(encodeProjectDir('/Users/alice/Code/agent-sessions')).toBe('-Users-alice-Code-agent-sessions')
    expect(encodeProjectDir('/private/tmp/x_y.z')).toBe('-private-tmp-x-y-z')
  })

  it('truncates past 200 characters and appends the base-36 Java string hash', () => {
    const long = '/Users/alice/' + Array.from({ length: 9 }, (_, i) => `a-very-long-folder-name-0${i}`).join('/')
    expect(encodeProjectDir(long)).toBe(
      '-Users-alice-a-very-long-folder-name-00-a-very-long-folder-name-01-a-very-long-folder-name-02-a-very-long-folder-name-03-a-very-long-folder-name-04-a-very-long-folder-name-05-a-very-long-folder-name-0-v8ocfi',
    )
  })

  it('hashes UTF-16 code units, so non-ASCII and astral characters count like the CLI counts them', () => {
    const long = '/home/bob/projects/' + 'x'.repeat(190) + '/naïve 🚀'
    expect(encodeProjectDir(long)).toBe(`-home-bob-projects-${'x'.repeat(181)}-y4dw9f`)
  })

  it('leaves a path of exactly 200 encoded characters alone', () => {
    const path = '/' + 'a'.repeat(199)
    expect(encodeProjectDir(path)).toBe('-' + 'a'.repeat(199))
  })
})
