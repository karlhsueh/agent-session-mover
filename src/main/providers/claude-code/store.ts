import { lstat, readFile } from 'node:fs/promises'
import path from 'node:path'
import { listNames, unlessMissing } from '../../core/paths'

const TRANSCRIPT = /^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\.jsonl$/
export const SIDECAR_FOLDERS = ['subagents', 'tool-results'] as const
export type SidecarFolder = (typeof SIDECAR_FOLDERS)[number]
const SIDECAR_NAME = /^[A-Za-z0-9_][A-Za-z0-9_.@+=-]*$/

export interface TranscriptLocation {
  id: string
  /** The `<enc>` folder name under `projects/`. */
  projectDir: string
  absPath: string
  size: number
  mtimeMs: number
}

/**
 * Every `projects/<enc>/<uuid>.jsonl`. The UUID pattern leaves out set-aside copies
 * (`*.orphaned-*`, `*.superseded-*`) and legacy `agent-*.jsonl` subagent files.
 */
export async function findTranscripts(root: string): Promise<TranscriptLocation[]> {
  const projects = path.join(root, 'projects')
  const found: TranscriptLocation[] = []
  for (const projectDir of await listNames(projects)) {
    const dir = path.join(projects, projectDir)
    if (!(await unlessMissing(lstat(dir), null))?.isDirectory()) continue
    for (const name of await listNames(dir)) {
      const match = TRANSCRIPT.exec(name)
      if (!match) continue
      const absPath = path.join(dir, name)
      const info = await unlessMissing(lstat(absPath), null)
      if (info?.isFile()) found.push({ id: match[1], projectDir, absPath, size: info.size, mtimeMs: info.mtimeMs })
    }
  }
  return found
}

export interface SidecarFile {
  folder: SidecarFolder
  name: string
  absPath: string
  size: number
  mtimeMs: number
}

/** Regular files directly inside `<id>/subagents/` and `<id>/tool-results/`. Symlinks and dotfiles are skipped. */
export async function findSidecars(transcript: TranscriptLocation): Promise<SidecarFile[]> {
  const base = path.join(path.dirname(transcript.absPath), transcript.id)
  const found: SidecarFile[] = []
  for (const folder of SIDECAR_FOLDERS) {
    const dir = path.join(base, folder)
    for (const name of await listNames(dir)) {
      if (!SIDECAR_NAME.test(name)) continue
      const absPath = path.join(dir, name)
      const info = await unlessMissing(lstat(absPath), null)
      if (info?.isFile()) found.push({ folder, name, absPath, size: info.size, mtimeMs: info.mtimeMs })
    }
  }
  return found
}

export function isSidecarName(name: string): boolean {
  return SIDECAR_NAME.test(name)
}

/**
 * Session ids with a live process, from `sessions/<pid>.json`. Only the `.json` registry files are
 * read. The `.key` files next to them are local IPC secrets.
 */
export async function liveSessionIds(root: string, isAlive: (pid: number) => boolean = processIsAlive): Promise<Set<string>> {
  const dir = path.join(root, 'sessions')
  const live = new Set<string>()
  for (const name of await listNames(dir)) {
    if (!/^\d+\.json$/.test(name)) continue
    try {
      const entry: unknown = JSON.parse(await readFile(path.join(dir, name), 'utf8'))
      const { pid, sessionId } = (entry ?? {}) as { pid?: unknown; sessionId?: unknown }
      if (typeof pid === 'number' && typeof sessionId === 'string' && isAlive(pid)) live.add(sessionId)
    } catch {
      // A registry file being written right now is not evidence of anything.
    }
  }
  return live
}

export function processIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}
