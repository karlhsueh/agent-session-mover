import { randomBytes } from 'node:crypto'
import { createReadStream, existsSync } from 'node:fs'
import { lstat, mkdir, realpath, rm } from 'node:fs/promises'
import path from 'node:path'
import {
  type ArchiveSummary,
  type ArchiveToken,
  type ConflictChoice,
  type ConflictCopies,
  type CopyFacts,
  type ImportPreview,
  type ImportRequest,
  type ImportResult,
  isAtOrUnder,
  type PathMapping,
  type PreviewMessage,
  type ProgressEvent,
  type SessionImportOutcome,
  type SessionInfo,
  type SessionKey,
  sessionKey,
  type SessionPreview,
} from '../../shared/sessions'
import { type ArchiveLimits, DEFAULT_LIMITS, extractArchive } from '../archive/archive'
import { ExecutionError, executePlan, type Fault } from './executor'
import type { CoreContext } from './export'
import type { Manifest, ManifestSession, Sha256 } from './manifest'
import { mapPath, resolveInside, type StorePath, UnsafePathError, unlessMissing } from './paths'
import { changesFor, type ComparedFile, planSession, relate, type SessionPlan } from './planner'
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
    source: { platform: manifest.source.platform, homeDir: manifest.source.homeDir, sep: manifest.source.sep },
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
  const suggest = (source: string): PathMapping => {
    if (here.exists(source)) return { source, target: source }
    if (!isAtOrUnder(source, homeDir, sep)) return { source, target: source }
    const rest = source.slice(homeDir.length).split(sep).filter(Boolean)
    return { source, target: [here.homeDir, ...rest].join(here.sep) }
  }
  // A folder inside one already listed follows it, so it gets a row only when its own suggestion differs.
  const listed: PathMapping[] = []
  for (const source of [...cwds].sort((a, b) => a.length - b.length)) {
    const mapping = suggest(source)
    if (mapPath(source, listed, sep, here.sep) !== mapping.target) listed.push(mapping)
  }
  return listed
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

type BlobReader = (sha256: Sha256) => AsyncIterable<Buffer>

const blobReader =
  (opened: OpenedArchive): BlobReader =>
  (sha256) =>
    createReadStream(path.join(opened.blobDir, sha256)) as AsyncIterable<Buffer>

function countingReader(read: BlobReader, onChunk: (bytes: number) => void): BlobReader {
  return async function* (sha256) {
    for await (const chunk of read(sha256)) {
      onChunk(chunk.length)
      yield chunk
    }
  }
}

async function planOne(context: CoreContext, opened: OpenedArchive, session: ManifestSession, mappings: PathMapping[], once: ReadOnce, readBlob: BlobReader = blobReader(opened)): Promise<PlannedSession> {
  const key = sessionKey(session.agent, session.id)
  const provider = context.providers[session.agent]
  const root = path.resolve(provider.storeRoot(context.env))
  const inspection = await provider.inspectTarget(root, session, { env: context.env, once, source: opened.manifest.source, mappings, sep: path.sep, readBlob })
  if (inspection.kind === 'refused') return { session, key, provider, root, inspection, plan: planSession(inspection, []) }
  try {
    const compared = await Promise.all(inspection.files.map((file) => compare(root, readBlob, file)))
    return { session, key, provider, root, inspection, plan: planSession(inspection, compared) }
  } catch (error) {
    if (!(error instanceof UnsafePathError)) throw error
    const action = { kind: 'blocked', reason: 'unsafe-path', message: `A file or folder in the agent's store is not where import can safely write. ${error.message}` } as const
    return { session, key, provider, root, inspection, plan: { action, writes: [], effects: [] } }
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
  if ('existingSha256' in relation && existing.decode) relation = { ...relation, existingSha256: await sha256File(existing.absPath) }
  return { file, sha256: planned.sha256, size: planned.size, relation }
}

async function existingCopy(root: string, file: TargetFile): Promise<{ absPath: string; path: StorePath; rawSize: number; decode: ContentTransform | null } | null> {
  const atPath = await regularFile(root, file.path)
  if (atPath) return { ...atPath, path: file.path, decode: null }
  if (!file.supersedes) return null
  const superseded = await regularFile(root, file.supersedes.path)
  return superseded && { ...superseded, path: file.supersedes.path, decode: file.supersedes.decode }
}

async function regularFile(root: string, rel: StorePath): Promise<{ absPath: string; rawSize: number } | null> {
  const absPath = await resolveInside(root, rel)
  const info = await unlessMissing(lstat(absPath), null)
  if (info && !info.isFile()) throw new UnsafePathError(`${rel} exists and is not a regular file`)
  return info && { absPath, rawSize: info.size }
}

/**
 * Reads the transcript here and the archive's with the same parser, so the user compares the copies by
 * their last message and length rather than by a file time on one side and a recorded time on the other.
 */
async function conflictCopies(planned: PlannedSession, blobDir: string): Promise<ConflictCopies | null> {
  const { provider, root, session, inspection } = planned
  if (inspection.kind !== 'ready') return null
  const target = inspection.files.find((file) => file.role === provider.transcriptRole)
  const archived = session.files.filter((file) => file.role === provider.transcriptRole)
  if (!target || archived.length !== 1) return null
  try {
    const existing = await existingCopy(root, target)
    if (!existing) return null
    const [here, archive] = await Promise.all([
      provider.previewTranscript({ absPath: existing.absPath, path: existing.path }),
      provider.previewTranscript({ absPath: path.join(blobDir, archived[0]!.sha256), path: archived[0]!.path }),
    ])
    const facts = (preview: SessionPreview): CopyFacts | null =>
      preview.kind === 'ok' ? { lastMessageAt: lastAt([preview.first, ...preview.recent]), messages: preview.counts.messages, complete: preview.complete } : null
    const hereFacts = facts(here.preview)
    const archiveFacts = facts(archive.preview)
    return hereFacts && archiveFacts && { here: hereFacts, archive: archiveFacts }
  } catch {
    // The comparison only helps the user choose. Without it the conflict still plans and imports.
    return null
  }
}

function lastAt(entries: readonly PreviewMessage[]): string | null {
  for (let index = entries.length - 1; index >= 0; index--) {
    const at = entries[index]!.at
    if (at) return at
  }
  return null
}

function selectSessions(opened: OpenedArchive, requests: readonly ImportRequest[]): { session: ManifestSession; onConflict: ConflictChoice }[] {
  const byKey = new Map(opened.manifest.sessions.map((session) => [sessionKey(session.agent, session.id), session]))
  return requests.map(({ key, onConflict }) => {
    const session = byKey.get(key)
    if (!session) throw new Error(`The archive has no session ${key}`)
    return { session, onConflict }
  })
}

export async function previewImport(context: CoreContext, opened: OpenedArchive, mappings: readonly PathMapping[]): Promise<ImportPreview> {
  const resolved = await resolveMappings(mappings)
  const sessions = []
  const once = shareReads()
  for (const session of opened.manifest.sessions) {
    const planned = await planOne(context, opened, session, resolved, once)
    const { action } = planned.plan
    sessions.push({
      key: planned.key,
      action: action.kind === 'conflict' ? { ...action, copies: await conflictCopies(planned, opened.blobDir) } : action,
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
  requests: readonly ImportRequest[],
  options: RunImportOptions = {},
): Promise<ImportResult> {
  const resolved = await resolveMappings(mappings)
  const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomBytes(4).toString('hex')}`
  const journalDir = path.join(context.appDataDir, 'journal')
  const backupDir = path.join(context.appDataDir, 'backups', runId)
  await mkdir(journalDir, { recursive: true })
  const sessions = selectSessions(opened, requests)
  const outcomes: SessionImportOutcome[] = []
  // Each session's share is twice its size: one half fills as planning reads its blobs, the other as writing does.
  // A provider may read a blob more than once while planning, so each half stops at the session's size.
  const sizeOf = (session: ManifestSession) => session.files.reduce((sum, file) => sum + file.size, 0)
  const bytesTotal = 2 * sessions.reduce((sum, { session }) => sum + sizeOf(session), 0)
  const step = Math.max(1024 * 1024, bytesTotal / 200)
  let done = 0
  let current: SessionKey | null = null
  let finished = 0
  let reported = 0
  const report = (bytesDone: number) => {
    reported = bytesDone
    options.onProgress?.({ operation: 'import', done, total: sessions.length, current, bytesDone, bytesTotal })
  }
  for (const { session, onConflict } of sessions) {
    const size = sizeOf(session)
    const read = { plan: 0, write: 0 }
    const counter = (phase: keyof typeof read) =>
      countingReader(blobReader(opened), (bytes) => {
        read[phase] += bytes
        const bytesDone = finished + Math.min(read.plan, size) + Math.min(read.write, size)
        if (bytesDone - reported >= step) report(bytesDone)
      })
    current = sessionKey(session.agent, session.id)
    report(finished)
    outcomes.push(await importOne(context, opened, session, onConflict, resolved, { runId, journalDir, backupDir, readForPlan: counter('plan'), readForWrite: counter('write'), fault: options.fault }))
    done += 1
    finished += 2 * size
  }
  current = null
  report(bytesTotal)
  const backedUp = outcomes.some((outcome) => 'backupDir' in outcome && outcome.backupDir !== null)
  return { runId, outcomes, backupDir: backedUp ? backupDir : null }
}

async function importOne(
  context: CoreContext,
  opened: OpenedArchive,
  session: ManifestSession,
  onConflict: ConflictChoice,
  mappings: PathMapping[],
  run: { runId: string; journalDir: string; backupDir: string; readForPlan: BlobReader; readForWrite: BlobReader; fault?: Fault },
): Promise<SessionImportOutcome> {
  const key = sessionKey(session.agent, session.id)
  let planned: PlannedSession
  try {
    planned = await planOne(context, opened, session, mappings, readFresh, run.readForPlan)
  } catch (error) {
    return { key, status: 'failed', action: { kind: 'blocked', reason: 'invalid-session', message: 'Planning failed.' }, error: messageOf(error), rolledBack: true }
  }
  const { action } = planned.plan
  const resumeCommand = planned.provider.resumeCommand(session.id, planned.inspection?.targetCwd ?? null)
  if (action.kind === 'skip-identical') return { key, status: 'skipped', action, backupDir: null, resumeCommand }
  if (action.kind === 'blocked' || (action.kind === 'conflict' && onConflict === 'skip')) return { key, status: 'refused', action }
  try {
    const { backupDir } = await executePlan(changesFor(planned.plan, onConflict), {
      root: planned.root,
      provider: planned.provider,
      key,
      journalDir: run.journalDir,
      backupDir: run.backupDir,
      readBlob: run.readForWrite,
      runId: run.runId,
      fault: run.fault,
    })
    return { key, status: STATUS[action.kind], action, backupDir, resumeCommand }
  } catch (error) {
    if (!(error instanceof ExecutionError)) throw error
    return { key, status: 'failed', action, error: error.message, rolledBack: error.rolledBack }
  }
}

const STATUS = { create: 'created', update: 'updated', conflict: 'replaced' } as const

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

