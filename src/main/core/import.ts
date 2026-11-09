import { randomBytes } from 'node:crypto'
import { createReadStream, existsSync } from 'node:fs'
import { lstat, mkdir, realpath, rm } from 'node:fs/promises'
import path from 'node:path'
import {
  type ArchiveSummary,
  type ArchiveToken,
  type ImportAction,
  type ImportPreview,
  type ImportResult,
  type PathMapping,
  type ProgressEvent,
  type SessionImportOutcome,
  type SessionInfo,
  type SessionKey,
  sessionKey,
} from '../../shared/sessions'
import { type ArchiveLimits, DEFAULT_LIMITS, extractArchive } from '../archive/archive'
import { ExecutionError, executePlan, type Fault } from './executor'
import type { CoreContext } from './export'
import type { Manifest, ManifestSession, Sha256 } from './manifest'
import { resolveInside, type StorePath, UnsafePathError, unlessMissing } from './paths'
import { type ComparedFile, planSession, relate, type SessionPlan } from './planner'
import { type ContentTransform, type Provider, type ReadOnce, readFresh, shareReads, type TargetFile, type TargetInspection } from './provider'
import { digest, readRange, sha256File } from './streams'

export interface OpenedArchive {
  token: ArchiveToken
  fileName: string
  manifest: Manifest
  stagingDir: string
  blobDir: string
}

export async function openArchive(
  context: CoreContext,
  archivePath: string,
  options: { limits?: ArchiveLimits; onProgress?: (event: ProgressEvent) => void } = {},
): Promise<OpenedArchive> {
  const token = randomBytes(16).toString('hex') as ArchiveToken
  const stagingDir = path.join(context.appDataDir, 'staging', token)
  const { manifest, blobDir } = await extractArchive(archivePath, stagingDir, options.limits ?? DEFAULT_LIMITS, (bytesRead, bytesTotal) =>
    options.onProgress?.({ operation: 'open', bytesRead, bytesTotal }),
  )
  return { token, fileName: path.basename(archivePath), manifest, stagingDir, blobDir }
}

export async function closeArchive(opened: OpenedArchive): Promise<void> {
  await rm(opened.stagingDir, { recursive: true, force: true })
}

/** Removes staged archives left by an earlier run of the app. */
export async function clearStaging(appDataDir: string): Promise<void> {
  await rm(path.join(appDataDir, 'staging'), { recursive: true, force: true })
}

export function summarizeArchive(opened: OpenedArchive): ArchiveSummary {
  const { manifest } = opened
  return {
    fileName: opened.fileName,
    createdAt: manifest.createdAt,
    appVersion: manifest.appVersion,
    source: { platform: manifest.source.platform, homeDir: manifest.source.homeDir },
    sessions: manifest.sessions.map(sessionInfo),
  }
}

function sessionInfo(session: ManifestSession): SessionInfo {
  const { files, ...rest } = session
  return {
    ...rest,
    key: sessionKey(session.agent, session.id),
    sizeBytes: files.reduce((sum, file) => sum + file.size, 0),
    fileCount: files.length,
  }
}

/** Same path when it exists here, else the source home swapped for this home with separators converted. */
export function suggestMappings(manifest: Manifest, here: { homeDir: string; sep: string; exists: (target: string) => boolean }): PathMapping[] {
  const { homeDir, sep } = manifest.source
  const cwds = new Set(manifest.sessions.flatMap((session) => [...(session.cwd ? [session.cwd] : []), ...session.cwds]))
  return [...cwds].map((source) => {
    if (here.exists(source)) return { source, target: source }
    const underHome = source === homeDir || source.startsWith(homeDir.endsWith(sep) ? homeDir : homeDir + sep)
    if (!underHome) return { source, target: source }
    const rest = source.slice(homeDir.length).split(sep).filter(Boolean)
    return { source, target: [here.homeDir, ...rest].join(here.sep) }
  })
}

export function defaultExists(target: string): boolean {
  return path.isAbsolute(target) && existsSync(target)
}

/** Resolves each target that exists to its real path, because Claude Code records the resolved form. */
async function resolveMappings(mappings: readonly PathMapping[]): Promise<PathMapping[]> {
  return Promise.all(mappings.map(async ({ source, target }) => ({ source, target: await realpath(target).catch(() => path.resolve(target)) })))
}

interface PlannedSession {
  session: ManifestSession
  key: SessionKey
  provider: Provider
  root: string
  inspection: TargetInspection
  plan: SessionPlan
}

function refusal(action: Extract<ImportAction, { kind: 'blocked' | 'conflict' }>): SessionPlan {
  return { action, writes: [], effects: [] }
}

type BlobReader = (sha256: Sha256) => AsyncIterable<Buffer>

async function planOne(context: CoreContext, opened: OpenedArchive, session: ManifestSession, mappings: PathMapping[], once: ReadOnce): Promise<PlannedSession> {
  const key = sessionKey(session.agent, session.id)
  const provider = context.providers[session.agent]
  const root = path.resolve(provider.storeRoot(context.env))
  const readBlob: BlobReader = (sha256) => createReadStream(path.join(opened.blobDir, sha256)) as AsyncIterable<Buffer>
  const inspection = await provider.inspectTarget(root, session, { env: context.env, once, source: opened.manifest.source, mappings, sep: path.sep, readBlob })
  if (inspection.kind === 'refused') return { session, key, provider, root, inspection, plan: planSession(inspection, []) }
  try {
    const compared = await Promise.all(inspection.files.map((file) => compare(root, readBlob, file)))
    return { session, key, provider, root, inspection, plan: planSession(inspection, compared) }
  } catch (error) {
    if (!(error instanceof UnsafePathError)) throw error
    return { session, key, provider, root, inspection, plan: refusal({ kind: 'blocked', reason: 'unsafe-path', message: error.message }) }
  }
}

async function compare(root: string, readBlob: BlobReader, file: TargetFile): Promise<ComparedFile> {
  const existing = await existingCopy(root, file)
  const blob = () => (file.transform ? file.transform(readBlob(file.sha256)) : readBlob(file.sha256))
  if (!existing) {
    const planned = await digest(blob())
    return { file, sha256: planned.sha256, size: planned.size, relation: relate(planned, null) }
  }
  const read = () => {
    const raw = readRange(existing.absPath, existing.rawSize)
    return existing.decode ? existing.decode(raw) : raw
  }
  const existingSize = existing.decode ? (await digest(read())).size : existing.rawSize
  const planned = await digest(blob(), existingSize)
  let relation = relate(planned, await digest(read(), planned.size))
  // The executor re-hashes the stored file before it moves it to the backup, so it needs the raw hash.
  if (relation.kind === 'target-is-prefix' && existing.decode) relation = { ...relation, existingSha256: await sha256File(existing.absPath) }
  return { file, sha256: planned.sha256, size: planned.size, relation }
}

async function existingCopy(root: string, file: TargetFile): Promise<{ absPath: string; rawSize: number; decode: ContentTransform | null } | null> {
  const atPath = await regularFile(root, file.path)
  if (atPath) return { ...atPath, decode: null }
  if (!file.supersedes) return null
  const superseded = await regularFile(root, file.supersedes.path)
  return superseded && { ...superseded, decode: file.supersedes.decode }
}

async function regularFile(root: string, rel: StorePath): Promise<{ absPath: string; rawSize: number } | null> {
  const absPath = await resolveInside(root, rel)
  const info = await unlessMissing(lstat(absPath), null)
  if (info && !info.isFile()) throw new UnsafePathError(`${rel} exists and is not a regular file`)
  return info && { absPath, rawSize: info.size }
}

function selectSessions(opened: OpenedArchive, keys?: readonly SessionKey[]): ManifestSession[] {
  if (!keys) return opened.manifest.sessions
  const byKey = new Map(opened.manifest.sessions.map((session) => [sessionKey(session.agent, session.id), session]))
  return keys.map((key) => {
    const session = byKey.get(key)
    if (!session) throw new Error(`The archive has no session ${key}`)
    return session
  })
}

export async function previewImport(context: CoreContext, opened: OpenedArchive, mappings: readonly PathMapping[]): Promise<ImportPreview> {
  const resolved = await resolveMappings(mappings)
  const sessions = []
  const once = shareReads()
  for (const session of opened.manifest.sessions) {
    const planned = await planOne(context, opened, session, resolved, once)
    sessions.push({
      key: planned.key,
      action: planned.plan.action,
      targetCwd: planned.inspection.targetCwd,
      warnings: planned.inspection.warnings,
    })
  }
  return { sessions }
}

export interface RunImportOptions {
  fault?: Fault
  onProgress?: (event: ProgressEvent) => void
}

/** Plans again from the current target state, then imports each session in its own journaled transaction. */
export async function runImport(
  context: CoreContext,
  opened: OpenedArchive,
  mappings: readonly PathMapping[],
  keys: readonly SessionKey[],
  options: RunImportOptions = {},
): Promise<ImportResult> {
  const resolved = await resolveMappings(mappings)
  const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomBytes(4).toString('hex')}`
  const journalDir = path.join(context.appDataDir, 'journal')
  const backupDir = path.join(context.appDataDir, 'backups', runId)
  await mkdir(journalDir, { recursive: true })
  const sessions = selectSessions(opened, keys)
  const outcomes: SessionImportOutcome[] = []
  for (const [index, session] of sessions.entries()) {
    options.onProgress?.({ operation: 'import', done: index, total: sessions.length, current: sessionKey(session.agent, session.id) })
    outcomes.push(await importOne(context, opened, session, resolved, { runId, journalDir, backupDir, fault: options.fault }))
  }
  options.onProgress?.({ operation: 'import', done: sessions.length, total: sessions.length, current: null })
  const backedUp = outcomes.some((outcome) => 'backupDir' in outcome && outcome.backupDir !== null)
  return { runId, outcomes, backupDir: backedUp ? backupDir : null }
}

async function importOne(
  context: CoreContext,
  opened: OpenedArchive,
  session: ManifestSession,
  mappings: PathMapping[],
  run: { runId: string; journalDir: string; backupDir: string; fault?: Fault },
): Promise<SessionImportOutcome> {
  const key = sessionKey(session.agent, session.id)
  let planned: PlannedSession
  try {
    planned = await planOne(context, opened, session, mappings, readFresh)
  } catch (error) {
    return { key, status: 'failed', action: { kind: 'blocked', reason: 'invalid-session', message: 'Planning failed.' }, error: messageOf(error), rolledBack: true }
  }
  const { action } = planned.plan
  const resumeCommand = planned.provider.resumeCommand(session.id, planned.inspection?.targetCwd ?? null)
  if (action.kind === 'skip-identical') return { key, status: 'skipped', action, backupDir: null, resumeCommand }
  if (action.kind === 'conflict' || action.kind === 'blocked') return { key, status: 'refused', action }
  try {
    const { backupDir } = await executePlan(planned.plan, {
      root: planned.root,
      provider: planned.provider,
      key,
      journalDir: run.journalDir,
      backupDir: run.backupDir,
      blobDir: opened.blobDir,
      runId: run.runId,
      fault: run.fault,
    })
    return { key, status: action.kind === 'create' ? 'created' : 'updated', action, backupDir, resumeCommand }
  } catch (error) {
    if (!(error instanceof ExecutionError)) throw error
    return { key, status: 'failed', action, error: error.message, rolledBack: error.rolledBack }
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

