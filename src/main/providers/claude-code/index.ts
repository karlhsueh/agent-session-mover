import { createHash } from 'node:crypto'
import { stat } from 'node:fs/promises'
import path from 'node:path'
import { type ImportWarning, type SessionInfo, type SessionSummary, sessionKey } from '../../../shared/sessions'
import type { FileRole, ManifestSession, Sha256 } from '../../core/manifest'
import { joinStorePath, mapPath } from '../../core/paths'
import type { CollectedSession, ImportContext, Provider, RefusedAction, SnapshotFile, TargetFile, TargetInspection } from '../../core/provider'
import { digest, lengthToLastNewline, readRange } from '../../core/streams'
import { LIST_BUDGET, readWindow, terminatedLines } from '../../core/window'
import { resumeLine } from '../text'
import { encodeProjectDir } from './encode'
import { previewClaudeTranscript } from './preview'
import { findSidecars, findTranscripts, isSidecarName, liveSessionIds, SIDECAR_FOLDERS, type SidecarFolder, type TranscriptLocation } from './store'
import { readSubagents } from './subagents'
import { clientFromEntrypoint, isHiddenEntrypoint, readFacts, rewriteTranscript, titleOf, type TranscriptFacts } from './transcript'

const AGENT = 'claude-code'
const ROLE_BY_FOLDER: Record<SidecarFolder, FileRole> = { subagents: 'subagent', 'tool-results': 'tool-result' }

export const claudeCodeProvider: Provider = {
  agent: AGENT,

  storeRoot({ env, homeDir }) {
    const configured = env.CLAUDE_CONFIG_DIR
    return path.resolve(configured ? configured.normalize('NFC') : path.join(homeDir, '.claude'))
  },

  async discover(root) {
    const live = await liveSessionIds(root)
    const summaries: SessionSummary[] = []
    for (const transcript of newestPerId(await findTranscripts(root))) {
      // Hashes are for export. Listing needs only what the records say and the sizes stat reports.
      const sidecars = await findSidecars(transcript)
      const facts = await readFacts(readWindow({ kind: 'file', absPath: transcript.absPath }, LIST_BUDGET))
      summaries.push({
        ...info(transcript, facts, [transcript.size, ...sidecars.map((sidecar) => sidecar.size)]),
        cwdsComplete: facts.complete,
        live: live.has(transcript.id),
        archived: false,
        hiddenFromPicker: isHiddenEntrypoint(facts.entrypoint ?? ''),
        subagents: await readSubagents(sidecars),
        resumeCommand: claudeCodeProvider.resumeCommand(transcript.id, primaryCwd(facts, transcript.projectDir)),
      })
    }
    return summaries
  },

  async collect(root, id) {
    const matches = (await findTranscripts(root)).filter((transcript) => transcript.id === id)
    if (matches.length === 0) throw new Error(`No Claude Code session ${id}`)
    if (matches.length > 1) throw new Error(`Claude Code session ${id} exists in ${matches.length} project folders`)
    const { facts, files } = await snapshot(matches[0])
    const { key: _key, agent: _agent, sizeBytes: _size, fileCount: _count, ...session } = info(matches[0], facts, files.map((file) => file.size))
    return { session: { agent: AGENT, ...session }, files, live: (await liveSessionIds(root)).has(id) } satisfies CollectedSession
  },

  async inspectTarget(root, session, context) {
    return inspect(root, session, context)
  },

  transcriptRole: 'transcript',
  resumeCommand: (id, cwd) => resumeLine(`claude --resume ${id}`, cwd),

  async findTranscript(root, id) {
    const [transcript] = newestPerId((await findTranscripts(root)).filter((each) => each.id === id))
    return transcript ? { absPath: transcript.absPath, path: joinStorePath('projects', transcript.projectDir, `${transcript.id}.jsonl`) } : null
  },

  previewTranscript: previewClaudeTranscript,

  async applyEffect() {
    throw new Error('Claude Code imports have no side effects')
  },

  async undoEffect() {},
}

function newestPerId(transcripts: TranscriptLocation[]): TranscriptLocation[] {
  const byId = new Map<string, TranscriptLocation>()
  for (const transcript of transcripts) {
    const known = byId.get(transcript.id)
    if (!known || transcript.mtimeMs > known.mtimeMs) byId.set(transcript.id, transcript)
  }
  return [...byId.values()]
}

async function snapshot(transcript: TranscriptLocation): Promise<{ facts: TranscriptFacts; files: SnapshotFile[] }> {
  const base = ['projects', transcript.projectDir]
  const size = await lengthToLastNewline(transcript.absPath, transcript.size)
  const hash = createHash('sha256')
  const facts = await readFacts(terminatedLines(tap(readRange(transcript.absPath, size), (chunk) => hash.update(chunk))))
  const files: SnapshotFile[] = [
    {
      role: 'transcript',
      path: joinStorePath(...base, `${transcript.id}.jsonl`),
      absPath: transcript.absPath,
      size,
      sha256: hash.digest('hex') as Sha256,
      mtimeMs: transcript.mtimeMs,
    },
  ]
  const sidecars = await findSidecars(transcript)
  for (const sidecar of sidecars) {
    const length = sidecar.name.endsWith('.jsonl') ? await lengthToLastNewline(sidecar.absPath, sidecar.size) : sidecar.size
    files.push({
      role: ROLE_BY_FOLDER[sidecar.folder],
      path: joinStorePath(...base, transcript.id, sidecar.folder, sidecar.name),
      absPath: sidecar.absPath,
      size: length,
      sha256: (await digest(readRange(sidecar.absPath, length))).sha256,
      mtimeMs: sidecar.mtimeMs,
    })
  }
  return { facts, files }
}

async function* tap(chunks: AsyncIterable<Buffer>, onChunk: (chunk: Buffer) => void): AsyncGenerator<Buffer> {
  for await (const chunk of chunks) {
    onChunk(chunk)
    yield chunk
  }
}

function info(transcript: TranscriptLocation, facts: TranscriptFacts, sizes: number[]): SessionInfo {
  const fallback = new Date(transcript.mtimeMs).toISOString()
  return {
    key: sessionKey(AGENT, transcript.id),
    agent: AGENT,
    id: transcript.id,
    client: clientFromEntrypoint(facts.entrypoint),
    clientDetail: facts.entrypoint ?? '',
    title: titleOf(facts),
    cwd: primaryCwd(facts, transcript.projectDir),
    cwds: facts.cwds,
    createdAt: facts.firstMs === null ? fallback : new Date(facts.firstMs).toISOString(),
    lastActivity: facts.lastMs === null ? fallback : new Date(facts.lastMs).toISOString(),
    cliVersion: facts.version,
    sizeBytes: sizes.reduce((sum, size) => sum + size, 0),
    fileCount: sizes.length,
  }
}

/** The cwd whose encoding names the project folder is where the session started. */
function primaryCwd(facts: TranscriptFacts, projectDir: string): string | null {
  return facts.cwds.find((cwd) => encodeProjectDir(cwd) === projectDir) ?? facts.cwds[0] ?? null
}


type SessionLayout = { projectDir: string; files: { file: ManifestSession['files'][number]; rest: string[] }[] }

/** Accepts only the shapes export writes: one transcript and sidecars in its folder. */
function layoutOf(session: ManifestSession): SessionLayout | null {
  let projectDir: string | null = null
  let transcripts = 0
  const files: SessionLayout['files'] = []
  for (const file of session.files) {
    const [projects, dir, ...rest] = file.path.split('/')
    if (projects !== 'projects' || !dir || (projectDir !== null && dir !== projectDir)) return null
    projectDir = dir
    if (file.role === 'transcript') {
      if (rest.length !== 1 || rest[0] !== `${session.id}.jsonl`) return null
      transcripts += 1
    } else {
      const [id, folder, name, ...extra] = rest
      const expected = SIDECAR_FOLDERS.find((candidate) => ROLE_BY_FOLDER[candidate] === file.role)
      if (id !== session.id || folder !== expected || !name || !isSidecarName(name) || extra.length > 0) return null
    }
    files.push({ file, rest })
  }
  return transcripts === 1 && projectDir ? { projectDir, files } : null
}

async function inspect(root: string, session: ManifestSession, context: ImportContext): Promise<TargetInspection> {
  const warnings: ImportWarning[] = []
  if (isHiddenEntrypoint(session.clientDetail)) warnings.push({ code: 'hidden-from-picker', clientDetail: session.clientDetail })
  const refuse = (action: RefusedAction, targetCwd: string | null = null): TargetInspection => ({ kind: 'refused', targetCwd, warnings, action })

  const layout = layoutOf(session)
  if (!layout) return refuse({ kind: 'blocked', reason: 'invalid-session', message: 'The archive lists files this app does not write for a Claude Code session.' })
  if (!session.cwd) return refuse({ kind: 'blocked', reason: 'unmapped-cwd', message: 'The session records no working directory.' })
  const mapCwd = (value: string) => mapPath(value, context.mappings, context.source.sep, context.sep)
  const targetCwd = mapCwd(session.cwd)
  if (!targetCwd) return refuse({ kind: 'blocked', reason: 'unmapped-cwd', message: `No folder on this machine is chosen for ${session.cwd}.` })
  if (!(await stat(targetCwd).then((s) => s.isDirectory(), () => false))) warnings.push({ code: 'target-cwd-missing', path: targetCwd })

  const existing = (await findTranscripts(root)).filter((transcript) => transcript.id === session.id)
  if (existing.length > 1) {
    return refuse(
      { kind: 'conflict', reason: 'multiple-copies', message: `This machine already has ${existing.length} copies of the session, so Claude Code cannot resume it by id.` },
      targetCwd,
    )
  }
  // Same id elsewhere in the store: update it in place, because a second copy would make `--resume <id>` fail.
  const projectDir = existing[0]?.projectDir ?? encodeProjectDir(targetCwd)

  const sourceRoot = context.source.storeRoots[AGENT]
  const storeFiles = new Map<string, string>()
  const targets = layout.files.map(({ file, rest }) => ({ file, path: joinStorePath('projects', projectDir, ...rest) }))
  if (sourceRoot) {
    for (const { file, path: target } of targets) {
      storeFiles.set([sourceRoot, ...file.path.split('/')].join(context.source.sep), path.join(root, ...target.split('/')))
    }
  }
  const transform = rewriteTranscript({ mapCwd, storeFiles })
  const lastActivityMs = Date.parse(session.lastActivity)
  const files: TargetFile[] = targets.map(({ file, path: target }) => ({
    role: file.role,
    path: target,
    sha256: file.sha256,
    transform: file.role !== 'tool-result' && target.endsWith('.jsonl') ? transform : null,
    mtimeMs: file.role === 'transcript' ? lastActivityMs : file.mtimeMs,
  }))

  return { kind: 'ready', targetCwd, warnings, live: (await liveSessionIds(root)).has(session.id), files, effects: [] }
}
