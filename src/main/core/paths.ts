import { lstat, readdir, realpath } from 'node:fs/promises'
import path from 'node:path'

declare const storePathBrand: unique symbol
/** A store-relative POSIX path that has passed `parseStorePath`. */
export type StorePath = string & { readonly [storePathBrand]: true }

const MAX_STORE_PATH = 1024
const SEGMENT = /^[A-Za-z0-9_.@+=-]+$/

export function parseStorePath(value: unknown): StorePath | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_STORE_PATH) return null
  if (value.includes('\0') || value.includes('\\') || value.startsWith('/')) return null
  const segments = value.split('/')
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..') return null
    if (!SEGMENT.test(segment)) return null
  }
  return value as StorePath
}

export function joinStorePath(...segments: string[]): StorePath {
  const joined = segments.join('/')
  const parsed = parseStorePath(joined)
  if (!parsed) throw new Error(`Not a safe store path: ${JSON.stringify(joined)}`)
  return parsed
}

export class UnsafePathError extends Error {}

/**
 * Resolves a store path to an absolute path and proves it stays inside the store root after
 * every existing symlink on the way is followed. Missing trailing segments are allowed, because
 * import creates them.
 */
export async function resolveInside(root: string, rel: StorePath): Promise<string> {
  const target = path.join(root, ...rel.split('/'))
  const realRoot = await realpathOfExisting(root)
  const realTarget = await realpathOfExisting(target)
  const relative = path.relative(realRoot, realTarget)
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new UnsafePathError(`${rel} resolves outside the store`)
  }
  const leaf = await lstat(target).catch(() => null)
  if (leaf?.isSymbolicLink()) throw new UnsafePathError(`${rel} is a symlink`)
  return target
}

async function realpathOfExisting(target: string): Promise<string> {
  const missing: string[] = []
  let current = target
  for (;;) {
    try {
      return path.join(await realpath(current), ...missing.reverse())
    } catch (error) {
      if (!isNotFound(error)) throw error
      const parent = path.dirname(current)
      if (parent === current) throw error
      missing.push(path.basename(current))
      current = parent
    }
  }
}

export function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'
}

/** Resolves to `fallback` when the path does not exist, and rethrows any other error. */
export function unlessMissing<T, F>(operation: Promise<T>, fallback: F): Promise<T | F> {
  return operation.catch((error) => (isNotFound(error) ? fallback : Promise.reject(error)))
}

/** The names in a folder, or none when it is missing or is a file. */
export async function listNames(dir: string): Promise<string[]> {
  try {
    return await readdir(dir)
  } catch (error) {
    if (isNotFound(error) || (error as NodeJS.ErrnoException).code === 'ENOTDIR') return []
    throw error
  }
}

/** Maps an absolute source path through the longest matching mapping, or returns null. */
export function mapPath(
  value: string,
  mappings: readonly { source: string; target: string }[],
  sourceSep: string,
  targetSep: string,
): string | null {
  let best: { source: string; target: string } | null = null
  for (const mapping of mappings) {
    const under = value === mapping.source || value.startsWith(withTrailing(mapping.source, sourceSep))
    if (under && (!best || mapping.source.length > best.source.length)) best = mapping
  }
  if (!best) return null
  let rest = value.slice(best.source.length)
  if (rest.startsWith(sourceSep)) rest = rest.slice(sourceSep.length)
  if (rest === '') return best.target
  return withTrailing(best.target, targetSep) + rest.split(sourceSep).join(targetSep)
}

function withTrailing(value: string, sep: string): string {
  return value.endsWith(sep) ? value : value + sep
}
