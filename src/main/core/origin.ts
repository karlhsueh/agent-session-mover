import { execFile } from 'node:child_process'
import { readFile, stat } from 'node:fs/promises'
import { hostname } from 'node:os'
import path from 'node:path'
import { isSafeRemote, type ManifestRepo, sanitizeComputerName } from './manifest'

/** The computer's name as its owner sees it, or null. Never throws, because export must not fail over a label. */
export async function readComputerName(platform: NodeJS.Platform): Promise<string | null> {
  if (platform === 'darwin') {
    const friendly = await new Promise<string | null>((resolve) => {
      execFile('scutil', ['--get', 'ComputerName'], { timeout: 1500, encoding: 'utf8' }, (error, stdout) => resolve(error ? null : stdout))
    })
    const name = friendly && sanitizeComputerName(friendly)
    if (name) return name
  }
  try {
    return sanitizeComputerName(hostname().replace(/\.local$/i, ''))
  } catch {
    return null
  }
}

const MAX_CONFIG_BYTES = 1024 * 1024
const MAX_DEPTH = 128

/**
 * The git repos that hold the given folders on this computer, each with one remote address and no
 * credentials. Reads the repo's config file instead of running git, so nothing else in it is touched.
 */
export async function readRepos(folders: Iterable<string>): Promise<ManifestRepo[]> {
  const byRoot = new Map<string, ManifestRepo | null>()
  for (const folder of folders) {
    if (!path.isAbsolute(folder)) continue
    const root = await repoRoot(folder).catch(() => null)
    if (!root || byRoot.has(root.dir)) continue
    const remote = await readRemote(root.gitPath).catch(() => null)
    byRoot.set(root.dir, remote ? { folder: root.dir, remote } : null)
  }
  return [...byRoot.values()].filter((repo): repo is ManifestRepo => repo !== null)
}

/** The nearest folder at or above `folder` that has a `.git` entry. */
async function repoRoot(folder: string): Promise<{ dir: string; gitPath: string } | null> {
  let current = path.resolve(folder)
  for (let depth = 0; depth < MAX_DEPTH; depth++) {
    const gitPath = path.join(current, '.git')
    if (await stat(gitPath).catch(() => null)) return { dir: current, gitPath }
    const parent = path.dirname(current)
    if (parent === current) return null
    current = parent
  }
  return null
}

/** `.git` is a folder, or a file naming one (`gitdir:`) for a worktree or submodule, whose `commondir` holds the config. */
async function configPath(gitPath: string): Promise<string> {
  let gitDir = gitPath
  if ((await stat(gitPath)).isFile()) {
    const pointer = (await readFile(gitPath, 'utf8')).match(/^gitdir:\s*(.+?)\s*$/m)
    if (!pointer) throw new Error('not a git pointer file')
    gitDir = path.resolve(path.dirname(gitPath), pointer[1]!)
  }
  const common = await readFile(path.join(gitDir, 'commondir'), 'utf8').catch(() => null)
  if (common?.trim()) gitDir = path.resolve(gitDir, common.trim())
  return path.join(gitDir, 'config')
}

async function readRemote(gitPath: string): Promise<string | null> {
  const file = await configPath(gitPath)
  if ((await stat(file)).size > MAX_CONFIG_BYTES) return null
  const remotes = remoteUrls(await readFile(file, 'utf8'))
  const url = remotes.get('origin') ?? remotes.values().next().value
  return url === undefined ? null : cleanRemote(url)
}

/** Each remote's first `url`, in file order. Every other key in the config is ignored. */
export function remoteUrls(config: string): Map<string, string> {
  const urls = new Map<string, string>()
  let remote: string | null = null
  for (const raw of config.split(/\r?\n/)) {
    const line = raw.trim()
    const section = line.match(/^\[\s*([A-Za-z0-9.-]+)(?:\s+"((?:[^"\\]|\\.)*)")?\s*\]/)
    if (section) {
      remote = section[1]!.toLowerCase() === 'remote' && section[2] !== undefined ? section[2].replace(/\\(.)/g, '$1') : null
      continue
    }
    if (remote === null || urls.has(remote)) continue
    const entry = line.match(/^url\s*=\s*(.*)$/i)
    if (entry) urls.set(remote, configValue(entry[1]!))
  }
  return urls
}

/** A config value without its quotes or a trailing comment. Remote addresses never need escapes. */
function configValue(raw: string): string {
  let out = ''
  let quoted = false
  for (const char of raw) {
    if (char === '"') quoted = !quoted
    else if (!quoted && (char === '#' || char === ';')) break
    else out += char
  }
  return out.trim()
}

/**
 * Drops the user and password from an http(s) address and the password from any other URL, keeps
 * `git@host:org/repo.git` as it is, and returns null for a local path or anything else odd.
 */
export function cleanRemote(url: string): string | null {
  const value = url.trim()
  // URL parsing would percent-encode a space or quote into something that looks safe.
  if (!/^[\x21-\x7e]+$/.test(value)) return null
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value)) {
    let parsed: URL
    try {
      parsed = new URL(value)
    } catch {
      return null
    }
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') parsed.username = ''
    parsed.password = ''
    parsed.search = ''
    parsed.hash = ''
    const cleaned = parsed.toString()
    return isSafeRemote(cleaned) ? cleaned : null
  }
  return isSafeRemote(value) ? value : null
}
