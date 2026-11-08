import path from 'node:path'
import type { ArchiveToken, PathMapping, SessionKey } from '../shared/sessions'
import { parseSessionKey } from '../shared/sessions'

const MAX_KEYS = 100_000
const MAX_MAPPINGS = 10_000
const MAX_PATH = 4096

export class InputError extends Error {}

export function parseKeys(input: unknown): SessionKey[] {
  if (!Array.isArray(input) || input.length === 0 || input.length > MAX_KEYS) throw new InputError('Expected a non-empty list of session keys.')
  const keys = new Set<SessionKey>()
  for (const value of input) {
    const parsed = parseSessionKey(value)
    if (!parsed) throw new InputError(`Not a session key: ${JSON.stringify(value)?.slice(0, 200)}`)
    keys.add(parsed.key)
  }
  return [...keys]
}

export function parseKey(input: unknown): NonNullable<ReturnType<typeof parseSessionKey>> {
  const parsed = parseSessionKey(input)
  if (!parsed) throw new InputError('Not a session key.')
  return parsed
}

/** Targets are folders on this machine and must be absolute. Sources are matched as text against the archive. */
export function parseMappings(input: unknown, isAbsolute: (target: string) => boolean = path.isAbsolute): PathMapping[] {
  if (!Array.isArray(input) || input.length > MAX_MAPPINGS) throw new InputError('Expected a list of path mappings.')
  const sources = new Set<string>()
  return input.map((value) => {
    const { source, target } = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>
    if (!isPathText(source) || !isPathText(target)) throw new InputError('Each mapping needs a source and a target path.')
    if (!isAbsolute(target)) throw new InputError(`Target ${JSON.stringify(target)} is not an absolute path.`)
    if (sources.has(source)) throw new InputError(`Source ${JSON.stringify(source)} is mapped twice.`)
    sources.add(source)
    return { source, target }
  })
}

function isPathText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_PATH && !value.includes('\0')
}

export function parseToken(input: unknown): ArchiveToken {
  if (typeof input !== 'string' || !/^[0-9a-f]{32}$/.test(input)) throw new InputError('Not an archive token.')
  return input as ArchiveToken
}
