import type { AgentId, ClientKind, SessionInfo } from '../../../shared/sessions'

export const AGENT_LABEL: Record<AgentId, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
}

export const CLIENT_LABEL: Record<ClientKind, string> = {
  cli: 'CLI',
  desktop: 'Desktop',
  ide: 'IDE',
  sdk: 'SDK',
  exec: 'Exec',
  subagent: 'Subagent',
  unknown: 'Unknown client',
}

export function folderName(path: string | null): string {
  if (!path) return 'No folder'
  return path.split(/[\\/]+/).filter(Boolean).at(-1) ?? path
}

export function tildePath(path: string, home: string): string {
  const prefix = home.replace(/[\\/]+$/, '')
  if (!prefix) return path
  if (path === prefix) return '~'
  return path.startsWith(prefix) && /[\\/]/.test(path.charAt(prefix.length)) ? `~${path.slice(prefix.length)}` : path
}

/** Reverses `tildePath`, so a field can show `~/x` and still hand main an absolute path. */
export function expandTilde(path: string, home: string): string {
  const prefix = home.replace(/[\\/]+$/, '')
  if (!prefix || !/^~([\\/]|$)/.test(path)) return path
  const rest = path.slice(1)
  return `${prefix}${prefix.includes('\\') ? rest.replace(/\//g, '\\') : rest}`
}

/**
 * Shows `cd '/home/me/x' && …` as `cd ~/'x' && …`. Both run the same in POSIX shells, so the
 * shorter form is also what Copy puts on the clipboard.
 */
export function shortCommand(command: string, home: string): string {
  const prefix = `cd '${home.replace(/[\\/]+$/, '')}/`
  return home && !home.includes("'") && command.startsWith(prefix) ? `cd ~/'${command.slice(prefix.length)}` : command
}

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

export function relativeTime(iso: string, now: number): string {
  const then = Date.parse(iso)
  if (Number.isNaN(then)) return ''
  const age = now - then
  if (age < MINUTE) return 'now'
  if (age < HOUR) return `${Math.floor(age / MINUTE)}m`
  if (age < DAY) return `${Math.floor(age / HOUR)}h`
  if (age < 7 * DAY) return `${Math.floor(age / DAY)}d`
  const date = new Date(then)
  const sameYear = date.getFullYear() === new Date(now).getFullYear()
  return date.toLocaleDateString(undefined, sameYear ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' })
}

export function absoluteTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

/** `Nov 8, 10:29 AM`, with the year only when it is not this year. */
export function shortDateTime(iso: string, now = Date.now()): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  const year = date.getFullYear() === new Date(now).getFullYear() ? undefined : 'numeric'
  return date.toLocaleString(undefined, { year, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

const PLATFORM_LABEL: Record<string, string> = { darwin: 'macOS', win32: 'Windows', linux: 'Linux' }

/** Names a Node `process.platform` value the way people say it. */
export function platformLabel(platform: string): string {
  return PLATFORM_LABEL[platform] ?? platform
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`
}

export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`
}

export function sessionTitle(session: Pick<SessionInfo, 'title' | 'id'>): string {
  return session.title?.trim() || `Untitled ${session.id.slice(0, 8)}`
}

const PICKER_NOTE: Record<AgentId, string> = {
  'claude-code': "Claude Code's /resume picker and --continue skip sessions started like this one.",
  codex: "Codex's resume picker and resume --last skip sessions started like this one.",
}

export function pickerNote(agent: AgentId, clientDetail: string): string {
  return `Started with ${clientDetail || 'an unknown client'}. ${PICKER_NOTE[agent]} The resume command still finds it.`
}

export const IS_MAC = navigator.userAgent.includes('Macintosh')
export const MOD = IS_MAC ? '⌘' : 'Ctrl+'
export const REVEAL_LABEL = IS_MAC ? 'Reveal in Finder' : 'Show in folder'
