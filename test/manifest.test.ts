import { describe, expect, it } from 'vitest'
import { ManifestError, parseManifest } from '../src/main/core/manifest'

const SHA_A = 'a'.repeat(64)
const SHA_B = 'b'.repeat(64)

function manifest(overrides: { root?: Record<string, unknown>; session?: Record<string, unknown>; files?: unknown[] } = {}) {
  return {
    format: 'agent-sessions-archive',
    version: 1,
    createdAt: '2026-11-07T10:00:00.000Z',
    appVersion: '0.0.0',
    source: { platform: 'darwin', homeDir: '/Users/alice', sep: '/', storeRoots: { 'claude-code': '/Users/alice/.claude' } },
    sessions: [
      {
        agent: 'claude-code',
        id: '11111111-2222-4333-8444-555555555555',
        title: 'A title',
        client: 'cli',
        clientDetail: 'cli',
        cwd: '/Users/alice/proj',
        cwds: ['/Users/alice/proj'],
        createdAt: '2026-11-01T10:00:00.000Z',
        lastActivity: '2026-11-01T11:00:00.000Z',
        cliVersion: '2.1.319',
        files: overrides.files ?? [
          { role: 'transcript', path: 'projects/-Users-alice-proj/11111111-2222-4333-8444-555555555555.jsonl', sha256: SHA_A, size: 10, mtimeMs: 1 },
        ],
        ...overrides.session,
      },
    ],
    ...overrides.root,
  }
}

const file = (path: string, extra: Record<string, unknown> = {}) => ({ role: 'tool-result', path, sha256: SHA_B, size: 3, mtimeMs: 1, ...extra })
const transcript = manifest().sessions[0].files[0] as Record<string, unknown>

describe('parseManifest', () => {
  it('accepts a well-formed manifest', () => {
    const parsed = parseManifest(manifest())
    expect(parsed.sessions[0].files[0].path).toBe('projects/-Users-alice-proj/11111111-2222-4333-8444-555555555555.jsonl')
  })

  it.each([
    ['a newer version', manifest({ root: { version: 2 } })],
    ['another format', manifest({ root: { format: 'tar' } })],
    ['an absolute path', manifest({ files: [transcript, file('/etc/passwd')] })],
    ['a parent segment', manifest({ files: [transcript, file('projects/../../.ssh/id_rsa')] })],
    ['a dot segment', manifest({ files: [transcript, file('projects/./x')] })],
    ['a backslash', manifest({ files: [transcript, file('projects\\x')] })],
    ['a NUL byte', manifest({ files: [transcript, file('projects/x\0y')] })],
    ['an empty segment', manifest({ files: [transcript, file('projects//x')] })],
    ['a drive letter', manifest({ files: [transcript, file('C:/x')] })],
    ['a duplicate path', manifest({ files: [transcript, { ...transcript }] })],
    ['an uppercase hash', manifest({ files: [transcript, file('projects/x', { sha256: 'A'.repeat(64) })] })],
    ['a short hash', manifest({ files: [transcript, file('projects/x', { sha256: 'abc' })] })],
    ['an unknown role', manifest({ files: [transcript, file('projects/x', { role: 'credentials' })] })],
    ['a Codex role in a Claude session', manifest({ files: [transcript, file('projects/x', { role: 'rollout' })] })],
    ['a negative size', manifest({ files: [transcript, file('projects/x', { size: -1 })] })],
    ['one hash with two sizes', manifest({ files: [transcript, file('projects/x', { sha256: SHA_A, size: 11 })] })],
    ['no files', manifest({ files: [] })],
    ['an unknown agent', manifest({ session: { agent: 'cursor' } })],
    ['a session id with a slash', manifest({ session: { id: '../x' } })],
    ['a malformed time', manifest({ session: { lastActivity: 'yesterday' } })],
    ['a branch that is not a string', manifest({ session: { gitBranch: 42 } })],
    ['an empty branch', manifest({ session: { gitBranch: '' } })],
    ['a branch over 4096 characters', manifest({ session: { gitBranch: 'b'.repeat(4097) } })],
  ])('rejects %s', (_name, input) => {
    expect(() => parseManifest(input)).toThrow(ManifestError)
  })

  it('keeps the branch through a round trip, and reads an archive written before it as null', () => {
    const written = parseManifest(manifest({ session: { gitBranch: 'feature/x' } }))
    expect(parseManifest(JSON.parse(JSON.stringify(written))).sessions[0].gitBranch).toBe('feature/x')
    expect(parseManifest(manifest()).sessions[0].gitBranch).toBeNull()
    expect(parseManifest(manifest({ session: { gitBranch: null } })).sessions[0].gitBranch).toBeNull()
  })

  it('rejects the same session listed twice', () => {
    const input = manifest()
    input.sessions.push({ ...input.sessions[0] })
    expect(() => parseManifest(input)).toThrow(ManifestError)
  })

  it('rejects non-objects', () => {
    expect(() => parseManifest(null)).toThrow(ManifestError)
    expect(() => parseManifest([])).toThrow(ManifestError)
    expect(() => parseManifest('manifest')).toThrow(ManifestError)
  })
})

describe('archive origin', () => {
  const withSource = (extra: Record<string, unknown>) => {
    const input = manifest()
    return { ...input, source: { ...input.source, ...extra } }
  }
  const repo = { folder: '/Users/alice/proj', remote: 'git@github.com:acme/proj.git' }

  it('keeps the computer name and repos through a round trip', () => {
    const written = parseManifest(withSource({ computerName: "Alice's MacBook Pro", repos: [repo] }))
    const read = parseManifest(JSON.parse(JSON.stringify(written)))
    expect(read.source.computerName).toBe("Alice's MacBook Pro")
    expect(read.source.repos).toEqual([repo])
  })

  it('reads an archive written before the fields existed', () => {
    const read = parseManifest(manifest())
    expect(read.source.computerName).toBeNull()
    expect(read.source.repos).toEqual([])
  })

  it.each([
    ['a name that is not a string', { computerName: 7 }],
    ['an empty name', { computerName: '' }],
    ['a name with padding', { computerName: ' Mac ' }],
    ['a name with a newline', { computerName: 'Mac\nmini' }],
    ['a name with a bidi override', { computerName: 'Mac‮exe' }],
    ['a name over 128 characters', { computerName: 'm'.repeat(129) }],
    ['repos that are not a list', { repos: { '/x': repo.remote } }],
    ['a repo that is not an object', { repos: [repo.remote] }],
    ['a repo with no folder', { repos: [{ remote: repo.remote }] }],
    ['a repo listed twice', { repos: [repo, repo] }],
    ['a remote with a token', { repos: [{ ...repo, remote: 'https://x:ghp_token@github.com/a/b.git' }] }],
    ['a remote with a user', { repos: [{ ...repo, remote: 'https://ghp_token@github.com/a/b.git' }] }],
    ['a remote that is an option', { repos: [{ ...repo, remote: '--upload-pack=touch /tmp/x' }] }],
    ['a remote with shell characters', { repos: [{ ...repo, remote: `${repo.remote};id` }] }],
    ['a local path remote', { repos: [{ ...repo, remote: '/srv/repos/b' }] }],
    ['an ext remote', { repos: [{ ...repo, remote: 'ext::sh' }] }],
    ['a remote over 2048 characters', { repos: [{ ...repo, remote: `https://github.com/${'a'.repeat(2048)}` }] }],
  ])('rejects %s', (_name, extra) => {
    expect(() => parseManifest(withSource(extra))).toThrow(ManifestError)
  })
})
