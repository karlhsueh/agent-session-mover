import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { exportSessions } from '../src/main/core/export'
import { closeArchive, openArchive, summarizeArchive } from '../src/main/core/import'
import { isSafeRemote, sanitizeComputerName } from '../src/main/core/manifest'
import { cleanRemote, readRepos, remoteUrls } from '../src/main/core/origin'
import { sessionKey } from '../src/shared/sessions'
import { readArchiveEntries } from './fixtures/archive'
import { removeTempDir, writeSession } from './fixtures/claude-store'
import { type Machine, makeMachine } from './fixtures/machine'

const TOKEN = 'ghp_SECRETTOKEN123'

describe('cleanRemote', () => {
  it.each([
    [`https://alice:${TOKEN}@github.com/acme/api.git`, 'https://github.com/acme/api.git'],
    [`https://${TOKEN}@github.com/acme/api.git`, 'https://github.com/acme/api.git'],
    [`http://alice:${TOKEN}@git.example.com:8080/acme/api`, 'http://git.example.com:8080/acme/api'],
    ['https://github.com/acme/api.git?token=x#frag', 'https://github.com/acme/api.git'],
    [`ssh://git:${TOKEN}@github.com/acme/api.git`, 'ssh://git@github.com/acme/api.git'],
    ['ssh://git@github.com:2222/acme/api.git', 'ssh://git@github.com:2222/acme/api.git'],
    ['git@github.com:acme/api.git', 'git@github.com:acme/api.git'],
    ['github.com:acme/api.git', 'github.com:acme/api.git'],
  ])('keeps %s as %s', (raw, clean) => {
    expect(cleanRemote(raw)).toBe(clean)
  })

  it.each([
    '/srv/git/api.git',
    'file:///srv/git/api.git',
    '../api.git',
    'C:/repos/api',
    '-oProxyCommand=touch /tmp/x',
    'ext::sh -c touch% /tmp/x',
    "git@github.com:acme/api.git'; rm -rf ~",
    'git@github.com:acme/$(whoami).git',
    'https://github.com/acme/api with space',
    '',
  ])('drops %j', (raw) => {
    expect(cleanRemote(raw)).toBeNull()
  })
})

describe('remoteUrls', () => {
  it('reads each remote url and nothing else, origin by name', () => {
    const config = [
      '[core]',
      '\tbare = false',
      '[user]',
      '\temail = alice@example.com',
      '[credential]',
      `\thelper = store --token ${TOKEN}`,
      '[remote "upstream"]',
      '\turl = git@github.com:upstream/api.git',
      '[REMOTE "origin"] ; comment',
      '\turl = "https://github.com/acme/api.git" # trailing',
      '\turl = https://mirror.example.com/api.git',
      '\tpushurl = git@github.com:acme/api.git',
    ].join('\n')
    expect([...remoteUrls(config)]).toEqual([
      ['upstream', 'git@github.com:upstream/api.git'],
      ['origin', 'https://github.com/acme/api.git'],
    ])
  })
})

describe('sanitizeComputerName', () => {
  it('trims, strips control and bidi characters, and caps the length', () => {
    expect(sanitizeComputerName("  Alice's MacBook Pro\n")).toBe("Alice's MacBook Pro")
    expect(sanitizeComputerName('evil\u202Egnp.exe')).toBe('evil gnp.exe')
    expect(sanitizeComputerName('x'.repeat(500))).toHaveLength(128)
    expect(sanitizeComputerName(' \u0000 ')).toBeNull()
  })
})

describe('isSafeRemote', () => {
  it('rejects credentials and shell or option characters', () => {
    expect(isSafeRemote('https://user@github.com/a/b')).toBe(false)
    expect(isSafeRemote('ssh://u:p@github.com/a/b')).toBe(false)
    expect(isSafeRemote('ssh://@github.com/a/b')).toBe(false)
    expect(isSafeRemote('-u')).toBe(false)
    expect(isSafeRemote('git@-host:a/b')).toBe(false)
    expect(isSafeRemote('localhost:a/b')).toBe(false)
    expect(isSafeRemote('x'.repeat(3000))).toBe(false)
    expect(isSafeRemote(42)).toBe(false)
  })
})

describe('export records where the archive came from', () => {
  let a: Machine
  let b: Machine
  let repo: string
  let worktree: string
  const S1 = '3a000000-0000-4000-8000-000000000001'
  const S2 = '3b000000-0000-4000-8000-000000000002'
  const S3 = '3c000000-0000-4000-8000-000000000003'

  beforeEach(async () => {
    a = await makeMachine('origin-src')
    b = await makeMachine('origin-dst')
    repo = path.join(a.home, 'code', 'api')
    worktree = path.join(a.home, 'code', 'api-feature')
    await mkdir(path.join(repo, '.git', 'worktrees', 'api-feature'), { recursive: true })
    await mkdir(path.join(repo, 'server'), { recursive: true })
    await writeFile(
      path.join(repo, '.git', 'config'),
      `[core]\n\trepositoryformatversion = 0\n[user]\n\temail = alice@example.com\n[remote "backup"]\n\turl = https://alice:${TOKEN}@backup.example.com/api.git\n[remote "origin"]\n\turl = https://alice:${TOKEN}@github.com/acme/api.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`,
    )
    await mkdir(worktree, { recursive: true })
    await writeFile(path.join(worktree, '.git'), `gitdir: ${path.join(repo, '.git', 'worktrees', 'api-feature')}\n`)
    await writeFile(path.join(repo, '.git', 'worktrees', 'api-feature', 'commondir'), '../..\n')
    await writeSession(a.root, { id: S1, cwd: path.join(repo, 'server') })
    await writeSession(a.root, { id: S2, cwd: worktree, startMinute: 30 })
    await writeSession(a.root, { id: S3, cwd: path.join(a.home, 'notes'), startMinute: 60 })
  })
  afterEach(async () => {
    await removeTempDir(a.dir)
    await removeTempDir(b.dir)
  })

  it('finds the repo above a folder and through a worktree pointer', async () => {
    expect(await readRepos([path.join(repo, 'server'), worktree, path.join(a.home, 'notes'), 'relative/path'])).toEqual([
      { folder: repo, remote: 'https://github.com/acme/api.git' },
      { folder: worktree, remote: 'https://github.com/acme/api.git' },
    ])
  })

  it('writes the computer name and each repo remote without credentials, and import reads them back', async () => {
    const file = path.join(a.dir, 'out.agentsessions')
    await exportSessions(a.context, [S1, S2, S3].map((id) => sessionKey('claude-code', id)), file)
    const entries = await readArchiveEntries(file)
    const raw = entries.get('manifest.json')!.toString()
    expect(raw).not.toContain(TOKEN)
    expect(raw).not.toContain('alice@example.com')
    expect(raw).not.toContain('backup.example.com')
    const manifest = JSON.parse(raw)
    expect(manifest.version).toBe(1)
    expect(manifest.source.computerName).toBe('Test Mac')
    expect(manifest.source.repos).toEqual([
      { folder: repo, remote: 'https://github.com/acme/api.git' },
      { folder: worktree, remote: 'https://github.com/acme/api.git' },
    ])

    const opened = await openArchive(b.context, file)
    try {
      const summary = summarizeArchive(opened)
      expect(summary.source.computerName).toBe('Test Mac')
      expect(summary.source.repos).toHaveLength(2)
    } finally {
      await closeArchive(opened)
    }
  })

  it('never fails an export when the computer name cannot be read', async () => {
    const file = path.join(a.dir, 'out.agentsessions')
    await exportSessions({ ...a.context, computerName: async () => null }, [sessionKey('claude-code', S3)], file)
    const manifest = JSON.parse((await readArchiveEntries(file)).get('manifest.json')!.toString())
    expect(manifest.source.computerName).toBeNull()
    expect(manifest.source.repos).toEqual([])
  })
})
